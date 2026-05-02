export interface PublicKeyInfo {
  keyId: string
  publicKey: CryptoKey
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .split('\n')
    .filter(l => !l.startsWith('-----'))
    .join('')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export async function fetchPublicKey(endpoint: string): Promise<PublicKeyInfo> {
  const res = await fetch(`${endpoint}/public-key`)
  if (!res.ok) throw new Error(`fetchPublicKey failed: ${res.status}`)
  const { keyId, publicKeyPem } = await res.json() as { keyId: string; publicKeyPem: string }
  const publicKey = await crypto.subtle.importKey(
    'spki',
    pemToDer(publicKeyPem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
  return { keyId, publicKey }
}

export async function encryptApiKey(apiKey: string, publicKey: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    new TextEncoder().encode(apiKey),
  )
}
