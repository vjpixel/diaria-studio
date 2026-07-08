/**
 * test/diaria-dashboard-tab-saude-3075.test.ts (#3075)
 *
 * Regressão (#633) para a issue #3075: "Saúde das Fontes" ganha aba própria
 * no diaria-dashboard, deixando de ser sub-seção de "Visão geral". Cobre:
 *
 *   1. A 7ª aba ("Saúde das fontes") existe, com radio/label/panel próprios.
 *   2. renderSourceHealthSection continua funcionando isolada (nenhum novo
 *      pipeline de dados — só mudou de panel).
 *   3. Achado Fable #1 (sticky header morto): só o table-wrap da Saúde das
 *      Fontes ganha max-height + overflow-y:auto (table-wrap-scroll); as
 *      outras tabelas do dashboard continuam com o table-wrap genérico
 *      (overflow-x apenas), sem essa variante.
 *   4. Achado Fable #2 (densidade de data): colunas "Último ok"/"Última
 *      falha" (Saúde das Fontes) e "Início" (Overnight) usam formato curto
 *      dd/mm hh:mm (sem ano) no texto, com o ano preservado no atributo
 *      title= do <td> (dd/mm/aa hh:mm via fmtTimeBRT original).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DashboardData, SourceHealthEntry, OvernightRun } from "../workers/diaria-dashboard/src/types.ts";

// Import dinâmico (mesmo padrão do resto da suíte de diaria-dashboard: o
// package.json do worker não declara "type": "module").
const { renderDashboardHtml, renderSourceHealthSection, renderOvernightSection, renderCtrSection } = await import(
  "../workers/diaria-dashboard/src/index.ts"
);

function baseData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: "2026-07-08T00:00:00Z",
    schema_version: 1,
    source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
    ctr: null,
    overnight: { runs: [], total_runs: 0 },
    use_melhor: null,
    poll_eia: null,
    top_clicked_recent: null,
    audience: null,
    stubs: [],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SourceHealthEntry> = {}): SourceHealthEntry {
  return {
    name: "Fonte X",
    slug: "fonte-x",
    attempts: 10,
    successes: 9,
    failures: 1,
    timeouts: 0,
    success_rate_pct: 90,
    consecutive_failures: 0,
    last_success_iso: "2026-07-07T13:45:00Z",
    last_failure_iso: "2026-06-01T02:10:00Z",
    last_duration_ms: 1200,
    status: "verde",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// #3075 item 1-3: 7ª aba "Saúde das fontes"
// ---------------------------------------------------------------------------

describe("#3075: Saúde das Fontes vira aba própria", () => {
  test("input radio #tab-saude existe", () => {
    const html = renderDashboardHtml(baseData());
    assert.match(html, /<input type="radio" class="tab-radios" name="dash-tab" id="tab-saude">/);
  });

  test("label da aba Saúde das fontes existe e aponta pra panel-saude", () => {
    const html = renderDashboardHtml(baseData());
    assert.match(
      html,
      /<label class="tab-label" id="tablabel-saude" for="tab-saude" role="tab" aria-controls="panel-saude">Saúde das fontes<\/label>/,
    );
  });

  test("panel-saude existe e contém a seção source-health", () => {
    const html = renderDashboardHtml(baseData({
      source_health: {
        entries: [makeEntry()],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "2026-07-08T00:00:00Z",
      },
    }));
    const panel = html.match(/id="panel-saude"[\s\S]*?<\/div><!-- \/panel-saude -->/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-saude deve existir");
    assert.ok(panel.includes('id="source-health"'), "seção source-health deve estar dentro do panel-saude");
    assert.ok(panel.includes("Fonte X"), "dados da fonte devem renderizar dentro do panel-saude");
  });

  test("panel-visaogeral NÃO contém mais a seção source-health", () => {
    const html = renderDashboardHtml(baseData({
      source_health: {
        entries: [makeEntry()],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "2026-07-08T00:00:00Z",
      },
    }));
    const panel = html.match(/id="panel-visaogeral"[\s\S]*?<\/div><!-- \/panel-visaogeral -->/)?.[0] ?? "";
    assert.ok(panel.length > 0, "panel-visaogeral deve existir");
    assert.ok(!panel.includes('id="source-health"'), "source-health não deve mais estar no panel Visão geral");
  });

  test("CSS de :checked/:focus-visible cobre a 7ª aba (tab-saude) nos 3 seletores", () => {
    const html = renderDashboardHtml(baseData());
    const style = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    assert.match(style, /#tab-saude:checked ~ \.tab-bar label\[for="tab-saude"\]/, "seletor :checked ~ .tab-bar deve incluir tab-saude");
    assert.match(style, /#tab-saude:focus-visible ~ \.tab-bar label\[for="tab-saude"\]/, "seletor :focus-visible ~ .tab-bar deve incluir tab-saude");
    assert.match(style, /#tab-saude:checked ~ \.tab-panels #panel-saude/, "seletor :checked ~ .tab-panels deve incluir panel-saude");
  });

  test("renderSourceHealthSection isolada continua funcionando sem mudança de pipeline de dados", () => {
    const data = baseData({
      source_health: {
        entries: [makeEntry({ name: "Fonte Isolada" })],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "2026-07-08T00:00:00Z",
      },
    });
    const html = renderSourceHealthSection(data);
    assert.ok(html.includes("Fonte Isolada"), "renderSourceHealthSection deve continuar renderizando entries normalmente");
  });
});

// ---------------------------------------------------------------------------
// Achado Fable #1: sticky header — só a tabela de Saúde das Fontes ganha
// max-height + overflow-y:auto (table-wrap-scroll), fazendo o th sticky
// funcionar de verdade (o table-wrap genérico só rola no eixo X).
// ---------------------------------------------------------------------------

describe("#3075 (achado Fable #1): scroll vertical na tabela de Saúde das Fontes", () => {
  test(".table-wrap-scroll define max-height + overflow-y: auto", () => {
    const html = renderDashboardHtml(baseData());
    const style = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    const rule = style.match(/\.table-wrap-scroll\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(rule, /max-height:/, "table-wrap-scroll deve ter max-height definido");
    assert.match(rule, /overflow-y:\s*auto/, "table-wrap-scroll deve ter overflow-y: auto (habilita o scroll que faz o sticky funcionar)");
  });

  test("renderSourceHealthSection usa a classe table-wrap-scroll no wrap da tabela", () => {
    const data = baseData({
      source_health: {
        entries: [makeEntry()],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "2026-07-08T00:00:00Z",
      },
    });
    const html = renderSourceHealthSection(data);
    assert.match(html, /<div class="table-wrap table-wrap-scroll">/, "wrap da tabela de Saúde das Fontes deve ter a classe table-wrap-scroll");
  });

  test("outras tabelas (Overnight, CTR) NÃO usam table-wrap-scroll — só a de Saúde das Fontes", () => {
    const run: OvernightRun = {
      edition: "260707", started_at: "2026-07-07T02:00:00Z", total_issues: 1,
      merged: 1, draft: 0, pulada: 0, in_progress: 0, duration_ms: 60_000, slowest_unit: null,
    };
    const overnightHtml = renderOvernightSection(baseData({ overnight: { runs: [run], total_runs: 1 } }));
    assert.ok(!overnightHtml.includes("table-wrap-scroll"), "Overnight não deve usar table-wrap-scroll");

    const ctrHtml = renderCtrSection(baseData({
      ctr: {
        total_editions: 1, total_links: 1,
        top_categories: [{ category: "Destaque", link_count: 1, total_clicks: 1, avg_ctr_pct: 1, max_ctr_pct: 1 }],
        top_links: [],
      },
    }));
    assert.ok(!ctrHtml.includes("table-wrap-scroll"), "CTR não deve usar table-wrap-scroll");
  });
});

// ---------------------------------------------------------------------------
// Achado Fable #2: densidade de data — dd/mm hh:mm sem ano no texto; ano
// preservado via title= (hover) com o formato completo (fmtTimeBRT).
// ---------------------------------------------------------------------------

describe("#3075 (achado Fable #2): formato curto de data (dd/mm hh:mm, ano no title)", () => {
  test("colunas Último ok / Última falha da Saúde das Fontes usam dd/mm hh:mm sem ano no texto visível", () => {
    const data = baseData({
      source_health: {
        entries: [makeEntry({ last_success_iso: "2026-07-07T13:45:00Z", last_failure_iso: "2026-06-01T02:10:00Z" })],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "2026-07-08T00:00:00Z",
      },
    });
    const html = renderSourceHealthSection(data);
    // Formato completo antigo tinha ano de 2 dígitos "dd/mm/aa" — não deve mais aparecer como texto de célula.
    assert.doesNotMatch(html, />\d{2}\/\d{2}\/\d{2},?\s*\d{2}:\d{2}<\/td>/, "texto visível da célula não deve conter o ano (formato dd/mm/aa)");
    // Formato curto dd/mm hh:mm deve aparecer como conteúdo textual da célula
    // (toLocaleString pt-BR intercala vírgula entre data e hora — aceitável).
    assert.match(html, /title="[^"]*">\d{2}\/\d{2},?\s*\d{2}:\d{2}<\/td>/, "célula deve exibir dd/mm hh:mm sem ano");
  });

  test("título (title=) da célula preserva o ano via fmtTimeBRT completo", () => {
    const data = baseData({
      source_health: {
        entries: [makeEntry({ last_success_iso: "2026-07-07T13:45:00Z" })],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "2026-07-08T00:00:00Z",
      },
    });
    const html = renderSourceHealthSection(data);
    // title= deve conter o ano de 2 dígitos (formato completo original)
    assert.match(html, /title="\d{2}\/\d{2}\/\d{2},?\s*\d{2}:\d{2}"/, "title= deve preservar o formato completo com ano");
  });

  test("coluna Início do Overnight também usa dd/mm hh:mm no texto, com ano no title", () => {
    const run: OvernightRun = {
      edition: "260707", started_at: "2026-07-07T02:00:00Z", total_issues: 1,
      merged: 1, draft: 0, pulada: 0, in_progress: 0, duration_ms: 60_000, slowest_unit: null,
    };
    const html = renderOvernightSection(baseData({ overnight: { runs: [run], total_runs: 1 } }));
    assert.match(html, /title="\d{2}\/\d{2}\/\d{2},?\s*\d{2}:\d{2}">\d{2}\/\d{2},?\s*\d{2}:\d{2}<\/td>/, "célula Início deve ter title completo (com ano) + texto curto (sem ano)");
  });

  test("data ausente (null) continua renderizando '—' tanto no texto quanto sem crash no title", () => {
    const data = baseData({
      source_health: {
        entries: [makeEntry({ last_success_iso: null, last_failure_iso: null })],
        total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "",
      },
    });
    let html: string;
    assert.doesNotThrow(() => { html = renderSourceHealthSection(data); });
    assert.ok(html!.includes("—"), "deve renderizar em vez de crashar com datas nulas");
  });
});
