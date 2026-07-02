import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderContactsSummarySection,
  renderDashboardHtml,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";

// #2857 fase C (cutover): `by_tier`/`by_tier_verified` foram removidos do tipo
// `ContactsSummary` e o fallback de render que os consumia (KV cacheado
// pré-fase-B) foi removido de sections-kv.ts — sucessor único é
// `by_cohort_first_send`/`by_cohort_first_send_verified`.
const sample: ContactsSummary = {
  generated_at: "2026-06-29T12:00:00Z",
  total: 427528,
  brevo: { synced_rows: 29600, has_signal: true },
  by_cohort_first_send: { "assinantes-ativos": 1167, "ex-assinantes": 7269, null: 131 },
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

test("renderContactsSummarySection: fallback pré-#2731 anexa o breakdown de 1º envio (cohort) à faixa 'zero' (#2812 item 6)", () => {
  // `sample` tem by_cohort_first_send mas NÃO tem priority_points_histogram —
  // antes do #2812 item 6, o fallback não mostrava breakdown NENHUM. Agora o
  // fallback também anexa as sub-linhas "1º envio".
  const html = renderContactsSummarySection(sample);
  assert.match(html, /zero \(sem histórico\)/, "faixa 'zero' presente");
  assert.match(html, /1º envio — Assinantes ativos/, "breakdown (assinantes-ativos) anexado no fallback");
  assert.match(html, /1º envio — Ex-assinantes/, "breakdown (ex-assinantes) anexado no fallback");
  assert.match(html, /1º envio — sem cohort/, "cohort nulo rotulado 'sem cohort'");
  const idxZero = html.indexOf("zero (sem histórico)");
  const idxCohort = html.indexOf("1º envio — Assinantes ativos");
  assert.ok(idxZero !== -1 && idxCohort !== -1 && idxZero < idxCohort, "breakdown vem DEPOIS da linha zero");
});

test("renderContactsSummarySection: fallback sem by_cohort_first_send no payload → sem breakdown, não lança (#2812 item 6)", () => {
  const noBreakdown = { ...sample, by_cohort_first_send: undefined };
  assert.doesNotThrow(() => renderContactsSummarySection(noBreakdown));
  const html = renderContactsSummarySection(noBreakdown);
  assert.doesNotMatch(html, /1º envio —/, "sem by_cohort_first_send → sem sub-linhas de breakdown");
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
  // #2805: a linha 0 pode carregar o breakdown de 1º envio no mesmo <td> — o
  // localizador usa regex (>0< ou >0 <span…) em vez de string fixa.
  const idx80 = html.indexOf(">80<");
  const idx15 = html.indexOf(">15<");
  const idx0 = html.search(/<td>0[< ]/);
  const idxNeg3 = html.indexOf(">-3<");
  const idxNull = html.indexOf("sem pontuação");
  assert.ok(idx80 < idx15 && idx15 < idx0 && idx0 < idxNeg3, "ordem numérica DESC: 80 > 15 > 0 > -3");
  assert.ok(idxNeg3 < idxNull, "'sem pontuação' (null) vai por último, depois do menor valor numérico");
});

test("renderContactsSummarySection: tabela 'Por tier' não existe (removida em #2805, sucessor é cohort desde #2857 fase C) — breakdown vai pra linha 0 do histograma", () => {
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
  assert.doesNotMatch(html, /Por tier \(1º envio\)/, "tabela separada não existe (nem por tier, nem por cohort)");
  // 3ª iteração (260702): o breakdown vira SUB-LINHAS reais — 1 <tr> por
  // cohort, contagem na coluna "contatos", rótulo "1º envio" (universo
  // próprio, #2807 review). A regex cobre presença + valores + ordem
  // (cohortSendRank ASC, "sem cohort" por último) + posição logo após a linha 0.
  assert.match(
    html,
    /<td>0<\/td><td[^>]*>427[.,]?520<\/td><\/tr>\s*<tr><td[^>]*>· 1º envio — Assinantes ativos<\/td><td[^>]*>1[.,]?167<\/td><\/tr>\s*<tr><td[^>]*>· 1º envio — Ex-assinantes<\/td><td[^>]*>7[.,]?269<\/td><\/tr>\s*<tr><td[^>]*>· 1º envio — sem cohort<\/td><td[^>]*>131<\/td><\/tr>/,
  );
  // as sub-linhas aparecem exatamente 1x (só depois da linha 0, sem vazar)
  assert.equal(html.split("1º envio — Assinantes ativos").length - 1, 1);
});

test("renderContactsSummarySection: coluna 'verified' quando o KV traz os campos novos (260702)", () => {
  const withVerified: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_verified: { "0": 81000, "15": 7 },
    by_cohort_first_send_verified: { "assinantes-ativos": 900, "ex-assinantes": 6100 },
  };
  const html = renderContactsSummarySection(withVerified);
  assert.match(html, /<th style="text-align:right">verified<\/th>/, "header da coluna presente");
  // linha 0: contatos e verified lado a lado
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>81[.,]?000<\/td>/);
  // linha 15
  assert.match(html, /<td>15<\/td><td[^>]*>40<\/td><td[^>]*>7<\/td>/);
  // sub-linha de cohort com verified próprio; cohort sem entrada no verified → 0
  assert.match(html, /· 1º envio — Assinantes ativos<\/td><td[^>]*>1[.,]?167<\/td><td[^>]*>900<\/td>/);
  assert.match(html, /· 1º envio — sem cohort<\/td><td[^>]*>131<\/td><td[^>]*>0<\/td>/);
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

test("renderContactsSummarySection: cohort não-reconhecido no breakdown → vai pro fim (junto de 'sem cohort'), nunca lança (#2807 review, migrado pra cohort na fase C)", () => {
  // Antes (#2807): o guard protegia contra Number("corrompida")=NaN quebrando
  // o comparator do breakdown por TIER. Desde #2857 fase C, o breakdown é por
  // COHORT — cohortSendRank não faz parsing numérico, então uma chave
  // desconhecida ("corrompida") já cai naturalmente no branch RANK_UNKNOWN
  // (mesmo destino de `null`), sem guard especial precisar existir. Este teste
  // documenta que o comportamento equivalente se mantém: nunca lança, chaves
  // reconhecidas primeiro (ASC por cohortSendRank), desconhecidas por último.
  const corrupt: ContactsSummary = {
    ...sample,
    by_cohort_first_send: { "ex-assinantes": 5, corrompida: 9, "assinantes-ativos": 3, null: 7 } as Record<string, number>,
    priority_points_histogram: { "0": 24 },
  };
  assert.doesNotThrow(() => renderContactsSummarySection(corrupt));
  const html = renderContactsSummarySection(corrupt);
  const idxAssinantes = html.indexOf("— Assinantes ativos<");
  const idxEx = html.indexOf("— Ex-assinantes<");
  const idxBad = html.indexOf("— corrompida<");
  const idxSem = html.indexOf("— sem cohort<");
  assert.ok(idxAssinantes !== -1 && idxEx !== -1 && idxBad !== -1 && idxSem !== -1, "todas as chaves renderizadas");
  assert.ok(idxAssinantes < idxEx, "cohorts reconhecidos primeiro, na ordem de envio (assinante-ativo antes de ex-assinante)");
  assert.ok(idxEx < idxBad && idxEx < idxSem, "chave não-reconhecida e null vão pro fim");
});

test("renderContactsSummarySection: linha 0 sem by_cohort_first_send no payload → renderiza sem breakdown, não lança (#2805)", () => {
  const noBreakdown = {
    ...sample,
    by_cohort_first_send: undefined,
    priority_points_histogram: { "0": 10 },
  } as unknown as ContactsSummary;
  assert.doesNotThrow(() => renderContactsSummarySection(noBreakdown));
  assert.match(renderContactsSummarySection(noBreakdown), />0<\/td>/);
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
  // #2857 fase A: a coluna cohort guarda o slug ('leads-YYYY-MM'), não mais a
  // safra crua — cohortLabel (via cohortDisplayLabel) traduz pro rótulo novo.
  const withCohort: ContactsSummary = {
    ...sample,
    by_cohort: { "leads-2026-06": 500, "leads-2026-05": 1200, null: 300 },
  };
  const html = renderContactsSummarySection(withCohort);
  assert.match(html, /Por safra \(cohort\)/);
  assert.match(html, />Leads mai\/2026</, "rótulo pt-BR traduzido");
  assert.match(html, />Leads jun\/2026</);
  assert.match(html, /sem cohort/);
  // ordem cronológica (maio antes de junho), null por último — a ordenação em
  // sections-kv.ts é lexicográfica sobre a CHAVE crua ('leads-2026-05' <
  // 'leads-2026-06'), que continua batendo com a ordem cronológica pros slugs
  // de safra mensal (mesmo prefixo 'leads-YYYY-').
  const idxMaio = html.indexOf(">Leads mai/2026<");
  const idxJunho = html.indexOf(">Leads jun/2026<");
  const idxSemCohort = html.indexOf("sem cohort");
  assert.ok(idxMaio < idxJunho, "maio (leads-2026-05) antes de junho (leads-2026-06)");
  assert.ok(idxJunho < idxSemCohort, "sem cohort (null) vai por último");
});

// ---------------------------------------------------------------------------
// #2857 fase B/C — by_cohort_first_send (sucessor único do antigo by_tier;
// desde a fase C não há mais fallback pra by_tier — campo nem existe no tipo)
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: sub-linhas de 1º envio usam rótulo de cohort (Assinantes ativos/Ex-assinantes/sem cohort)", () => {
  const withCohortFirstSend: ContactsSummary = {
    ...sample,
    by_cohort_first_send: { "assinantes-ativos": 1167, "ex-assinantes": 7269, null: 131 },
    priority_points_histogram: { "0": 427520, "15": 40, null: 12 },
  };
  const html = renderContactsSummarySection(withCohortFirstSend);
  assert.match(html, /1º envio — Assinantes ativos/, "sub-linha com rótulo de cohort");
  assert.match(html, /1º envio — Ex-assinantes/);
  assert.match(html, /1º envio — sem cohort/, "cohort null rotulado 'sem cohort' (via cohortLabel)");
  // ordem: cohortSendRank ASC (assinantes-ativos < ex-assinantes < null/desconhecido)
  const idxAssinantes = html.indexOf("1º envio — Assinantes ativos");
  const idxEx = html.indexOf("1º envio — Ex-assinantes");
  const idxSem = html.indexOf("1º envio — sem cohort");
  assert.ok(idxAssinantes < idxEx && idxEx < idxSem, "ordem cohortSendRank ASC, null por último");
});

test("renderContactsSummarySection: payload com verified (by_cohort_first_send_verified) → coluna extra nas sub-linhas de cohort", () => {
  const withVerified: ContactsSummary = {
    ...sample,
    by_cohort_first_send: { "assinantes-ativos": 1167, "ex-assinantes": 7269 },
    by_cohort_first_send_verified: { "assinantes-ativos": 900 },
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_verified: { "0": 81000, "15": 7 },
  };
  const html = renderContactsSummarySection(withVerified);
  assert.match(html, /<th style="text-align:right">verified<\/th>/);
  assert.match(html, /1º envio — Assinantes ativos<\/td><td[^>]*>1[.,]?167<\/td><td[^>]*>900<\/td>/);
  assert.match(html, /1º envio — Ex-assinantes<\/td><td[^>]*>7[.,]?269<\/td><td[^>]*>0<\/td>/, "cohort sem entrada no verified → 0");
});

test("renderContactsSummarySection: fallback pré-#2731 com by_cohort_first_send (payload novo + KV pré-#2731) anexa breakdown de cohort à faixa 'zero'", () => {
  // `sample` não tem priority_points_histogram — dispara o fallback antigo
  // (renderPriorityPointsFallback), que também precisa saber renderizar cohort.
  const fallbackWithCohort: ContactsSummary = {
    ...sample,
    by_cohort_first_send: { "assinantes-ativos": 1167, "ex-assinantes": 7269 },
  };
  const html = renderContactsSummarySection(fallbackWithCohort);
  assert.match(html, /zero \(sem histórico\)/);
  assert.match(html, /1º envio — Assinantes ativos/);
});

// ---------------------------------------------------------------------------
// #2865 — coluna "Brevo" (brevo_list_ids IS NOT NULL) no histograma de
// priority_points e no breakdown de 1º envio por cohort
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: coluna 'Brevo' aparece quando priority_points_histogram_brevo está presente (#2865)", () => {
  const withBrevo: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_brevo: { "0": 29000, "15": 12 },
  };
  const html = renderContactsSummarySection(withBrevo);
  assert.match(html, /<th style="text-align:right">Brevo<\/th>/, "header da coluna Brevo presente");
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>29[.,]?000<\/td>/, "linha 0 com valor Brevo");
  assert.match(html, /<td>15<\/td><td[^>]*>40<\/td><td[^>]*>12<\/td>/, "linha 15 com valor Brevo");
});

test("renderContactsSummarySection: sub-linhas de 1º envio ganham coluna Brevo quando by_cohort_first_send_brevo presente (#2865)", () => {
  const withBrevo: ContactsSummary = {
    ...sample,
    by_cohort_first_send: { "assinantes-ativos": 1167, "ex-assinantes": 7269 },
    by_cohort_first_send_brevo: { "assinantes-ativos": 900 },
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_brevo: { "0": 29000 },
  };
  const html = renderContactsSummarySection(withBrevo);
  assert.match(
    html,
    /1º envio — Assinantes ativos<\/td><td[^>]*>1[.,]?167<\/td><td[^>]*>900<\/td>/,
    "sub-linha com valor Brevo",
  );
  assert.match(
    html,
    /1º envio — Ex-assinantes<\/td><td[^>]*>7[.,]?269<\/td><td[^>]*>0<\/td>/,
    "cohort sem entrada no mapa Brevo → 0",
  );
});

test("renderContactsSummarySection: KV antigo (sem priority_points_histogram_brevo) → sem header/coluna Brevo (retrocompat, #2865)", () => {
  const noBrevo: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
  };
  const html = renderContactsSummarySection(noBrevo);
  assert.doesNotMatch(html, /<th[^>]*>Brevo<\/th>/, "coluna Brevo não aparece sem o dado");
});

test("renderContactsSummarySection: colunas verified e Brevo coexistem (mesma linha, 4 células)", () => {
  const both: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
    priority_points_histogram_verified: { "0": 81000 },
    priority_points_histogram_brevo: { "0": 29000 },
  };
  const html = renderContactsSummarySection(both);
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>81[.,]?000<\/td><td[^>]*>29[.,]?000<\/td>/);
});

test("renderContactsSummarySection: by_cohort com verified → coluna extra; sem verified → 2 colunas só", () => {
  const withVerified: ContactsSummary = {
    ...sample,
    by_cohort: { "leads-2026-06": 500 },
    by_cohort_verified: { "leads-2026-06": 120 },
  };
  const htmlWithVerified = renderContactsSummarySection(withVerified);
  assert.match(htmlWithVerified, />Leads jun\/2026<\/td><td[^>]*>500<\/td><td[^>]*>120<\/td>/);

  const withoutVerified: ContactsSummary = {
    ...sample,
    by_cohort: { "leads-2026-06": 500 },
  };
  const htmlNoVerified = renderContactsSummarySection(withoutVerified);
  assert.match(htmlNoVerified, />Leads jun\/2026<\/td><td[^>]*>500<\/td><\/tr>/, "sem 3ª coluna quando by_cohort_verified ausente");
});
