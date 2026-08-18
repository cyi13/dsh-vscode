/**
 * Single-file host + client build for dsh-deeplink.
 *
 * The web server serves exactly one file per plugin
 * (/plugins/dsh-deeplink/client.js), so the client half is one CJS bundle
 * wrapped in the ModuleLoader factory handshake. The host half is plain ESM
 * for Node.
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
    js: "window.__ModuleLoader__.load({ id: 'dsh-deeplink', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

// Minimal type stubs so the exports map stays resolvable.
writeFileSync('lib/index.d.ts', 'export declare const name = "dsh-deeplink";\nexport declare function apply(ctx: unknown): void;\n')
writeFileSync('lib/client.d.ts', 'export interface ClientContext { sessions: unknown }\nexport declare function apply(ctx: ClientContext): void;\n')
console.log('[dsh-deeplink] build done')
