import { build } from 'esbuild'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const srcHandlers = join(root, 'src', 'handlers')
const outHandlers = join(root, 'dist', 'handlers')

const handlers = ['proxy', 'rotation', 'public-key']

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
    // AWS SDK v3 is built into the Node 22 Lambda runtime — exclude from bundle
    external: ['@aws-sdk/*'],
  })
}))

console.log('✓ handlers bundled to dist/handlers/')
