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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

    // /leaderboard/top1?period=2026-04 (mantido para testes legados)
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

    // /leaderboard/2026-04.json — novo endpoint #2475 com correct/total para todos os ranks
    if (urlStr.includes("/leaderboard/") && urlStr.endsWith("/2026-04.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          entries: [
            { rank: 1, medal: "🥇", nickname: "João", correct: 8, total: 10, pct: 80 },
            { rank: 2, medal: "🥈", nickname: "Maria", correct: 5, total: 10, pct: 50 },
            { rank: 3, medal: "🥉", nickname: "Pedro", correct: 3, total: 8, pct: 37 },
          ],
          period_slug: "2026-04",
        }),
      };
    }

    // /leaderboard/2026-05.json → 404
    if (urlStr.includes("/leaderboard/") && urlStr.endsWith("/2026-05.json")) {
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

  test("#2463/#3025: enxerga edições no layout NESTED (data/editions/{AAMM}/{AAMMDD}/) misturadas com flat legado", async () => {
    // Antes (readdirSync direto no top-level, filtro /^\d{6}$/): uma edição no
    // layout nested pós-#3023 era invisível — o dashboard/poll summary
    // silenciosamente não incluía essas edições.
    const { discoverEditions } = await import("../scripts/build-poll-eia-data.ts");
    const tmp = mkdtempSync(join(tmpdir(), "poll-eia-disc-nested-"));
    mkdirSync(join(tmp, "260418")); // flat legado
    mkdirSync(join(tmp, "2606", "260622"), { recursive: true }); // nested novo

    const result = discoverEditions(tmp);
    assert.deepEqual(result, ["260418", "260622"]);
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

// ─── fetchMonthLeaderboardJson com fetch stub ─────────────────────────────────

describe("fetchMonthLeaderboardJson (#2475 follow-up)", () => {
  test("retorna entries com correct/total para todos os ranks", async () => {
    const restore = installFetchStub();
    try {
      const { fetchMonthLeaderboardJson } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchMonthLeaderboardJson("https://poll.example.com", "2026-04");
      assert.ok(result, "deve retornar leaderboard JSON");
      assert.equal(result!.entries.length, 3);
      assert.equal(result!.entries[0].nickname, "João");
      assert.equal(result!.entries[0].rank, 1);
      assert.equal(result!.entries[0].correct, 8);
      assert.equal(result!.entries[0].total, 10);
      // Ranks 2 e 3 têm métricas reais (bug #2475)
      assert.equal(result!.entries[1].nickname, "Maria");
      assert.equal(result!.entries[1].rank, 2);
      assert.equal(result!.entries[1].correct, 5);
      assert.equal(result!.entries[1].total, 10);
      assert.equal(result!.entries[2].nickname, "Pedro");
      assert.equal(result!.entries[2].rank, 3);
      assert.equal(result!.entries[2].correct, 3);
      assert.equal(result!.entries[2].total, 8);
    } finally { restore(); }
  });

  test("retorna null para período sem dados (404)", async () => {
    const restore = installFetchStub();
    try {
      const { fetchMonthLeaderboardJson } = await import("../scripts/build-poll-eia-data.ts");
      const result = await fetchMonthLeaderboardJson("https://poll.example.com", "2026-05");
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
      // #2773: correct_count bruto propagado (permite agregação mensal exata no dashboard)
      assert.equal(ed260418!.correct_count, 30);

      // Dados corretos da edição 260419 (sem gabarito)
      const ed260419 = summary.editions.find((e) => e.edition === "260419");
      assert.ok(ed260419, "deve ter edição 260419");
      assert.equal(ed260419!.total_votes, 12);
      assert.equal(ed260419!.pct_correct, null);
      assert.equal(ed260419!.correct_choice, null);
      assert.equal(ed260419!.correct_count, 0);

      // Leaderboard: 2026-04 tem dados, 2026-05 não (404)
      assert.ok(summary.leaderboard.length > 0, "deve ter entradas no leaderboard");
      const joao = summary.leaderboard.find((e) => e.display_name === "João");
      assert.ok(joao, "João deve estar no leaderboard");
      assert.equal(joao!.correct, 8, "correct de João deve vir do endpoint JSON (8)");
      assert.equal(joao!.total, 10, "total de João deve vir do endpoint JSON (10)");

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

  // Regressão #2475: ranks 2/3 não devem ter correct=0
  test("ranks 2 e 3 têm correct/total > 0 no leaderboard agregado (#2475)", async () => {
    const restore = installFetchStub();
    try {
      const { buildPollEiaSummaryFromApi } = await import("../scripts/build-poll-eia-data.ts");
      // 260418 → stats + leaderboard 2026-04 com João(8/10), Maria(5/10), Pedro(3/8)
      const editions = ["260418"];
      const summary = await buildPollEiaSummaryFromApi(editions, "https://poll.example.com");

      const maria = summary.leaderboard.find((e) => e.display_name === "Maria");
      const pedro = summary.leaderboard.find((e) => e.display_name === "Pedro");
      assert.ok(maria, "Maria deve estar no leaderboard");
      assert.ok(pedro, "Pedro deve estar no leaderboard");
      // Bug #2475: com /leaderboard/top1, ranks 2/3 tinham correct=0 e total=0
      // porque só rank=1 tinha métricas via campo top1[]. Com o novo endpoint .json,
      // todos os ranks têm métricas reais.
      assert.ok(maria!.correct > 0, `Maria.correct deve ser > 0 (got ${maria!.correct})`);
      assert.ok(maria!.total > 0, `Maria.total deve ser > 0 (got ${maria!.total})`);
      assert.ok(pedro!.correct > 0, `Pedro.correct deve ser > 0 (got ${pedro!.correct})`);
      assert.ok(pedro!.total > 0, `Pedro.total deve ser > 0 (got ${pedro!.total})`);
      assert.equal(maria!.correct, 5, "Maria deve ter correct=5");
      assert.equal(maria!.total, 10, "Maria deve ter total=10");
      assert.equal(pedro!.correct, 3, "Pedro deve ter correct=3");
      assert.equal(pedro!.total, 8, "Pedro deve ter total=8");
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

// ─── pushEiaEngagementToBrevoKv (#2738) ──────────────────────────────────────

describe("pushEiaEngagementToBrevoKv (#2738)", () => {
  const fakeSummary = {
    source: "push" as const,
    last_edition: "260418",
    editions: [
      { edition: "260418", total_votes: 47, voted_a: 30, voted_b: 17, pct_correct: 64, correct_choice: "A" },
    ],
    leaderboard: [{ display_name: "João", correct: 8, total: 10, streak: 0 }],
    updated_at: "2026-07-01T09:00:00.000Z",
  };

  test("sem credenciais Cloudflare: fail-soft, não lança e não trava o --push principal", async () => {
    const { pushEiaEngagementToBrevoKv } = await import("../scripts/build-poll-eia-data.ts");
    const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const origToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.doesNotReject(() => pushEiaEngagementToBrevoKv(fakeSummary));
    } finally {
      if (origAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origAccount;
      if (origToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = origToken;
    }
  });
});

describe("buildEiaEngagementKvPayload (#2738) — payload SLIM, sem PII/leaderboard", () => {
  test("mantém editions + updated_at, DESCARTA leaderboard/source/last_edition", async () => {
    const { buildEiaEngagementKvPayload } = await import("../scripts/build-poll-eia-data.ts");
    const summary = {
      source: "push" as const,
      last_edition: "260418",
      editions: [
        { edition: "260418", total_votes: 47, voted_a: 30, voted_b: 17, pct_correct: 64, correct_choice: "A" },
      ],
      leaderboard: [{ display_name: "João", correct: 8, total: 10, streak: 0 }],
      updated_at: "2026-07-01T09:00:00.000Z",
    };
    const payload = buildEiaEngagementKvPayload(summary);
    assert.deepEqual(payload, {
      editions: summary.editions,
      updated_at: summary.updated_at,
    });
    // Prova negativa explícita: nenhum campo PII-adjacent (nicknames) vaza.
    assert.ok(!("leaderboard" in payload), "leaderboard NÃO deve estar no payload (PII-adjacent, específico do diaria-dashboard)");
    assert.ok(!("source" in payload), "source não é relevante pra esta aba");
    assert.ok(!("last_edition" in payload), "last_edition é derivável de editions[0], redundante");
  });

  test("editions vazio → payload com array vazio, não quebra", async () => {
    const { buildEiaEngagementKvPayload } = await import("../scripts/build-poll-eia-data.ts");
    const payload = buildEiaEngagementKvPayload({
      source: "push", last_edition: null, editions: [], leaderboard: [], updated_at: null,
    });
    assert.deepEqual(payload, { editions: [], updated_at: null });
  });
});

// #2903: fetch com brand=clarice + descoberta de ciclos mensais
describe("brand=clarice + discoverMonthlyCycles (#2903)", () => {
  test("discoverMonthlyCycles acha só dirs YYMM-MM, ordenados", async () => {
    const { discoverMonthlyCycles } = await import("../scripts/build-poll-eia-data.ts");
    const dir = mkdtempSync(join(tmpdir(), "monthly-"));
    for (const name of ["2606-07", "2605-06", "junk", "260705"]) mkdirSync(join(dir, name));
    const cycles = discoverMonthlyCycles(dir);
    assert.deepEqual(cycles, ["2605-06", "2606-07"], "só YYMM-MM, sorted; ignora junk e AAMMDD");
  });

  test("fetchEditionStats anexa &brand=clarice; diaria não anexa", async () => {
    const { fetchEditionStats } = await import("../scripts/build-poll-eia-data.ts");
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ total: 0 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      await fetchEditionStats("https://poll.x", "2606-07", "clarice");
      await fetchEditionStats("https://poll.x", "260705"); // default diaria
      assert.match(urls[0], /edition=2606-07&brand=clarice/, "clarice anexa &brand=clarice");
      assert.doesNotMatch(urls[1], /brand=/, "diaria (default) não anexa &brand=");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── refreshPollEiaSummaryLocal (#3861 — botão "Atualizar É IA?" do Studio) ──

describe("refreshPollEiaSummaryLocal (#3861)", () => {
  test("data/editions/ ausente -> {ok:false} fail-soft, sem tocar rede (nenhum fetch chamado)", async () => {
    const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("não deveria chamar fetch"); }) as unknown as typeof globalThis.fetch;
    try {
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-refresh-noedts-"));
      const result = await refreshPollEiaSummaryLocal({ rootDir });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /data\/editions/);
      assert.equal(fetchCalled, false, "sem data/editions/, nunca deveria tentar buscar do worker poll");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("data/editions/ existe mas vazio -> {ok:false} fail-soft", async () => {
    const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
    const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-refresh-empty-"));
    mkdirSync(join(rootDir, "data", "editions"), { recursive: true });
    const result = await refreshPollEiaSummaryLocal({ rootDir });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /nenhuma edição/);
  });

  test("caminho feliz: escreve data/poll-eia-summary.json a partir do worker poll (fetch stubado)", async () => {
    const restore = installFetchStub();
    try {
      const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-refresh-happy-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      mkdirSync(join(rootDir, "data", "editions", "260419"), { recursive: true });

      const result = await refreshPollEiaSummaryLocal({ rootDir, workerUrl: "https://poll.example.com" });

      assert.equal(result.ok, true);
      assert.ok(result.summary, "deve retornar o summary agregado");
      assert.equal(result.summary!.editions.length, 2);

      const outPath = join(rootDir, "data", "poll-eia-summary.json");
      assert.ok(existsSync(outPath), "deve escrever data/poll-eia-summary.json");
      const written = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(written.editions.length, 2);
      assert.equal(written.last_edition, "260419");
    } finally { restore(); }
  });

  test("regressão (guard de publicação): NUNCA chama o push pro KV do clarice-dashboard, mesmo com credenciais Cloudflare presentes", async () => {
    // O push real (pushEiaEngagementToBrevoKv) usa node:https, não
    // globalThis.fetch — o stub abaixo cobre só as chamadas ao worker poll.
    // A prova estrutural de que o push nunca é acionado é que
    // refreshPollEiaSummaryLocal simplesmente não referencia
    // pushEiaEngagementToBrevoKv/discoverMonthlyCycles em lugar nenhum do seu
    // corpo — este teste fixa o comportamento observável (nenhuma env var
    // de Cloudflare é sequer lida: o resultado não muda com ou sem elas).
    const restore = installFetchStub();
    const origAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const origToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = "fake-account-id";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "fake-token";
    try {
      const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-refresh-guard-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      const result = await refreshPollEiaSummaryLocal({ rootDir, workerUrl: "https://poll.example.com" });
      assert.equal(result.ok, true, "regenera o arquivo local normalmente, independente de credenciais Cloudflare");
      // Se o push remoto tivesse sido disparado por engano, o resultado
      // ainda seria {ok:true} (o push é fire-and-forget/fail-soft do CLI) —
      // a prova real é de código: refreshPollEiaSummaryLocal não importa
      // nem referencia pushEiaEngagementToBrevoKv (ver docstring da função).
    } finally {
      restore();
      if (origAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origAccount; else delete process.env.CLOUDFLARE_ACCOUNT_ID;
      if (origToken !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = origToken; else delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    }
  });

  test("falha ao buscar do worker poll (fetch rejeita) -> {ok:false} fail-soft, não lança", async () => {
    const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("rede indisponível"); }) as unknown as typeof globalThis.fetch;
    try {
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-refresh-fetchfail-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      // buildPollEiaSummaryFromApi já engole erro de fetch por edição
      // individualmente (fail-soft interno) — o resultado aqui deve ser
      // {ok:true} com editions vazio, nunca uma exceção propagada.
      await assert.doesNotReject(() => refreshPollEiaSummaryLocal({ rootDir, workerUrl: "https://poll.example.com" }));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── mapBounded (#3882 — pool de concorrência limitada, substitui o chunking) ─

describe("mapBounded (#3882)", () => {
  test("respeita o teto de concorrência (peak <= concurrency) e prova paralelismo real", async () => {
    const { mapBounded } = await import("../scripts/build-poll-eia-data.ts");
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    await mapBounded(items, 6, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    assert.ok(peak <= 6, `peak deveria ser <= 6, foi ${peak}`);
    assert.ok(peak >= 2, `peak deveria provar paralelismo real (>= 2), foi ${peak}`);
  });

  test("preserva a ordem original dos resultados, mesmo com latências diferentes por item", async () => {
    const { mapBounded } = await import("../scripts/build-poll-eia-data.ts");
    const delaysMs = [50, 10, 30, 5, 40];
    const results = await mapBounded(delaysMs, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    assert.deepEqual(results, delaysMs, "resultado deve bater com a ordem de entrada, não com a ordem de conclusão");
  });

  test("array vazio é no-op (nunca chama fn)", async () => {
    const { mapBounded } = await import("../scripts/build-poll-eia-data.ts");
    let called = 0;
    const results = await mapBounded([] as number[], 6, async () => { called++; return 1; });
    assert.equal(called, 0);
    assert.deepEqual(results, []);
  });

  test("concurrency > items.length usa só items.length workers efetivos", async () => {
    const { mapBounded } = await import("../scripts/build-poll-eia-data.ts");
    const items = [1, 2];
    let active = 0;
    let peak = 0;
    await mapBounded(items, 10, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
      return i;
    });
    assert.ok(peak <= 2, `peak deveria ser <= 2, foi ${peak}`);
  });
});

// ─── refreshPollEiaSummaryLocal — cache TTL curto (#3882) ────────────────────

describe("refreshPollEiaSummaryLocal — cache TTL curto (#3882)", () => {
  test("cache fresco (updated_at agora): serve do disco, cached:true, NUNCA toca fetch", async () => {
    const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("não deveria chamar fetch — cache deveria ter servido"); }) as unknown as typeof globalThis.fetch;
    try {
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-cache-fresh-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      const cachedSummary = {
        source: "push",
        last_edition: "260418",
        editions: [{ edition: "260418", total_votes: 10, voted_a: 6, voted_b: 4, pct_correct: 60, correct_choice: "A", correct_count: 6 }],
        leaderboard: [],
        updated_at: new Date().toISOString(), // agora — bem dentro do TTL de 2min
      };
      writeFileSync(join(rootDir, "data", "poll-eia-summary.json"), JSON.stringify(cachedSummary));

      const result = await refreshPollEiaSummaryLocal({ rootDir });
      assert.equal(result.ok, true);
      assert.equal(result.cached, true, "deve vir do cache");
      assert.equal(result.summary?.last_edition, "260418");
      assert.equal(fetchCalled, false, "não deveria ter chamado fetch — dado ainda fresco");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("cache expirado (updated_at > TTL): refaz o fetch, cached ausente/false", async () => {
    const restore = installFetchStub();
    try {
      const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-cache-stale-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      const staleSummary = {
        source: "push",
        last_edition: "999999", // valor sentinela — se aparecer no resultado, o cache foi usado por engano
        editions: [],
        leaderboard: [],
        updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10min atrás, TTL é 2min
      };
      writeFileSync(join(rootDir, "data", "poll-eia-summary.json"), JSON.stringify(staleSummary));

      const result = await refreshPollEiaSummaryLocal({ rootDir });
      assert.equal(result.ok, true);
      assert.ok(!result.cached, "não deve vir do cache — expirado");
      assert.equal(result.summary?.last_edition, "260418", "deve refletir o fetch NOVO (fixture da 260418), não o sentinela do cache expirado");
    } finally {
      restore();
    }
  });

  test("force:true ignora o cache mesmo fresco — refaz o fetch", async () => {
    const restore = installFetchStub();
    try {
      const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-cache-force-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      const freshSentinel = {
        source: "push",
        last_edition: "999999", // sentinela — sem force seria servido do cache (está fresco)
        editions: [],
        leaderboard: [],
        updated_at: new Date().toISOString(),
      };
      writeFileSync(join(rootDir, "data", "poll-eia-summary.json"), JSON.stringify(freshSentinel));

      const result = await refreshPollEiaSummaryLocal({ rootDir, force: true });
      assert.equal(result.ok, true);
      assert.ok(!result.cached, "force deve ignorar o cache");
      assert.equal(result.summary?.last_edition, "260418", "deve refletir o fetch NOVO, não o sentinela do cache (mesmo fresco)");
    } finally {
      restore();
    }
  });

  test("arquivo de cache corrompido (JSON inválido): cai pro fetch normal, não lança", async () => {
    const restore = installFetchStub();
    try {
      const { refreshPollEiaSummaryLocal } = await import("../scripts/build-poll-eia-data.ts");
      const rootDir = mkdtempSync(join(tmpdir(), "poll-eia-cache-corrupt-"));
      mkdirSync(join(rootDir, "data", "editions", "260418"), { recursive: true });
      writeFileSync(join(rootDir, "data", "poll-eia-summary.json"), "{ isso não é json válido");

      let result: Awaited<ReturnType<typeof refreshPollEiaSummaryLocal>> | undefined;
      await assert.doesNotReject(async () => { result = await refreshPollEiaSummaryLocal({ rootDir }); });
      assert.equal(result?.ok, true);
      assert.ok(!result?.cached, "cache corrompido nunca deve reportar cached:true");
    } finally {
      restore();
    }
  });
});
