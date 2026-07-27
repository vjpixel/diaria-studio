/**
 * test/poll-root-head-4125.test.ts (#4125 item 6)
 *
 * Regressão: `GET /` redireciona (301) pra `/jogar` desde #3701, mas `HEAD /`
 * caía no 404 JSON genérico do fim do dispatcher — a guarda só aceitava
 * `request.method === "GET"`. Mesmo racional já aplicado a
 * `/leaderboard`/`/img/*` (#3998, ver poll-leaderboard-head-3998.test.ts):
 * link-preview generators e uptime checks fazem HEAD antes de seguir o
 * link, e a raiz (`eia.diar.ia.br/`) é o link mais compartilhado do worker.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeEnv(): Env {
  return {
    POLL: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      getWithMetadata: async () => ({ value: null, metadata: null }),
      list: async () => ({ keys: [], list_complete: true }),
    } as unknown as KVNamespace,
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

describe("#4125 item 6 — HEAD / não deve 404 (só GET era aceito antes do fix)", () => {
  it("GET /: 301 pra /jogar (comportamento pré-existente, #3701)", async () => {
    const req = new Request("https://eia.diar.ia.br/", { method: "GET" });
    const res = await workerDefault.fetch(req, makeEnv(), {} as ExecutionContext);
    assert.equal(res.status, 301);
    assert.match(res.headers.get("Location") ?? "", /\/jogar$/);
  });

  it("HEAD /: 301 pra /jogar, não 404 (regressão #4125 item 6)", async () => {
    const req = new Request("https://eia.diar.ia.br/", { method: "HEAD" });
    const res = await workerDefault.fetch(req, makeEnv(), {} as ExecutionContext);
    assert.equal(res.status, 301, `HEAD / deveria ser 301 (regressão #4125 item 6), recebeu ${res.status}`);
    assert.match(res.headers.get("Location") ?? "", /\/jogar$/);
  });
});
