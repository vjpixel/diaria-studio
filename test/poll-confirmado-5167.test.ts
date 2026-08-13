/**
 * test/poll-confirmado-5167.test.ts (#5167 item 7)
 *
 * Regressão (#633) pra `GET /confirmado` — destino do double opt-in da
 * Beehiiv (`opt_in_redirect_url`, item 8 — fora do escopo desta unidade).
 * Cobre: render puro (sem I/O), a Response completa, e o wiring no router
 * do worker `poll` (sem exigir nenhum secret — rota pública, como /stats).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderConfirmadoPage, handleConfirmadoPage, PAGE_URL } from "../workers/poll/src/confirmado.ts";
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

describe("renderConfirmadoPage (#5167 item 7) — unit", () => {
  it("PAGE_URL é eia.diar.ia.br/confirmado", () => {
    assert.equal(PAGE_URL, "https://eia.diar.ia.br/confirmado");
  });

  it("confirma o cadastro e diz quando a 1ª edição chega", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /Assinatura confirmada/);
    assert.match(html, /primeira edição chega/);
  });

  it("linka as 3 portas — livros, jogo, arquivo", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /<a href="https:\/\/livros\.diar\.ia\.br\/">/);
    assert.match(html, /<a href="https:\/\/eia\.diar\.ia\.br\/jogar">/);
    assert.match(html, /<a href="https:\/\/arquivo\.diar\.ia\.br\/">/);
  });

  it("CTA pro survey de interesses f7528798 (URL confirmada via MCP get_survey)", () => {
    const html = renderConfirmadoPage();
    assert.match(
      html,
      /<a href="https:\/\/diar\.ia\.br\/forms\/f7528798-f8d5-4fcd-98c2-dc113e8c268b">/,
    );
  });

  it("<title> e canonical batem com PAGE_URL", () => {
    const html = renderConfirmadoPage();
    assert.match(html, /<title>Assinatura confirmada — diar\.ia\.br<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/eia\.diar\.ia\.br\/confirmado">/);
  });
});

describe("handleConfirmadoPage (#5167 item 7) — Response", () => {
  it("200, HTML, cacheável", async () => {
    const res = handleConfirmadoPage();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
    assert.ok(res.headers.get("Cache-Control")?.includes("public"));
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
  });
});

describe("GET /confirmado (#5167 item 7) — router", () => {
  it("responde 200 sem exigir nenhum secret (rota pública)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://eia.diar.ia.br/confirmado"), env);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Assinatura confirmada/);
  });

  it("só GET — outro método cai no 404 padrão do router (não crasha)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://eia.diar.ia.br/confirmado", { method: "POST" }), env);
    assert.equal(res.status, 404);
  });
});
