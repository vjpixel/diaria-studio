/**
 * test/poll-confirmado-5167.test.ts (#5167 item 7; redirect desde #7737)
 *
 * Regressão (#633) pra `GET /confirmado` no Worker `poll`
 * (`eia.diar.ia.br/confirmado`) — destino histórico do double opt-in da
 * Beehiiv/Kit. Desde #7737 (decisão do editor) a página REAL mora no apex
 * (`diar.ia.br/confirmado`, Worker `site` — cobertura em
 * `test/site-worker-confirmado-7737.test.ts`; render puro em
 * `test/confirmado-page-shared-7737.test.ts`) — esta rota agora só devolve
 * 301 pra lá, mas continua no ar (link já entregue em e-mails de
 * confirmação e gravado em `opt_in_redirect_url` da Beehiiv).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleConfirmadoRedirect, CONFIRMADO_REDIRECT_URL } from "../workers/poll/src/confirmado.ts";
import type { Env } from "../workers/poll/src/index.ts";
import worker from "../workers/poll/src/index.ts";

function makeMapKV() {
  const m = new Map<string, string>();
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: undefined };
    },
  };
}

function makeEnv(): Env {
  return {
    POLL: makeMapKV() as unknown as Env["POLL"],
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  };
}

describe("CONFIRMADO_REDIRECT_URL (#7737)", () => {
  it("aponta pro apex — diar.ia.br/confirmado", () => {
    assert.equal(CONFIRMADO_REDIRECT_URL, "https://diar.ia.br/confirmado");
  });
});

describe("handleConfirmadoRedirect (#7737) — Response", () => {
  it("301 permanente pro apex", () => {
    const res = handleConfirmadoRedirect();
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://diar.ia.br/confirmado");
  });
});

describe("GET /confirmado (#5167 item 7, redirect desde #7737) — router", () => {
  it("301 pro apex sem exigir nenhum secret (rota pública)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://eia.diar.ia.br/confirmado"), env);
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "https://diar.ia.br/confirmado");
  });

  it("só GET — outro método cai no 404 padrão do router (não crasha)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://eia.diar.ia.br/confirmado", { method: "POST" }), env);
    assert.equal(res.status, 404);
  });
});
