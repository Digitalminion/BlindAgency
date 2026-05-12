import {
  CreateKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  KMSInvalidStateException,
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
// KMS PendingDeletion keys are immediately unusable for cryptographic operations.
// We schedule deletion only after a key has been out of SSM for a full rotation cycle,
// ensuring any clients holding the previous public key can still decrypt during the grace window.
const DELETION_WINDOW_DAYS = 7 // KMS minimum; actual revocation happens via SSM removal

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
  const newKeyArn = created.KeyMetadata?.Arn
  if (!newKeyArn) throw new Error('KMS CreateKey returned no Arn')

  // 2. Export the public key and format as PEM
  const pubKeyRes = await kms.send(new GetPublicKeyCommand({ KeyId: newKeyArn }))
  if (!pubKeyRes.PublicKey) throw new Error('KMS GetPublicKey returned no PublicKey')
  const publicKeyPem = derToPem(pubKeyRes.PublicKey)
  const keyId = randomUUID()

  const newEntry = JSON.stringify({ keyId, keyArn: newKeyArn, publicKeyPem })

  // 3. Rotate SSM: current → previous, new → current
  //    Read both parameters in parallel so we know which key is retiring from SSM entirely.
  const [currentRes, previousRes] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: SSM_CURRENT })).catch(() => null),
    ssm.send(new GetParameterCommand({ Name: SSM_PREVIOUS })).catch(() => null),
  ])

  // The key leaving SSM_PREVIOUS has been out of SSM_CURRENT for a full rotation cycle —
  // all in-flight clients holding it will have had time to transition. Safe to KMS-delete.
  let toDeleteKeyArn: string | null = null
  if (previousRes?.Parameter?.Value) {
    try {
      const retiring = JSON.parse(previousRes.Parameter.Value) as unknown
      if (typeof retiring === 'object' && retiring !== null && typeof (retiring as Record<string, unknown>).keyArn === 'string') {
        toDeleteKeyArn = (retiring as { keyArn: string }).keyArn
      }
    } catch {
      // Malformed SSM entry — skip deletion for safety
    }
  }

  // Promote current → previous (overwrites any stale previous entry)
  if (currentRes?.Parameter?.Value) {
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

  // 5. Schedule deletion of the key that cycled fully out of SSM — it is now unreachable by
  //    any client. The 7-day window satisfies the KMS minimum; actual access was cut at SSM.
  if (toDeleteKeyArn) {
    await kms.send(new ScheduleKeyDeletionCommand({
      KeyId: toDeleteKeyArn,
      PendingWindowInDays: DELETION_WINDOW_DAYS,
    })).catch((err: unknown) => {
      // Already pending deletion (e.g. double-fire or prior partial failure) — treat as success
      if (err instanceof KMSInvalidStateException) return
      throw err
    })
  }
}
