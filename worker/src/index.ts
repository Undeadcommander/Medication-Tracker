// Dosely reminder server for Cloudflare Workers: the same /api routes as server/index.ts.
// The Worker handles CORS and security headers; one Durable Object (PushStore) does the rest.
import { PushStore, type Env } from './store';
import { storeStub } from './stub';
import { bodyLimitFor, isJsonRequest, parseOriginList } from './validate';
import { loadVapid, type VapidLoad } from './webpush';

// workerd only accepts handlers and classes as named exports of the entry module, so helpers
// (storeStub, constants) live in other modules.
export { PushStore };
export type { Env };

function withHeaders(res: Response, cors: Record<string, string>): Response {
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const jsonError = (error: string, status: number) => json({ error }, status);

// Per isolate (a deploy or secret change starts new ones). Same inputs as the Durable Object's.
let origins: { raw: string | undefined; set: Set<string> } | null = null;
let vapid: { raw: string; load: Promise<VapidLoad> } | null = null;

function allowedOrigins(env: Env): Set<string> {
  if (!origins || origins.raw !== env.ALLOWED_ORIGINS) origins = { raw: env.ALLOWED_ORIGINS, set: parseOriginList(env.ALLOWED_ORIGINS) };
  return origins.set;
}

/** The same check the Durable Object runs (loadVapid on the same secrets), so both always agree. */
function workerVapid(env: Env): Promise<VapidLoad> {
  const raw = JSON.stringify([env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT]);
  if (vapid?.raw !== raw) {
    vapid = {
      raw,
      load: loadVapid({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }),
    };
  }
  return vapid.load;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return withHeaders(jsonError('not found', 404), {});
    }

    // CORS for the front end on GitHub Pages. ALLOWED_ORIGINS is a comma-separated list of exact
    // origins such as "https://undeadcommander.github.io" (same rule as server/index.ts).
    const allowed = allowedOrigins(env);
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
    // Refuse a declared oversize body here, before streaming it to the Durable Object (which also
    // enforces the cap while reading, for bodies without a Content-Length).
    if (request.method === 'POST' && Number(request.headers.get('Content-Length')) > bodyLimitFor(url.pathname)) {
      return withHeaders(jsonError('payload too large', 413), cors);
    }
    // Answered here without a Durable Object request (the free plan has a daily quota of them):
    // a body that isn't JSON (same 400 the object gives), and the public key.
    if (request.method === 'POST' && (!isJsonRequest(request) || request.headers.get('Content-Length') === '0')) {
      return withHeaders(jsonError('body must be an object', 400), cors);
    }
    if (url.pathname === '/api/push/public-key') {
      const v = await workerVapid(env);
      return withHeaders(v.ok ? json({ publicKey: v.signer.config.publicKey }) : jsonError('push not configured', 503), cors);
    }

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
