import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderContactsSummarySection,
  renderDashboardHtml,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";

const sample: ContactsSummary = {
  generated_at: "2026-06-29T12:00:00Z",
  total: 427528,
  brevo: { synced_rows: 29600, has_signal: true },
  by_tier: { "1": 1167, "2": 7269, null: 131 },
  eligibility: { eligible: 422961, ineligible: 4567, by_reason: { mv_rejected: 4452, dispute: 115 } },
  priority_points: { lt0: 1, eq0: 427520, p1_40: 5, p41_80: 1, gt80: 0, optin: 3 },
  mv: { verified: 81425, none: 340731, rejected: 4452, unknown: 920 },
  engagement: { with_opens: 2219, with_clicks: 74 },
};

test("renderContactsSummarySection: stub gracioso quando null", () => {
  const html = renderContactsSummarySection(null);
  assert.match(html, /Dados ainda não gerados/);
  assert.match(html, /clarice-db-summary\.ts/);
});

test("renderContactsSummarySection: total 0 (objeto válido) renderiza, não vira stub", () => {
  // store legitimamente vazio é dado válido, não ausência de dado (#2660 review)
  const html = renderContactsSummarySection({ ...sample, total: 0 });
  assert.doesNotMatch(html, /Dados ainda não gerados/);
  assert.match(html, /Banco de contatos/);
});

test("renderContactsSummarySection: payload parcial/stale (sem subobjetos) não lança", () => {
  // simula um contacts:summary de versão antiga do script — o handler casta sem
  // validar shape; o render NÃO pode crashar e derrubar o dashboard.
  const partial = { generated_at: "2026-06-29T12:00:00Z", total: 5 } as ContactsSummary;
  assert.doesNotThrow(() => renderContactsSummarySection(partial));
  assert.match(renderContactsSummarySection(partial), /Banco de contatos/);
});

test("renderDashboardHtml: CSS torna o painel Contatos visível quando selecionado", () => {
  // regressão do bug crítico: o painel ficaria display:none sem a regra CSS
  const html = renderDashboardHtml([], [], null, null, sample);
  assert.match(html, /#tab-contatos:checked ~ \.tab-panels #panel-contatos/);
});

test("renderContactsSummarySection: renderiza razões/pontos/mv/engajamento", () => {
  const html = renderContactsSummarySection(sample);
  assert.match(html, /mv_rejected/);
  assert.match(html, /41–80/); // faixa de priority_points
  // locale-robusto: pt-BR "29.600", en-US "29,600" ou raw "29600" (small-icu no CI)
  assert.match(html, /29[.,]?600/); // brevo synced
  assert.match(html, /2[.,]?219/); // engajamento with_opens
});

test("renderContactsSummarySection: sem priority_points_histogram (KV pré-#2731) → cai pras faixas antigas", () => {
  // `sample` não tem priority_points_histogram — confirma o fallback gracioso.
  const html = renderContactsSummarySection(sample);
  assert.match(html, /41–80/, "faixa antiga presente (fallback)");
  assert.doesNotMatch(html, /valor exato/, "não deve mostrar o cabeçalho do histograma novo sem o campo");
});

test("renderContactsSummarySection: com priority_points_histogram → valores exatos, ordenados DESC (#2731)", () => {
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "-3": 2, "0": 427520, "15": 40, "80": 3, null: 12 },
  };
  const html = renderContactsSummarySection(withHistogram);
  assert.match(html, /valor exato/, "cabeçalho do histograma novo presente");
  assert.doesNotMatch(html, /41–80/, "faixas antigas NÃO aparecem quando o histograma existe");
  assert.match(html, /sem pontuação/, "null vira rótulo 'sem pontuação'");
  // Ordem: maior valor primeiro (fila de re-envio, #2731 — comentário do editor).
  // #2805: a linha 0 pode carregar o breakdown por tier no mesmo <td> — o
  // localizador usa regex (>0< ou >0 <span…) em vez de string fixa.
  const idx80 = html.indexOf(">80<");
  const idx15 = html.indexOf(">15<");
  const idx0 = html.search(/<td>0[< ]/);
  const idxNeg3 = html.indexOf(">-3<");
  const idxNull = html.indexOf("sem pontuação");
  assert.ok(idx80 < idx15 && idx15 < idx0 && idx0 < idxNeg3, "ordem numérica DESC: 80 > 15 > 0 > -3");
  assert.ok(idxNeg3 < idxNull, "'sem pontuação' (null) vai por último, depois do menor valor numérico");
});

test("renderContactsSummarySection: tabela 'Por tier' removida; breakdown por tier vai pra linha 0 do histograma (#2805)", () => {
  // #2805: a antiga tabela "Por tier (1º envio)" (firstSend = send_eligible=1
  // + sends_count=0, #2732) vira breakdown inline na linha 0 do histograma.
  // O universo NÃO é idêntico à linha (#2807 review: optin nunca-enviado tem
  // 40 pts; re-envio decaído pode ter 0 exato) — daí o rótulo explícito
  // "1º envio" no span.
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40, null: 12 },
  };
  const html = renderContactsSummarySection(withHistogram);
  assert.doesNotMatch(html, /Por tier \(1º envio\)/, "tabela separada não existe mais");
  // 3ª iteração (260702): o breakdown vira SUB-LINHAS reais — 1 <tr> por
  // tier, contagem na coluna "contatos", rótulo "1º envio" (universo próprio,
  // #2807 review). A regex cobre presença + valores + ordem (tier menor mais
  // acima, "sem tier" por último) + posição logo após a linha 0.
  assert.match(
    html,
    /<td>0<\/td><td[^>]*>427[.,]?520<\/td><\/tr>\s*<tr><td[^>]*>· 1º envio — T01<\/td><td[^>]*>1[.,]?167<\/td><\/tr>\s*<tr><td[^>]*>· 1º envio — T02<\/td><td[^>]*>7[.,]?269<\/td><\/tr>\s*<tr><td[^>]*>· 1º envio — sem tier<\/td><td[^>]*>131<\/td><\/tr>/,
  );
  // as sub-linhas aparecem exatamente 1x (só depois da linha 0, sem vazar)
  assert.equal(html.split("1º envio — T01").length - 1, 1);
});

test("renderContactsSummarySection: coluna 'verified' quando o KV traz os campos novos (260702)", () => {
  const withVerified: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_verified: { "0": 81000, "15": 7 },
    by_tier_verified: { "1": 900, "2": 6100 },
  };
  const html = renderContactsSummarySection(withVerified);
  assert.match(html, /<th style="text-align:right">verified<\/th>/, "header da coluna presente");
  // linha 0: contatos e verified lado a lado
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>81[.,]?000<\/td>/);
  // linha 15
  assert.match(html, /<td>15<\/td><td[^>]*>40<\/td><td[^>]*>7<\/td>/);
  // sub-linha de tier com verified próprio; tier sem entrada no verified → 0
  assert.match(html, /· 1º envio — T01<\/td><td[^>]*>1[.,]?167<\/td><td[^>]*>900<\/td>/);
  assert.match(html, /· 1º envio — sem tier<\/td><td[^>]*>131<\/td><td[^>]*>0<\/td>/);
});

test("renderContactsSummarySection: KV antigo (sem campos verified) → tabela de 2 colunas, sem header verified", () => {
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
  };
  const html = renderContactsSummarySection(withHistogram);
  // (não usar />verified</ solto — a tabela do MillionVerifier tem a chave
  // "verified" como linha legítima; o que não pode existir é o HEADER da coluna.
  // O shape da linha sem coluna extra já é coberto pela regex do teste "3ª
  // iteração" acima — sem assert duplicado aqui, review #2815.)
  assert.doesNotMatch(html, /<th[^>]*>verified<\/th>/, "coluna não aparece sem o dado");
});

test("renderContactsSummarySection: chave corrompida no by_tier → vai pro fim, ordem estável (#2807 review)", () => {
  // Regressão do guard de NaN: sem ele, Number("corrompida") = NaN fazia o
  // comparator retornar NaN → ordem implementation-defined. Com o guard, a
  // chave não-numérica é tratada como null (fim da fila), e o resto ordena
  // tier ASC normalmente.
  const corrupt: ContactsSummary = {
    ...sample,
    by_tier: { "2": 5, corrompida: 9, "1": 3, null: 7 } as Record<string, number>,
    priority_points_histogram: { "0": 24 },
  };
  const html = renderContactsSummarySection(corrupt);
  const idxT01 = html.indexOf("— T01<");
  const idxT02 = html.indexOf("— T02<");
  const idxBad = html.indexOf("— Tcorrompida<");
  const idxSem = html.indexOf("— sem tier<");
  assert.ok(idxT01 !== -1 && idxT02 !== -1 && idxBad !== -1 && idxSem !== -1, "todas as chaves renderizadas");
  assert.ok(idxT01 < idxT02, "tiers numéricos primeiro, ASC");
  assert.ok(idxT02 < idxBad && idxT02 < idxSem, "chave corrompida e null vão pro fim");
});

test("renderContactsSummarySection: sem histograma (KV pré-#2731) → tabela 'Por tier' também não volta (#2805)", () => {
  const html = renderContactsSummarySection(sample);
  assert.doesNotMatch(html, /Por tier \(1º envio\)/);
});

test("renderContactsSummarySection: linha 0 sem by_tier no payload → renderiza sem breakdown, não lança (#2805)", () => {
  const noByTier = {
    ...sample,
    by_tier: undefined,
    priority_points_histogram: { "0": 10 },
  } as unknown as ContactsSummary;
  assert.doesNotThrow(() => renderContactsSummarySection(noByTier));
  assert.match(renderContactsSummarySection(noByTier), />0<\/td>/);
});

test("renderContactsSummarySection: ordem das tabelas — priority_points → Inelegíveis → MV (#2806)", () => {
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
  };
  const html = renderContactsSummarySection(withHistogram);
  const idxPp = html.indexOf("priority_points (valor exato)");
  const idxInelig = html.indexOf("Inelegíveis por razão");
  const idxMv = html.indexOf("MillionVerifier (bucket)");
  assert.ok(idxPp !== -1 && idxInelig !== -1 && idxMv !== -1, "as 3 tabelas presentes");
  assert.ok(idxPp < idxInelig, "Inelegíveis vem DEPOIS de priority_points (#2806)");
  assert.ok(idxInelig < idxMv, "MillionVerifier permanece por último");
});

test("renderContactsSummarySection: branch has_signal=false mostra alerta", () => {
  const html = renderContactsSummarySection({
    ...sample,
    brevo: { synced_rows: 0, has_signal: false },
  });
  assert.match(html, /sem sinal Brevo ainda/);
  assert.match(html, /var\(--alert\)/);
});

test("renderDashboardHtml: inclui a aba Contatos (radio + label + panel)", () => {
  const html = renderDashboardHtml([], [], null, null, sample);
  assert.match(html, /id="tab-contatos"/);
  assert.match(html, /id="panel-contatos"/);
  assert.match(html, />Contatos</);
});

test("renderDashboardHtml: sem summary → aba presente mas com stub", () => {
  const html = renderDashboardHtml([], [], null, null, null);
  assert.match(html, /id="panel-contatos"/);
  assert.match(html, /Dados ainda não gerados/);
});

// ---------------------------------------------------------------------------
// #2817 — "Por safra (cohort)"
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: sem by_cohort (KV pré-#2817) → tabela 'Por safra' NÃO aparece, não lança", () => {
  // `sample` não tem by_cohort — confirma o degrade gracioso do campo opcional.
  assert.doesNotThrow(() => renderContactsSummarySection(sample));
  const html = renderContactsSummarySection(sample);
  assert.doesNotMatch(html, /Por safra \(cohort\)/);
});

test("renderContactsSummarySection: com by_cohort → tabela 'Por safra' com rótulo pt-BR, ordem cronológica", () => {
  const withCohort: ContactsSummary = {
    ...sample,
    by_cohort: { "2026-06": 500, "2026-05": 1200, null: 300 },
  };
  const html = renderContactsSummarySection(withCohort);
  assert.match(html, /Por safra \(cohort\)/);
  assert.match(html, />maio</, "rótulo pt-BR traduzido");
  assert.match(html, />junho</);
  assert.match(html, /sem safra/);
  // ordem cronológica (maio antes de junho), null por último
  const idxMaio = html.indexOf(">maio<");
  const idxJunho = html.indexOf(">junho<");
  const idxSemSafra = html.indexOf("sem safra");
  assert.ok(idxMaio < idxJunho, "maio (2026-05) antes de junho (2026-06)");
  assert.ok(idxJunho < idxSemSafra, "sem safra (null) vai por último");
});

test("renderContactsSummarySection: by_cohort com verified → coluna extra; sem verified → 2 colunas só", () => {
  const withVerified: ContactsSummary = {
    ...sample,
    by_cohort: { "2026-06": 500 },
    by_cohort_verified: { "2026-06": 120 },
  };
  const htmlWithVerified = renderContactsSummarySection(withVerified);
  assert.match(htmlWithVerified, />junho<\/td><td[^>]*>500<\/td><td[^>]*>120<\/td>/);

  const withoutVerified: ContactsSummary = {
    ...sample,
    by_cohort: { "2026-06": 500 },
  };
  const htmlNoVerified = renderContactsSummarySection(withoutVerified);
  assert.match(htmlNoVerified, />junho<\/td><td[^>]*>500<\/td><\/tr>/, "sem 3ª coluna quando by_cohort_verified ausente");
});
