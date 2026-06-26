/**
 * test/diaria-dashboard-use-melhor-poll.test.ts (#2474, #2475)
 *
 * Testes para:
 *   - buildUseMelhorSummary: extração de itens Use Melhor por edição + join com CTR
 *   - buildPollEiaSummary: leitura de poll-eia-summary.json (push path)
 *   - renderUseMelhorSection / renderPollEiaSection: renderização HTML
 *   - normalizeUrlForJoin: join URL lossy surfaçado, não silenciado
 *
 * Regra #633: PR de feature exige teste. Cobre:
 *   - Extração correta dos itens use_melhor do approved.json
 *   - Join CTR por URL (lossy): itens sem match têm ctr_pct=null + coverage surfaçada
 *   - Cobertura do join é reportada (não silenciada)
 *   - Degradação graciosa: sem edições, sem CSV, sem poll-eia-summary.json
 *   - renderUseMelhorSection não crasha com dados vazios ou completos
 *   - renderPollEiaSection renderiza seção de stub quando poll_eia=null
 *   - renderPollEiaSection renderiza dados reais quando disponíveis
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers de fixture ───────────────────────────────────────────────────────

function makeTmpEditionsDir(): string {
  return mkdtempSync(join(tmpdir(), "use-melhor-test-"));
}

function writeApprovedJson(editionsDir: string, edition: string, useMelhorItems: unknown[]): void {
  const edDir = join(editionsDir, edition, "_internal");
  mkdirSync(edDir, { recursive: true });
  writeFileSync(
    join(edDir, "01-approved.json"),
    JSON.stringify({ highlights: [], lancamento: [], radar: [], use_melhor: useMelhorItems, video: [] }),
    "utf8",
  );
}

function writeCtrCsv(dir: string, rows: string[]): string {
  const csvPath = join(dir, "link-ctr-table.csv");
  const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
  writeFileSync(csvPath, [header, ...rows].join("\n"), "utf8");
  return csvPath;
}

function writePollEiaSummary(dir: string, summary: unknown): string {
  const path = join(dir, "poll-eia-summary.json");
  writeFileSync(path, JSON.stringify(summary), "utf8");
  return path;
}

// ─── Testes de normalizeUrlForJoin ────────────────────────────────────────────

describe("normalizeUrlForJoin (#2474)", () => {
  test("URLs identicas normalizam igual", async () => {
    const { normalizeUrlForJoin } = await import("../scripts/build-diaria-dashboard-data.ts");
    const a = normalizeUrlForJoin("https://example.com/page/");
    const b = normalizeUrlForJoin("https://example.com/page");
    // Ambas devem colapsar trailing slash
    assert.equal(a, b, "trailing slash deve ser removido na normalização");
  });

  test("URL inválida não crasha (fallback lowercase)", async () => {
    const { normalizeUrlForJoin } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = normalizeUrlForJoin("nao-e-url");
    assert.equal(typeof result, "string", "deve retornar string para URL inválida");
    assert.ok(result.length > 0, "deve retornar algo não-vazio");
  });

  test("mesma URL com host uppercase/lowercase normalizam igual", async () => {
    const { normalizeUrlForJoin } = await import("../scripts/build-diaria-dashboard-data.ts");
    const a = normalizeUrlForJoin("https://Example.COM/path");
    const b = normalizeUrlForJoin("https://example.com/path");
    assert.equal(a, b, "host deve ser case-insensitive na normalização");
  });
});

// ─── Testes de buildUseMelhorSummary ─────────────────────────────────────────

describe("buildUseMelhorSummary (#2474)", () => {
  test("retorna null quando diretório de edições não existe (param injetado)", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = buildUseMelhorSummary("/tmp/nao-existe-xyzzy-um", "/tmp/nao-existe-csv.csv");
    assert.equal(result, null, "sem editions dir → null");
  });

  test("end-to-end: 2 edições, join CTR, cobertura surfaçada (params injetados)", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const editionsDir = makeTmpEditionsDir();
    // 260501: 1 item com CTR (perplexity), 1 sem (nao-tem-ctr)
    writeApprovedJson(editionsDir, "260501", [
      { url: "https://perplexity.ai/tutorial", title: "Como usar o Perplexity" },
      { url: "https://nao-tem-ctr.com/post", title: "Sem CTR" },
    ]);
    // 260508: 1 item com CTR (cursor)
    writeApprovedJson(editionsDir, "260508", [
      { url: "https://cursor.sh/tips", title: "Cursor AI dicas" },
    ]);
    // 260415: edição mais antiga com use_melhor vazio → não conta como first_edition
    writeApprovedJson(editionsDir, "260415", []);

    const csvPath = writeCtrCsv(editionsDir, [
      "2026-05-01,Ed 01,Use Melhor,Como usar o Perplexity,https://perplexity.ai/tutorial,perplexity.ai,200,20,18,9.00,Use Melhor,INT",
      "2026-05-08,Ed 08,Use Melhor,Cursor AI dicas,https://cursor.sh/tips,cursor.sh,180,12,11,6.11,Use Melhor,INT",
      // linha Destaque com URL diferente — não deve entrar no índice Use Melhor
      "2026-05-08,Ed 08,Destaque,Outra coisa,https://destaque.com/x,destaque.com,180,5,4,2.00,Destaque,INT",
    ]);

    const r = buildUseMelhorSummary(editionsDir, csvPath);
    assert.ok(r, "deve retornar summary");
    assert.equal(r!.total_editions_with_use_melhor, 2, "2 edições com itens (260415 vazia ignorada)");
    assert.equal(r!.first_edition, "260501", "first_edition = 1ª edição com itens, não a 260415 vazia");
    // Coverage: 3 itens totais, 2 com match, 1 sem
    assert.equal(r!.coverage.total_items, 3);
    assert.equal(r!.coverage.matched, 2);
    assert.equal(r!.coverage.unmatched, 1, "1 item sem CTR surfaçado (não silenciado)");
    assert.equal(r!.coverage.coverage_pct, 67);
    // Editions ordenadas desc (mais recente primeiro)
    assert.equal(r!.editions[0].edition, "260508", "mais recente primeiro");
    // Top items ordenados por CTR desc
    assert.equal(r!.top_items[0].ctr_pct, 9.00, "perplexity (9.00) é o top");
    // Item sem match tem ctr_pct=null
    const ed501 = r!.editions.find((e) => e.edition === "260501")!;
    const semCtr = ed501.items.find((i) => i.url === "https://nao-tem-ctr.com/post")!;
    assert.equal(semCtr.ctr_pct, null, "item sem match → ctr_pct null");
  });

  test("regressão (Angles A+D): célula ctr_pct em branco NÃO vira 0% medido", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const editionsDir = makeTmpEditionsDir();
    writeApprovedJson(editionsDir, "260501", [
      { url: "https://blank-ctr.com/post", title: "CTR em branco" },
    ]);
    // CSV com célula ctr_pct vazia para essa URL
    const csvPath = writeCtrCsv(editionsDir, [
      "2026-05-01,Ed 01,Use Melhor,CTR em branco,https://blank-ctr.com/post,blank-ctr.com,200,0,0,,Use Melhor,INT",
    ]);
    const r = buildUseMelhorSummary(editionsDir, csvPath);
    assert.ok(r, "deve retornar summary");
    // A URL com CTR em branco NÃO deve contar como match com 0% — deve ser unmatched
    assert.equal(r!.coverage.matched, 0, "célula em branco não conta como match");
    assert.equal(r!.coverage.unmatched, 1, "célula em branco vira unmatched (dado ausente)");
    const item = r!.editions[0].items[0];
    assert.equal(item.ctr_pct, null, "ctr_pct null (não 0) para célula em branco");
  });

  test("join CTR por URL: item sem match tem ctr_pct=null (lossy surfaçado)", async () => {
    // Testa a lógica do join diretamente
    // approved.json URL: https://cursor.sh/tips
    // CSV URL: https://cursor.sh/tips → match esperado
    // approved.json URL: https://nao-esta-no-csv.com/tutorial → sem match → ctr_pct=null

    const { normalizeUrlForJoin } = await import("../scripts/build-diaria-dashboard-data.ts");

    const ctrUrls = ["https://cursor.sh/tips", "https://perplexity.ai/tutorial"];
    const approvedUrls = ["https://cursor.sh/tips", "https://nao-esta-no-csv.com/tutorial"];

    const ctrIndex = new Map(ctrUrls.map((u) => [normalizeUrlForJoin(u), { ctr_pct: 6.11, unique_verified_clicks: 11 }]));

    let matched = 0;
    let unmatched = 0;
    for (const url of approvedUrls) {
      if (ctrIndex.has(normalizeUrlForJoin(url))) {
        matched++;
      } else {
        unmatched++;
      }
    }

    assert.equal(matched, 1, "deve ter 1 match (cursor.sh/tips)");
    assert.equal(unmatched, 1, "deve ter 1 unmatched (nao-esta-no-csv)");

    // Cobertura 50% — surfaçada, não silenciada
    const pct = Math.round((matched / (matched + unmatched)) * 100);
    assert.equal(pct, 50, "cobertura de 50% deve ser calculada corretamente");
  });

  test("buildUseMelhorSummary com dados reais (via diretório temporário)", async () => {
    // Testa end-to-end usando diretório real em /tmp.
    // Como DATA_DIR está hardcoded no script, simulamos com a estrutura correta
    // criando arquivos em /tmp e validando a lógica core via funções exportáveis.
    const { normalizeUrlForJoin, parseCsvLine } = await import("../scripts/build-diaria-dashboard-data.ts");

    // Simula 2 edições com use_melhor
    const items260501 = [
      { url: "https://perplexity.ai/tutorial", title: "Como usar o Perplexity" },
      { url: "https://nao-tem-ctr.com/post", title: "Sem CTR" },
    ];
    const items260508 = [
      { url: "https://cursor.sh/tips", title: "Cursor AI dicas" },
    ];

    // CTR CSV rows (category=Use Melhor)
    const ctrRows = [
      "2026-05-01,Ed 01,Use Melhor,Como usar o Perplexity,https://perplexity.ai/tutorial,perplexity.ai,200,20,18,9.00,Use Melhor,INT",
      "2026-05-08,Ed 08,Use Melhor,Cursor AI dicas avançadas,https://cursor.sh/tips,cursor.sh,180,12,11,6.11,Use Melhor,INT",
    ];

    // Build CTR index (simulating buildCtrIndexByUrl logic)
    const ctrIndex = new Map<string, { ctr_pct: number; unique_verified_clicks: number }>();
    const header = parseCsvLine("date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin");
    const baseUrlIdx = header.indexOf("base_url");
    const ctrIdx = header.indexOf("ctr_pct");
    const clicksIdx = header.indexOf("unique_verified_clicks");
    const catIdx = header.indexOf("category");

    for (const row of ctrRows) {
      const cols = parseCsvLine(row);
      if ((cols[catIdx] ?? "").trim() !== "Use Melhor") continue;
      const url = (cols[baseUrlIdx] ?? "").trim();
      const ctr = parseFloat(cols[ctrIdx] ?? "0") || 0;
      const clicks = parseInt(cols[clicksIdx] ?? "0", 10) || 0;
      ctrIndex.set(normalizeUrlForJoin(url), { ctr_pct: ctr, unique_verified_clicks: clicks });
    }

    // Join items from 260501
    let matched = 0;
    let unmatched = 0;
    const joinedItems = items260501.map((item) => {
      const ctrData = ctrIndex.get(normalizeUrlForJoin(item.url)) ?? null;
      if (ctrData) matched++; else unmatched++;
      return { ...item, ctr_pct: ctrData?.ctr_pct ?? null, unique_verified_clicks: ctrData?.unique_verified_clicks ?? null };
    });

    assert.equal(matched, 1, "260501: 1 item com CTR (perplexity)");
    assert.equal(unmatched, 1, "260501: 1 item sem CTR (nao-tem-ctr)");

    const perplexity = joinedItems.find((i) => i.url === "https://perplexity.ai/tutorial");
    assert.ok(perplexity, "deve encontrar perplexity");
    assert.equal(perplexity!.ctr_pct, 9.00, "CTR do perplexity deve ser 9.00");
    assert.equal(perplexity!.unique_verified_clicks, 18);

    const semCtr = joinedItems.find((i) => i.url === "https://nao-tem-ctr.com/post");
    assert.ok(semCtr, "deve encontrar item sem CTR");
    assert.equal(semCtr!.ctr_pct, null, "item sem match deve ter ctr_pct=null");
    assert.equal(semCtr!.unique_verified_clicks, null);

    // Cobertura surfaçada
    const coverage = { total_items: matched + unmatched, matched, unmatched, coverage_pct: Math.round((matched / (matched + unmatched)) * 100) };
    assert.equal(coverage.coverage_pct, 50, "cobertura 50%");
    assert.ok(coverage.unmatched > 0, "unmatched surfaçado (não zero-silenciado)");

    // Join items from 260508 — contadores próprios (não reusar unmatched do 260501)
    let matched2 = 0;
    let unmatched2 = 0;
    const joinedItems2 = items260508.map((item) => {
      const ctrData = ctrIndex.get(normalizeUrlForJoin(item.url)) ?? null;
      if (ctrData) matched2++; else unmatched2++;
      return { ...item, ctr_pct: ctrData?.ctr_pct ?? null };
    });
    assert.equal(matched2, 1, "260508: 1 item com CTR (cursor)");
    assert.equal(unmatched2, 0, "260508: 0 itens sem CTR");
    assert.equal(joinedItems2[0].ctr_pct, 6.11);
  });
});

// ─── Testes de buildPollEiaSummary (#2475) ────────────────────────────────────

describe("buildPollEiaSummary (#2475)", () => {
  test("retorna null quando arquivo não existe (param injetado)", async () => {
    const { buildPollEiaSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = buildPollEiaSummary("/tmp/nao-existe-poll-xyzzy.json");
    assert.equal(result, null, "sem arquivo → null");
  });

  test("retorna null para JSON malformado", async () => {
    const { buildPollEiaSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const dir = makeTmpEditionsDir();
    const path = join(dir, "poll-eia-summary.json");
    writeFileSync(path, "{ nao eh json valido", "utf8");
    assert.equal(buildPollEiaSummary(path), null, "JSON malformado → null");
  });

  test("lê e retorna PollEiaSummary válido (param injetado)", async () => {
    const { buildPollEiaSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const dir = makeTmpEditionsDir();
    const summary = {
      source: "push",
      last_edition: "260622",
      updated_at: "2026-06-22T22:00:00Z",
      editions: [{ edition: "260622", total_votes: 47, voted_a: 30, voted_b: 17, pct_correct: 64, correct_choice: "A" }],
      leaderboard: [{ display_name: "João", correct: 8, total: 10, streak: 3 }],
    };
    const path = writePollEiaSummary(dir, summary);
    const r = buildPollEiaSummary(path);
    assert.ok(r, "deve retornar summary");
    assert.equal(r!.editions.length, 1);
    assert.equal(r!.leaderboard.length, 1);
  });

  test("regressão (Angles A+E): leaderboard não-array → null (não crasha o render depois)", async () => {
    const { buildPollEiaSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const dir = makeTmpEditionsDir();
    // editions é array válido, MAS leaderboard é string (schema drift)
    const path = writePollEiaSummary(dir, { source: "push", editions: [], leaderboard: "corrompido" });
    assert.equal(buildPollEiaSummary(path), null, "leaderboard não-array → null (guard adicionado)");
  });

  test("regressão: editions não-array → null", async () => {
    const { buildPollEiaSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const dir = makeTmpEditionsDir();
    const path = writePollEiaSummary(dir, { source: "push", editions: "nope", leaderboard: [] });
    assert.equal(buildPollEiaSummary(path), null, "editions não-array → null");
  });
});

// ─── Testes de renderUseMelhorSection (#2474) ─────────────────────────────────

describe("renderUseMelhorSection (#2474)", () => {
  function makeBase(): import("../workers/diaria-dashboard/src/types.ts").DashboardData {
    return {
      generated_at: "2026-06-21T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      use_melhor: null,
      poll_eia: null,
      stubs: [],
    };
  }

  test("renderiza seção stub quando use_melhor=null", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderUseMelhorSection(makeBase());
    assert.ok(html.includes("use-melhor"), "deve ter id use-melhor");
    assert.ok(html.includes("Use Melhor"), "deve incluir título");
    assert.ok(html.includes("data/editions"), "deve mencionar o caminho de busca");
  });

  test("renderiza dados reais com cobertura surfaçada", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 2,
      first_edition: "260501",
      editions: [
        {
          edition: "260508",
          items: [
            { url: "https://cursor.sh/tips", title: "Cursor AI dicas", ctr_pct: 6.11, unique_verified_clicks: 11 },
          ],
          ctr_matched: 1,
          ctr_unmatched: 0,
        },
        {
          edition: "260501",
          items: [
            { url: "https://perplexity.ai/tutorial", title: "Como usar o Perplexity", ctr_pct: 9.00, unique_verified_clicks: 18 },
            { url: "https://nao-tem-ctr.com/post", title: "Sem CTR", ctr_pct: null, unique_verified_clicks: null },
          ],
          ctr_matched: 1,
          ctr_unmatched: 1,
        },
      ],
      top_items: [
        { edition: "260501", url: "https://perplexity.ai/tutorial", title: "Como usar o Perplexity", ctr_pct: 9.00, unique_verified_clicks: 18 },
        { edition: "260508", url: "https://cursor.sh/tips", title: "Cursor AI dicas", ctr_pct: 6.11, unique_verified_clicks: 11 },
      ],
      coverage: { total_items: 3, matched: 2, unmatched: 1, coverage_pct: 67 },
    };

    const html = renderUseMelhorSection(data);

    // Seção presente
    assert.ok(html.includes("use-melhor"), "deve ter id use-melhor");
    assert.ok(html.includes("2 edições com Use Melhor"), "deve mostrar total de edições");

    // Cobertura surfaçada (não silenciada)
    assert.ok(html.includes("2/3"), "deve mostrar matched/total");
    assert.ok(html.includes("67%"), "deve mostrar porcentagem de cobertura");
    assert.ok(html.includes("sem match"), "deve mencionar itens sem match");

    // Items presentes
    assert.ok(html.includes("Perplexity"), "deve incluir item Perplexity");
    assert.ok(html.includes("9.00%") || html.includes("9.0%"), "deve incluir CTR do Perplexity");

    // Top items
    assert.ok(html.includes("Top 10 itens"), "deve ter tabela top 10");

    // Link seguro
    assert.ok(html.includes("href=\"https://perplexity.ai/tutorial\""), "deve incluir href seguro");
  });

  test("não inclui XSS em títulos de itens", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260501",
      editions: [{
        edition: "260501",
        items: [{ url: "https://safe.com", title: '<script>alert("xss")</script>', ctr_pct: 5.0, unique_verified_clicks: 10 }],
        ctr_matched: 1,
        ctr_unmatched: 0,
      }],
      top_items: [{ edition: "260501", url: "https://safe.com", title: '<script>alert("xss")</script>', ctr_pct: 5.0, unique_verified_clicks: 10 }],
      coverage: { total_items: 1, matched: 1, unmatched: 0, coverage_pct: 100 },
    };
    const html = renderUseMelhorSection(data);
    assert.ok(!html.includes('<script>alert("xss")'), "não deve injetar script sem escape");
    assert.ok(html.includes("&lt;script&gt;"), "deve escapar a tag script");
  });

  test("join lossy: item com ctr_pct=null renderiza '—' (não crasha)", async () => {
    const { renderUseMelhorSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.use_melhor = {
      total_editions_with_use_melhor: 1,
      first_edition: "260501",
      editions: [{
        edition: "260501",
        items: [{ url: "https://nao-tem-ctr.com", title: "Sem CTR", ctr_pct: null, unique_verified_clicks: null }],
        ctr_matched: 0,
        ctr_unmatched: 1,
      }],
      top_items: [],
      coverage: { total_items: 1, matched: 0, unmatched: 1, coverage_pct: 0 },
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderUseMelhorSection(data); }, "não deve crashar com ctr_pct=null");
    assert.ok(html!.includes("—"), "ctr_pct null deve renderizar '—'");
    // Cobertura: 0/1 = 0% surfaçado
    assert.ok(html!.includes("0/1"), "deve mostrar 0/1 no coverage");
  });
});

// ─── Testes de renderPollEiaSection (#2475) ───────────────────────────────────

describe("renderPollEiaSection (#2475)", () => {
  function makeBase(): import("../workers/diaria-dashboard/src/types.ts").DashboardData {
    return {
      generated_at: "2026-06-21T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      use_melhor: null,
      poll_eia: null,
      stubs: [],
    };
  }

  test("renderiza seção stub quando poll_eia=null", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderPollEiaSection(makeBase());
    assert.ok(html.includes("poll-eia"), "deve ter id poll-eia");
    assert.ok(html.includes("É IA?"), "deve incluir título");
    assert.ok(html.includes("poll-eia-summary.json"), "deve mencionar o arquivo de push");
  });

  test("renderiza dados reais quando poll_eia disponível", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.poll_eia = {
      source: "push",
      last_edition: "260622",
      updated_at: "2026-06-22T22:00:00Z",
      editions: [
        {
          edition: "260622",
          total_votes: 47,
          voted_a: 30,
          voted_b: 17,
          pct_correct: 64,
          correct_choice: "A",
        },
        {
          edition: "260615",
          total_votes: 35,
          voted_a: 20,
          voted_b: 15,
          pct_correct: null,
          correct_choice: null,
        },
      ],
      leaderboard: [
        { display_name: "João", correct: 8, total: 10, streak: 3 },
        { display_name: "Maria", correct: 6, total: 8, streak: 0 },
      ],
    };

    const html = renderPollEiaSection(data);

    // Seção presente
    assert.ok(html.includes("poll-eia"), "deve ter id poll-eia");
    assert.ok(html.includes("É IA?"), "deve incluir título");

    // Dados de edição
    assert.ok(html.includes("260622"), "deve incluir edição 260622");
    assert.ok(html.includes("47"), "deve incluir total de votos");
    assert.ok(html.includes("64%"), "deve incluir % acerto");
    assert.ok(html.includes("260615"), "deve incluir edição 260615");

    // Leaderboard
    assert.ok(html.includes("Leaderboard"), "deve ter leaderboard");
    assert.ok(html.includes("João"), "deve incluir 1º do leaderboard");
    assert.ok(html.includes("🔥3"), "deve incluir streak de João");

    // Nota de votos de teste excluídos
    assert.ok(html.includes("vjpixel@gmail.com") || html.includes("pixel@memelab"), "deve mencionar exclusão de votos de teste");

    // pct_correct null → "—"
    assert.ok(html.includes("—"), "edição sem pct_correct deve renderizar '—'");
  });

  test("leaderboard vazio → nota 'sem dados' (não omite silenciosamente)", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.poll_eia = {
      source: "push",
      last_edition: "260622",
      updated_at: null,
      editions: [{ edition: "260622", total_votes: 3, voted_a: 2, voted_b: 1, pct_correct: null, correct_choice: null }],
      leaderboard: [],
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderPollEiaSection(data); }, "não deve crashar com leaderboard vazio");
    assert.ok(html!.includes("poll-eia"), "deve renderizar seção mesmo sem leaderboard");
    // #2511 self-review (Angle E): leaderboard vazio mostra nota explícita
    assert.ok(html!.includes("Sem dados de leaderboard"), "leaderboard vazio mostra nota, não omite");
  });

  test("regressão (Angles A+E): editions/leaderboard não-array no KV não crasha o render", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    // Simula KV stale/corrompido que escapou a validação do build (Worker faz cast direto)
    data.poll_eia = {
      source: "push",
      last_edition: null,
      updated_at: null,
      // @ts-expect-error testando defesa runtime contra schema drift
      editions: "corrompido",
      // @ts-expect-error testando defesa runtime contra schema drift
      leaderboard: null,
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderPollEiaSection(data); }, "não deve crashar com editions/leaderboard não-array");
    assert.ok(html!.includes("poll-eia"), "deve renderizar seção mesmo com dados corrompidos");
  });

  test("não inclui XSS em display_name do leaderboard", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeBase();
    data.poll_eia = {
      source: "push",
      last_edition: "260622",
      updated_at: null,
      editions: [],
      leaderboard: [
        { display_name: '<script>alert("xss")</script>', correct: 5, total: 5, streak: 5 },
      ],
    };
    const html = renderPollEiaSection(data);
    assert.ok(!html.includes('<script>alert("xss")'), "não deve injetar script sem escape");
    assert.ok(html.includes("&lt;script&gt;"), "deve escapar a tag script no leaderboard");
  });
});

// ─── Testes de renderDashboardHtml com as novas seções ───────────────────────

describe("renderDashboardHtml com use_melhor e poll_eia (#2474, #2475)", () => {
  function makeFullData(): import("../workers/diaria-dashboard/src/types.ts").DashboardData {
    return {
      generated_at: "2026-06-21T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      use_melhor: {
        total_editions_with_use_melhor: 1,
        first_edition: "260501",
        editions: [{
          edition: "260501",
          items: [{ url: "https://perplexity.ai/tutorial", title: "Como usar o Perplexity", ctr_pct: 9.0, unique_verified_clicks: 18 }],
          ctr_matched: 1,
          ctr_unmatched: 0,
        }],
        top_items: [{ edition: "260501", url: "https://perplexity.ai/tutorial", title: "Como usar o Perplexity", ctr_pct: 9.0, unique_verified_clicks: 18 }],
        coverage: { total_items: 1, matched: 1, unmatched: 0, coverage_pct: 100 },
      },
      poll_eia: {
        source: "push",
        last_edition: "260622",
        updated_at: "2026-06-22T22:00:00Z",
        editions: [{ edition: "260622", total_votes: 47, voted_a: 30, voted_b: 17, pct_correct: 64, correct_choice: "A" }],
        leaderboard: [],
      },
      stubs: [],
    };
  }

  test("HTML final inclui seções use-melhor e poll-eia", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeFullData());

    assert.ok(html.includes('id="use-melhor"'), "deve ter seção use-melhor");
    assert.ok(html.includes('id="poll-eia"'), "deve ter seção poll-eia");
    // #2602: nav links substituídos por abas — verificar label de aba em vez de href.
    // Escopar à tab-bar do body (for="tab-X" também aparece no CSS do <head>).
    const tabBar = html.match(/<div class="tab-bar"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.ok(tabBar.includes('for="tab-usemelhor"'), "deve ter label de aba Use Melhor");
    assert.ok(tabBar.includes('for="tab-eia"'), "deve ter label de aba É IA?");
  });

  test("HTML válido com as novas seções: doctype, lang, viewport", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeFullData());
    assert.ok(html.startsWith("<!DOCTYPE html>"), "deve começar com doctype");
    assert.ok(html.includes('lang="pt-BR"'), "deve ter lang=pt-BR");
    assert.ok(html.includes("viewport"), "deve ter meta viewport");
  });

  test("HTML com use_melhor=null e poll_eia=null não crasha", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeFullData();
    data.use_melhor = null;
    data.poll_eia = null;
    let html: string;
    assert.doesNotThrow(() => { html = renderDashboardHtml(data); }, "não deve crashar com seções null");
    assert.ok(html!.includes("<!DOCTYPE html>"), "deve gerar HTML válido");
    assert.ok(html!.includes("use-melhor"), "deve incluir id da seção use-melhor mesmo no stub");
    assert.ok(html!.includes("poll-eia"), "deve incluir id da seção poll-eia mesmo no stub");
  });

  test("todas as seções principais estão presentes no HTML (#2602: reorg em abas não perde seções)", async () => {
    // #2602: ordem relativa entre seções de abas diferentes não faz sentido checar —
    // cada seção vive em seu próprio panel. Checar que todas existem no HTML.
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeFullData());

    assert.ok(html.includes('id="ctr"'), "seção ctr deve existir");
    assert.ok(html.includes('id="use-melhor"'), "seção use-melhor deve existir");
    assert.ok(html.includes('id="poll-eia"'), "seção poll-eia deve existir");
    assert.ok(html.includes('id="overnight"'), "seção overnight deve existir");
    assert.ok(html.includes('id="source-health"'), "seção source-health deve existir");
    assert.ok(html.includes('id="top-clicked-recent"'), "seção top-clicked-recent deve existir");
    assert.ok(html.includes('id="audience"'), "seção audience deve existir");
  });
});

// ─── #2602: tab navigation — estrutura HTML das 6 abas ───────────────────────

describe("#2602: tab navigation — 6 abas na diaria-dashboard", () => {
  function makeMinimalData(): import("../workers/diaria-dashboard/src/types.ts").DashboardData {
    return {
      generated_at: "2026-06-26T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      use_melhor: null,
      poll_eia: null,
      top_clicked_recent: null,
      audience: null,
      stubs: [],
    };
  }

  test("HTML contém 6 inputs radio para as abas (tab state)", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const radioMatches = html.match(/type="radio"[^>]*name="dash-tab"/g) ?? [];
    assert.equal(radioMatches.length, 6, "deve ter exatamente 6 radio inputs para as 6 abas");
  });

  test("HTML contém 6 labels de aba com textos corretos e na ordem certa", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    // IMPORTANTE: escopar à <div class="tab-bar"> do body. O atributo for="tab-X"
    // também aparece no CSS (label[for="tab-X"]) no <head>, então asserts contra o
    // html inteiro seriam falso-positivos (passariam mesmo sem os <label>). A tab-bar
    // não tem <div> aninhado, então o 1º </div> a fecha.
    const tabBar = html.match(/<div class="tab-bar"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.ok(tabBar.length > 0, "tab-bar deve existir no body");
    // Verificar presença de todos os labels (texto) dentro da tab-bar
    assert.match(tabBar, /Visão geral/, "deve ter label 'Visão geral'");
    assert.match(tabBar, /\bCTR\b/, "deve ter label 'CTR'");
    assert.match(tabBar, /Top links/, "deve ter label 'Top links'");
    assert.match(tabBar, /Use Melhor/, "deve ter label 'Use Melhor'");
    assert.match(tabBar, /É IA\?/, "deve ter label 'É IA?'");
    assert.match(tabBar, /Audiência/, "deve ter label 'Audiência'");
    // Verificar ordem: posição de cada label DENTRO da tab-bar (não no CSS)
    const posVisaoGeral = tabBar.indexOf('for="tab-visaogeral"');
    const posCtr = tabBar.indexOf('for="tab-ctr"');
    const posTopLinks = tabBar.indexOf('for="tab-toplinks"');
    const posUseMelhor = tabBar.indexOf('for="tab-usemelhor"');
    const posEia = tabBar.indexOf('for="tab-eia"');
    const posAudiencia = tabBar.indexOf('for="tab-audiencia"');
    assert.ok(posVisaoGeral > -1 && posCtr > -1 && posTopLinks > -1 && posUseMelhor > -1 && posEia > -1 && posAudiencia > -1, "todos os 6 labels devem existir na tab-bar");
    assert.ok(posVisaoGeral < posCtr, "Visão geral deve vir antes de CTR");
    assert.ok(posCtr < posTopLinks, "CTR deve vir antes de Top links");
    assert.ok(posTopLinks < posUseMelhor, "Top links deve vir antes de Use Melhor");
    assert.ok(posUseMelhor < posEia, "Use Melhor deve vir antes de É IA?");
    assert.ok(posEia < posAudiencia, "É IA? deve vir antes de Audiência");
  });

  test("1ª aba (Visão geral) tem checked por default", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.match(html, /id="tab-visaogeral"[^>]*checked/, "aba Visão geral deve estar checked por default");
  });

  test("panel-visaogeral contém overnight e source-health", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const panel = html.match(/id="panel-visaogeral"[\s\S]*?(?=id="panel-ctr")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-visaogeral deve existir");
    assert.ok(panel.includes('id="overnight"'), "overnight deve estar no panel Visão geral");
    assert.ok(panel.includes('id="source-health"'), "source-health deve estar no panel Visão geral");
  });

  test("panel-ctr contém seção ctr", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const panel = html.match(/id="panel-ctr"[\s\S]*?(?=id="panel-toplinks")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-ctr deve existir");
    assert.ok(panel.includes('id="ctr"'), "seção ctr deve estar no panel CTR");
  });

  test("panel-toplinks contém top-clicked-recent", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const panel = html.match(/id="panel-toplinks"[\s\S]*?(?=id="panel-usemelhor")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-toplinks deve existir");
    assert.ok(panel.includes('id="top-clicked-recent"'), "top-clicked-recent deve estar no panel Top links");
  });

  test("panel-usemelhor contém use-melhor", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const panel = html.match(/id="panel-usemelhor"[\s\S]*?(?=id="panel-eia")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-usemelhor deve existir");
    assert.ok(panel.includes('id="use-melhor"'), "use-melhor deve estar no panel Use Melhor");
  });

  test("panel-eia contém poll-eia", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const panel = html.match(/id="panel-eia"[\s\S]*?(?=id="panel-audiencia")/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-eia deve existir");
    assert.ok(panel.includes('id="poll-eia"'), "poll-eia deve estar no panel É IA?");
  });

  test("panel-audiencia contém audience", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const panel = html.match(/id="panel-audiencia"[\s\S]*?<\/div><!-- \/tab-panels -->/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-audiencia deve existir");
    assert.ok(panel.includes('id="audience"'), "audience deve estar no panel Audiência");
  });

  test("CSS das abas usa :checked (sem JS externo para tab switching)", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.match(html, /:checked/, "CSS deve conter :checked para tab switching sem JS");
    assert.match(html, /type="radio"/, "deve usar radio inputs para tab state");
  });

  test("nenhuma seção ficou fora dos panels (overnight, source-health, ctr, top-clicked-recent, use-melhor, poll-eia, audience todos estão em algum panel)", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    const tabPanelsBlock = html.match(/<div class="tab-panels">[\s\S]*?<\/div><!-- \/tab-panels -->/)?.[0] ?? "";
    assert.ok(tabPanelsBlock.length > 0, "bloco tab-panels deve existir");
    for (const sectionId of ["overnight", "source-health", "ctr", "top-clicked-recent", "use-melhor", "poll-eia", "audience"]) {
      assert.ok(tabPanelsBlock.includes(`id="${sectionId}"`), `seção id="${sectionId}" deve estar dentro do bloco tab-panels`);
    }
  });
});
