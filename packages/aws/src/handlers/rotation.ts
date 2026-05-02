import {
  CreateKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  KeySpec,
  KeyUsageType,
  ScheduleKeyDeletionCommand,
} from '@aws-sdk/client-kms'
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm'
import { randomUUID } from 'crypto'

const kms = new KMSClient({})
const ssm = new SSMClient({})

const SSM_CURRENT = process.env.SSM_KEY_PARAM ?? '/blindagency/keys/current'
const SSM_PREVIOUS = process.env.SSM_PREV_PARAM ?? '/blindagency/keys/previous'
// Grace window: previous key stays valid for 2hr after rotation
const DELETION_WINDOW_DAYS = 7 // KMS minimum; we rely on SSM removal to stop new decryptions

function derToPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`
}

export const handler = async (): Promise<void> => {
  // 1. Create new asymmetric KMS key for RSA-OAEP encryption
  const created = await kms.send(new CreateKeyCommand({
    KeySpec: KeySpec.RSA_2048,
    KeyUsage: KeyUsageType.ENCRYPT_DECRYPT,
    Description: 'blindagency relay key',
    // Tag is required by IAM policy — CreateKey is only permitted when this tag is present.
    Tags: [{ TagKey: 'Application', TagValue: 'BlindAgency' }],
  }))
  const newKeyArn = created.KeyMetadata!.Arn!

  // 2. Export the public key and format as PEM
  const pubKeyRes = await kms.send(new GetPublicKeyCommand({ KeyId: newKeyArn }))
  const publicKeyPem = derToPem(pubKeyRes.PublicKey as Uint8Array)
  const keyId = randomUUID()

  const newEntry = JSON.stringify({ keyId, keyArn: newKeyArn, publicKeyPem })

  // 3. Rotate SSM: current → previous, new → current
  //    Read current before overwriting so we can schedule its deletion
  let previousKeyArn: string | null = null
  const currentRes = await ssm.send(new GetParameterCommand({ Name: SSM_CURRENT })).catch(() => null)

  if (currentRes?.Parameter?.Value) {
    const prev = JSON.parse(currentRes.Parameter.Value) as { keyArn: string }
    previousKeyArn = prev.keyArn

    // Promote current to previous (overwrites any stale previous entry)
    await ssm.send(new PutParameterCommand({
      Name: SSM_PREVIOUS,
      Value: currentRes.Parameter.Value,
      Type: 'String',
      Overwrite: true,
    }))
  } else {
    // First rotation — clear any stale previous entry
    await ssm.send(new DeleteParameterCommand({ Name: SSM_PREVIOUS })).catch(() => null)
  }

  // 4. Write new key as current
  await ssm.send(new PutParameterCommand({
    Name: SSM_CURRENT,
    Value: newEntry,
    Type: 'String',
    Overwrite: true,
  }))

  // 5. Schedule deletion of the now-previous KMS key (2hr grace via SSM; KMS minimum is 7 days)
  //    We stop new decryptions by removing it from SSM before it gets KMS-deleted.
  //    The 7-day KMS window is a safety net for any in-flight sessions beyond the SSM window.
  if (previousKeyArn) {
    await kms.send(new ScheduleKeyDeletionCommand({
      KeyId: previousKeyArn,
      PendingWindowInDays: DELETION_WINDOW_DAYS,
    }))
  }
}
