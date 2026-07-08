/**
 * test/poll-cors-origin-3116.test.ts
 *
 * Regressão #3116: `Access-Control-Allow-Origin` com lista separada por
 * vírgula (`env.ALLOWED_ORIGINS`, ex: "https://diar.ia.br,https://diaria.beehiiv.com")
 * é um header INVÁLIDO pela spec de CORS — só aceita 1 valor ou "*". Navegadores
 * tratam a lista concatenada como mismatch e bloqueiam a resposta, quebrando
 * CORS exatamente pras origens que deveriam ser permitidas.
 *
 * Fix (`workers/poll/src/index.ts`, `corsHeaders`): split de `ALLOWED_ORIGINS`
 * por vírgula; ecoa SOMENTE a `Origin` da request se ela estiver na allowlist
 * (+ `Vary: Origin`); omite o header por completo se não estiver (nunca vaza
 * a allowlist nem ecoa origem arbitrária).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { corsHeaders, type Env } from "../workers/poll/src/index.ts";
import poll from "../workers/poll/src/index.ts";

const TWO_ORIGINS = "https://diar.ia.br,https://diaria.beehiiv.com";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    POLL: {} as unknown as Env["POLL"],
    POLL_SECRET: "test",
    ADMIN_SECRET: "test",
    ALLOWED_ORIGINS: TWO_ORIGINS,
    ...overrides,
  };
}

describe("corsHeaders — #3116 (allowlist com múltiplas origens)", () => {
  it("origem permitida (1ª da lista) → ecoa SÓ essa origem, sem vírgula, com Vary: Origin", () => {
    const env = makeEnv({ _requestOrigin: "https://diar.ia.br" });
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], "https://diar.ia.br");
    assert.ok(!headers["Access-Control-Allow-Origin"].includes(","), "nunca deve conter vírgula");
    assert.equal(headers["Vary"], "Origin");
  });

  it("origem permitida (2ª da lista) → ecoa SÓ essa origem, sem vírgula, com Vary: Origin", () => {
    const env = makeEnv({ _requestOrigin: "https://diaria.beehiiv.com" });
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], "https://diaria.beehiiv.com");
    assert.ok(!headers["Access-Control-Allow-Origin"].includes(","), "nunca deve conter vírgula");
    assert.equal(headers["Vary"], "Origin");
  });

  it("origem NÃO permitida → header ausente (não vaza a allowlist nem ecoa origem arbitrária)", () => {
    const env = makeEnv({ _requestOrigin: "https://evil.example.com" });
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], undefined);
    assert.equal(headers["Vary"], undefined);
  });

  it("request sem header Origin → header ausente", () => {
    const env = makeEnv({ _requestOrigin: null });
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], undefined);
  });

  it("ALLOWED_ORIGINS='*' preserva allow-all (comportamento anterior), independente de Origin", () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "*", _requestOrigin: "https://qualquer-coisa.com" });
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], "*");
    assert.equal(headers["Vary"], undefined);
  });

  it("ALLOWED_ORIGINS vazio/não configurado preserva allow-all", () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "", _requestOrigin: "https://qualquer-coisa.com" });
    const headers = corsHeaders(env);
    assert.equal(headers["Access-Control-Allow-Origin"], "*");
  });

  it("Access-Control-Allow-Methods/Headers sempre presentes independente da origem", () => {
    const allowed = corsHeaders(makeEnv({ _requestOrigin: "https://diar.ia.br" }));
    const disallowed = corsHeaders(makeEnv({ _requestOrigin: "https://evil.example.com" }));
    for (const headers of [allowed, disallowed]) {
      assert.equal(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
      assert.equal(headers["Access-Control-Allow-Headers"], "Content-Type");
    }
  });
});

describe("dispatcher principal (OPTIONS preflight) — #3116 e2e", () => {
  function envNoOrigin(): Env {
    return {
      POLL: {} as unknown as Env["POLL"],
      POLL_SECRET: "test",
      ADMIN_SECRET: "test",
      ALLOWED_ORIGINS: TWO_ORIGINS,
    };
  }

  it("preflight de cada origem permitida ecoa só ELA (nunca a lista com vírgula)", async () => {
    for (const origin of ["https://diar.ia.br", "https://diaria.beehiiv.com"]) {
      const req = new Request("https://poll.diaria.workers.dev/vote", {
        method: "OPTIONS",
        headers: { Origin: origin },
      });
      const res = await poll.fetch(req, envNoOrigin());
      assert.equal(res.status, 204);
      const acao = res.headers.get("Access-Control-Allow-Origin");
      assert.equal(acao, origin);
      assert.ok(acao === null || !acao.includes(","), "header nunca deve conter vírgula");
      assert.equal(res.headers.get("Vary"), "Origin");
    }
  });

  it("preflight de origem não permitida NÃO recebe Access-Control-Allow-Origin", async () => {
    const req = new Request("https://poll.diaria.workers.dev/vote", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    const res = await poll.fetch(req, envNoOrigin());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });
});
