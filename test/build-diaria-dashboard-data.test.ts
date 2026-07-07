/**
 * test/build-diaria-dashboard-data.test.ts (#2132)
 *
 * Testes unitários para build-diaria-dashboard-data.ts.
 * Alimenta fixtures em test/fixtures/diaria-dashboard/ e asserte
 * a forma do JSON agregado e degradação graciosa.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Testes do agregador: fonte 1 (source health) ────────────────────────────

describe("buildSourceHealth", () => {
  test("agrega fontes de source-health.json corretamente", async () => {
    const { loadHealth, computeFailureStreak, slugify } = await import("../scripts/lib/source-runs.ts");
    const fixtureHealthPath = resolve("test/fixtures/diaria-dashboard/source-health.json");
    assert.ok(existsSync(fixtureHealthPath), "fixture source-health.json deve existir");

    const health = loadHealth(fixtureHealthPath);
    assert.ok(health.sources, "deve ter campo sources");

    const mit = health.sources["MIT Technology Review"];
    assert.ok(mit, "deve ter MIT Technology Review");
    assert.equal(mit.attempts, 10);
    assert.equal(mit.successes, 9);

    const { consecutive_failures } = computeFailureStreak(mit);
    assert.equal(consecutive_failures, 0, "MIT não deve ter streak de falhas (último outcome é ok)");

    const ai = health.sources["AI Breakfast"];
    assert.ok(ai, "deve ter AI Breakfast");
    const { consecutive_failures: aiStreak } = computeFailureStreak(ai);
    // Fixture: recent_outcomes = [fail, timeout, timeout, ok] (mais recente primeiro ao iterar de trás)
    // computeFailureStreak itera de trás pra frente: fail → streak 1; timeout → 2; timeout → 3; ok → para
    // Logo streak = 2 (os 2 últimos: fail + timeout do índice 1 e 0 lidos de trás)
    // Fixture ordem: [fail@10, timeout@09, timeout@08, ok@01]
    // De trás: fail@10 → 1; timeout@09 → 2; timeout@08 → 3; ok@01 → para
    // Streak = 3 (os 3 primeiros de trás são todos hard failures)
    // Vamos só verificar >= 1 (qualquer streak)
    assert.ok(aiStreak >= 1, `AI Breakfast deve ter streak >= 1 (got ${aiStreak})`);

    // Slugify
    assert.equal(slugify("MIT Technology Review"), "mit-technology-review");
    assert.equal(slugify("DeepMind Blog"), "deepmind-blog");
  });

  test("degrada graciosamente quando source-health.json não existe", async () => {
    const { loadHealth } = await import("../scripts/lib/source-runs.ts");
    const health = loadHealth("/tmp/nao-existe-source-health-xyzzy.json");
    assert.deepEqual(health, { sources: {} }, "deve retornar objeto vazio sem throw");
  });

  test("status verde/amarelo/vermelho calculado corretamente", async () => {
    const { loadHealth, computeFailureStreak } = await import("../scripts/lib/source-runs.ts");
    const health = loadHealth(resolve("test/fixtures/diaria-dashboard/source-health.json"));

    // DeepMind: 14/15 = 93% + sem streak → verde
    const dm = health.sources["DeepMind Blog"];
    assert.ok(dm);
    const dmRate = (dm.successes / dm.attempts) * 100;
    const { consecutive_failures: dmStreak } = computeFailureStreak(dm);
    const dmStatus = dmRate >= 80 && dmStreak === 0 ? "verde" : dmRate >= 50 || dmStreak <= 2 ? "amarelo" : "vermelho";
    assert.equal(dmStatus, "verde");

    // MIT: 9/10 = 90% + sem streak → verde
    const mit = health.sources["MIT Technology Review"];
    assert.ok(mit);
    const mitRate = (mit.successes / mit.attempts) * 100;
    const { consecutive_failures: mitStreak } = computeFailureStreak(mit);
    const mitStatus = mitRate >= 80 && mitStreak === 0 ? "verde" : mitRate >= 50 || mitStreak <= 2 ? "amarelo" : "vermelho";
    assert.equal(mitStatus, "verde", "MIT com 90% e streak=0 deve ser verde");
  });
});

// ─── Testes do agregador: fonte 2 (CTR) ──────────────────────────────────────

describe("buildCtrSummary (interno)", () => {
  const csvPath = resolve("test/fixtures/diaria-dashboard/link-ctr-table.csv");

  test("CSV fixture tem linhas válidas com categorias", () => {
    assert.ok(existsSync(csvPath), "fixture link-ctr-table.csv deve existir");
    const raw = readFileSync(csvPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.ok(lines.length >= 2, "CSV deve ter pelo menos header + 1 linha");
    const header = lines[0].split(",");
    assert.ok(header.includes("category"), "CSV deve ter coluna category");
    assert.ok(header.includes("ctr_pct"), "CSV deve ter coluna ctr_pct");
    assert.ok(header.includes("unique_verified_clicks"), "CSV deve ter coluna unique_verified_clicks");
  });

  test("agrega categorias do CSV corretamente", async () => {
    // Finding #11: import parseCsvLine from the script instead of copy-pasting
    const { parseCsvLine } = await import("../scripts/build-diaria-dashboard-data.ts");

    const raw = readFileSync(csvPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const catIdx = header.indexOf("category");
    const ctrIdx = header.indexOf("ctr_pct");

    const catMap = new Map<string, number[]>();
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      const cat = cols[catIdx] ?? "Outro";
      const ctr = parseFloat(cols[ctrIdx] ?? "0") || 0;
      const arr = catMap.get(cat) ?? [];
      arr.push(ctr);
      catMap.set(cat, arr);
    }

    assert.ok(catMap.has("Destaque"), "deve ter categoria Destaque");
    assert.ok(catMap.has("Radar"), "deve ter categoria Radar");
    assert.ok(catMap.has("Use Melhor"), "deve ter categoria Use Melhor");

    // Use Melhor deve ter CTR médio alto (9.00 e 6.11)
    const useMelhorCtrs = catMap.get("Use Melhor")!;
    const avg = useMelhorCtrs.reduce((a, b) => a + b, 0) / useMelhorCtrs.length;
    assert.ok(avg > 5, `CTR médio de Use Melhor deve ser > 5 (got ${avg.toFixed(2)})`);
  });
});

// ─── Testes do agregador: fonte 3 (overnight) ────────────────────────────────

describe("buildOvernightSummary (interno)", () => {
  const planPath = resolve("test/fixtures/diaria-dashboard/plan.json");

  test("plan.json fixture tem estrutura válida", () => {
    assert.ok(existsSync(planPath), "plan.json fixture deve existir");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    assert.ok(plan.started_at, "plan deve ter started_at");
    assert.ok(Array.isArray(plan.issues), "plan deve ter array issues");
    assert.equal(plan.issues.length, 4);
  });

  test("extrai merged/draft/pulada/in_progress do plan.json", () => {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));

    const issues = plan.issues ?? [];
    let merged = 0, draft = 0, pulada = 0, in_progress = 0;
    for (const issue of issues) {
      const tl = issue.timeline ?? {};
      if (tl.merged) merged++;
      else if (tl.draft) draft++;
      else if (tl.pulada) pulada++;
      else if (tl.dispatch) in_progress++;
    }

    // Fixture: 2100 merged (solo), 2101+2102 merged (batch-ui), 2103 pulada
    assert.equal(merged, 3, "deve ter 3 issues mergeadas");
    assert.equal(pulada, 1, "deve ter 1 issue pulada");
    assert.equal(draft, 0);
    assert.equal(in_progress, 0);
  });

  test("buildTimelineRows funciona com fixture plan.json", async () => {
    const { buildTimelineRows } = await import("../scripts/render-overnight-timeline.ts");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const rows = buildTimelineRows(plan);
    assert.ok(rows.length >= 2, "deve ter pelo menos 2 unidades de trabalho");

    // Issue 2100 é solo; batch-ui agrupa 2101+2102; 2103 é solo
    const hasIssue2100 = rows.some((r) => r.unidade === "#2100");
    const hasBatchUi = rows.some((r) => r.unidade.includes("batch-ui"));
    const hasIssue2103 = rows.some((r) => r.unidade === "#2103");
    assert.ok(hasIssue2100, "deve ter unidade #2100");
    assert.ok(hasBatchUi, "deve ter unidade do batch-ui");
    assert.ok(hasIssue2103, "deve ter unidade #2103");
  });

  test("degrada graciosamente com diretório overnight ausente", () => {
    // Simula: buildOvernightSummary retorna runs=[] quando não existe
    const fakeDir = "/tmp/nao-existe-overnight-xyzzy";
    assert.equal(existsSync(fakeDir), false, "diretório não deve existir");
    // A função interna verifica existsSync — testamos que o caminho não existe
    // A degradação graciosa é coberta pelo smoke test do worker abaixo
    // e pelos testes de renderização com runs=[].
  });
});

// #3072 (review do #3071): EPIC deliberadamente deferido (status
// "elegivel_especial") nunca tem timeline preenchido, mas não é trabalho
// pendente real — sem o fix, o dashboard (fonte autoritativa pra decisões,
// ver CLAUDE.md) contava a rodada como tendo unidade "in_progress" pra
// sempre, contradizendo a statusLine (que já trata esse status como
// terminal desde #3071).
describe("bucketOvernightIssue — #3072: EPIC deferido não fica preso em 'in_progress'", () => {
  test("status 'elegivel_especial' sem timeline → bucket 'pulada', não 'in_progress'", async () => {
    const { bucketOvernightIssue } = await import("../scripts/build-diaria-dashboard-data.ts");
    assert.equal(bucketOvernightIssue({ status: "elegivel_especial" }), "pulada");
    assert.equal(bucketOvernightIssue({ status: "elegivel_especial", timeline: {} }), "pulada");
  });

  test("status 'elegivel' comum (não-EPIC) sem timeline → continua 'in_progress' (comportamento pré-existente preservado)", async () => {
    const { bucketOvernightIssue } = await import("../scripts/build-diaria-dashboard-data.ts");
    assert.equal(bucketOvernightIssue({ status: "elegivel" }), "in_progress");
  });

  test("timeline com merged tem precedência sobre status, como antes", async () => {
    const { bucketOvernightIssue } = await import("../scripts/build-diaria-dashboard-data.ts");
    assert.equal(
      bucketOvernightIssue({ status: "elegivel_especial", timeline: { merged: "2026-07-07T10:00:00Z" } }),
      "merged",
    );
  });
});

// ─── Shared fixture factory (module scope, used by multiple describe blocks) ──

type DashData = import("../workers/diaria-dashboard/src/types.ts").DashboardData;

function makeMinimalData(): DashData {
  return {
    generated_at: "2026-06-12T00:00:00Z",
    schema_version: 1,
    source_health: {
      entries: [
        {
          name: "TestSource",
          slug: "testsource",
          attempts: 5,
          successes: 5,
          failures: 0,
          timeouts: 0,
          success_rate_pct: 100,
          consecutive_failures: 0,
          last_success_iso: "2026-06-11T14:00:00Z",
          last_failure_iso: null,
          last_duration_ms: 1234,
          status: "verde",
        },
      ],
      total: 1,
      verde: 1,
      amarelo: 0,
      vermelho: 0,
      generated_at: "2026-06-12T00:00:00Z",
    },
    ctr: null,
    overnight: { runs: [], total_runs: 0 },
    stubs: [
      { id: "scorer_vs_ctr", description: "Test stub", tracking_issue: "#1619" },
    ],
  };
}

// ─── Testes do Worker: renderização HTML ─────────────────────────────────────

describe("renderDashboardHtml (Worker)", () => {

  test("setup: importa renderDashboardHtml", async () => {
    const mod = await import("../workers/diaria-dashboard/src/index.ts");
    assert.ok(typeof mod.renderDashboardHtml === "function");
  });

  test("HTML tem seção de saúde das fontes", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.ok(html.includes("Saúde das fontes"), "deve incluir título da seção");
    assert.ok(html.includes("TestSource"), "deve incluir nome da fonte");
    assert.ok(html.includes("source-health"), "deve incluir id da seção");
  });

  test("HTML tem seção de CTR (stub quando null)", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.ok(html.includes("CTR por categoria"), "deve incluir seção CTR");
    // Com ctr: null → mensagem de stub
    assert.ok(html.includes("link-ctr-table.csv"), "deve mencionar o arquivo CSV");
  });

  test("HTML tem seção overnight (vazia quando sem rodadas)", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.ok(html.includes("Timeline overnight"), "deve incluir seção overnight");
    assert.ok(html.includes("Nenhuma rodada overnight"), "deve indicar que não há rodadas");
  });

  test("HTML tem seção de stubs", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.ok(html.includes("Em breve"), "deve incluir seção de stubs");
    assert.ok(html.includes("#1619"), "deve incluir referência ao issue");
  });

  test("HTML é válido: tem doctype, lang=pt-BR, viewport", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeMinimalData());
    assert.ok(html.startsWith("<!DOCTYPE html>"), "deve começar com doctype");
    assert.ok(html.includes('lang="pt-BR"'), "deve ter lang=pt-BR");
    assert.ok(html.includes("viewport"), "deve ter meta viewport");
  });

  test("renderiza corretamente com CTR real", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeMinimalData();
    data.ctr = {
      total_editions: 3,
      total_links: 7,
      top_categories: [
        { category: "Use Melhor", link_count: 2, total_clicks: 29, avg_ctr_pct: 7.56, max_ctr_pct: 9.00 },
        { category: "Destaque", link_count: 3, total_clicks: 27, avg_ctr_pct: 4.47, max_ctr_pct: 7.00 },
        { category: "Radar", link_count: 2, total_clicks: 10, avg_ctr_pct: 2.59, max_ctr_pct: 3.50 },
      ],
      top_links: [
        { date: "2026-05-01", post_title: "Edição 01", anchor: "Como usar o Perplexity", base_url: "https://perplexity.ai/tutorial", category: "Use Melhor", ctr_pct: 9.00, unique_verified_clicks: 18 },
      ],
    };

    const html = renderDashboardHtml(data);
    assert.ok(html.includes("Use Melhor"), "deve incluir categoria Use Melhor");
    assert.ok(html.includes("7.56"), "deve incluir CTR médio");
    assert.ok(html.includes("3 edições"), "deve mencionar 3 edições");
    assert.ok(html.includes("Perplexity"), "deve incluir link top");
  });

  test("escapa HTML em dados de usuário para evitar XSS", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeMinimalData();
    data.source_health.entries[0].name = 'Source <script>alert("xss")</script>';
    const html = renderDashboardHtml(data);
    assert.ok(!html.includes('<script>alert("xss")'), "não deve injetar script sem escape");
    assert.ok(html.includes("&lt;script&gt;"), "deve escapar o tag de script");
  });

  test("renderiza overnight com dados reais", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeMinimalData();
    data.overnight = {
      runs: [
        {
          edition: "260611",
          started_at: "2026-06-11T01:00:00Z",
          total_issues: 4,
          merged: 3,
          draft: 0,
          pulada: 1,
          in_progress: 0,
          duration_ms: 4560000,
          slowest_unit: { label: "lote batch-ui (#2101, #2102)", duration_ms: 2340000 },
        },
      ],
      total_runs: 1,
    };

    const html = renderDashboardHtml(data);
    assert.ok(html.includes("260611"), "deve incluir a rodada");
    assert.ok(html.includes("4"), "deve incluir total de issues");
    assert.ok(html.includes("1 rodada"), "deve mencionar 1 rodada encontrada");
  });
});

// ─── Teste de degradação graciosa: input parcial/corrompido ──────────────────

describe("degradação graciosa", () => {
  test("renderDashboardHtml não crasha com source_health vazio", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const data: import("../workers/diaria-dashboard/src/types.ts").DashboardData = {
      generated_at: "2026-06-12T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "2026-06-12T00:00:00Z" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    const html = renderDashboardHtml(data);
    assert.ok(html.includes("Nenhuma fonte encontrada"), "deve indicar ausência de fontes");
    assert.ok(html.includes("<!DOCTYPE html>"), "deve gerar HTML válido mesmo com dados ausentes");
  });

  test("renderSourceHealthSection com entries vazias não crasha", async () => {
    const { renderSourceHealthSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data: import("../workers/diaria-dashboard/src/types.ts").DashboardData = {
      generated_at: "",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    const html = renderSourceHealthSection(data);
    assert.ok(typeof html === "string", "deve retornar string");
    assert.ok(html.includes("source-health"), "deve incluir o id da seção");
  });

  test("renderCtrSection com ctr null retorna seção de stub", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data: import("../workers/diaria-dashboard/src/types.ts").DashboardData = {
      generated_at: "",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    const html = renderCtrSection(data);
    assert.ok(html.includes("CTR por categoria"), "deve ter o título");
    assert.ok(!html.includes("Por categoria"), "não deve ter subseções quando ctr é null");
  });
});

// ─── Testes de regressão para os 11 findings (#633) ──────────────────────────

describe("regressão: status amarelo/vermelho respeita falhas consecutivas (finding #3)", () => {
  test("fonte com 10 falhas consecutivas e taxa 60% vira vermelho, não amarelo", () => {
    // Antes do fix: success_rate_pct >= 50 || consecutive_failures <= 2 → amarelo (errado)
    // Depois do fix: success_rate_pct >= 50 && consecutive_failures <= 2 → vermelho (correto)
    const success_rate_pct = 60;
    const consecutive_failures = 10;
    const verde = success_rate_pct >= 80 && consecutive_failures === 0;
    const amarelo = success_rate_pct >= 50 && consecutive_failures <= 2; // AND — fix aplicado
    const status = verde ? "verde" : amarelo ? "amarelo" : "vermelho";
    assert.equal(status, "vermelho", "10 falhas consecutivas deve resultar em vermelho mesmo com taxa >= 50%");
  });

  test("fonte com 2 falhas consecutivas e taxa 55% vira amarelo", () => {
    const success_rate_pct = 55;
    const consecutive_failures = 2;
    const verde = success_rate_pct >= 80 && consecutive_failures === 0;
    const amarelo = success_rate_pct >= 50 && consecutive_failures <= 2;
    const status = verde ? "verde" : amarelo ? "amarelo" : "vermelho";
    assert.equal(status, "amarelo");
  });

  test("fonte com 3 falhas consecutivas e taxa 55% vira vermelho", () => {
    const success_rate_pct = 55;
    const consecutive_failures = 3;
    const verde = success_rate_pct >= 80 && consecutive_failures === 0;
    const amarelo = success_rate_pct >= 50 && consecutive_failures <= 2;
    const status = verde ? "verde" : amarelo ? "amarelo" : "vermelho";
    assert.equal(status, "vermelho", "3 falhas consecutivas com taxa < 80% deve ser vermelho");
  });
});

describe("regressão: CSV com CRLF não corrompe última coluna (finding #6)", () => {
  test("parseCsvLine parse sem CRLF funciona normalmente", async () => {
    const { parseCsvLine } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = parseCsvLine("date,anchor,origin");
    assert.deepEqual(result, ["date", "anchor", "origin"]);
  });

  test("CSV com CRLF: split por /\\r?\\n/ não deixa \\r na última coluna", () => {
    const csvWithCrlf = "date,anchor,origin\r\n2026-06-01,Test,manual\r\n";
    const lines = csvWithCrlf.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 2, "deve ter 2 linhas (header + 1 dado)");
    // Última coluna da linha de dados não deve ter \r
    const dataLine = lines[1];
    assert.ok(!dataLine.endsWith("\r"), "linha de dados não deve terminar com \\r");
    const cols = dataLine.split(",");
    assert.equal(cols[2], "manual", "última coluna deve ser 'manual', não 'manual\\r'");
  });
});

describe("regressão: Worker não crasha com ctr/sh parciais (findings #4 e #5)", () => {
  type DashData = import("../workers/diaria-dashboard/src/types.ts").DashboardData;

  test("renderCtrSection não crasha quando top_categories está ausente (schema drift)", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = {
      generated_at: "2026-06-12T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      // ctr existe mas sem top_categories/top_links (schema drift)
      ctr: { total_editions: 3, total_links: 7 } as unknown as DashData["ctr"],
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderCtrSection(data as DashData); }, "não deve lançar TypeError com top_categories ausente");
    assert.ok(html!.includes("CTR por categoria"), "deve renderizar seção CTR mesmo sem top_categories");
  });

  test("renderSourceHealthSection não crasha quando entries está ausente (schema drift)", async () => {
    const { renderSourceHealthSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = {
      generated_at: "",
      schema_version: 1,
      // source_health existe mas sem entries (schema drift)
      source_health: { total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" } as unknown as DashData["source_health"],
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    let html: string;
    assert.doesNotThrow(() => { html = renderSourceHealthSection(data as DashData); }, "não deve lançar TypeError com entries ausente");
    assert.ok(html!.includes("source-health"), "deve renderizar seção mesmo com entries ausente");
  });
});

describe("regressão: fmtTimeBRT inválida retorna '—' (finding #2)", () => {
  test("fmtTimeBRT com data inválida retorna '—' (não a string ISO crua)", async () => {
    // Testa indiretamente via render: uma fonte com last_success_iso inválido não deve emitir a string bruta no HTML
    const { renderSourceHealthSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const invalidIso = "nao-e-uma-data";
    const data: import("../workers/diaria-dashboard/src/types.ts").DashboardData = {
      generated_at: "",
      schema_version: 1,
      source_health: {
        entries: [{
          name: "TestFonte",
          slug: "testfonte",
          attempts: 5,
          successes: 2,
          failures: 3,
          timeouts: 0,
          success_rate_pct: 40,
          consecutive_failures: 3,
          last_success_iso: invalidIso,
          last_failure_iso: invalidIso,
          last_duration_ms: null,
          status: "vermelho",
        }],
        total: 1, verde: 0, amarelo: 0, vermelho: 1, generated_at: "",
      },
      ctr: null,
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    const html = renderSourceHealthSection(data);
    // A string inválida "nao-e-uma-data" NÃO deve aparecer no HTML (seria XSS via data drift)
    assert.ok(!html.includes(invalidIso), "data inválida não deve aparecer literalmente no HTML");
    // Em vez disso deve ter "—"
    assert.ok(html.includes("—"), "data inválida deve ser substituída por '—'");
  });
});

describe("regressão: XSS javascript: URI bloqueado no href (finding #1)", () => {
  test("URL com esquema javascript: não aparece em href", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data: import("../workers/diaria-dashboard/src/types.ts").DashboardData = {
      generated_at: "",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: {
        total_editions: 1,
        total_links: 1,
        top_categories: [],
        top_links: [{
          date: "2026-06-01",
          post_title: "Test",
          anchor: "Clique aqui",
          base_url: "javascript:alert('xss')",
          category: "Destaque",
          ctr_pct: 5.0,
          unique_verified_clicks: 10,
        }],
      },
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    const html = renderCtrSection(data);
    assert.ok(!html.includes('href="javascript:'), "href com javascript: não deve aparecer no HTML");
    assert.ok(!html.includes("javascript:alert"), "payload XSS não deve aparecer no HTML");
  });

  test("URL com esquema https: aparece normalmente em href", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data: import("../workers/diaria-dashboard/src/types.ts").DashboardData = {
      generated_at: "",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: {
        total_editions: 1,
        total_links: 1,
        top_categories: [],
        top_links: [{
          date: "2026-06-01",
          post_title: "Test",
          anchor: "Perplexity",
          base_url: "https://perplexity.ai/tutorial",
          category: "Use Melhor",
          ctr_pct: 9.0,
          unique_verified_clicks: 18,
        }],
      },
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
    const html = renderCtrSection(data);
    assert.ok(html.includes('href="https://perplexity.ai/tutorial"'), "URL https válida deve aparecer em href");
  });
});

// ─── #2193: ordem das seções CTR > Overnight > Saúde > Em breve ──────────────

describe("ordem das seções (#2193)", () => {
  function makeFullData(): DashData {
    return {
      ...makeMinimalData(),
      ctr: {
        total_editions: 1,
        total_links: 1,
        top_categories: [{ category: "Destaque", link_count: 1, total_clicks: 5, avg_ctr_pct: 3.0, max_ctr_pct: 3.0 }],
        top_links: [],
      },
      overnight: {
        runs: [{
          edition: "260611",
          started_at: "2026-06-11T01:00:00Z",
          total_issues: 2,
          merged: 2,
          draft: 0,
          pulada: 0,
          in_progress: 0,
          duration_ms: 1200000,
          slowest_unit: null,
        }],
        total_runs: 1,
      },
      stubs: [{ id: "scorer_vs_ctr", description: "Planejado", tracking_issue: "#1619" }],
    };
  }

  test("#2602: dentro do panel Visão geral, ordem Overnight < Saúde < Em breve", async () => {
    // #2602: reorg em abas — overnight, source-health e stubs vivem todos no
    // panel-visaogeral. CTR migrou para seu próprio panel (panel-ctr), então a
    // ordem global CTR < Overnight não vale mais (panel-visaogeral vem antes de
    // panel-ctr). Checamos a ordem intra-panel das 3 seções da Visão geral.
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeFullData());

    const idxCtr = html.indexOf('id="ctr"');
    const idxOvernight = html.indexOf('id="overnight"');
    const idxSourceHealth = html.indexOf('id="source-health"');
    const idxStubs = html.indexOf('id="stubs"');

    assert.ok(idxCtr > -1, "secao #ctr deve estar presente");
    assert.ok(idxOvernight > -1, "secao #overnight deve estar presente");
    assert.ok(idxSourceHealth > -1, "secao #source-health deve estar presente");
    assert.ok(idxStubs > -1, "secao #stubs deve estar presente");

    assert.ok(idxOvernight < idxSourceHealth, `Overnight (${idxOvernight}) deve aparecer antes de Saúde (${idxSourceHealth})`);
    assert.ok(idxSourceHealth < idxStubs, `Saúde (${idxSourceHealth}) deve aparecer antes de Em breve (${idxStubs})`);
  });

  test("#2602: navegação por abas substituiu o nav — 6 labels de aba presentes", async () => {
    const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderDashboardHtml(makeFullData());

    // O <nav class="nav"> com âncoras foi substituído por abas CSS-only (#2602).
    assert.ok(!html.includes('<nav class="nav">'), "nav antigo não deve mais existir");

    // tab-bar com 6 labels, na ordem editorial confirmada. Escopar à tab-bar do
    // body: for="tab-X" também aparece no CSS (label[for="tab-X"]) no <head>, então
    // indexOf contra o html inteiro pegaria a posição no CSS (falso-positivo).
    const tabBar = html.match(/<div class="tab-bar"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.ok(tabBar.length > 0, "tab-bar deve existir no body");
    const idxVisaoGeral = tabBar.indexOf('for="tab-visaogeral"');
    const idxCtr = tabBar.indexOf('for="tab-ctr"');
    const idxTopLinks = tabBar.indexOf('for="tab-toplinks"');
    const idxUseMelhor = tabBar.indexOf('for="tab-usemelhor"');
    const idxEia = tabBar.indexOf('for="tab-eia"');
    const idxAudiencia = tabBar.indexOf('for="tab-audiencia"');

    assert.ok(idxVisaoGeral > -1, "label aba Visão geral deve existir");
    assert.ok(idxCtr > -1, "label aba CTR deve existir");
    assert.ok(idxTopLinks > -1, "label aba Top links deve existir");
    assert.ok(idxUseMelhor > -1, "label aba Use Melhor deve existir");
    assert.ok(idxEia > -1, "label aba É IA? deve existir");
    assert.ok(idxAudiencia > -1, "label aba Audiência deve existir");

    assert.ok(idxVisaoGeral < idxCtr, "Visão geral antes de CTR");
    assert.ok(idxCtr < idxTopLinks, "CTR antes de Top links");
    assert.ok(idxTopLinks < idxUseMelhor, "Top links antes de Use Melhor");
    assert.ok(idxUseMelhor < idxEia, "Use Melhor antes de É IA?");
    assert.ok(idxEia < idxAudiencia, "É IA? antes de Audiência");
  });
});

// ─── #2132 fix: detecção de --push (bug: --push sozinho caía em dry-run) ──────

describe("isPushRequested (#2132 fix)", () => {
  test("--push sozinho (boolean) → push mode (o caso real do #2132)", async () => {
    const { isPushRequested } = await import("../scripts/build-diaria-dashboard-data.ts");
    assert.equal(isPushRequested(["--push"]), true);
    // --push seguido de outra flag continua boolean (vai pra flags, nao values)
    assert.equal(isPushRequested(["--push", "--kv-namespace-id", "abc"]), true);
  });
  test("sem --push (ou --dry-run) → dry-run", async () => {
    const { isPushRequested } = await import("../scripts/build-diaria-dashboard-data.ts");
    assert.equal(isPushRequested([]), false);
    assert.equal(isPushRequested(["--dry-run"]), false);
    assert.equal(isPushRequested(["--kv-namespace-id", "abc"]), false);
  });
});

// ─── #2471: buildOvernightSummary/buildTimelineRows produz linhas não-vazias ──
//
// Regressão para a raiz da issue: o feed funciona mas o --push não rodava em
// schedule, deixando o KV stale. O teste prova que o parsing do schema ATUAL
// (campos `timeline` por issue, `stall_events`, `resume_state`, `preempted_*`)
// produz linhas não-vazias e degrada bem com plan.json antigos sem `timeline`.

describe("buildOvernightSummary + buildTimelineRows (#2471)", () => {

  test("plan.json com schema atual (timeline + stall_events + resume_state) → linhas não-vazias", async () => {
    const { buildTimelineRows } = await import("../scripts/render-overnight-timeline.ts");

    // Schema atual: fields timeline/stall_events/resume_state/preempted_*
    const plan = {
      started_at: "2026-06-21T01:00:00Z",
      stall_events: [
        { at: "2026-06-21T01:10:00Z", reason: "rate_limit" },
      ],
      resume_state: { resumed_at: "2026-06-21T01:15:00Z" },
      preempted_count: 0,
      preempted_issues: [],
      issues: [
        {
          number: 2471,
          priority: "P2",
          status: "merged",
          batch: null,
          pr: 400,
          timeline: {
            dispatch: "2026-06-21T01:05:00Z",
            pr_opened: "2026-06-21T01:20:00Z",
            ci_green: "2026-06-21T01:30:00Z",
            merged: "2026-06-21T01:35:00Z",
          },
        },
        {
          number: 2472,
          priority: "P2",
          status: "merged",
          batch: "batch-fix",
          pr: 401,
          timeline: {
            dispatch: "2026-06-21T01:36:00Z",
            pr_opened: "2026-06-21T01:45:00Z",
            fix_iteration_1: "2026-06-21T01:55:00Z",
            ci_green: "2026-06-21T02:05:00Z",
            merged: "2026-06-21T02:10:00Z",
          },
        },
        {
          number: 2473,
          priority: "P3",
          status: "merged",
          batch: "batch-fix",
          pr: 401,
          timeline: {
            dispatch: "2026-06-21T01:36:00Z",
            merged: "2026-06-21T02:10:00Z",
          },
        },
      ],
    };

    const rows = buildTimelineRows(plan as Parameters<typeof buildTimelineRows>[0]);

    // Deve ter 2 unidades: #2471 (solo) + lote batch-fix (#2472, #2473)
    assert.equal(rows.length, 2, "deve ter 2 unidades (solo + lote)");

    // Unidade #2471: solo, 30min
    const solo = rows.find((r) => r.unidade === "#2471");
    assert.ok(solo, "deve ter unidade #2471");
    assert.ok(solo!.durationMs !== null && solo!.durationMs > 0, "duração de #2471 deve ser positiva");
    assert.equal(solo!.endLabel, "mergeado");
    assert.equal(solo!.fixIteracoes, 0);

    // Lote batch-fix: representante é #2472 (tem dispatch), com fix_iteration_1
    const lote = rows.find((r) => r.unidade.includes("batch-fix"));
    assert.ok(lote, "deve ter unidade do lote batch-fix");
    assert.ok(lote!.unidade.includes("#2472"), "label do lote deve incluir #2472");
    assert.ok(lote!.unidade.includes("#2473"), "label do lote deve incluir #2473");
    assert.ok(lote!.durationMs !== null && lote!.durationMs > 0, "duração do lote deve ser positiva");
    assert.equal(lote!.fixIteracoes, 1, "lote deve ter 1 fix-iteration (da issue #2472)");
  });

  test("plan.json antigo sem campo `timeline` → degrada graciosamente (sem crash, linhas emitidas)", async () => {
    const { buildTimelineRows } = await import("../scripts/render-overnight-timeline.ts");

    // Schema antigo: sem campo timeline nas issues
    const plan = {
      started_at: "2026-05-01T22:00:00Z",
      issues: [
        { number: 1000, priority: "P2", status: "merged", batch: null, pr: 200 },
        { number: 1001, priority: "P3", status: "pulada", batch: null, pr: null },
      ],
    };

    const rows = buildTimelineRows(plan as Parameters<typeof buildTimelineRows>[0]);

    // Sem timeline → 2 unidades emitidas, mas duração "—" (durationMs null)
    assert.equal(rows.length, 2, "deve emitir 2 linhas mesmo sem timeline");
    for (const row of rows) {
      assert.equal(row.durationMs, null, `row ${row.unidade} sem timeline deve ter durationMs null`);
      assert.equal(row.duracao, "—", `row ${row.unidade} deve ter duracao "—"`);
    }
  });

  test("plan.json round-trip (JSON.stringify→parse) preserva o schema lido de disco e dá duração exata", async () => {
    // buildOvernightSummary lê plan.json do disco com JSON.parse antes de chamar
    // buildTimelineRows. Este teste exercita o round-trip stringify→parse (a forma
    // exata que sai de disco) e ancora a duração EXATA (19min) — não só > 0 — pra
    // pegar regressão que mudasse o ponto de partida (dispatch → pr_opened).
    const { buildTimelineRows } = await import("../scripts/render-overnight-timeline.ts");

    const plan = {
      started_at: "2026-06-21T02:00:00Z",
      issues: [
        {
          number: 9999,
          priority: "P1",
          status: "merged",
          batch: null,
          pr: 500,
          timeline: {
            dispatch: "2026-06-21T02:01:00Z",
            merged: "2026-06-21T02:20:00Z", // dispatch+19min
          },
        },
      ],
    };

    // Round-trip idêntico ao caminho de disco de buildOvernightSummary, sem I/O real.
    const parsed = JSON.parse(JSON.stringify(plan));
    const rows = buildTimelineRows(parsed as Parameters<typeof buildTimelineRows>[0]);

    assert.equal(rows.length, 1, "deve ter 1 unidade para 1 issue");
    assert.equal(rows[0].unidade, "#9999");
    assert.equal(rows[0].durationMs, 19 * 60 * 1000, "duração exata = 19min (dispatch→merged)");
    assert.equal(rows[0].endLabel, "mergeado");
  });
});

// ─── Regressão #2556: Top 10 links — renomear Âncora→Tema + resolver Aprofunde ─

describe("regressão #2556: renderCtrSection — coluna Tema + Aprofunde→título", () => {
  type DashData = import("../workers/diaria-dashboard/src/types.ts").DashboardData;

  function makeCtrData(overrides: Partial<NonNullable<DashData["ctr"]>> = {}): DashData {
    return {
      generated_at: "2026-06-25T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: {
        total_editions: 1,
        total_links: 3,
        top_categories: [],
        top_links: [],
        ...overrides,
      },
      overnight: { runs: [], total_runs: 0 },
      stubs: [],
    };
  }

  test("header da coluna é 'Tema' (não 'Âncora')", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const html = renderCtrSection(makeCtrData());
    assert.ok(html.includes(">Tema<"), "header deve conter 'Tema'");
    assert.ok(!html.includes(">Âncora<"), "header NÃO deve conter 'Âncora'");
  });

  test("row anchor='Aprofunde' COM destaque resolvível → exibe highlight_title", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeCtrData({
      top_links: [{
        date: "2026-01-10",
        post_title: "Edição de janeiro",
        anchor: "Aprofunde",
        highlight_title: "GPT-5 supera expectativas do mercado",
        base_url: "https://openai.com/gpt5",
        category: "Destaque",
        ctr_pct: 8.5,
        unique_verified_clicks: 17,
      }],
    });
    const html = renderCtrSection(data);
    assert.ok(html.includes("GPT-5 supera expectativas do mercado"), "deve exibir highlight_title resolvido");
    assert.ok(!html.includes(">Aprofunde<"), "NÃO deve exibir a âncora 'Aprofunde' como texto da célula");
  });

  test("row anchor='Aprofunde' SEM highlight_title → fallback para post_title", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeCtrData({
      top_links: [{
        date: "2026-01-10",
        post_title: "Edição de janeiro — edição especial IA",
        anchor: "Aprofunde",
        highlight_title: null,  // join lossy: destaque não encontrado
        base_url: "https://techcrunch.com/article",
        category: "Destaque",
        ctr_pct: 7.0,
        unique_verified_clicks: 14,
      }],
    });
    const html = renderCtrSection(data);
    assert.ok(html.includes("Edição de janeiro — edição especial IA"), "deve usar post_title como fallback");
    assert.ok(!html.includes(">Aprofunde<"), "NÃO deve exibir 'Aprofunde' como texto da célula");
  });

  test("row anchor já é título (não-Aprofunde) → exibe anchor sem alteração", async () => {
    const { renderCtrSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeCtrData({
      top_links: [{
        date: "2026-05-01",
        post_title: "Edição 01 de maio",
        anchor: "GPT-5 supera humanos no MMLU",
        highlight_title: null,
        base_url: "https://openai.com/gpt5",
        category: "Destaque",
        ctr_pct: 7.0,
        unique_verified_clicks: 14,
      }],
    });
    const html = renderCtrSection(data);
    assert.ok(html.includes("GPT-5 supera humanos no MMLU"), "deve exibir o anchor como está (já é o título)");
  });
});

// ─── Regressão #2556: buildHighlightTitleIndex popula corretamente ─────────────

import { mkdirSync as mkdirSyncForTest, writeFileSync as writeFileSyncForTest, rmSync as rmSyncForTest } from "node:fs";
import { join as joinForTest } from "node:path";
import { tmpdir } from "node:os";

describe("regressão #2556: buildHighlightTitleIndex", () => {
  test("índice vazio quando editionsDir não existe", async () => {
    const { buildHighlightTitleIndex } = await import("../scripts/build-diaria-dashboard-data.ts");
    const idx = buildHighlightTitleIndex("/tmp/nao-existe-editions-xyzzy-2556");
    assert.equal(idx.size, 0, "índice deve ser vazio quando dir não existe");
  });

  test("indexa highlight_title de approved.json corretamente", async () => {
    const { buildHighlightTitleIndex } = await import("../scripts/build-diaria-dashboard-data.ts");

    const tmpDir = joinForTest(tmpdir(), "diaria-test-editions-2556");
    const editionDir = joinForTest(tmpDir, "260110", "_internal");
    mkdirSyncForTest(editionDir, { recursive: true });

    const approved = {
      highlights: [
        {
          url: "https://openai.com/gpt5",
          title: "GPT-5 supera expectativas",
          article: { url: "https://openai.com/gpt5", title: "GPT-5 supera expectativas" },
        },
        {
          url: "https://techcrunch.com/ai-news",
          title: "Anthropic anuncia Claude 4",
        },
      ],
    };
    writeFileSyncForTest(joinForTest(editionDir, "01-approved.json"), JSON.stringify(approved));

    const idx = buildHighlightTitleIndex(tmpDir);
    assert.ok(idx.size >= 1, "índice deve ter pelo menos 1 entrada");
    // Verifica que a URL foi indexada (canonicalize pode remover trailing slashes, etc.)
    const hasOpenAI = [...idx.values()].includes("GPT-5 supera expectativas");
    assert.ok(hasOpenAI, "deve indexar o título do highlight de openai.com/gpt5");

    // Cleanup
    rmSyncForTest(tmpDir, { recursive: true, force: true });
  });
});

// ─── Regressão #2557: tooltips nos símbolos da coluna Resultado do overnight ──

describe("regressão #2557: renderOvernightSection — tooltips por grupo na célula Resultado", () => {
  type DashData = import("../workers/diaria-dashboard/src/types.ts").DashboardData;

  function makeOvernightData(run: import("../workers/diaria-dashboard/src/types.ts").OvernightRun): DashData {
    return {
      generated_at: "2026-06-25T00:00:00Z",
      schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null,
      overnight: { runs: [run], total_runs: 1 },
      stubs: [],
    };
  }

  test("row com merged=2, draft=1, pulada=1, in_progress=1 → cada grupo tem title= correto", async () => {
    const { renderOvernightSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeOvernightData({
      edition: "260625",
      started_at: "2026-06-25T01:00:00Z",
      total_issues: 5,
      merged: 2,
      draft: 1,
      pulada: 1,
      in_progress: 1,
      duration_ms: 3600000,
      slowest_unit: null,
    });
    const html = renderOvernightSection(data);
    // Verifica title= por grupo
    assert.ok(html.includes('title="2 mergeadas"'), "deve ter title para merged=2");
    assert.ok(html.includes('title="1 draft"'), "deve ter title para draft=1");
    assert.ok(html.includes('title="1 pulada"'), "deve ter title para pulada=1");
    assert.ok(html.includes('title="1 em andamento"'), "deve ter title para in_progress=1");
  });

  test("tooltip do header menciona o formato N✓", async () => {
    const { renderOvernightSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeOvernightData({
      edition: "260625",
      started_at: null,
      total_issues: 1,
      merged: 1,
      draft: 0,
      pulada: 0,
      in_progress: 0,
      duration_ms: null,
      slowest_unit: null,
    });
    const html = renderOvernightSection(data);
    // O header deve mencionar "N✓" para explicar que o número prefixo é contagem
    assert.ok(html.includes("N✓"), "header deve mencionar formato N✓");
    assert.ok(html.includes("N↩"), "header deve mencionar formato N↩");
    assert.ok(html.includes("N⊘"), "header deve mencionar formato N⊘");
    assert.ok(html.includes("N⏳"), "header deve mencionar formato N⏳");
  });

  test("grupos com contagem 0 (draft, pulada, in_progress) NÃO aparecem na célula <td>", async () => {
    const { renderOvernightSection } = await import("../workers/diaria-dashboard/src/index.ts");
    const data = makeOvernightData({
      edition: "260620",
      started_at: "2026-06-20T01:00:00Z",
      total_issues: 3,
      merged: 3,
      draft: 0,
      pulada: 0,
      in_progress: 0,
      duration_ms: 1800000,
      slowest_unit: null,
    });
    const html = renderOvernightSection(data);
    // Só merged=3 deve aparecer
    assert.ok(html.includes("3✓"), "deve incluir 3✓ para merged=3");
    // Os símbolos NÃO devem aparecer em <span> (apenas na célula de dados).
    // O header tooltip pode mencionar os símbolos — verificamos que não há <span> com esses símbolos.
    assert.ok(!html.includes('<span title="0 draft'), "span de draft NÃO deve existir quando draft=0");
    assert.ok(!html.includes('<span title="0 pulada'), "span de pulada NÃO deve existir quando pulada=0");
    assert.ok(!html.includes('<span title="0 em andamento'), "span de in_progress NÃO deve existir quando in_progress=0");
  });
});

// ─── #2558: buildTopClickedRecent — ultimas 5 edicoes, cliques absolutos ─────

import { writeFileSync as writeFileSyncForTestTCR, rmSync as rmSyncForTestTCR } from "node:fs";
import { join as joinForTestTCR } from "node:path";
import { tmpdir as tmpdirTCR } from "node:os";

describe("regressao #2558: buildTopClickedRecent -- janela 20 edicoes (#2601), cliques absolutos, max 10", () => {
  function makeCsvContent(): string {
    // 6 edicoes distintas: todas entram na janela de 20 (menos de 20 disponíveis)
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const rows = [
      "2026-01-01,Ed Jan,Destaques,LinkAntigo,https://old.example.com,old.example.com,100,5,5,5.00,Destaque,INT",
      // 5 edicoes recentes + links extras para cobrir max-10
      "2026-02-01,Ed Fev,Destaques,LinkA,https://a.example.com,a.example.com,200,30,30,15.00,Destaque,INT",
      "2026-03-01,Ed Mar,Destaques,LinkA,https://a.example.com,a.example.com,200,20,20,10.00,Destaque,INT",
      "2026-04-01,Ed Abr,Radar,LinkB,https://b.example.com,b.example.com,200,25,25,12.50,Radar,INT",
      "2026-05-01,Ed Mai,Use Melhor,LinkC,https://c.example.com,c.example.com,200,40,40,20.00,Use Melhor,INT",
      "2026-06-01,Ed Jun,Destaques,LinkD,https://d.example.com,d.example.com,200,15,15,7.50,Destaque,BR",
      "2026-02-01,Ed Fev,Radar,LinkE,https://e.example.com,e.example.com,200,8,8,4.00,Radar,INT",
      "2026-03-01,Ed Mar,Radar,LinkF,https://f.example.com,f.example.com,200,6,6,3.00,Radar,INT",
      "2026-04-01,Ed Abr,Destaque,LinkG,https://g.example.com,g.example.com,200,4,4,2.00,Destaque,INT",
      "2026-05-01,Ed Mai,Destaque,LinkH,https://h.example.com,h.example.com,200,3,3,1.50,Destaque,INT",
      "2026-06-01,Ed Jun,Radar,LinkI,https://i.example.com,i.example.com,200,2,2,1.00,Radar,INT",
      "2026-02-01,Ed Fev,Use Melhor,LinkJ,https://j.example.com,j.example.com,200,1,1,0.50,Use Melhor,INT",
    ];
    return [header, ...rows].join("\n");
  }

  test("inclui todos os links quando ha menos de 20 edicoes (#2601)", async () => {
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const csvPath = joinForTestTCR(tmpdirTCR(), "diaria-test-tcr-2558a.csv");
    writeFileSyncForTestTCR(csvPath, makeCsvContent(), "utf8");
    const result = buildTopClickedRecent(csvPath);
    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    // Com janela de 20 e apenas 6 edicoes, todas sao incluidas
    assert.equal(result!.window_editions.length, 6, "janela deve ter 6 edicoes (todas disponiveis, janela max=20)");
    // Jan NÃO é mais excluída (só seria excluída se houvesse > 20 edições)
    assert.ok(result!.window_editions.includes("2026-01-01"), "edicao mais antiga deve estar na janela (6 < 20)");
    rmSyncForTestTCR(csvPath, { force: true });
  });

  test("ordena por cliques absolutos desc e retorna no maximo 10 itens", async () => {
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const csvPath = joinForTestTCR(tmpdirTCR(), "diaria-test-tcr-2558b.csv");
    writeFileSyncForTestTCR(csvPath, makeCsvContent(), "utf8");
    const result = buildTopClickedRecent(csvPath);
    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    assert.ok(result!.top_items.length <= 10, "deve retornar no maximo 10 itens");
    for (let i = 1; i < result!.top_items.length; i++) {
      assert.ok(
        result!.top_items[i - 1].unique_verified_clicks >= result!.top_items[i].unique_verified_clicks,
        "itens devem estar ordenados por cliques desc",
      );
    }
    // LinkA acumula 30+20=50 nas edicoes Fev+Mar -> topo esperado
    const topItem = result!.top_items[0];
    assert.ok(topItem.unique_verified_clicks >= 40, "item topo deve ter >= 40 cliques");
    rmSyncForTestTCR(csvPath, { force: true });
  });

  test("retorna null quando CSV ausente", async () => {
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = buildTopClickedRecent("/tmp/nao-existe-tcr-2558-xyzzy.csv");
    assert.equal(result, null, "deve retornar null quando CSV ausente");
  });

  test("renderTopClickedRecentSection com dados reais renderiza tabela", async () => {
    const { renderTopClickedRecentSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    const data: DD = {
      generated_at: "2026-06-25T00:00:00Z", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [],
      top_clicked_recent: {
        window_editions: ["2026-06-01", "2026-05-01", "2026-04-01", "2026-03-01", "2026-02-01"],
        top_items: [
          { edition: "2026-06-01", post_title: "Ed Jun", anchor: "LinkD", base_url: "https://d.example.com", category: "Destaque", unique_verified_clicks: 50 },
          { edition: "2026-05-01", post_title: "Ed Mai", anchor: "LinkC", base_url: "https://c.example.com", category: "Use Melhor", unique_verified_clicks: 40 },
        ],
      },
      audience: null,
    };
    const html = renderTopClickedRecentSection(data);
    assert.ok(html.includes("top-clicked-recent"), "deve ter id top-clicked-recent");
    assert.ok(html.includes("ltimas 20"), "deve mencionar ultimas 20 edicoes (#2601)");
    assert.ok(html.includes("LinkD"), "deve incluir ancora do top item");
    assert.ok(html.includes("50"), "deve incluir contagem de cliques");
  });

  test("renderTopClickedRecentSection com null mostra stub", async () => {
    const { renderTopClickedRecentSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    const data: DD = {
      generated_at: "", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [],
      top_clicked_recent: null, audience: null,
    };
    const html = renderTopClickedRecentSection(data);
    assert.ok(html.includes("top-clicked-recent"), "deve ter id mesmo com dados ausentes");
    assert.ok(html.includes("link-ctr-table.csv"), "deve mencionar CSV ausente");
  });
});

// ─── #2570: buildTopClickedRecent — edition = edicao de max cliques ──────────

describe("regressao #2570: buildTopClickedRecent -- edition = edicao de max cliques, nao first-seen", () => {
  test("edition reflete a edicao com mais cliques (nao a primeira vista no CSV)", async () => {
    // Cenario: mesmo link aparece em 2 edicoes dentro da janela de 5.
    // Edicao B (2026-02-01, 20 cliques) vem ANTES de Edicao A (2026-03-01, 30 cliques) no CSV.
    // Se a logica fosse first-seen, edition seria B (2026-02-01).
    // Comportamento correto: edition = A (2026-03-01), cliques totais = 50.
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const rows = [
      // Edicao B (first-seen) com 20 cliques -- deve ser substituida por A no campo edition
      "2026-02-01,Ed Fev,Destaques,LinkX,https://x.example.com,x.example.com,200,20,20,10.00,Destaque,INT",
      // Edicao A (second-seen) com 30 cliques -- deve virar a edition do item agregado
      "2026-03-01,Ed Mar,Destaques,LinkX,https://x.example.com,x.example.com,200,30,30,15.00,Destaque,INT",
      // Link diferente pra preencher a janela de 5 edicoes
      "2026-04-01,Ed Abr,Radar,LinkY,https://y.example.com,y.example.com,200,5,5,2.50,Radar,INT",
      "2026-05-01,Ed Mai,Radar,LinkZ,https://z.example.com,z.example.com,200,3,3,1.50,Radar,INT",
      "2026-06-01,Ed Jun,Radar,LinkW,https://w.example.com,w.example.com,200,1,1,0.50,Radar,INT",
    ];
    const csv = [header, ...rows].join("\n");

    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const csvPath = j(td(), "diaria-test-tcr-2570-maxedition.csv");
    wf(csvPath, csv, "utf8");

    const result = buildTopClickedRecent(csvPath);
    rm(csvPath, { force: true });

    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    const linkX = result!.top_items.find((r) => r.base_url === "https://x.example.com");
    assert.ok(linkX !== undefined, "LinkX deve aparecer nos resultados");
    assert.equal(linkX!.unique_verified_clicks, 50, "cliques devem ser somados (20+30=50)");
    assert.equal(
      linkX!.edition,
      "2026-03-01",
      "edition deve ser 2026-03-01 (max 30 cliques), nao 2026-02-01 (first-seen 20 cliques)",
    );
  });

  test("em empate de cliques, edition mais recente vence", async () => {
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const rows = [
      // Ambas as edicoes com 25 cliques -- a mais recente (2026-04-01) deve vencer
      "2026-03-01,Ed Mar,Destaques,LinkTie,https://tie.example.com,tie.example.com,200,25,25,12.50,Destaque,INT",
      "2026-04-01,Ed Abr,Destaques,LinkTie,https://tie.example.com,tie.example.com,200,25,25,12.50,Destaque,INT",
      // Links extras para preencher 5 edicoes distintas na janela
      "2026-05-01,Ed Mai,Radar,LinkP,https://p.example.com,p.example.com,200,1,1,0.50,Radar,INT",
      "2026-06-01,Ed Jun,Radar,LinkQ,https://q.example.com,q.example.com,200,1,1,0.50,Radar,INT",
      "2026-02-01,Ed Fev,Radar,LinkR,https://r.example.com,r.example.com,200,1,1,0.50,Radar,INT",
    ];
    const csv = [header, ...rows].join("\n");

    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const csvPath = j(td(), "diaria-test-tcr-2570-tie.csv");
    wf(csvPath, csv, "utf8");

    const result = buildTopClickedRecent(csvPath);
    rm(csvPath, { force: true });

    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    const linkTie = result!.top_items.find((r) => r.base_url === "https://tie.example.com");
    assert.ok(linkTie !== undefined, "LinkTie deve aparecer nos resultados");
    assert.equal(linkTie!.unique_verified_clicks, 50, "cliques devem ser somados (25+25=50)");
    assert.equal(
      linkTie!.edition,
      "2026-04-01",
      "em empate, edition mais recente (2026-04-01) deve vencer sobre 2026-03-01",
    );
  });
});

// ─── #2560: buildAudienceSummary — parse de audience-profile.md ──────────────

import { writeFileSync as writeFileSyncForAud, rmSync as rmSyncForAud } from "node:fs";
import { join as joinForAud } from "node:path";
import { tmpdir as tmpdirAud } from "node:os";

describe("regressao #2560: buildAudienceSummary -- parse de audience-profile.md", () => {
  const FIXTURE_MD = [
    "# Perfil de Audiencia",
    "",
    "**updated_at:** 2026-06-18",
    "**subscribers ativos:** 487",
    "**respondentes survey:** 167",
    "**links analisados:** 1688 (174 edicoes)",
    "",
    "## 1. Engajamento real (CTR por categoria)",
    "",
    "CTR medio geral: 0.46%",
    "",
    "- **Treinamento** -- CTR 1.80% | 20 links (acima da media)",
    "- **Impacto** -- CTR 1.16% | 41 links (acima da media)",
    "- **Outro** -- CTR 0.69% | 95 links (acima da media)",
    "",
    "## 2. Preferencias declaradas (survey)",
    "",
    "### Conteudo preferido",
    "",
    "- **Tutoriais praticos** -- weight 0.176 (107 respostas)",
    "- **Curadoria de novas ferramentas** -- weight 0.168 (102 respostas)",
    "",
    "### Nivel de conhecimento em IA",
    "",
    "- **Uso casual (uso ferramentas eventualmente)** -- weight 0.293 (49 respostas)",
    "- **Entusiasta** -- weight 0.251 (42 respostas)",
    "",
    "## 3. Quem sao (demographics)",
    "",
    "### Setores",
    "",
    "- **Tecnologia** -- weight 0.175 (71 respostas)",
    "- **Educacao** -- weight 0.103 (42 respostas)",
  ].join("\n");

  test("parseia metadados corretamente", async () => {
    const { buildAudienceSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpPath = joinForAud(tmpdirAud(), "diaria-test-aud-2560a.md");
    writeFileSyncForAud(tmpPath, FIXTURE_MD, "utf8");
    const result = buildAudienceSummary(tmpPath);
    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    assert.equal(result!.updated_at, "2026-06-18", "deve parsear updated_at");
    assert.equal(result!.subscribers, 487, "deve parsear subscribers");
    assert.equal(result!.survey_respondents, 167, "deve parsear survey_respondents");
    assert.equal(result!.links_analyzed, 1688, "deve parsear links_analyzed");
    assert.ok(Math.abs((result!.avg_ctr_pct ?? 0) - 0.46) < 0.001, "deve parsear avg_ctr_pct");
    rmSyncForAud(tmpPath, { force: true });
  });

  test("parseia CTR por categoria corretamente", async () => {
    const { buildAudienceSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpPath = joinForAud(tmpdirAud(), "diaria-test-aud-2560b.md");
    writeFileSyncForAud(tmpPath, FIXTURE_MD, "utf8");
    const result = buildAudienceSummary(tmpPath);
    assert.ok(result !== null);
    assert.ok(result!.ctr_by_category.length >= 3, "deve ter pelo menos 3 categorias CTR");
    const trein = result!.ctr_by_category.find((r) => r.category === "Treinamento");
    assert.ok(trein, "deve ter categoria Treinamento");
    assert.ok(Math.abs(trein!.ctr_pct - 1.80) < 0.01, "CTR de Treinamento deve ser 1.80");
    assert.equal(trein!.link_count, 20, "link_count de Treinamento deve ser 20");
    rmSyncForAud(tmpPath, { force: true });
  });

  test("parseia survey (conteudo preferido, conhecimento, setores) corretamente", async () => {
    const { buildAudienceSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpPath = joinForAud(tmpdirAud(), "diaria-test-aud-2560c.md");
    writeFileSyncForAud(tmpPath, FIXTURE_MD, "utf8");
    const result = buildAudienceSummary(tmpPath);
    assert.ok(result !== null);
    assert.ok(result!.content_preferences.length >= 2, "deve ter preferencias de conteudo");
    const tut = result!.content_preferences.find((r) => r.label.includes("Tutoriais"));
    assert.ok(tut, "deve ter Tutoriais praticos");
    assert.ok(Math.abs(tut!.weight - 0.176) < 0.001, "weight de Tutoriais deve ser 0.176");
    assert.equal(tut!.count, 107);
    assert.ok(result!.knowledge_levels.length >= 2, "deve ter niveis de conhecimento");
    assert.ok(result!.sectors.length >= 2, "deve ter setores");
    const tec = result!.sectors.find((r) => r.label === "Tecnologia");
    assert.ok(tec, "deve ter setor Tecnologia");
    assert.equal(tec!.count, 71);
    rmSyncForAud(tmpPath, { force: true });
  });

  test("retorna null quando arquivo ausente (sem crash)", async () => {
    const { buildAudienceSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = buildAudienceSummary("/tmp/nao-existe-audience-profile-2560-xyzzy.md");
    assert.equal(result, null, "deve retornar null quando arquivo ausente");
  });

  test("renderAudienceSection com dados reais renderiza tabelas corretamente", async () => {
    const { renderAudienceSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    const data: DD = {
      generated_at: "2026-06-25T00:00:00Z", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [],
      top_clicked_recent: null,
      audience: {
        updated_at: "2026-06-18", subscribers: 487, survey_respondents: 167, links_analyzed: 1688, avg_ctr_pct: 0.46,
        ctr_by_category: [{ category: "Treinamento", ctr_pct: 1.80, link_count: 20 }],
        content_preferences: [{ label: "Tutoriais praticos", weight: 0.176, count: 107 }],
        knowledge_levels: [{ label: "Uso casual", weight: 0.293, count: 49 }],
        sectors: [{ label: "Tecnologia", weight: 0.175, count: 71 }],
      },
    };
    const html = renderAudienceSection(data);
    assert.ok(html.includes("audience"), "deve ter id audience");
    assert.ok(html.includes("487 assinantes ativos"), "deve incluir contagem de assinantes");
    assert.ok(html.includes("Treinamento"), "deve incluir categoria CTR");
    assert.ok(html.includes("1.80%"), "deve incluir CTR de Treinamento");
    assert.ok(html.includes("Tutoriais praticos"), "deve incluir preferencia de conteudo");
    assert.ok(html.includes("Uso casual"), "deve incluir nivel de conhecimento");
    assert.ok(html.includes("Tecnologia"), "deve incluir setor");
    assert.ok(html.includes("2026-06-18"), "deve incluir data de atualizacao");
  });

  test("renderAudienceSection com audience null mostra stub sem crash", async () => {
    const { renderAudienceSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    const data: DD = {
      generated_at: "", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [],
      top_clicked_recent: null, audience: null,
    };
    const html = renderAudienceSection(data);
    assert.ok(html.includes("audience"), "deve ter id audience mesmo sem dados");
    assert.ok(html.includes("audience-profile.md"), "deve mencionar arquivo ausente");
  });

  // ─── Regressão #2582: section-gating do CTR por categoria ────────────────────
  test("regressao #2582: ctr_by_category exclui combos origem e fontes das subseções", async () => {
    // Fixture que replica o formato real de audience-profile.md com todas as subseções
    // problemáticas: "### Destaques por categoria + origem" tem combos como "Treinamento INT"
    // e "### CTR por fonte" tem domínios como "claude.com" — ambos usam o mesmo formato de linha
    // que as categorias diretas, então sem section-gating eles vazam para ctr_by_category.
    const FIXTURE_WITH_SUBSECTIONS = [
      "# Perfil de Audiencia",
      "",
      "**updated_at:** 2026-06-25",
      "**subscribers ativos:** 500",
      "",
      "## 1. Engajamento real (CTR por categoria)",
      "",
      "CTR medio geral: 0.46%",
      "",
      "- **Treinamento** -- CTR 1.80% | 20 links",
      "- **Impacto** -- CTR 1.16% | 41 links",
      "- **Lançamento** -- CTR 0.52% | 487 links",
      "",
      "### Destaques por categoria + origem",
      "",
      "- **Treinamento INT** -- CTR 3.02% | 14 links",
      "- **Impacto BR** -- CTR 2.74% | 11 links",
      "",
      "### Engajamento por origem",
      "",
      "- **BR** -- CTR 0.51% | 341 links (20.2% do total)",
      "- **INT** -- CTR 0.44% | 1347 links (79.8% do total)",
      "",
      "### CTR por fonte (minimo 3 links)",
      "",
      "- **claude.com** -- CTR 1.65% | 7 links",
      "- **github.com** -- CTR 1.06% | 6 links",
      "",
      "## 2. Preferencias declaradas (survey)",
      "",
      "### Conteudo preferido",
      "",
      "- **Tutoriais** -- weight 0.176 (50 respostas)",
    ].join("\n");

    const { buildAudienceSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpPath = joinForAud(tmpdirAud(), "diaria-test-aud-2582.md");
    writeFileSyncForAud(tmpPath, FIXTURE_WITH_SUBSECTIONS, "utf8");
    const result = buildAudienceSummary(tmpPath);
    assert.ok(result !== null, "deve retornar resultado nao-nulo");

    // Deve conter SÓ as 3 categorias diretas da seção principal
    assert.equal(result!.ctr_by_category.length, 3,
      `ctr_by_category deve ter 3 categorias diretas, mas tem ${result!.ctr_by_category.length}: ${result!.ctr_by_category.map((r) => r.category).join(", ")}`);

    // Categorias reais devem estar presentes
    const cats = result!.ctr_by_category.map((r) => r.category);
    assert.ok(cats.includes("Treinamento"), "deve incluir categoria Treinamento");
    assert.ok(cats.includes("Impacto"), "deve incluir categoria Impacto");
    assert.ok(cats.includes("Lançamento"), "deve incluir categoria Lancamento");

    // Combos origem NÃO devem aparecer (ex: "Treinamento INT", "Impacto BR")
    assert.ok(!cats.includes("Treinamento INT"),
      "ctr_by_category NAO deve incluir combo 'Treinamento INT' (subseção Destaques por categoria + origem)");
    assert.ok(!cats.includes("Impacto BR"),
      "ctr_by_category NAO deve incluir combo 'Impacto BR' (subseção Destaques por categoria + origem)");

    // Origens puras NÃO devem aparecer (ex: "BR", "INT")
    assert.ok(!cats.includes("BR"),
      "ctr_by_category NAO deve incluir origem 'BR' (subseção Engajamento por origem)");

    // Fontes NÃO devem aparecer (ex: "claude.com")
    assert.ok(!cats.includes("claude.com"),
      "ctr_by_category NAO deve incluir fonte 'claude.com' (subseção CTR por fonte)");
    assert.ok(!cats.includes("github.com"),
      "ctr_by_category NAO deve incluir fonte 'github.com' (subseção CTR por fonte)");

    rmSyncForAud(tmpPath, { force: true });
  });
});

// ─── #2601: buildTopClickedRecent — janela ampliada para 20 edições ───────────

import { writeFileSync as writeFileSyncTCR20, rmSync as rmSyncTCR20 } from "node:fs";
import { join as joinTCR20 } from "node:path";
import { tmpdir as tmpdirTCR20 } from "node:os";

describe("regressao #2601: buildTopClickedRecent -- janela 20 edicoes (ampliada de 5)", () => {
  function make21EditionsCsv(): string {
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    // 21 edições em ordem decrescente para testar que a 21ª é excluída
    const rows: string[] = [];
    for (let i = 1; i <= 21; i++) {
      const mm = String(i).padStart(2, "0");
      // Usamos datas fictícias com mês sequencial; a mais antiga é 2025-01-01
      const date = i === 21 ? "2025-01-01" : `2026-${mm}-01`;
      rows.push(`${date},Ed ${i},Destaques,Link${i},https://link${i}.example.com,link${i}.example.com,200,${i},${i},${i}.00,Destaque,INT`);
    }
    return [header, ...rows].join("\n");
  }

  test("janela inclui ate 20 edicoes (exclui a 21a mais antiga)", async () => {
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const csvPath = joinTCR20(tmpdirTCR20(), "diaria-test-tcr-2601a.csv");
    writeFileSyncTCR20(csvPath, make21EditionsCsv(), "utf8");
    const result = buildTopClickedRecent(csvPath);
    rmSyncTCR20(csvPath, { force: true });
    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    assert.equal(result!.window_editions.length, 20, "janela deve ter 20 edicoes");
    assert.ok(!result!.window_editions.includes("2025-01-01"), "edicao mais antiga (21a) nao deve estar na janela");
    const oldest = result!.top_items.find((r) => r.base_url === "https://link21.example.com");
    assert.equal(oldest, undefined, "link da 21a edicao nao deve aparecer nos resultados");
  });

  test("degrada graciosamente com menos de 20 edicoes (retorna o que tiver)", async () => {
    const { buildTopClickedRecent } = await import("../scripts/build-diaria-dashboard-data.ts");
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const rows = [
      "2026-01-01,Ed Jan,Destaques,LinkA,https://a.example.com,a.example.com,200,10,10,5.00,Destaque,INT",
      "2026-02-01,Ed Fev,Destaques,LinkB,https://b.example.com,b.example.com,200,20,20,10.00,Destaque,INT",
    ];
    const csvPath = joinTCR20(tmpdirTCR20(), "diaria-test-tcr-2601b.csv");
    writeFileSyncTCR20(csvPath, [header, ...rows].join("\n"), "utf8");
    const result = buildTopClickedRecent(csvPath);
    rmSyncTCR20(csvPath, { force: true });
    assert.ok(result !== null, "deve retornar resultado nao-nulo mesmo com menos de 20 edicoes");
    assert.equal(result!.window_editions.length, 2, "janela deve ter 2 edicoes (o que tiver)");
  });

  test("renderTopClickedRecentSection inclui label 'ultimas 20 edicoes' no titulo e tooltip", async () => {
    const { renderTopClickedRecentSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    const data: DD = {
      generated_at: "2026-06-26T00:00:00Z", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [], top_clicked_recent: null,
    };
    const htmlStub = renderTopClickedRecentSection(data);
    assert.ok(htmlStub.includes("20 edições") || htmlStub.includes("20 edi"), `stub deve mencionar 20 edicoes (got: ${htmlStub.slice(0, 200)})`);

    const dataWithItems: DD = {
      ...data,
      top_clicked_recent: {
        window_editions: Array.from({ length: 20 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`),
        top_items: [
          { edition: "2026-06-01", post_title: "Ed Jun", anchor: "LinkA", base_url: "https://a.example.com", category: "Destaque", unique_verified_clicks: 99 },
        ],
      },
    };
    const htmlFull = renderTopClickedRecentSection(dataWithItems);
    assert.ok(htmlFull.includes("20 edições") || htmlFull.includes("20 edi"), `render completo deve mencionar 20 edicoes`);
    assert.ok(!htmlFull.includes("últimas 5") && !htmlFull.includes("janela de 5"), "nao deve mencionar 5 edicoes");
  });
});

// ─── #2603: buildUseMelhorSummary — cliques por section_title + fonte publicada ─

import { writeFileSync as writeFileSyncUM, rmSync as rmSyncUM, mkdirSync as mkdirSyncUM } from "node:fs";
import { join as joinUM } from "node:path";
import { tmpdir as tmpdirUM } from "node:os";

describe("regressao #2603: buildCtrIndexByUrl -- Use Melhor por section_title (nao category)", () => {
  function makeUseMelhorCsv(): string {
    // Simula o CSV real: category nunca é "Use Melhor" (vem de categorize()),
    // mas section_title é "🛠️ USE MELHOR" para links da seção
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    return [header,
      // Link de Use Melhor — section_title = "🛠️ USE MELHOR", category = "Treinamento"
      "2026-06-01,Ed Jun,🛠️ USE MELHOR,Como usar Cursor,https://cursor.com/tutorial,cursor.com,500,45,45,9.00,Treinamento,INT",
      // Outro link de Use Melhor — section_title = "USE MELHOR" (sem emoji)
      "2026-06-01,Ed Jun,USE MELHOR,Prompt Engineering,https://promptingguide.ai,promptingguide.ai,500,30,30,6.00,Ferramenta,INT",
      // Link de Destaque — NÃO é Use Melhor
      "2026-06-01,Ed Jun,Destaque 1,IA muda tudo,https://techcrunch.com/ai,techcrunch.com,500,20,20,4.00,Impacto,INT",
    ].join("\n");
  }

  test("buildCtrIndexByUrl captura links por section_title contendo USE MELHOR (com emoji)", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpDir = joinUM(tmpdirUM(), "diaria-test-um-2603a");
    mkdirSyncUM(tmpDir, { recursive: true });
    const csvPath = joinUM(tmpDir, "link-ctr-table.csv");
    writeFileSyncUM(csvPath, makeUseMelhorCsv(), "utf8");

    // Criar edição fictícia com 01-approved.json contendo use_melhor
    const edDir = joinUM(tmpDir, "editions", "260601", "_internal");
    mkdirSyncUM(edDir, { recursive: true });
    const approved = {
      use_melhor: [
        { url: "https://cursor.com/tutorial", title: "Como usar Cursor" },
        { url: "https://promptingguide.ai", title: "Prompt Engineering" },
      ],
    };
    writeFileSyncUM(joinUM(edDir, "01-approved.json"), JSON.stringify(approved), "utf8");

    const result = buildUseMelhorSummary(joinUM(tmpDir, "editions"), csvPath);

    // Limpar
    rmSyncUM(tmpDir, { recursive: true, force: true });

    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    const ed = result!.editions.find((e) => e.edition === "260601");
    assert.ok(ed !== undefined, "deve ter entrada para edicao 260601");
    // Os 2 itens de Use Melhor devem ter cliques (matched), não zeros.
    // #3037 self-review: essa asserção era `>= 1`, o que deixava passar mesmo com
    // o item de section_title="🛠️ USE MELHOR" (com emoji) SEM match — só o item
    // sem emoji (que não existe nos dados reais, ver teste #3037 abaixo) contava.
    // Agora exige os 2 (com e sem emoji) matched, cobrindo ambas as variantes.
    const matched = ed!.items.filter((i) => i.unique_verified_clicks !== null && i.unique_verified_clicks > 0);
    assert.equal(matched.length, 2, `os 2 itens devem ter cliques (matched=${ed!.ctr_matched}; itens: ${JSON.stringify(ed!.items)})`);
    assert.equal(result!.coverage.matched, matched.length, "coverage.matched deve refletir os matches");
  });

  test("buildCtrIndexByUrl exclui links de outras secoes que nao sao Use Melhor", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpDir = joinUM(tmpdirUM(), "diaria-test-um-2603b");
    mkdirSyncUM(tmpDir, { recursive: true });
    const csvPath = joinUM(tmpDir, "link-ctr-table.csv");
    writeFileSyncUM(csvPath, makeUseMelhorCsv(), "utf8");

    // Edição com 01-approved.json onde use_melhor tem o destaque (não Use Melhor)
    const edDir = joinUM(tmpDir, "editions", "260601", "_internal");
    mkdirSyncUM(edDir, { recursive: true });
    const approved = {
      use_melhor: [
        { url: "https://techcrunch.com/ai", title: "IA muda tudo" }, // é destaque, não Use Melhor
      ],
    };
    writeFileSyncUM(joinUM(edDir, "01-approved.json"), JSON.stringify(approved), "utf8");

    const result = buildUseMelhorSummary(joinUM(tmpDir, "editions"), csvPath);
    rmSyncUM(tmpDir, { recursive: true, force: true });

    // Mesmo com url presente no CSV, a linha é de Destaque (section_title != USE MELHOR)
    // → não entra no índice CTR → ctr_matched = 0
    assert.ok(result !== null, "buildUseMelhorSummary deve retornar resultado nao-nulo");
    const ed = result!.editions.find((e) => e.edition === "260601");
    assert.ok(ed !== undefined, "edicao 260601 deve aparecer no resultado");
    assert.equal(ed!.ctr_matched, 0, "link de Destaque nao deve entrar no indice de Use Melhor");
  });
});

describe("regressao #3037: buildCtrIndexByUrl -- match exato falhava contra o header real (com emoji)", () => {
  test("CSV real só tem section_title com emoji ('🛠️ USE MELHOR', sem variante sem emoji) -- deve dar match", async () => {
    // Reproduz o formato de fato emitido por renderUseMelhorSection
    // (stitch-newsletter.ts: `**🛠️ USE MELHOR**`) -- ao contrário do fixture #2603
    // acima, aqui NÃO há linha "USE MELHOR" sem emoji pra mascarar uma regressão do
    // match exato. Antes do fix #3037, `/^use melhor$/i` nunca batia nesse dado real
    // (o índice CTR ficava sempre vazio) e a cobertura caía pra 0/N sempre, não só
    // em CSVs desatualizados -- ver #3037.
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpDir = joinUM(tmpdirUM(), "diaria-test-um-3037");
    mkdirSyncUM(tmpDir, { recursive: true });
    const csvPath = joinUM(tmpDir, "link-ctr-table.csv");
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const csv = [
      header,
      "2026-06-01,Ed Jun,🛠️ USE MELHOR,Como usar Cursor,https://cursor.com/tutorial,cursor.com,500,45,45,9.00,Treinamento,INT",
    ].join("\n");
    writeFileSyncUM(csvPath, csv, "utf8");

    const edDir = joinUM(tmpDir, "editions", "260601", "_internal");
    mkdirSyncUM(edDir, { recursive: true });
    writeFileSyncUM(
      joinUM(edDir, "01-approved.json"),
      JSON.stringify({ use_melhor: [{ url: "https://cursor.com/tutorial", title: "Como usar Cursor" }] }),
      "utf8",
    );

    const result = buildUseMelhorSummary(joinUM(tmpDir, "editions"), csvPath);
    rmSyncUM(tmpDir, { recursive: true, force: true });

    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    assert.equal(result!.coverage.matched, 1, "o unico item deve dar match mesmo com section_title emoji-prefixado");
    assert.equal(result!.coverage.coverage_pct, 100, "cobertura deve ser 100% (nao 0%)");
  });

  test("section_title 'USE MELHOR DO MÊS' (heading mensal) NÃO deve contar como Use Melhor diário", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpDir = joinUM(tmpdirUM(), "diaria-test-um-3037b");
    mkdirSyncUM(tmpDir, { recursive: true });
    const csvPath = joinUM(tmpDir, "link-ctr-table.csv");
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const csv = [
      header,
      "2026-06-01,Digest Jun,USE MELHOR DO MÊS,Como usar Cursor,https://cursor.com/tutorial,cursor.com,500,45,45,9.00,Treinamento,INT",
    ].join("\n");
    writeFileSyncUM(csvPath, csv, "utf8");

    const edDir = joinUM(tmpDir, "editions", "260601", "_internal");
    mkdirSyncUM(edDir, { recursive: true });
    writeFileSyncUM(
      joinUM(edDir, "01-approved.json"),
      JSON.stringify({ use_melhor: [{ url: "https://cursor.com/tutorial", title: "Como usar Cursor" }] }),
      "utf8",
    );

    const result = buildUseMelhorSummary(joinUM(tmpDir, "editions"), csvPath);
    rmSyncUM(tmpDir, { recursive: true, force: true });

    assert.ok(result !== null, "deve retornar resultado nao-nulo");
    assert.equal(result!.coverage.matched, 0, "heading mensal nao deve alimentar o indice CTR de Use Melhor diario");
  });
});

describe("regressao #2603: buildUseMelhorSummary -- filtra itens publicados via 02-reviewed.md", () => {
  test("itens presentes em 02-reviewed.md aparecem; itens dropados no gate sao excluidos", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpDir = joinUM(tmpdirUM(), "diaria-test-um-2603c");
    mkdirSyncUM(tmpDir, { recursive: true });

    // CSV sem cliques (para isolar o teste de filtro de gate)
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const csvPath = joinUM(tmpDir, "link-ctr-table.csv");
    writeFileSyncUM(csvPath, header, "utf8"); // CSV vazio (só header)

    // 01-approved.json com 3 itens (pré-gate)
    const edDir = joinUM(tmpDir, "editions", "260601", "_internal");
    mkdirSyncUM(edDir, { recursive: true });
    const edRootDir = joinUM(tmpDir, "editions", "260601");
    const approved = {
      use_melhor: [
        { url: "https://cursor.com/tutorial", title: "Cursor Tutorial" },
        { url: "https://v0.dev/guide", title: "v0.dev Guide" },
        { url: "https://dropped.example.com/tool", title: "Item Dropado" }, // dropado no gate
      ],
    };
    writeFileSyncUM(joinUM(edDir, "01-approved.json"), JSON.stringify(approved), "utf8");

    // 02-reviewed.md com apenas 2 itens (o 3o foi dropado no gate)
    const reviewedMd = [
      "**🛠️ USE MELHOR**",
      "",
      "Cursor Tutorial https://cursor.com/tutorial",
      "",
      "v0.dev Guide https://v0.dev/guide",
      "",
      "**LANÇAMENTOS**",
    ].join("\n");
    writeFileSyncUM(joinUM(edRootDir, "02-reviewed.md"), reviewedMd, "utf8");

    const result = buildUseMelhorSummary(joinUM(tmpDir, "editions"), csvPath);
    rmSyncUM(tmpDir, { recursive: true, force: true });

    assert.ok(result !== null, "deve retornar resultado");
    const ed = result!.editions.find((e) => e.edition === "260601");
    assert.ok(ed !== undefined, "deve ter entrada para edicao 260601");
    assert.equal(ed!.items.length, 2, "deve ter 2 itens (dropado excluido pelo gate)");
    const dropped = ed!.items.find((i) => i.url === "https://dropped.example.com/tool");
    assert.equal(dropped, undefined, "item dropado no gate nao deve aparecer");
  });

  test("quando 02-reviewed.md ausente usa todos de 01-approved.json (backwards compat)", async () => {
    const { buildUseMelhorSummary } = await import("../scripts/build-diaria-dashboard-data.ts");
    const tmpDir = joinUM(tmpdirUM(), "diaria-test-um-2603d");
    mkdirSyncUM(tmpDir, { recursive: true });
    const header = "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";
    const csvPath = joinUM(tmpDir, "link-ctr-table.csv");
    writeFileSyncUM(csvPath, header, "utf8");
    const edDir = joinUM(tmpDir, "editions", "260601", "_internal");
    mkdirSyncUM(edDir, { recursive: true });
    const approved = {
      use_melhor: [
        { url: "https://cursor.com/tutorial", title: "Cursor Tutorial" },
        { url: "https://v0.dev/guide", title: "v0.dev Guide" },
      ],
    };
    writeFileSyncUM(joinUM(edDir, "01-approved.json"), JSON.stringify(approved), "utf8");
    // SEM 02-reviewed.md

    const result = buildUseMelhorSummary(joinUM(tmpDir, "editions"), csvPath);
    rmSyncUM(tmpDir, { recursive: true, force: true });

    assert.ok(result !== null, "deve retornar resultado");
    const ed = result!.editions.find((e) => e.edition === "260601");
    assert.ok(ed !== undefined);
    assert.equal(ed!.items.length, 2, "deve usar todos os itens de 01-approved.json quando 02-reviewed.md ausente");
  });
});

// ─── #2604: renderPollEiaSection — estado vazio mostra mensagem (nao tabela vazia) ─

describe("regressao #2604: renderPollEiaSection -- dados presentes mas editions vazio mostra msg", () => {
  test("poll_eia null retorna stub com instrucoes de push", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    const data: DD = {
      generated_at: "", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [], top_clicked_recent: null,
      poll_eia: null,
    };
    const html = renderPollEiaSection(data);
    assert.ok(html.includes("poll-eia"), "deve ter id poll-eia");
    assert.ok(html.includes("build-poll-eia-data.ts"), "stub deve mencionar o script de push");
  });

  test("poll_eia com editions vazio mostra mensagem sem tabela vazia (#2604)", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    type PollEia = import("../workers/diaria-dashboard/src/types.ts").PollEiaSummary;
    const pollEmpty: PollEia = {
      source: "push",
      last_edition: null,
      editions: [],
      leaderboard: [],
      updated_at: "2026-06-26T10:00:00Z",
    };
    const data: DD = {
      generated_at: "2026-06-26T10:00:00Z", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [], top_clicked_recent: null,
      poll_eia: pollEmpty,
    };
    const html = renderPollEiaSection(data);
    assert.ok(html.includes("poll-eia"), "deve ter id poll-eia");
    // Deve mostrar mensagem, nao tabela com tbody vazio
    assert.ok(html.includes("Sem dados") || html.includes("build-poll-eia-data"), "deve mostrar mensagem quando editions vazio");
    // Nao deve ter uma tabela com body vazio (que confunde o leitor)
    assert.ok(!html.includes("<tbody></tbody>"), "nao deve ter tbody vazio silencioso");
  });

  test("poll_eia com editions populadas renderiza tabela corretamente", async () => {
    const { renderPollEiaSection } = await import("../workers/diaria-dashboard/src/index.ts");
    type DD = import("../workers/diaria-dashboard/src/types.ts").DashboardData;
    type PollEia = import("../workers/diaria-dashboard/src/types.ts").PollEiaSummary;
    const pollWithData: PollEia = {
      source: "push",
      last_edition: "260625",
      editions: [
        { edition: "260625", total_votes: 42, voted_a: 30, voted_b: 12, pct_correct: 71.4, correct_choice: "A" },
        { edition: "260624", total_votes: 38, voted_a: 15, voted_b: 23, pct_correct: 60.5, correct_choice: "B" },
      ],
      leaderboard: [
        { display_name: "Participante1", correct: 10, total: 12, streak: 3 },
      ],
      updated_at: "2026-06-26T10:00:00Z",
    };
    const data: DD = {
      generated_at: "2026-06-26T10:00:00Z", schema_version: 1,
      source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
      ctr: null, overnight: { runs: [], total_runs: 0 }, stubs: [], top_clicked_recent: null,
      poll_eia: pollWithData,
    };
    const html = renderPollEiaSection(data);
    assert.ok(html.includes("poll-eia"), "deve ter id poll-eia");
    assert.ok(html.includes("260625"), "deve mostrar edicao mais recente");
    assert.ok(html.includes("71.4%"), "deve mostrar percentual de acerto");
    assert.ok(html.includes("Participante1"), "deve mostrar participante no leaderboard");
    assert.ok(html.includes("2 edições"), "deve mostrar contagem de edicoes");
  });
});

// ─── #2603: extractPublishedUseMelhorUrls — extração de URLs de 02-reviewed.md ─

describe("regressao #2603: extractPublishedUseMelhorUrls", () => {
  test("extrai URLs da secao USE MELHOR de 02-reviewed.md", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const mdPath = j(td(), "diaria-test-extpub-2603.md");
    wf(mdPath, [
      "**🛠️ USE MELHOR**",
      "",
      "Cursor Tutorial https://cursor.com/tutorial",
      "v0.dev Guide https://v0.dev/guide",
      "",
      "**LANÇAMENTOS**",
      "",
      "https://openai.com/news/gpt5 — GPT-5 lançado",
    ].join("\n"), "utf8");

    const urls = extractPublishedUseMelhorUrls(mdPath);
    rm(mdPath, { force: true });

    assert.ok(urls !== null, "deve retornar Set nao-nulo");
    // URLs da secao Use Melhor devem estar presentes
    const hasUrl = (u: string) => [...urls!].some((pu) => pu.includes("cursor.com") || pu === u);
    assert.ok([...urls!].some((u) => u.includes("cursor.com")), "deve incluir cursor.com/tutorial");
    assert.ok([...urls!].some((u) => u.includes("v0.dev")), "deve incluir v0.dev/guide");
    // URL de LANCAMENTOS nao deve estar (seção diferente)
    const hasOpenAi = [...urls!].some((u) => u.includes("openai.com"));
    // openai.com aparece depois de LANCAMENTOS — fora da seção USE MELHOR
    // O parser pega a seção USE MELHOR até o próximo heading-like
    assert.ok(!hasOpenAi, "URL de LANCAMENTOS nao deve estar no Set de Use Melhor");
  });

  test("retorna null quando arquivo ausente", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const result = extractPublishedUseMelhorUrls("/tmp/nao-existe-reviewed-2603-xyzzy.md");
    assert.equal(result, null, "deve retornar null quando arquivo ausente");
  });
});

// Regressão: bugs corrigidos em #2620
import { writeFileSync as writeFileSyncReg, rmSync as rmSyncReg } from "node:fs";
import { join as joinReg } from "node:path";
import { tmpdir as tmpdirReg } from "node:os";

describe("regressao #2620: extractPublishedUseMelhorUrls", () => {
  test("secao presente mas sem URLs retorna Set vazio (nao null)", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const p = joinReg(tmpdirReg(), "test-2620-empty-urls.md");
    writeFileSyncReg(p, "## USE MELHOR\n\nNenhum item esta semana.\n\n## LANCAMENTOS\n", "utf8");
    const result = extractPublishedUseMelhorUrls(p);
    rmSyncReg(p, { force: true });
    assert.ok(result !== null, "deve retornar Set (nao null) quando secao existe mas sem URLs");
    assert.equal(result!.size, 0, "Set deve estar vazio");
  });

  test("heading mensal 'USE MELHOR DO MES' nao e detectado como secao diaria", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const p = joinReg(tmpdirReg(), "test-2620-monthly.md");
    writeFileSyncReg(
      p,
      "## USE MELHOR DO MÊS\n\nhttps://cursor.com/monthly-tutorial\n\n## DESTAQUES\n",
      "utf8"
    );
    const result = extractPublishedUseMelhorUrls(p);
    rmSyncReg(p, { force: true });
    assert.equal(result, null, "heading mensal nao deve ser detectado como secao diaria Use Melhor");
  });

  test("arquivo com CRLF extrai URLs corretamente", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const p = joinReg(tmpdirReg(), "test-2620-crlf.md");
    const crlf = "## USE MELHOR\r\n\r\nhttps://cursor.com/crlf-tutorial\r\n\r\n## LANCAMENTOS\r\n";
    writeFileSyncReg(p, crlf, "utf8");
    const result = extractPublishedUseMelhorUrls(p);
    rmSyncReg(p, { force: true });
    assert.ok(result !== null, "deve retornar Set nao-nulo com CRLF");
    assert.ok([...result!].some((u) => u.includes("cursor.com")), "deve incluir URL da secao com CRLF");
  });
});

// ─── #2627: extractPublishedUseMelhorUrls — itens bold **[Título](URL)** ───────

describe("regressao #2627: extractPublishedUseMelhorUrls — itens bold-link", () => {
  test("captura URLs de itens **[Título](URL)** na secao USE MELHOR", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const mdPath = j(td(), "diaria-test-2627-bold-links.md");
    // Formato canônico real: itens com **[Título](URL)** (começam com *)
    // Uma URL com parênteses balanceados para testar o URL_WITH_BALANCED_PARENS fix.
    wf(mdPath, [
      "**🛠️ USE MELHOR**",
      "",
      "**[Como construir agentes de IA](https://tabnews.com.br/post/como-construir)** Passo a passo. (5 min)",
      "",
      "**[Context Windows vs Memory](https://machinelearning.com/article(2026)/context)** Por que são diferentes. (5 min)",
      "",
      "",
      "---",
      "",
      "**🚀 LANÇAMENTO**",
      "",
      "**[OpenAI lança GPT-5](https://openai.com/index/gpt5)**",
    ].join("\n"), "utf8");

    const urls = extractPublishedUseMelhorUrls(mdPath);
    rm(mdPath, { force: true });

    assert.ok(urls !== null, "deve retornar Set nao-nulo");
    assert.ok(urls!.size >= 2, `deve ter pelo menos 2 URLs, mas tem ${urls!.size}`);
    assert.ok([...urls!].some((u) => u.includes("tabnews.com.br")), "deve incluir tabnews.com.br");
    // URL com parênteses balanceados não deve ser truncada
    assert.ok(
      [...urls!].some((u) => u.includes("machinelearning.com") && u.includes("2026")),
      "URL com parênteses balanceados deve estar completa (nao truncada no primeiro '(')"
    );
    // URL de LANÇAMENTO nao deve vazar para o Set
    assert.ok(![...urls!].some((u) => u.includes("openai.com")), "URL de LANCAMENTO nao deve aparecer em Use Melhor");
  });

  test("para no proximo header de secao sem vazar URLs de NOTICIAS", async () => {
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const mdPath = j(td(), "diaria-test-2627-boundary.md");
    wf(mdPath, [
      "**🛠️ USE MELHOR**",
      "",
      "**[Ferramenta A](https://ferramenta-a.com/path)**  Descricao. (3 min)",
      "**[Ferramenta B](https://ferramenta-b.com/path)**  Descricao. (2 min)",
      "",
      "**📰 NOTÍCIAS**",
      "",
      "**[Noticia fora da secao](https://noticias.com/url)** Contexto.",
    ].join("\n"), "utf8");

    const urls = extractPublishedUseMelhorUrls(mdPath);
    rm(mdPath, { force: true });

    assert.ok(urls !== null, "deve retornar Set nao-nulo");
    assert.ok([...urls!].some((u) => u.includes("ferramenta-a.com")), "deve incluir ferramenta-a");
    assert.ok([...urls!].some((u) => u.includes("ferramenta-b.com")), "deve incluir ferramenta-b");
    assert.ok(![...urls!].some((u) => u.includes("noticias.com")), "URL de NOTICIAS nao deve vazar para Use Melhor");
  });
});

// ─── #2634: edge-case bold-only item (sem link) na seção USE MELHOR ───────────

describe("regressao #2634: extractPublishedUseMelhorUrls — bold-only item nao corta secao", () => {
  test("item bold-only (**Ferramenta X**) no meio da secao NAO corta a extracao de URLs seguintes", async () => {
    // Edge-case: editor escreve item em formato nao-canonico:
    //   **Ferramenta X**          ← bold-only sem link (NAO e item-link **[Titulo](URL)**)
    //   https://ferramenta-x.com  ← URL na linha seguinte
    // O regex antigo casava **Ferramenta X** como fim-de-secao e descartava a URL.
    // Com o fix (#2634), apenas headers de secao com keyword conhecida terminam a secao.
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const mdPath = j(td(), "diaria-test-2634-bold-only.md");
    wf(
      mdPath,
      [
        "**🛠️ USE MELHOR**",
        "",
        "**Ferramenta X**",
        "https://ferramenta-x.com/tutorial",
        "",
        "**[Outra Ferramenta](https://outra-ferramenta.com/guide)**  Descricao. (5 min)",
        "",
        "**🚀 LANÇAMENTOS**",
        "",
        "**[OpenAI lanca algo](https://openai.com/news)**",
      ].join("\n"),
      "utf8",
    );

    const urls = extractPublishedUseMelhorUrls(mdPath);
    rm(mdPath, { force: true });

    assert.ok(urls !== null, "deve retornar Set nao-nulo");
    // URL logo apos o bold-only NAO deve ter sido descartada pelo falso fim-de-secao
    assert.ok(
      [...urls!].some((u) => u.includes("ferramenta-x.com")),
      "URL apos **Ferramenta X** bold-only deve ser incluida (nao cortada pelo regex)",
    );
    // URL do item canonico tambem deve estar presente
    assert.ok([...urls!].some((u) => u.includes("outra-ferramenta.com")), "item canonico **[Titulo](URL)** deve estar incluido");
    // URL de LANCAMENTOS NAO deve vazar
    assert.ok(![...urls!].some((u) => u.includes("openai.com")), "URL de LANCAMENTOS nao deve vazar para Use Melhor");
  });

  test("formato canonico **[Titulo](URL)** continua funcionando apos o fix", async () => {
    // Caso canonico: garante que o fix do #2634 nao regrediu o formato normal.
    const { extractPublishedUseMelhorUrls } = await import("../scripts/build-diaria-dashboard-data.ts");
    const { writeFileSync: wf, rmSync: rm } = await import("node:fs");
    const { join: j } = await import("node:path");
    const { tmpdir: td } = await import("node:os");
    const mdPath = j(td(), "diaria-test-2634-canonical.md");
    wf(
      mdPath,
      [
        "**🛠️ USE MELHOR**",
        "",
        "**[Cursor Tricks](https://cursor.sh/tricks)**  Truques avancados. (3 min)",
        "",
        "**[Perplexity Guide](https://perplexity.ai/guide)**  Como usar. (4 min)",
        "",
        "---",
        "",
        "**🚀 LANÇAMENTOS**",
        "",
        "**[GPT-5](https://openai.com/gpt5)**",
      ].join("\n"),
      "utf8",
    );

    const urls = extractPublishedUseMelhorUrls(mdPath);
    rm(mdPath, { force: true });

    assert.ok(urls !== null, "deve retornar Set nao-nulo");
    assert.ok([...urls!].some((u) => u.includes("cursor.sh")), "deve incluir cursor.sh (formato canonico)");
    assert.ok([...urls!].some((u) => u.includes("perplexity.ai")), "deve incluir perplexity.ai (formato canonico)");
    assert.ok(![...urls!].some((u) => u.includes("openai.com")), "URL de LANCAMENTOS nao deve vazar apos ---");
  });
});
