import type { Env } from './store';

/** All devices live in one Durable Object: this app has one user and a handful of devices. */
export const STORE_NAME = 'global';

export function storeStub(env: Env) {
  return env.PUSH_STORE.get(env.PUSH_STORE.idFromName(STORE_NAME));
}
