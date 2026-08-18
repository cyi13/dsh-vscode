/**
 * Single-file host + client build for dsh-clipboard.
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternal,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  external: dshExternal,
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-clipboard', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

writeFileSync('lib/index.d.ts', 'export declare const name = "dsh-clipboard";\nexport declare function apply(ctx: unknown): void;\n')
writeFileSync('lib/client.d.ts', 'export declare function apply(ctx: unknown): void;\n')
console.log('[dsh-clipboard] build done')
