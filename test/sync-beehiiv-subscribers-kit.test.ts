/**
 * test/sync-beehiiv-subscribers-kit.test.ts (#6091)
 *
 * Cobre as funções puras: `computeMissingEmails` (diff) e
 * `evaluateEmptyGuard` (guard contra falha silenciosa de auth/paginação
 * do lado do Kit). `fetchActiveBeehiivEmails`/`main` não são testadas aqui
 * de ponta a ponta (rede real via `fetch` global não injetável neste
 * script — mesma limitação já aceita em `fetch-tally-audience.ts`/
 * `publish-newsletter-kit.ts` pra funções `main()` que não expõem
 * `fetchImpl`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMissingEmails, evaluateEmptyGuard } from "../scripts/sync-beehiiv-subscribers-kit.ts";

describe("computeMissingEmails", () => {
  it("e-mail ausente do Kit inteiramente: aparece como missing", () => {
    const result = computeMissingEmails(["a@b.com"], new Map());
    assert.deepEqual(result, ["a@b.com"]);
  });

  it("e-mail presente no Kit com state active: NÃO aparece como missing", () => {
    const result = computeMissingEmails(["a@b.com"], new Map([["a@b.com", "active"]]));
    assert.deepEqual(result, []);
  });

  it("e-mail presente no Kit mas com state != active (ex: cancelled): aparece como missing (precisa reativar)", () => {
    const result = computeMissingEmails(["a@b.com"], new Map([["a@b.com", "cancelled"]]));
    assert.deepEqual(result, ["a@b.com"]);
  });

  it("normaliza case/whitespace do e-mail antes de comparar", () => {
    const result = computeMissingEmails(["  A@B.COM  "], new Map([["a@b.com", "active"]]));
    assert.deepEqual(result, []);
  });

  it("preserva o e-mail ORIGINAL (não normalizado) na saída — pro POST usar a forma real da Beehiiv", () => {
    const result = computeMissingEmails(["A@B.com"], new Map());
    assert.deepEqual(result, ["A@B.com"]);
  });

  it("lista vazia de ativos da Beehiiv: nada a sincronizar", () => {
    assert.deepEqual(computeMissingEmails([], new Map([["a@b.com", "active"]])), []);
  });
});

describe("evaluateEmptyGuard", () => {
  it("sem estado anterior (1ª rodada): sempre passa, não há baseline", () => {
    assert.deepEqual(evaluateEmptyGuard(0, null), { ok: true });
    assert.deepEqual(evaluateEmptyGuard(585, null), { ok: true });
  });

  it("contagem atual >= 50% da anterior: passa", () => {
    const prev = { last_run_at: "2026-08-24T00:00:00Z", kit_subscriber_count: 585 };
    assert.deepEqual(evaluateEmptyGuard(585, prev), { ok: true });
    assert.deepEqual(evaluateEmptyGuard(293, prev), { ok: true }); // exatamente 50%
  });

  it("contagem atual < 50% da anterior: bloqueia (provável falha de auth/paginação)", () => {
    const prev = { last_run_at: "2026-08-24T00:00:00Z", kit_subscriber_count: 585 };
    const result = evaluateEmptyGuard(10, prev);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /provável falha de auth\/paginação/);
      assert.match(result.reason, /585/);
    }
  });

  it("estado anterior com count 0 (nunca sincronizou nada): trata como sem baseline, sempre passa", () => {
    const prev = { last_run_at: "2026-08-24T00:00:00Z", kit_subscriber_count: 0 };
    assert.deepEqual(evaluateEmptyGuard(5, prev), { ok: true });
  });
});
