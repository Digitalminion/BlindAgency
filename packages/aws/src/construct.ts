import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

export type Provider = 'anthropic' | 'openai' | 'gemini'

export interface BlindAgencyProps {
  providers: Provider[]
  corsOrigins: string[]
  rotationInterval?: Duration
  /** Maximum concurrent executions for the relay Lambda. Prevents runaway scale and limits
   *  abuse of the relay as an open LLM proxy. Defaults to 10. */
  maxConcurrency?: number
}

// Handlers are pre-bundled to dist/handlers/{name}/index.js by `npm run build`.
// Resolving via '../dist/handlers' works whether __dirname is src/ (Vitest runs TS source)
// or dist/ (tsc output, npm-installed package) — both reach the same dist/handlers/ path.
const __dirname = dirname(fileURLToPath(import.meta.url))
const HANDLERS = join(__dirname, '..', 'dist', 'handlers')

export class BlindAgencyConstruct extends Construct {
  readonly apiUrl: string
  readonly publicKeyUrl: string

  constructor(scope: Construct, id: string, props: BlindAgencyProps) {
    super(scope, id)

    const {
      providers,
      corsOrigins,
      rotationInterval = Duration.hours(1),
      maxConcurrency = 10,
    } = props

    const ssmKeyParam = `/${id}/keys/current`
    const ssmPrevParam = `/${id}/keys/previous`
    const corsOrigin = corsOrigins.length === 1 ? corsOrigins[0] : '*'

    const commonEnv = {
      SSM_KEY_PARAM: ssmKeyParam,
      SSM_PREV_PARAM: ssmPrevParam,
      CORS_ORIGIN: corsOrigin,
    }

    // ── Log group encryption key ────────────────────────────────────────────
    // Encrypts CloudWatch log groups at rest. If anything were ever accidentally
    // logged by the proxy Lambda, it would be unreadable without this key.
    const logEncryptionKey = new kms.Key(this, 'LogKey', {
      description: `${id} log group encryption`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // CloudWatch Logs needs permission to use the key
    logEncryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal(`logs.${Stack.of(this).region}.amazonaws.com`)],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
    }))

    // ── Log groups ──────────────────────────────────────────────────────────
    // Proxy: 1-day retention, KMS-encrypted, WARN log level (set on the function below).
    // The Lambda runtime emits START/END/REPORT at INFO by default — suppressed by
    // systemLogLevel: WARN so nothing is written for normal invocations.
    const proxyLogGroup = new logs.LogGroup(this, 'ProxyLogs', {
      retention: logs.RetentionDays.ONE_DAY,
      encryptionKey: logEncryptionKey,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const rotationLogGroup = new logs.LogGroup(this, 'RotationLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const publicKeyLogGroup = new logs.LogGroup(this, 'PublicKeyLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const fnProps: Omit<lambda.FunctionProps, 'code' | 'logGroup' | 'reservedConcurrentExecutions'> = {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(29),
      handler: 'index.handler',
      // X-Ray tracing disabled. If active, X-Ray captures outbound HTTP subsegments
      // including headers — on the proxy that means the provider auth header built
      // from the decrypted key could appear in trace data.
      tracing: lambda.Tracing.DISABLED,
      // Structured JSON logs so log level controls are effective.
      loggingFormat: lambda.LoggingFormat.JSON,
    }

    // ── Lambda: public-key ──────────────────────────────────────────────────
    const publicKeyFn = new lambda.Function(this, 'PublicKeyFn', {
      ...fnProps,
      code: lambda.Code.fromAsset(join(HANDLERS, 'public-key')),
      environment: commonEnv,
      logGroup: publicKeyLogGroup,
      applicationLogLevelV2: lambda.ApplicationLogLevel.WARN,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
    })

    publicKeyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: ssmKeyParam.slice(1) }),
      ],
    }))

    // ── Lambda: proxy ───────────────────────────────────────────────────────
    const proxyFn = new lambda.Function(this, 'ProxyFn', {
      ...fnProps,
      code: lambda.Code.fromAsset(join(HANDLERS, 'proxy')),
      environment: { ...commonEnv, PROVIDERS: providers.join(',') },
      logGroup: proxyLogGroup,
      // WARN suppresses INFO-level system logs (START/END/REPORT) — nothing is written
      // to CloudWatch for a normal successful invocation.
      applicationLogLevelV2: lambda.ApplicationLogLevel.WARN,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      // Hard cap on concurrency. Prevents the relay from being used as an open LLM proxy
      // at scale and limits blast radius if credentials are stolen.
      reservedConcurrentExecutions: maxConcurrency,
    })

    proxyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: ssmKeyParam.slice(1) }),
        Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: ssmPrevParam.slice(1) }),
      ],
    }))

    // Tag condition: proxy may only decrypt with keys tagged Application=BlindAgency.
    // aws:ResourceTag evaluates against the existing key's tags.
    proxyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:ResourceTag/Application': 'BlindAgency' },
      },
    }))

    // ── Lambda: rotation ────────────────────────────────────────────────────
    const rotationFn = new lambda.Function(this, 'RotationFn', {
      ...fnProps,
      code: lambda.Code.fromAsset(join(HANDLERS, 'rotation')),
      environment: commonEnv,
      timeout: Duration.seconds(60),
      logGroup: rotationLogGroup,
      applicationLogLevelV2: lambda.ApplicationLogLevel.WARN,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
    })

    // CreateKey + TagResource: aws:RequestTag enforces that the key MUST be created with the tag.
    // kms:TagResource is required alongside kms:CreateKey when tags are applied at creation time.
    rotationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:CreateKey', 'kms:TagResource'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:RequestTag/Application': 'BlindAgency' },
      },
    }))

    // Key management: aws:ResourceTag enforces these actions only work on already-tagged keys.
    rotationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:GetPublicKey', 'kms:ScheduleKeyDeletion', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:ResourceTag/Application': 'BlindAgency' },
      },
    }))

    rotationFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [
        Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: ssmKeyParam.slice(1) }),
        Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: ssmPrevParam.slice(1) }),
      ],
    }))

    // ── Bootstrap: invoke rotation once on first deploy ─────────────────────
    // Ensures the first key pair exists in SSM before the stack reports success.
    // Static physicalResourceId means this only runs on stack creation, not updates.
    const bootstrap = new cr.AwsCustomResource(this, 'BootstrapKeyPair', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: rotationFn.functionName,
          InvocationType: 'RequestResponse',
        },
        physicalResourceId: cr.PhysicalResourceId.of('bootstrap-key-pair'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [rotationFn.functionArn],
        }),
      ]),
    })
    bootstrap.node.addDependency(rotationFn)

    // ── Rotation schedule ───────────────────────────────────────────────────
    // retryAttempts: 2 and maxEventAge match the EventBridge async invocation defaults,
    // declared explicitly so a future reader cannot argue these were left to chance.
    // maxEventAge is capped at twice the rotation interval — a rotation event that has
    // been queued that long is stale and should be dropped rather than applied.
    new events.Rule(this, 'RotationRule', {
      schedule: events.Schedule.rate(rotationInterval),
      targets: [new targets.LambdaFunction(rotationFn, {
        retryAttempts: 2,
        maxEventAge: Duration.seconds(rotationInterval.toSeconds() * 2),
      })],
    })

    // ── HTTP API ────────────────────────────────────────────────────────────
    // Access logging is intentionally not configured. HTTP API access logs include
    // request metadata but not bodies — omitting them removes any path by which
    // request-level data could be written to a persistent log store.
    const api = new apigatewayv2.HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type'],
      },
    })

    api.addRoutes({
      path: '/public-key',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('PublicKeyIntegration', publicKeyFn),
    })

    api.addRoutes({
      path: '/relay',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('RelayIntegration', proxyFn),
    })

    this.apiUrl = api.apiEndpoint
    this.publicKeyUrl = `${api.apiEndpoint}/public-key`
  }
}
