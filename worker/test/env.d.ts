// Bindings seen by tests through `cloudflare:test`.
type StoreEnv = import('../src/store').Env;
declare namespace Cloudflare {
  interface Env extends StoreEnv {}
}
