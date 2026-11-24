/**
 * fork: lets the app's server modules load outside Next.js: the Shopmonkey CLI (`run.ts`) and the end-to-end suite's
 * job runner (`e2e/support/run-jobs.ts`). Those modules import `server-only`, which Next's bundler provides and npm
 * never installs (it isn't a dependency), so plain Node can't find it. Here it resolves to an empty module.
 *
 *   npx tsx --import ./scripts/shopmonkey/register.mjs scripts/shopmonkey/run.ts ...
 *
 * `module.registerHooks` needs Node 22.15 or later (the repo pins 22.23.4: Dockerfile, devcontainer, CI).
 */
import * as nodeModule from 'node:module'

const { registerHooks } = nodeModule
if (typeof registerHooks !== 'function') {
  console.error(
    `The Shopmonkey scripts need Node 22.15 or later (this is ${process.version}); the repo pins 22.23.4.`
  )
  process.exit(1)
}

const empty = new URL('./server-only.cjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: empty, format: 'commonjs', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
