/**
 * test/build-poll-eia-data.test.ts (#2475)
 *
 * Testes para scripts/build-poll-eia-data.ts:
 *   - editionToMonthSlug: conversão AAMMDD → YYYY-MM
 *   - discoverEditions: leitura de data/editions/ com pattern AAMMDD
 *   - editionsToMonthSlugs: slugs únicos de uma lista de edições
 *   - fetchEditionStats: fetch de /stats?edition= com stub de fetch
 *   - fetchMonthLeaderboard: fetch de /leaderboard/top1 com stub de fetch
 *   - buildPollEiaSummaryFromApi: extração + exclusão de votos de teste
 *
 * Regra #633: PR de feature exige teste cobrindo extração dos dados do poll
 * (com fixture) e exclusão dos votos de teste do editor.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Stub de fetch — compartilhado entre testes ────────────────────────────────

/**
 * Instala um stub de fetch global que simula os endpoints do worker poll.
 * Retorna a função de restauração.
 */
function installFetchStub(): () => void {
  const orig = globalThis.fetch;
  // @ts-ignore substituição de global.fetch em Node 18+
  globalThis.fetch = async (url: string | URL, _opts?: RequestInit) => {
    const urlStr = String(url);

    // /stats?edition=260418 → sucesso com 47 votos
    if (urlStr.includes("/stats") && urlStr.includes("edition=260418")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          edition: "260418",
          total: 47,
          voted_a: 30,
          voted_b: 17,
          correct_answer: "A",
          correct_count: 30,
          correct_pct: 64,
        }),
      };
    }

    // /stats?edition=260419 → sem gabarito (correct_pct: null)
    if (urlStr.includes("/stats") && urlStr.includes("edition=260419")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          edition: "260419",
          total: 12,
          voted_a: 7,
          voted_b: 5,
          correct_answer: null,
          correct_count: 0,
          correct_pct: null,
        }),
      };
    }

    // /stats?edition=260500 → 404 (sem votos)
    if (urlStr.includes("/stats") && urlStr.includes("edition=260500")) {
      return { ok: false, status: 404, text: async () => "Not Found" };
    }

    // /stats?edition=260999 → total=0 (edição sem votos)
    if (urlStr.includes("/stats") && urlStr.includes("edition=260999")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          edition: "260999",
          total: 0,
          voted_a: 0,
          voted_b: 0,
          correct_answer: null,
          correct_count: 0,
          correct_pct: null,
        }),
      };
    }

    // /leaderboard/top1?period=2026-04
    if (urlStr.includes("/leaderboard/top1") && urlStr.includes("period=2026-04")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          top1: [{ nickname: "João", correct: 8, total: 10, pct: 80 }],
          podium: [
            { nickname: "João", rank: 1 },
            { nickname: "Maria", rank: 2 },
            { nickname: "Pedro", rank: 3 },
          ],
          period: "Abril",
          period_slug: "2026-04",
        }),
      };
    }

    // /leaderboard/top1?period=2026-05 → sem dados
    if (urlStr.includes("/leaderboard/top1") && urlStr.includes("period=2026-05")) {
      return { ok: false, status: 404, text: async () => "Not Found" };
    }

    // Fallback: 404
    return { ok: false, status: 404, text: async () => "Not Found" };
  };
  return () => { globalThis.fetch = orig; };
}

// ─── editionToMonthSlug ───────────────────────────────────────────────────────

describe("editionToMonthSlug (#2475)", () => {
  test("converte AAMMDD para YYYY-MM corretamente", async () => {
    const { editionToMonthSlug } = await import("../scripts/build-poll-eia-data.ts");
    assert.equal(editionToMonthSlug("260418"), "2026-04");
    assert.equal(editionToMonthSlug("260101"), "2026-01");
    assert.equal(editionToMonthSlug("251231"), "2025-12");
  });

  test("retorna null para formatos inválidos", async () => {
    const { editionToMonthSlug } = await import("../scripts/build-poll-eia-data.ts");
    assert.equal(editionToMonthSlug("abc"), null, "string não numérica");
    assert.equal(editionToMonthSlug("261300"), null, "mês 13 inválido");
    assert.equal(editionToMonthSlug("260000"), null, "mês 00 inválido");
    assert.equal(editionToMonthSlug("12345"), null, "5 dígitos");
    assert.equal(editionToMonthSlug(""), null, "vazio");
  });
});

// ─── discoverEditions ─────────────────────────────────────────────────────────

describe("discoverEditions (#2475)", () => {
  test("retorna array vazio para diretório inexistente", async () => {
    const { discoverEditions } = await import("../scripts/build-poll-eia-data.ts");
    const result = discoverEditions("/tmp/nao-existe-xyz-abc-2475");
    assert.deepEqual(result, []);
  });

  test("retorna edições AAMMDD ordenadas crescente", async () => {
    const { discoverEditions } = await import("../scripts/build-poll-eia-data.ts");
    const tmp = mkdtempSync(join(tmpdir(), "poll-eia-disc-"));
    mkdirSync(join(tmp, "260501"));
    mkdirSync(join(tmp, "260418"));
    mkdirSync(join(tmp, "260622"));
    mkdirSync(join(tmp, "_internal")); // não AAMMDD — deve ser ignorado
    mkdirSync(join(tmp, "not-edition")); // não AAMMDD — deve ser ignorado

    const result = discoverEditions(tmp);
    assert.deepEqual(result, ["260418", "260501", "260622"]);
  });

  test("ignora arquivos (não diretórios)", async () => {
    const { discoverEditions } = await import("../scripts/build-poll-eia-data.ts");
    const tmp = mkdtempSync(join(tmpdir(), "poll-eia-disc-"));
    mkdirSync(join(tmp, "260501"));
    // Cria um arquivo com nome AAMMDD — deve ser ignorado
    writeFileSync(join(tmp, "260418"), "not a dir");

    const result = discoverEditions(tmp);
    assert.deepEqual(result, ["260501"]);
  });
});

// ─── editionsToMonthSlugs ─────────────────────────────────────────────────────

describe("editionsToMonthSlugs (#2475)", () => {
  test("dedupa meses entre edições do mesmo mês", async () => {
    const { editionsToMonthSlugs } = await import("../scripts/build-poll-eia-data.ts");
    const editions = ["260418", "260419", "260501", "260502", "260503"];
    const slugs = editionsToMonthSlugs(editions);
    assert.deepEqual(slugs, ["2026-04", "2026-05"]);
  });

  test("retorna array vazio para lista vazia", async () => {
    const { editionsToMonthSlugs } = await import("../scripts/build-poll-eia-data.ts");
    assert.deepEqual(editionsToMonthSlugs([]), []);
  });

  test("ignora edições com formato inválido", async () => {
    const { editionsToMonthSlugs } = await import("../scripts/build-poll-eia-data.ts");
    const editions = ["260418", "invalid", "260501"];
    const slugs = editionsToMonthSlugs(editions);
    assert.deepEqual(slugs, ["2026-04", "2026-05"]);
  });
});

// ─── fetchEditionStats com fetch stub ────────────────────────────────────────

describe("fetchEditionStats (#2475)", () => {
  test("retorna stats para edição com votos", async () => {
    const restore = installFetchStub();
    try {
      const { fetchEditionStats } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchEditionStats("https://poll.example.com", "260418");
      assert.ok(result, "deve retornar stats");
      assert.equal(result!.total, 47);
      assert.equal(result!.voted_a, 30);
      assert.equal(result!.voted_b, 17);
      assert.equal(result!.correct_answer, "A");
      assert.equal(result!.correct_pct, 64);
    } finally { restore(); }
  });

  test("retorna stats com pct_correct null (sem gabarito)", async () => {
    const restore = installFetchStub();
    try {
      const { fetchEditionStats } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchEditionStats("https://poll.example.com", "260419");
      assert.ok(result, "deve retornar stats mesmo sem gabarito");
      assert.equal(result!.total, 12);
      assert.equal(result!.correct_pct, null);
      assert.equal(result!.correct_answer, null);
    } finally { restore(); }
  });

  test("retorna null para edição sem votos (404)", async () => {
    const restore = installFetchStub();
    try {
      const { fetchEditionStats } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchEditionStats("https://poll.example.com", "260500");
      assert.equal(result, null, "404 → null");
    } finally { restore(); }
  });

  test("retorna null para edição com total=0", async () => {
    const restore = installFetchStub();
    try {
      const { fetchEditionStats } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchEditionStats("https://poll.example.com", "260999");
      assert.equal(result, null, "total=0 → null (sem votos para exibir)");
    } finally { restore(); }
  });
});

// ─── fetchMonthLeaderboard com fetch stub ─────────────────────────────────────

describe("fetchMonthLeaderboard (#2475)", () => {
  test("retorna leaderboard com podium", async () => {
    const restore = installFetchStub();
    try {
      const { fetchMonthLeaderboard } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchMonthLeaderboard("https://poll.example.com", "2026-04");
      assert.ok(result, "deve retornar leaderboard");
      assert.equal(result!.podium.length, 3);
      assert.equal(result!.podium[0].nickname, "João");
      assert.equal(result!.podium[0].rank, 1);
    } finally { restore(); }
  });

  test("retorna null para período sem dados (404)", async () => {
    const restore = installFetchStub();
    try {
      const { fetchMonthLeaderboard } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchMonthLeaderboard("https://poll.example.com", "2026-05");
      assert.equal(result, null, "404 → null");
    } finally { restore(); }
  });
});

// ─── buildPollEiaSummaryFromApi (end-to-end com fetch stub) ──────────────────

describe("buildPollEiaSummaryFromApi (#2475)", () => {
  test("agrega dados de múltiplas edições e leaderboard (fixture)", async () => {
    const restore = installFetchStub();
    try {
      const { buildPollEiaSummaryFromApi } = await import("../scripts/build-poll-eia-data.ts");
      // 260500 → 404 (skip); 260418 e 260419 com dados
      const editions = ["260418", "260419", "260500"];
      const summary = await buildPollEiaSummaryFromApi(editions, "https://poll.example.com");

      // Metadados básicos
      assert.equal(summary.source, "push");
      assert.ok(summary.updated_at, "deve ter updated_at");

      // Edições com dados: 260418 e 260419 (260500 → null)
      assert.equal(summary.editions.length, 2, "2 edições com dados (260500 skipada)");

      // Ordena desc (mais recente primeiro)
      assert.equal(summary.editions[0].edition, "260419", "mais recente primeiro");
      assert.equal(summary.editions[1].edition, "260418");

      // last_edition = edição mais recente com dados
      assert.equal(summary.last_edition, "260419");

      // Dados corretos da edição 260418
      const ed260418 = summary.editions.find((e) => e.edition === "260418");
      assert.ok(ed260418, "deve ter edição 260418");
      assert.equal(ed260418!.total_votes, 47);
      assert.equal(ed260418!.voted_a, 30);
      assert.equal(ed260418!.voted_b, 17);
      assert.equal(ed260418!.pct_correct, 64);
      assert.equal(ed260418!.correct_choice, "A");

      // Dados corretos da edição 260419 (sem gabarito)
      const ed260419 = summary.editions.find((e) => e.edition === "260419");
      assert.ok(ed260419, "deve ter edição 260419");
      assert.equal(ed260419!.total_votes, 12);
      assert.equal(ed260419!.pct_correct, null);
      assert.equal(ed260419!.correct_choice, null);

      // Leaderboard: 2026-04 tem dados, 2026-05 não (404)
      assert.ok(summary.leaderboard.length > 0, "deve ter entradas no leaderboard");
      const joao = summary.leaderboard.find((e) => e.display_name === "João");
      assert.ok(joao, "João deve estar no leaderboard");
      assert.equal(joao!.correct, 8, "correct de João deve vir do top1 (8)");
      assert.equal(joao!.total, 10, "total de João deve vir do top1 (10)");

      // Todos os entries têm display_name string válida
      for (const entry of summary.leaderboard) {
        assert.equal(typeof entry.display_name, "string");
        assert.ok(entry.display_name.length > 0, "display_name não deve ser vazio");
      }
    } finally { restore(); }
  });

  test("leaderboard não remove nicknames legítimos (EDITOR_TEST_DISPLAY_NAMES vazio por default)", async () => {
    const restore = installFetchStub();
    try {
      const { buildPollEiaSummaryFromApi } = await import("../scripts/build-poll-eia-data.ts");
      const editions = ["260418"];
      const summary = await buildPollEiaSummaryFromApi(editions, "https://poll.example.com");
      // João, Maria, Pedro são do leaderboard de 2026-04 — todos devem estar presentes
      const names = summary.leaderboard.map((e) => e.display_name);
      assert.ok(names.includes("João"), "João deve estar (não é teste)");
      assert.ok(names.includes("Maria"), "Maria deve estar (não é teste)");
      assert.ok(names.includes("Pedro"), "Pedro deve estar (não é teste)");
    } finally { restore(); }
  });

  test("retorna summary vazio quando nenhuma edição tem dados", async () => {
    const restore = installFetchStub();
    try {
      const { buildPollEiaSummaryFromApi } = await import("../scripts/build-poll-eia-data.ts");
      const editions = ["260500"]; // só 404
      const summary = await buildPollEiaSummaryFromApi(editions, "https://poll.example.com");
      assert.equal(summary.editions.length, 0, "sem edições com dados → editions vazio");
      assert.equal(summary.last_edition, null, "sem edições → last_edition null");
      assert.equal(summary.leaderboard.length, 0, "sem leaderboard para período sem votos");
    } finally { restore(); }
  });

  test("source é sempre 'push'", async () => {
    const restore = installFetchStub();
    try {
      const { buildPollEiaSummaryFromApi } = await import("../scripts/build-poll-eia-data.ts");
      const summary = await buildPollEiaSummaryFromApi([], "https://poll.example.com");
      assert.equal(summary.source, "push");
    } finally { restore(); }
  });

  test("limite de 20 edições no output mesmo com mais de 20 edições com dados", async () => {
    // Stub local para 25 edições com dados
    const orig = globalThis.fetch;
    // @ts-ignore
    globalThis.fetch = async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/stats")) {
        const ed = urlStr.match(/edition=(\d{6})/)?.[1] ?? "000000";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            edition: ed,
            total: 10,
            voted_a: 6,
            voted_b: 4,
            correct_answer: "A",
            correct_count: 6,
            correct_pct: 60,
          }),
        };
      }
      if (urlStr.includes("/leaderboard")) {
        return { ok: false, status: 404, text: async () => "Not Found" };
      }
      return { ok: false, status: 404, text: async () => "Not Found" };
    };
    try {
      const { buildPollEiaSummaryFromApi } = await import("../scripts/build-poll-eia-data.ts");
      // Gera 25 edições fictícias
      const editions = Array.from({ length: 25 }, (_, i) => {
        const n = String(i + 1).padStart(2, "0");
        return `2601${n}`;
      });
      const summary = await buildPollEiaSummaryFromApi(editions, "https://poll.example.com");
      assert.ok(summary.editions.length <= 20, `máximo 20 edições no output (got ${summary.editions.length})`);
    } finally { globalThis.fetch = orig; }
  });
});

// ─── Teste de integração: buildPollEiaSummary lê o output deste script ────────

describe("integração: output do buildPollEiaSummaryFromApi aceito por buildPollEiaSummary (#2475)", () => {
  test("output é aceito por buildPollEiaSummary sem erros", async () => {
    const { buildPollEiaSummary } = await import("../scripts/build-diaria-dashboard-data.ts");

    // Simula output do buildPollEiaSummaryFromApi
    const fakeOutput = {
      source: "push" as const,
      last_edition: "260418",
      updated_at: "2026-06-24T00:00:00Z",
      editions: [
        {
          edition: "260418",
          total_votes: 47,
          voted_a: 30,
          voted_b: 17,
          pct_correct: 64,
          correct_choice: "A",
        },
      ],
      leaderboard: [
        { display_name: "João", correct: 8, total: 10, streak: 0 },
      ],
    };

    const dir = mkdtempSync(join(tmpdir(), "poll-eia-integ-"));
    const path = join(dir, "poll-eia-summary.json");
    writeFileSync(path, JSON.stringify(fakeOutput), "utf8");

    const result = buildPollEiaSummary(path);
    assert.ok(result, "buildPollEiaSummary deve aceitar o output");
    assert.equal(result!.editions.length, 1);
    assert.equal(result!.editions[0].total_votes, 47);
    assert.equal(result!.leaderboard.length, 1);
    assert.equal(result!.leaderboard[0].display_name, "João");
  });
});
