import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMockShopmonkey } from '../src/__tests__/features/integrations/shopmonkey/mockServer'

/**
 * fork (M8): Shopmonkey as far as the app can tell, for the import spec. The app is pointed here by
 * SHOPMONKEY_API_BASE_URL, which only the environment can set (`src/integrations/shopmonkey/client.ts`).
 *
 * The records are the synthetic fixtures (`src/__tests__/features/integrations/fixtures/shopmonkey/synthetic`), served
 * by the same mock the unit and database tests use, plus the two calls connecting makes: the key's status and its
 * user. A key containing "wrong" is refused, the way Shopmonkey refuses one it doesn't know. It only reads: the mock
 * answers 405 to a POST that isn't a search. Run on its own with `npx tsx e2e/shopmonkey-standin.ts`.
 */

const PORT = Number(process.env.E2E_SHOPMONKEY_PORT ?? 8027)
const mock = createMockShopmonkey()

const ME = {
  companyId: 'syn_com_1',
  company: { id: 'syn_com_1', name: 'Synthetic Auto Works' },
  locations: [{ id: 'syn_loc_1', name: 'Synthetic Auto Works' }],
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `standin-${status}` })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    if (url.pathname === '/health') return send(res, 200, { ok: true })
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth.includes('wrong')) {
      return send(res, 401, { success: false, message: 'Invalid API key' })
    }
    if (url.pathname === '/v3/auth/api_key/status') {
      return send(res, 200, { success: true, data: { active: true } })
    }
    if (url.pathname === '/v3/user/me') return send(res, 200, { success: true, data: ME })
    const method = req.method ?? 'GET'
    const answer = await mock.fetch(`https://api.shopmonkey.cloud${url.pathname}${url.search}`, {
      method,
      ...(method === 'POST' ? { body: await readBody(req) } : {}),
    })
    res.writeHead(answer.status, Object.fromEntries(answer.headers))
    res.end(Buffer.from(await answer.arrayBuffer()))
  } catch {
    send(res, 500, { success: false })
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] Shopmonkey stand-in on http://127.0.0.1:${PORT}`)
})
