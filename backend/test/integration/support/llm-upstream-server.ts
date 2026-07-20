import { createLlmUpstreamStub } from './llm-upstream.js'

const port = Number.parseInt(process.env.LLM_STUB_PORT ?? '0', 10)
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('LLM_STUB_PORT must be a valid TCP port')
}

const delayText = process.env.LLM_STUB_DELAY_MS
if (delayText !== undefined && !/^(0|[1-9]\d*)$/.test(delayText)) {
  throw new Error('LLM_STUB_DELAY_MS must be an integer from 0 through 60000')
}
const delayMs = delayText === undefined ? undefined : Number(delayText)
if (delayMs !== undefined && (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000)) {
  throw new Error('LLM_STUB_DELAY_MS must be an integer from 0 through 60000')
}
const upstream = createLlmUpstreamStub(delayMs === undefined ? {} : { delayMs })
const address = await upstream.app.listen({ port, host: '127.0.0.1' })
// Stable one-line readiness protocol for fresh-backend.mjs. Keep this on stdout.
process.stdout.write(`LLM stub listening ${address}\n`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void upstream.close().finally(() => process.exit(0))
  })
}
