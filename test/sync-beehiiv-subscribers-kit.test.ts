/**
 * test/sync-beehiiv-subscribers-kit.test.ts (#6091, #6092)
 *
 * Cobre as funções puras (`computeMissingEmails`, `evaluateEmptyGuard`,
 * `normalizeEmailForComparison`) e o par `readSyncState`/`writeSyncState`
 * (achado do review #6092: agora recebem `rootDir` explícito — antes o
 * path era fixo no módulo e apontava pro `data/` real compartilhado via
 * OneDrive, o que tornava esse par intestável sem risco de sujar estado
 * de produção). `fetchActiveBeehiivEmails` (rede real via `fetchImpl`
 * injetável) tem cobertura própria abaixo; `main()` de ponta a ponta
 * segue não testado (mesma limitação aceita em `fetch-tally-audience.ts`/
 * `publish-newsletter-kit.ts` — main() não expõe fetchImpl pro lado Kit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeMissingEmails,
  evaluateEmptyGuard,
  normalizeEmailForComparison,
  readSyncState,
  writeSyncState,
  fetchActiveBeehiivEmails,
} from "../scripts/sync-beehiiv-subscribers-kit.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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
    // 293/585 ≈ 50,085% — não é exatamente 50% (585*0.5=292.5), é o menor
    // inteiro que já passa do limiar (292 ainda ficaria abaixo).
    assert.deepEqual(evaluateEmptyGuard(293, prev), { ok: true });
  });

  it("baseline anterior corrompido (count negativo, nunca ocorre organicamente) bloqueia — nunca deixa passar por aritmética inesperada", () => {
    const prev = { last_run_at: "2026-08-24T00:00:00Z", kit_subscriber_count: -1 };
    const result = evaluateEmptyGuard(5, prev);
    assert.equal(result.ok, false);
  });

  it("ratio explicitamente NaN falha FECHADO (nunca {ok:true}) — só alcançável hoje via bug em isValidSyncState, mas o guard não deve confiar cegamente na divisão", () => {
    // Chama a função com um "previousState" cujo count é NaN — driblando o
    // type system (isValidSyncState normalmente barraria isso antes de
    // chegar aqui) pra provar que o PRÓPRIO evaluateEmptyGuard, isolado,
    // trata ratio não-finito como reprovação e não como aprovação silenciosa.
    const prev = { last_run_at: "2026-08-24T00:00:00Z", kit_subscriber_count: NaN as unknown as number };
    const result = evaluateEmptyGuard(5, prev);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /indefinido/);
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

describe("normalizeEmailForComparison", () => {
  it("lowercase + trim", () => {
    assert.equal(normalizeEmailForComparison("  A@B.COM  "), "a@b.com");
  });

  it("já normalizado: idempotente", () => {
    assert.equal(normalizeEmailForComparison("a@b.com"), "a@b.com");
  });
});

describe("readSyncState / writeSyncState", () => {
  it("round-trip: escreve e lê de volta o mesmo estado", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sync-state-"));
    try {
      const state = { last_run_at: "2026-08-25T00:00:00Z", kit_subscriber_count: 600 };
      writeSyncState(dir, state);
      assert.deepEqual(readSyncState(dir), state);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem arquivo (1ª rodada, nunca sincronizou): devolve null, não lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sync-state-"));
    try {
      assert.equal(readSyncState(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido: lança erro nomeado (arquivo corrompido, não estado vazio)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sync-state-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "kit-subscriber-sync-state.json"), "{ isto não é json");
      assert.throws(() => readSyncState(dir), /JSON inválido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON válido mas shape errado (campo renomeado/tipo errado): lança erro nomeado, NUNCA passa como SyncState válido", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sync-state-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "kit-subscriber-sync-state.json"), JSON.stringify({ last_run_at: "x", kit_subscriber_count: "585" }));
      assert.throws(() => readSyncState(dir), /shape inesperado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON válido mas shape errado (kit_subscriber_count ausente): lança erro nomeado", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sync-state-"));
    try {
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, "data", "kit-subscriber-sync-state.json"), JSON.stringify({ last_run_at: "x" }));
      assert.throws(() => readSyncState(dir), /shape inesperado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchActiveBeehiivEmails", () => {
  const apiKey = "bh_test_key";
  const publicationId = "pub_123";

  it("pagina até drenar total_results (achado #1897: total_pages não confiável, per_page ignorado)", async () => {
    let calls = 0;
    const result = await fetchActiveBeehiivEmails(apiKey, publicationId, {
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) {
          return jsonResponse(200, {
            data: [{ email: "a@b.com", status: "active" }],
            total_results: 2,
            limit: 1,
            page: 1,
          });
        }
        return jsonResponse(200, {
          data: [{ email: "b@b.com", status: "active" }],
          total_results: 2,
          limit: 1,
          page: 2,
        });
      }) as typeof fetch,
    });
    assert.equal(calls, 2);
    assert.deepEqual(result, ["a@b.com", "b@b.com"]);
  });

  it("1 página só (total_results cabe): não faz 2ª chamada", async () => {
    let calls = 0;
    const result = await fetchActiveBeehiivEmails(apiKey, publicationId, {
      fetchImpl: (async () => {
        calls++;
        return jsonResponse(200, { data: [{ email: "a@b.com", status: "active" }], total_results: 1, limit: 100, page: 1 });
      }) as typeof fetch,
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, ["a@b.com"]);
  });

  it("resposta não-2xx: lança erro com status e página", async () => {
    await assert.rejects(
      fetchActiveBeehiivEmails(apiKey, publicationId, {
        fetchImpl: (async () => new Response("erro interno", { status: 500 })) as typeof fetch,
      }),
      /Beehiiv API 500 em subscriptions \(página 1\)/,
    );
  });

  it("loop encerra antes de drenar total_results: lança guard de truncamento em vez de devolver lista incompleta", async () => {
    let calls = 0;
    await assert.rejects(
      fetchActiveBeehiivEmails(apiKey, publicationId, {
        fetchImpl: (async () => {
          calls++;
          // total_results diz 5, mas a página devolve vazio imediatamente —
          // hasMorePages encerra o loop achando que acabou, deixando
          // emails.length (0) < totalResults (5).
          return jsonResponse(200, { data: [], total_results: 5, limit: 100, page: calls });
        }) as typeof fetch,
      }),
      /subscriptions truncado: 0\/5/,
    );
  });
});
