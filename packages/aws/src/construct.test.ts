import { App, Stack, Duration } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { BlindAgencyConstruct } from './construct.js'

function synth(props?: Partial<ConstructorParameters<typeof BlindAgencyConstruct>[2]>) {
  const app = new App()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  new BlindAgencyConstruct(stack, 'BlindAgency', {
    providers: ['anthropic'],
    corsOrigins: ['https://example.com'],
    ...props,
  })
  return Template.fromStack(stack)
}

describe('BlindAgencyConstruct', () => {
  it('creates four application Lambda functions', () => {
    const t = synth()
    // 4 app Lambdas (proxy, rotation, public-key, integrity) + 1 singleton provider Lambda from AwsCustomResource framework
    t.resourceCountIs('AWS::Lambda::Function', 5)
  })

  it('creates an HTTP API', () => {
    const t = synth()
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1)
  })

  it('creates /public-key, /relay, and /integrity routes', () => {
    const t = synth()
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 3)
  })

  it('creates one rotation EventBridge rule', () => {
    const t = synth()
    // Only the rotation schedule — bootstrap is handled by AwsCustomResource
    t.resourceCountIs('AWS::Events::Rule', 1)
  })

  it('creates a custom resource for first-deploy key bootstrap', () => {
    const t = synth()
    t.resourceCountIs('Custom::AWS', 1)
  })

  it('rotation function CreateKey + TagResource are tag-conditioned on Application=BlindAgency', () => {
    const t = synth()
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:CreateKey', 'kms:TagResource']),
            Condition: { StringEquals: { 'aws:RequestTag/Application': 'BlindAgency' } },
          }),
        ]),
      },
    })
  })

  it('rotation function key management is tag-conditioned on Application=BlindAgency', () => {
    const t = synth()
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:GetPublicKey', 'kms:ScheduleKeyDeletion']),
            Condition: { StringEquals: { 'aws:ResourceTag/Application': 'BlindAgency' } },
          }),
        ]),
      },
    })
  })

  it('all log groups use KMS encryption', () => {
    const t = synth()
    const logGroups = t.findResources('AWS::Logs::LogGroup')
    const encryptedCount = Object.values(logGroups).filter(
      (lg: unknown) => (lg as { Properties: Record<string, unknown> }).Properties.KmsKeyId !== undefined
    ).length
    expect(encryptedCount).toBe(Object.keys(logGroups).length)
  })

  it('rotation Lambda does not have CORS_ORIGIN in environment', () => {
    const t = synth()
    const fns = t.findResources('AWS::Lambda::Function')
    const rotationFnEnvs = Object.values(fns)
      .map((fn: unknown) => (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables)
      .filter(Boolean)
    const hasCorsInRotation = rotationFnEnvs.some(env => env && 'CORS_ORIGIN' in env && 'SSM_PREV_PARAM' in (env as object) && !('PROVIDERS' in (env as object)))
    expect(hasCorsInRotation).toBe(false)
  })

  it('rotation function does not have kms:DescribeKey permission', () => {
    const t = synth()
    const policies = t.findResources('AWS::IAM::Policy')
    const allActions = Object.values(policies).flatMap((p: unknown) => {
      const doc = (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties.PolicyDocument
      return doc.Statement.flatMap(s => (Array.isArray(s.Action) ? s.Action : [s.Action]))
    })
    expect(allActions).not.toContain('kms:DescribeKey')
  })

  it('proxy Decrypt is tag-conditioned on Application=BlindAgency', () => {
    const t = synth()
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:Decrypt',
            Condition: { StringEquals: { 'aws:ResourceTag/Application': 'BlindAgency' } },
          }),
        ]),
      },
    })
  })

  it('sets rotation Lambda reserved concurrency to 1 to prevent double-fire corruption', () => {
    const t = synth()
    t.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 1,
    })
  })

  it('accepts custom rotation interval', () => {
    expect(() => synth({ rotationInterval: Duration.hours(6) })).not.toThrow()
  })

  it('accepts multiple providers', () => {
    expect(() => synth({ providers: ['anthropic', 'openai', 'gemini'] })).not.toThrow()
  })

  it('exposes apiUrl, publicKeyUrl, and integrityUrl', () => {
    const app = new App()
    const stack = new Stack(app, 'S', { env: { account: '123', region: 'us-east-1' } })
    const c = new BlindAgencyConstruct(stack, 'B', {
      providers: ['anthropic'],
      corsOrigins: ['*'],
    })
    expect(c.apiUrl).toBeDefined()
    expect(c.publicKeyUrl).toContain('/public-key')
    expect(c.integrityUrl).toContain('/integrity')
  })
})
