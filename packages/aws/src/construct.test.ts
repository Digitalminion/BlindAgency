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
  it('creates three application Lambda functions', () => {
    const t = synth()
    // 3 app Lambdas + 1 singleton provider Lambda from AwsCustomResource framework
    t.resourceCountIs('AWS::Lambda::Function', 4)
  })

  it('creates an HTTP API', () => {
    const t = synth()
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1)
  })

  it('creates /public-key and /relay routes', () => {
    const t = synth()
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 2)
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

  it('accepts custom rotation interval', () => {
    expect(() => synth({ rotationInterval: Duration.hours(6) })).not.toThrow()
  })

  it('accepts multiple providers', () => {
    expect(() => synth({ providers: ['anthropic', 'openai', 'gemini'] })).not.toThrow()
  })

  it('exposes apiUrl and publicKeyUrl', () => {
    const app = new App()
    const stack = new Stack(app, 'S', { env: { account: '123', region: 'us-east-1' } })
    const c = new BlindAgencyConstruct(stack, 'B', {
      providers: ['anthropic'],
      corsOrigins: ['*'],
    })
    expect(c.apiUrl).toBeDefined()
    expect(c.publicKeyUrl).toContain('/public-key')
  })
})
