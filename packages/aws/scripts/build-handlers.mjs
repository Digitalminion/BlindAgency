import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { deflateRawSync } from 'zlib'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const srcHandlers = join(root, 'src', 'handlers')
const outHandlers = join(root, 'dist', 'handlers')

const handlers = ['proxy', 'rotation', 'public-key', 'integrity']

// CRC-32 using the standard polynomial (used by ZIP format)
function crc32(buf) {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = (crc >>> 8) ^ t[(crc ^ b) & 0xFF]
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// Build a single-file deterministic ZIP with fixed Jan-1-1980 timestamps.
// Using pre-built ZIPs (rather than Code.fromAsset(directory)) means CDK
// uploads these bytes verbatim — so SHA256(zip) === Lambda CodeSha256.
function makeZip(filename, data) {
  const name = Buffer.from(filename)
  const deflated = deflateRawSync(data, { level: 9 })
  const crc = crc32(data)
  const dosDate = 0x0021 // Jan 1 1980 (minimum valid ZIP date)
  const dosTime = 0x0000 // 00:00:00

  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0) // local file header sig
  local.writeUInt16LE(20, 4)          // version needed (2.0)
  local.writeUInt16LE(0, 6)           // flags
  local.writeUInt16LE(8, 8)           // compression: DEFLATE
  local.writeUInt16LE(dosTime, 10)
  local.writeUInt16LE(dosDate, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(deflated.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)          // extra field length
  name.copy(local, 30)

  const centralOffset = local.length + deflated.length

  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0) // central directory sig
  central.writeUInt16LE(20, 4)          // version made by
  central.writeUInt16LE(20, 6)          // version needed
  central.writeUInt16LE(0, 8)           // flags
  central.writeUInt16LE(8, 10)          // compression: DEFLATE
  central.writeUInt16LE(dosTime, 12)
  central.writeUInt16LE(dosDate, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(deflated.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30)          // extra field length
  central.writeUInt16LE(0, 32)          // file comment length
  central.writeUInt16LE(0, 34)          // disk number start
  central.writeUInt16LE(0, 36)          // internal attrs
  central.writeUInt32LE(0, 38)          // external attrs
  central.writeUInt32LE(0, 42)             // local header offset — single file, always at 0
  name.copy(central, 46)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory sig
  eocd.writeUInt16LE(0, 4)           // disk number
  eocd.writeUInt16LE(0, 6)           // start disk
  eocd.writeUInt16LE(1, 8)           // entries on disk
  eocd.writeUInt16LE(1, 10)          // total entries
  eocd.writeUInt32LE(central.length, 12) // central dir size
  eocd.writeUInt32LE(centralOffset, 16)  // central dir offset
  eocd.writeUInt16LE(0, 20)          // comment length

  return Buffer.concat([local, deflated, central, eocd])
}

await Promise.all(handlers.map(name => {
  const outdir = join(outHandlers, name)
  mkdirSync(outdir, { recursive: true })
  return build({
    entryPoints: [join(srcHandlers, `${name}.ts`)],
    outfile: join(outdir, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    // AWS SDK v3 is built into the Node 24 Lambda runtime — exclude from bundle
    external: ['@aws-sdk/*'],
  })
}))

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const hashes = {}

for (const name of handlers) {
  const source = readFileSync(join(outHandlers, name, 'index.js'))
  const zip = makeZip('index.js', source)
  writeFileSync(join(outHandlers, `${name}.zip`), zip)
  hashes[name] = `sha256:${createHash('sha256').update(zip).digest('base64')}`
}

writeFileSync(
  join(root, 'dist', 'lambda-hashes.json'),
  JSON.stringify({ version, handlers: hashes }, null, 2) + '\n',
)

console.log('✓ handlers bundled to dist/handlers/')
console.log('✓ deterministic ZIPs written to dist/handlers/*.zip')
console.log('✓ hash manifest written to dist/lambda-hashes.json')
