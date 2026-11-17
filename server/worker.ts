import { AuthError, bearer, login, logout, register, userForToken } from './auth'
export { Sea } from './sea'

/**
 * The front door: accounts, the leaderboard, and the way onto the open sea.
 * Everything else is the built game, served as static assets.
 */
export interface Env {
  DB: D1Database
  SEA: DurableObjectNamespace
  ASSETS: Fetcher
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json()
    return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`

    try {
      switch (route) {
        case 'POST /api/register':
          return json(await register(env.DB, await body(request)))
        case 'POST /api/login':
          return json(await login(env.DB, await body(request)))
        case 'POST /api/logout':
          await logout(env.DB, bearer(request))
          return json({ ok: true })
        case 'GET /api/me': {
          const user = await userForToken(env.DB, bearer(request))
          return user ? json({ user }) : json({ error: 'Not signed in.' }, 401)
        }
        case 'GET /api/leaderboard': {
          const { results } = await env.DB.prepare(
            `SELECT users.username AS name, stats.renown, stats.sinkings, stats.deaths, stats.best_plunder AS bestPlunder
             FROM stats JOIN users ON users.id = stats.user_id
             ORDER BY stats.renown DESC, stats.sinkings DESC, stats.best_plunder DESC LIMIT 20`,
          ).all()
          return json({ rows: results })
        }
        case 'GET /ws': {
          if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426)
          // Browsers cannot set headers on a WebSocket, so the token rides in
          // the query string. It is checked here, and the sea is told only
          // who this is — never handed anything the browser said about itself.
          const user = await userForToken(env.DB, url.searchParams.get('token'))
          if (!user) return json({ error: 'Not signed in.' }, 401)
          const headers = new Headers({ Upgrade: 'websocket' })
          headers.set('X-User-Id', String(user.id))
          headers.set('X-User-Name', user.username)
          const sea = env.SEA.get(env.SEA.idFromName('open-sea'))
          return sea.fetch(new Request('https://sea/connect', { headers }))
        }
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404)
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, err.status)
      console.error(err)
      return json({ error: 'Something went wrong ashore.' }, 500)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
