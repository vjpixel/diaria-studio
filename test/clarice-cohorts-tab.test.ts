import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCohortsTabPanel,
  renderDashboardHtml,
  COHORT_DEVIATION_THRESHOLD_PP,
  type CohortStatsRow,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";

// #2864: aba "Cohorts" — comparativo de envio/engajamento por cohort.

test("renderCohortsTabPanel: stub gracioso quando cohortStats é undefined", () => {
  const html = renderCohortsTabPanel(undefined);
  assert.match(html, /id="cohorts-tab"/);
  assert.match(html, /Dados ainda não gerados/);
  assert.match(html, /clarice-db-summary\.ts/);
  assert.doesNotMatch(html, /undefined/);
});

test("renderCohortsTabPanel: {} (script rodou, base vazia) ≠ undefined — NÃO manda re-rodar o script (#2660, review #2872)", () => {
  const html = renderCohortsTabPanel({});
  assert.match(html, /Nenhum cohort no store/);
  assert.doesNotMatch(html, /Dados ainda não gerados/);
});

test("renderCohortsTabPanel: payload parcial (numerador ausente) → '—', sem NaN%, sem envenenar colAvg (review #2872)", () => {
  const partial = {
    "assinantes-ativos": {
      contacts: 100, eligible: 90, received: 50, sends_sum: 150,
      clicked: 10, unsub: 1, hard_bounce: 0, mv_verified: 80
      // `opened` AUSENTE (KV antigo/parcial) → openRate = NaN sem o guard
    } as unknown as CohortStatsRow,
    "ex-assinantes": {
      contacts: 200, eligible: 180, received: 100, sends_sum: 300,
      opened: 60, clicked: 20, unsub: 2, hard_bounce: 0, mv_verified: 150
    },
  };
  const html = renderCohortsTabPanel(partial);
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /60\.0%/, "linha completa segue calculada (60/100 abriu)");
});

test("renderCohortsTabPanel: renderiza contatos/elegíveis/recebeu/envios e taxas calculadas", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 1200, eligible: 1190, received: 1000, sends_sum: 3000,
      opened: 800, clicked: 200, unsub: 8, hard_bounce: 2, mv_verified: 1150
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /Assinantes ativos/);
  assert.match(html, />1[.,]?200</, "contatos");
  assert.match(html, />1[.,]?190</, "elegíveis");
  assert.match(html, />1[.,]?000</, "recebeu ≥1");
  assert.match(html, />3[.,]?000</, "soma de envios");
  assert.match(html, />80\.0%</, "abertura 800/1000");
  assert.match(html, />20\.0%</, "clique 200/1000");
  assert.match(html, />0\.8%</, "unsub 8/1000 (#2880: coluna separada de bounce)");
  assert.match(html, />0\.2%</, "bounce 2/1000 (#2880: coluna separada de unsub)");
  // #2880 D: mv verified virou número ABSOLUTO (não mais % sobre contacts).
  assert.match(html, />1[.,]?150</, "mv verified como número absoluto");
  assert.doesNotMatch(html, /Pts médio/, "#2880 F: coluna Pts médio removida");
});

test("renderCohortsTabPanel: coluna 'Na Brevo' aparece no header e a célula reflete cohort_stats[x].brevo (#2880)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 1200, eligible: 1190, received: 1000, sends_sum: 3000,
      opened: 800, clicked: 200, unsub: 10, hard_bounce: 0, mv_verified: 1150, brevo: 900
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<th[^>]*>Na Brevo<\/th>/, "header da coluna presente");
  assert.match(html, />900</, "célula reflete brevo");
});

test("renderCohortsTabPanel: cohort_stats[x].brevo ausente (KV pré-#2880) → célula mostra 0, não lança", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 90, received: 50, sends_sum: 150,
      opened: 40, clicked: 10, unsub: 1, hard_bounce: 0, mv_verified: 80
      // `brevo` AUSENTE — KV cacheado antes do #2880
    } as unknown as CohortStatsRow,
  };
  assert.doesNotThrow(() => renderCohortsTabPanel(stats));
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<th[^>]*>Na Brevo<\/th>/);
  assert.match(html, />0</, "brevo ausente degrada pra 0");
});

test("renderCohortsTabPanel: cohort sem ninguém 'recebeu' (received=0) mostra '—' nas taxas de engajamento, não NaN/Infinity", () => {
  const stats: Record<string, CohortStatsRow> = {
    "leads-2026-06": {
      contacts: 500, eligible: 480, received: 0, sends_sum: 0,
      opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  // Abertura/Clique/Unsub/Bounce → "—"; MV verified é número absoluto (#2880 D),
  // então tem valor real (0) mesmo sem denominador de taxa.
  const dashCount = (html.match(/>—</g) ?? []).length;
  assert.ok(dashCount >= 4, `esperado ao menos 4 travessões (abertura/clique/unsub/bounce), achou ${dashCount}`);
});

test("renderCohortsTabPanel: cohort 'null' (sem cohort atribuído) rotulado 'sem cohort'", () => {
  const stats: Record<string, CohortStatsRow> = {
    null: {
      contacts: 10, eligible: 10, received: 0, sends_sum: 0,
      opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, />sem cohort</);
});

test("renderCohortsTabPanel: ordena por cohortSendRank (assinantes-ativos < ex-assinantes < leads < caudão < null)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "leads-caudao": { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0 },
    "ex-assinantes": { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0 },
    "assinantes-ativos": { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0 },
    null: { contacts: 1, eligible: 1, received: 0, sends_sum: 0, opened: 0, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0 },
  };
  const html = renderCohortsTabPanel(stats);
  const idxAtivos = html.indexOf("Assinantes ativos");
  const idxEx = html.indexOf("Ex-assinantes");
  // #2880 C: rótulo de leads-caudao virou "Caudão" (sem prefixo "Leads ").
  const idxCaudao = html.indexOf("Caudão");
  const idxNull = html.indexOf("sem cohort");
  assert.ok(idxAtivos < idxEx, "assinantes-ativos antes de ex-assinantes");
  assert.ok(idxEx < idxCaudao, "ex-assinantes antes de leads-caudao");
  assert.ok(idxCaudao < idxNull, "leads-caudao antes de null (sem cohort)");
});

test("renderCohortsTabPanel: célula com desvio >20pp da média da coluna ganha class=\"alert\"", () => {
  // 2 cohorts: A com abertura 90%, B com abertura 10% → média = 50%; ambos
  // desviam 40pp (>20pp) → ambos devem ganhar destaque.
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 90, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0
    },
    "ex-assinantes": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 10, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<td class="alert">90\.0%<\/td>/, "90% (desvio +40pp) destacado");
  assert.match(html, /<td class="alert">10\.0%<\/td>/, "10% (desvio -40pp) destacado");
});

test("renderCohortsTabPanel: cohorts próximos da média (desvio <=20pp) NÃO ganham destaque", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 55, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0
    },
    "ex-assinantes": {
      contacts: 100, eligible: 100, received: 100, sends_sum: 100,
      opened: 45, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 0
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /<td class="alert">55\.0%<\/td>/);
  assert.doesNotMatch(html, /<td class="alert">45\.0%<\/td>/);
});

test("COHORT_DEVIATION_THRESHOLD_PP é 20", () => {
  assert.equal(COHORT_DEVIATION_THRESHOLD_PP, 20);
});

test("renderCohortsTabPanel: header tem colunas Unsub e Bounce separadas, não mais 'Unsub+Bounce', e não tem mais 'Pts médio' (#2880)", () => {
  const html = renderCohortsTabPanel({});
  // {} ainda renderiza o stub sem thead — validar contra um payload com 1 linha.
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 10, eligible: 10, received: 10, sends_sum: 10,
      opened: 5, clicked: 2, unsub: 1, hard_bounce: 1, mv_verified: 3
    },
  };
  const withRows = renderCohortsTabPanel(stats);
  assert.match(withRows, /<th[^>]*>Unsub<\/th>/, "coluna Unsub isolada no header");
  assert.match(withRows, /<th[^>]*>Bounce<\/th>/, "coluna Bounce isolada no header");
  assert.doesNotMatch(withRows, /Unsub\+Bounce/, "header antigo combinado não existe mais");
  assert.doesNotMatch(withRows, /Pts médio/, "coluna Pts médio removida");
  assert.doesNotMatch(html, /Pts médio/);
});

test("renderCohortsTabPanel: linha Total soma contagens e agrega taxas (Σnum/Σrecebeu), não é média das linhas (#2880 E)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 90, received: 50, sends_sum: 150,
      opened: 30, clicked: 10, unsub: 2, hard_bounce: 1, mv_verified: 40, brevo: 80
    },
    "ex-assinantes": {
      contacts: 200, eligible: 150, received: 100, sends_sum: 300,
      opened: 60, clicked: 15, unsub: 5, hard_bounce: 2, mv_verified: 80, brevo: 150
    },
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<tr class="total-row">/, "linha Total presente");
  const totalRowMatch = html.match(/<tr class="total-row">([\s\S]*?)<\/tr>/);
  assert.ok(totalRowMatch, "linha Total tem conteúdo capturável");
  const totalRowHtml = totalRowMatch![1];
  assert.match(totalRowHtml, />Total</, "rótulo Total");
  assert.match(totalRowHtml, />300</, "contatos somados (100+200)");
  assert.match(totalRowHtml, />230</, "brevo somado (80+150)");
  assert.match(totalRowHtml, />240</, "elegíveis somados (90+150)");
  assert.match(totalRowHtml, />150</, "recebeu somado (50+100)");
  assert.match(totalRowHtml, />450</, "envios somados (150+300)");
  // Taxas agregadas sobre received total (150): abertura 90/150=60.0%,
  // clique 25/150=16.7%, unsub 7/150=4.7%, bounce 3/150=2.0% — NÃO a média
  // simples das duas linhas (que daria outro número).
  assert.match(totalRowHtml, />60\.0%</, "abertura agregada Σ90/Σ150");
  assert.match(totalRowHtml, />16\.7%</, "clique agregado Σ25/Σ150");
  assert.match(totalRowHtml, />4\.7%</, "unsub agregado Σ7/Σ150");
  assert.match(totalRowHtml, />2\.0%</, "bounce agregado Σ3/Σ150");
  assert.match(totalRowHtml, />120</, "mv verified somado (40+80)");
  // linha Total não ganha destaque de desvio (sem class="alert" nas células de taxa).
  assert.doesNotMatch(totalRowHtml, /class="alert"/);
});

test("renderDashboardHtml: NÃO inclui mais a aba Cohorts (radio/label/panel eliminados, #2880) — tabela vive dentro de Contatos", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  assert.doesNotMatch(html, /id="tab-cohorts"/, "radio da aba Cohorts eliminado");
  assert.doesNotMatch(html, /id="panel-cohorts"/, "panel Cohorts eliminado");
  assert.doesNotMatch(html, /for="tab-cohorts"/, "label da aba Cohorts eliminada");
  assert.doesNotMatch(html, /aria-controls="panel-cohorts"/, "tab-bar não referencia mais panel-cohorts");
  // a tabela Cohorts (stub gracioso quando cohort_stats ausente) segue existindo,
  // só que agora dentro do panel-contatos.
  assert.match(html, /id="panel-contatos"/);
  assert.match(html, /id="cohorts-tab"/, "renderCohortsTabPanel ainda é chamado, dentro da aba Contatos");
});

test("renderDashboardHtml: contactsSummary.cohort_stats popula a tabela Cohorts dentro da aba Contatos (#2880)", () => {
  const contactsSummary: ContactsSummary = {
    generated_at: "2026-07-02T12:00:00Z",
    total: 100,
    brevo: { synced_rows: 50, has_signal: true },
    eligibility: { eligible: 90, ineligible: 10, by_reason: {} },
    priority_points: { lt0: 0, eq0: 100, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 },
    mv: {},
    engagement: { with_opens: 0, with_clicks: 0 },
    cohort_stats: {
      "assinantes-ativos": {
        contacts: 100, eligible: 90, received: 80, sends_sum: 200,
        opened: 40, clicked: 5, unsub: 2, hard_bounce: 0, mv_verified: 70, brevo: 60
      },
    },
  };
  const html = renderDashboardHtml([], [], null, null, contactsSummary);
  const panel = html.match(/id="panel-contatos"[\s\S]*?(?=<\/div><!-- \/panel-contatos -->)/)?.[0] ?? "";
  assert.match(panel, /Assinantes ativos/);
  assert.doesNotMatch(panel, /Dados ainda não gerados/);
});

test("renderDashboardHtml: legenda do footer avisa que vermelho na aba Cohorts NÃO é circuit breaker (#2875 item 6)", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  assert.match(html, /class="footer"/);
  const footer = html.match(/<p class="footer">[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.match(footer, /circuit breaker/, "legenda global de circuit breaker segue presente");
  assert.match(footer, /Cohorts/, "footer referencia a exceção da tabela Cohorts");
  assert.match(footer, new RegExp(`${COHORT_DEVIATION_THRESHOLD_PP}pp`), "footer cita o threshold real de desvio da tabela Cohorts");
});
