// Dosely reminder server for Cloudflare Workers: the same /api routes as server/index.ts.
// The Worker handles CORS and security headers; one Durable Object (PushStore) does the rest.
import { PushStore, type Env } from './store';
import { parseOriginList } from './validate';

export { PushStore };
export type { Env };

/** All devices live in one Durable Object: this app has one user and a handful of devices. */
export const STORE_NAME = 'global';

export function storeStub(env: Env) {
  return env.PUSH_STORE.get(env.PUSH_STORE.idFromName(STORE_NAME));
}

function withHeaders(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

const jsonError = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return withHeaders(jsonError('not found', 404), {});
    }

    // CORS for the front end on GitHub Pages. ALLOWED_ORIGINS is a comma-separated list of exact
    // origins such as "https://undeadcommander.github.io" (same rule as server/index.ts).
    const allowed = parseOriginList(env.ALLOWED_ORIGINS);
    const origin = request.headers.get('Origin');
    const cors: Record<string, string> =
      origin && allowed.has(origin)
        ? {
            'Access-Control-Allow-Origin': origin,
            Vary: 'Origin',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          }
        : {};
    if (request.method === 'OPTIONS') {
      return withHeaders(new Response(null, { status: origin && allowed.has(origin) ? 204 : 403 }), cors);
    }
    // Only known routes reach the Durable Object, so stray requests cost no DO request.
    const known =
      (request.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/api/push/public-key')) ||
      (request.method === 'POST' &&
        /^\/api\/push\/(subscribe|unsubscribe|reminders|snooze|test)$/.test(url.pathname));
    if (!known) return withHeaders(jsonError('not found', 404), cors);

    try {
      return withHeaders(await storeStub(env).fetch(request), cors);
    } catch (err) {
      console.error('[push] Durable Object call failed:', err);
      return withHeaders(jsonError('internal error', 500), cors);
    }
  },

  /** Cron watchdog (every minute): re-arms the Durable Object's alarm if it was lost. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(storeStub(env).watchdog());
  },
} satisfies ExportedHandler<Env>;
