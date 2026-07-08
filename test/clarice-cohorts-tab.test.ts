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
// #2909: colunas "Recebeu neste ciclo"/"Falta enviar" (−"Envios (Σ)"/−"MV verified").
// #2908: cohorts nunca-enviados (received=0) num <details> recolhível.

// Helper de fixture: preenche os campos obrigatórios de CohortStatsRow e deixa
// sobrescrever qualquer um. `sends_sum`/`mv_verified` NÃO existem mais no tipo
// (#2909); `received_this_cycle`/`brevo` são opcionais (schema evolution).
const mk = (o: Partial<CohortStatsRow>): CohortStatsRow => ({
  contacts: 0,
  eligible: 0,
  received: 0,
  opened: 0,
  clicked: 0,
  unsub: 0,
  hard_bounce: 0,
  ...o,
});

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
      contacts: 100, eligible: 90, received: 50,
      clicked: 10, unsub: 1, hard_bounce: 0,
      // `opened` AUSENTE (KV antigo/parcial) → openRate = NaN sem o guard
    } as unknown as CohortStatsRow,
    "ex-assinantes": mk({ contacts: 200, eligible: 180, received: 100, opened: 60, clicked: 20, unsub: 2, hard_bounce: 0 }),
  };
  const html = renderCohortsTabPanel(partial);
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /60\.0%/, "linha completa segue calculada (60/100 abriu)");
});

test("renderCohortsTabPanel: renderiza contatos/na-brevo/elegíveis/recebeu e taxas calculadas", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({
      contacts: 1200, eligible: 1190, received: 1000,
      opened: 800, clicked: 200, unsub: 8, hard_bounce: 2, brevo: 1150,
    }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /Assinantes ativos/);
  assert.match(html, />1[.,]?200</, "contatos");
  assert.match(html, />1[.,]?190</, "elegíveis");
  assert.match(html, />1[.,]?000</, "recebeu ≥1");
  assert.match(html, />80\.0%</, "abertura 800/1000");
  assert.match(html, />20\.0%</, "clique 200/1000");
  assert.match(html, />0\.8%</, "unsub 8/1000 (#2880: coluna separada de bounce)");
  assert.match(html, />0\.2%</, "bounce 2/1000 (#2880: coluna separada de unsub)");
  // #2909: colunas "Envios (Σ)" e "MV verified" REMOVIDAS.
  assert.doesNotMatch(html, /Envios \(Σ\)/, "coluna Envios (Σ) removida (#2909)");
  assert.doesNotMatch(html, /MV verified/, "coluna MV verified removida (#2909)");
  assert.doesNotMatch(html, /Pts médio/, "#2880 F: coluna Pts médio removida");
});

test("renderCohortsTabPanel: coluna 'Na Brevo' aparece no header e a célula reflete cohort_stats[x].brevo (#2880)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 1200, eligible: 1190, received: 1000, opened: 800, clicked: 200, unsub: 10, brevo: 900 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<th[^>]*>Na Brevo<\/th>/, "header da coluna presente");
  assert.match(html, />900</, "célula reflete brevo");
});

test("renderCohortsTabPanel: cohort_stats[x].brevo ausente (KV pré-#2880) → célula mostra 0, não lança", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 90, received: 50,
      opened: 40, clicked: 10, unsub: 1, hard_bounce: 0,
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
    "leads-2026-06": mk({ contacts: 500, eligible: 480, received: 0 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  // Abertura/Clique/Unsub/Bounce → "—" (e, sem ciclo, Recebeu neste ciclo/Falta
  // enviar também "—").
  const dashCount = (html.match(/>—</g) ?? []).length;
  assert.ok(dashCount >= 4, `esperado ao menos 4 travessões, achou ${dashCount}`);
});

test("renderCohortsTabPanel: cohort 'null' (sem cohort atribuído) rotulado 'sem cohort'", () => {
  const stats: Record<string, CohortStatsRow> = {
    null: mk({ contacts: 10, eligible: 10, received: 0 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, />sem cohort</);
});

test("renderCohortsTabPanel: ordena por cohortSendRank (assinantes-ativos < ex-assinantes < leads < caudão < null)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "leads-caudao": mk({ contacts: 1, eligible: 1 }),
    "ex-assinantes": mk({ contacts: 1, eligible: 1 }),
    "assinantes-ativos": mk({ contacts: 1, eligible: 1 }),
    null: mk({ contacts: 1, eligible: 1 }),
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

test("renderCohortsTabPanel: desvio >20pp da média — direção importa (#3091: vermelho só pra desvio desfavorável)", () => {
  // 2 cohorts: A com abertura 90%, B com abertura 10% → média = 50%; ambos
  // desviam 40pp (>20pp), mas abertura é "higher-is-better": 90% (acima da
  // média) é FAVORÁVEL → ▲ destacado sem alarme; 10% (abaixo da média) é
  // DESFAVORÁVEL → ▼ + class="alert" (vermelho = "ruim", igual ao resto do
  // dashboard). Antes do #3091, AMBOS ganhavam class="alert" — pintando de
  // vermelho a MELHOR linha.
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, opened: 90 }),
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, opened: 10 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<td><strong>▲ 90\.0%<\/strong><\/td>/, "90% (desvio favorável, acima da média) ganha ▲, SEM class=alert");
  assert.doesNotMatch(html, /<td class="alert">90\.0%<\/td>/, "90% NÃO deve mais ser vermelho (era o bug do #3091)");
  assert.match(html, /<td class="alert">▼ 10\.0%<\/td>/, "10% (desvio desfavorável, abaixo da média) ganha ▼ + class=alert (vermelho)");
});

test("renderCohortsTabPanel: unsub/bounce são 'lower-is-better' — desvio ABAIXO da média é favorável (▲), ACIMA é desfavorável (▼ vermelho)", () => {
  // 2 cohorts: A com unsub 1%, B com unsub 41% → média = 21%; ambos desviam
  // 20pp (não passa o threshold de >20pp)... usar valores que desviem >20pp.
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, unsub: 1 }), // 1% unsub
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, unsub: 50 }), // 50% unsub
  };
  const html = renderCohortsTabPanel(stats);
  // média = 25.5%; 1% desvia -24.5pp (abaixo da média = favorável, unsub é
  // lower-is-better) → ▲ sem alerta. 50% desvia +24.5pp (acima da média =
  // desfavorável) → ▼ + class="alert".
  assert.match(html, /<td><strong>▲ 1\.0%<\/strong><\/td>/, "unsub baixo (abaixo da média) é favorável → ▲, sem vermelho");
  assert.match(html, /<td class="alert">▼ 50\.0%<\/td>/, "unsub alto (acima da média) é desfavorável → ▼ + vermelho");
});

test("renderCohortsTabPanel: cohorts próximos da média (desvio <=20pp) NÃO ganham destaque", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 100, received: 100, opened: 55 }),
    "ex-assinantes": mk({ contacts: 100, eligible: 100, received: 100, opened: 45 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /<td class="alert">55\.0%<\/td>/);
  assert.doesNotMatch(html, /<td class="alert">45\.0%<\/td>/);
});

test("COHORT_DEVIATION_THRESHOLD_PP é 20", () => {
  assert.equal(COHORT_DEVIATION_THRESHOLD_PP, 20);
});

test("renderCohortsTabPanel: header tem colunas Unsub e Bounce separadas, não 'Unsub+Bounce'/'Pts médio' (#2880)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 10, eligible: 10, received: 10, opened: 5, clicked: 2, unsub: 1, hard_bounce: 1 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<th[^>]*>Unsub<\/th>/, "coluna Unsub isolada no header");
  assert.match(html, /<th[^>]*>Bounce<\/th>/, "coluna Bounce isolada no header");
  assert.doesNotMatch(html, /Unsub\+Bounce/, "header antigo combinado não existe mais");
  assert.doesNotMatch(html, /Pts médio/, "coluna Pts médio removida");
});

test("renderCohortsTabPanel: linha Total soma contagens e agrega taxas (Σnum/Σrecebeu), não é média das linhas (#2880 E)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, opened: 30, clicked: 10, unsub: 2, hard_bounce: 1, brevo: 80 }),
    "ex-assinantes": mk({ contacts: 200, eligible: 150, received: 100, opened: 60, clicked: 15, unsub: 5, hard_bounce: 2, brevo: 150 }),
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
  // Taxas agregadas sobre received total (150): abertura 90/150=60.0%,
  // clique 25/150=16.7%, unsub 7/150=4.7%, bounce 3/150=2.0% — NÃO a média
  // simples das duas linhas.
  assert.match(totalRowHtml, />60\.0%</, "abertura agregada Σ90/Σ150");
  assert.match(totalRowHtml, />16\.7%</, "clique agregado Σ25/Σ150");
  assert.match(totalRowHtml, />4\.7%</, "unsub agregado Σ7/Σ150");
  assert.match(totalRowHtml, />2\.0%</, "bounce agregado Σ3/Σ150");
  // #2909: linha Total não tem mais Envios (Σ) nem MV verified.
  assert.doesNotMatch(totalRowHtml, /class="alert"/, "linha Total sem destaque de desvio");
});

// ---------------------------------------------------------------------------
// #2909 — colunas "Recebeu neste ciclo" + "Falta enviar"
// ---------------------------------------------------------------------------

test("renderCohortsTabPanel: header tem 'Recebeu neste ciclo' + 'Falta enviar', e NÃO tem 'Envios (Σ)'/'MV verified' (#2909)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, received_this_cycle: 30, opened: 40 }),
  };
  const html = renderCohortsTabPanel(stats, "2026-06-01T00:00:00Z");
  assert.match(html, /<th[^>]*>Recebeu neste ciclo<\/th>/, "coluna Recebeu neste ciclo presente");
  assert.match(html, /<th[^>]*>Falta enviar<\/th>/, "coluna Falta enviar presente");
  assert.doesNotMatch(html, /<th[^>]*>Envios \(Σ\)<\/th>/, "Envios (Σ) removida");
  assert.doesNotMatch(html, /<th[^>]*>MV verified<\/th>/, "MV verified removida");
});

test("renderCohortsTabPanel: com cycleStart, 'Recebeu neste ciclo'=número e 'Falta enviar'=elegíveis−recebeu_ciclo (#2909)", () => {
  const stats: Record<string, CohortStatsRow> = {
    // eligible 90, received_this_cycle 30 → falta = 60. brevo=55 (≠60, evita colisão).
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, received_this_cycle: 30, opened: 40, clicked: 10, unsub: 1, brevo: 55 }),
  };
  const html = renderCohortsTabPanel(stats, "2026-06-01T00:00:00Z");
  assert.match(html, />30</, "Recebeu neste ciclo = 30");
  assert.match(html, />60</, "Falta enviar = eligible(90) − received_this_cycle(30)");
});

test("renderCohortsTabPanel: SEM cycleStart, colunas de ciclo exibem '—' (não o número), nota avisa (#2909)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, received_this_cycle: 30, opened: 40, clicked: 10, unsub: 1, brevo: 55 }),
  };
  const html = renderCohortsTabPanel(stats); // cycleStart default = null
  assert.doesNotMatch(html, />30</, "Recebeu neste ciclo NÃO exibido como número sem ciclo");
  assert.match(html, /nenhum ciclo de envio com send-plan legível/i, "nota explica o '—'");
});

test("renderCohortsTabPanel: linha Total — 'Falta enviar' = Σelegíveis − Σrecebeu_ciclo (#2909)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, received_this_cycle: 30, opened: 30, clicked: 10, unsub: 2, hard_bounce: 1, brevo: 80 }),
    "ex-assinantes": mk({ contacts: 200, eligible: 150, received: 100, received_this_cycle: 40, opened: 60, clicked: 15, unsub: 5, hard_bounce: 2, brevo: 150 }),
  };
  const html = renderCohortsTabPanel(stats, "2026-06-01T00:00:00Z");
  const totalRowHtml = html.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)![1];
  assert.match(totalRowHtml, />70</, "Recebeu neste ciclo total = 30+40");
  assert.match(totalRowHtml, />170</, "Falta enviar total = Σelegíveis(240) − Σrecebeu_ciclo(70)");
});

test("renderCohortsTabPanel: 'Falta enviar' nunca negativo — recebeu>elegíveis → 0 (clamp, review PR)", () => {
  // eligible 40, received_this_cycle 45: 5 contatos descadastraram/bounce APÓS
  // receberem no ciclo → send_eligible caiu p/ 0 mas last_sent_at ≥ cycle_start.
  // Falta = max(0, 40−45) = 0, jamais "−5" (por cohort E na linha Total).
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 40, received: 50, received_this_cycle: 45, opened: 30, clicked: 10, unsub: 5, brevo: 60 }),
  };
  const html = renderCohortsTabPanel(stats, "2026-06-01T00:00:00Z");
  assert.doesNotMatch(html, />[-−]\d/, "nenhum número negativo renderizado (Falta enviar clampado em 0)");
  const totalRowHtml = html.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)![1];
  assert.doesNotMatch(totalRowHtml, />[-−]\d/, "linha Total também sem negativo");
});

test("renderCohortsTabPanel: received_this_cycle ausente (KV pré-#2909) com ciclo → degrada pra 0, não lança (#2909)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": {
      contacts: 100, eligible: 90, received: 50,
      opened: 40, clicked: 10, unsub: 1, hard_bounce: 0,
      // received_this_cycle AUSENTE
    } as unknown as CohortStatsRow,
  };
  assert.doesNotThrow(() => renderCohortsTabPanel(stats, "2026-06-01T00:00:00Z"));
  const html = renderCohortsTabPanel(stats, "2026-06-01T00:00:00Z");
  // recebeu_ciclo degrada a 0 → falta = eligible(90) − 0 = 90.
  assert.match(html, />90</, "falta = eligible quando received_this_cycle ausente (0)");
});

// ---------------------------------------------------------------------------
// #2908 — cohorts nunca-enviados (received=0) num <details> recolhível
// ---------------------------------------------------------------------------

test("renderCohortsTabPanel: nunca-enviados (received=0) vão pro <details>; ativos (received>0) na tabela principal (#2908)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, opened: 40, clicked: 10, unsub: 1 }), // ATIVO
    "ex-assinantes": mk({ contacts: 500, eligible: 480, received: 0 }), // NUNCA-ENVIADO
  };
  const html = renderCohortsTabPanel(stats);
  assert.match(html, /<details class="never-sent">/, "container <details> presente");
  assert.match(html, /Cohorts sem envio \(1\)/, "summary conta os nunca-enviados");
  // #3090: o glossário das colunas também é um <details> (class="links-ctr"),
  // renderizado ANTES da tabela — usar o seletor específico do never-sent
  // (class="never-sent"), não o primeiro <details> genérico da página.
  const detailsIdx = html.indexOf('<details class="never-sent">');
  const ativosIdx = html.indexOf("Assinantes ativos");
  const exIdx = html.indexOf("Ex-assinantes");
  assert.ok(ativosIdx !== -1 && ativosIdx < detailsIdx, "ativo na tabela principal (antes do <details>)");
  assert.ok(exIdx !== -1 && exIdx > detailsIdx, "nunca-enviado DENTRO do <details>");
  // linha Total presente (há ≥1 ativo).
  assert.match(html, /<tr class="total-row">/);
});

test("renderCohortsTabPanel: sem nenhum nunca-enviado → NÃO renderiza o <details> (#2908)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, opened: 40 }),
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /<details class="never-sent">/, "sem <details> quando todos foram enviados");
});

test("renderCohortsTabPanel: <details> envolve uma TABELA inteira (HTML válido), não <tr> soltos (#2908)", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 50, opened: 40 }),
    "ex-assinantes": mk({ contacts: 500, eligible: 480, received: 0 }),
  };
  const html = renderCohortsTabPanel(stats);
  // dentro do <details> vem <table> (não um <tr> órfão logo após o </summary>).
  assert.match(html, /<details class="never-sent">[\s\S]*?<table>[\s\S]*?<\/table>[\s\S]*?<\/details>/);
});

// ---------------------------------------------------------------------------
// renderDashboardHtml — integração da tabela Cohorts dentro da aba Contatos
// ---------------------------------------------------------------------------

test("renderDashboardHtml: NÃO inclui mais a aba Cohorts (radio/label/panel eliminados, #2880) — tabela vive dentro de Contatos", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  assert.doesNotMatch(html, /id="tab-cohorts"/, "radio da aba Cohorts eliminado");
  assert.doesNotMatch(html, /id="panel-cohorts"/, "panel Cohorts eliminado");
  assert.doesNotMatch(html, /for="tab-cohorts"/, "label da aba Cohorts eliminada");
  assert.doesNotMatch(html, /aria-controls="panel-cohorts"/, "tab-bar não referencia mais panel-cohorts");
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
      "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 80, opened: 40, clicked: 5, unsub: 2, brevo: 60 }),
    },
  };
  const html = renderDashboardHtml([], [], null, null, contactsSummary);
  const panel = html.match(/id="panel-contatos"[\s\S]*?(?=<\/div><!-- \/panel-contatos -->)/)?.[0] ?? "";
  assert.match(panel, /Assinantes ativos/);
  assert.doesNotMatch(panel, /Dados ainda não gerados/);
});

test("renderDashboardHtml: cycle_start do summary flui até a tabela Cohorts (#2909)", () => {
  const contactsSummary: ContactsSummary = {
    generated_at: "2026-07-02T12:00:00Z",
    total: 100,
    cycle_start: "2026-06-01T00:00:00Z",
    brevo: { synced_rows: 50, has_signal: true },
    eligibility: { eligible: 90, ineligible: 10, by_reason: {} },
    priority_points: { lt0: 0, eq0: 100, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 },
    mv: {},
    engagement: { with_opens: 0, with_clicks: 0 },
    cohort_stats: {
      "assinantes-ativos": mk({ contacts: 100, eligible: 90, received: 80, received_this_cycle: 25, opened: 40, brevo: 60 }),
    },
  };
  const html = renderDashboardHtml([], [], null, null, contactsSummary);
  // com cycle_start presente, "Recebeu neste ciclo" = 25 é EXIBIDO (não "—").
  assert.match(html, />25</, "received_this_cycle exibido quando cycle_start flui pelo dashboard");
});

test("renderDashboardHtml: legenda do footer diz que vermelho SEMPRE significa 'ruim' — inclusive na aba Cohorts (#3091, reverte #2875 item 6)", () => {
  // #3091: antes, o footer avisava que vermelho na tabela Cohorts tinha "outro
  // significado" (podia pintar a MELHOR linha de vermelho). Com a direção do
  // desvio agora considerada (favorável → ▲, desfavorável → ▼ vermelho),
  // vermelho volta a significar só "ruim" em toda a página — a exceção
  // desapareceu, só o CRITÉRIO (desvio vs. circuit breaker) continua distinto.
  const html = renderDashboardHtml([], [], null, null, null);
  assert.match(html, /class="footer"/);
  const footer = html.match(/<p class="footer">[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.match(footer, /circuit breaker/, "legenda global de circuit breaker segue presente");
  assert.match(footer, /Vermelho sempre significa ["“]ruim["”]/, "footer afirma que vermelho é sempre 'ruim' em toda a página (#3091)");
  assert.match(footer, /Cohorts/, "footer ainda referencia o critério distinto da tabela Cohorts");
  assert.match(footer, new RegExp(`${COHORT_DEVIATION_THRESHOLD_PP}pp`), "footer cita o threshold real de desvio da tabela Cohorts");
  assert.doesNotMatch(footer, /outro significado/, "disclaimer antigo ('outro significado') removido — vermelho não diverge mais em significado (#3091)");
});
