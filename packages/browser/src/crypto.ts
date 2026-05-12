export interface PublicKeyInfo {
  keyId: string
  publicKey: CryptoKey
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/\r/g, '')
    .split('\n')
    .filter(l => !l.startsWith('-----'))
    .join('')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    pemToDer(pem),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
}

export async function encryptApiKey(apiKey: string, publicKey: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    new TextEncoder().encode(apiKey),
  )
}
