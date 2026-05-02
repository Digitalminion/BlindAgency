export interface KeyBlob {
  keyId: string
  ciphertext: string // base64-encoded encrypted API key
}

const STORAGE_KEY = 'blindagency:keyblob'
let memoryStore: KeyBlob | null = null

function available(): boolean {
  try {
    sessionStorage.setItem('__ba_test__', '1')
    sessionStorage.removeItem('__ba_test__')
    return true
  } catch {
    return false
  }
}

export function saveKeyBlob(blob: KeyBlob): void {
  if (available()) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(blob))
  } else {
    memoryStore = blob
  }
}

export function loadKeyBlob(): KeyBlob | null {
  if (available()) {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as KeyBlob) : null
  }
  return memoryStore
}

export function clearKeyBlob(): void {
  if (available()) sessionStorage.removeItem(STORAGE_KEY)
  memoryStore = null
}
