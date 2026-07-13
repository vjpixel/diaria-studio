import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderContactsSummarySection,
  renderDashboardHtml,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";

// #2880: as tabelas "Por safra (cohort)" e as sub-linhas "1º envio — cohort"
// foram removidas de renderContactsSummarySection — o eixo cohort vive só na
// tabela Cohorts (renderCohortsTabPanel, agora dentro da aba Contatos, ver
// test/clarice-cohorts-tab.test.ts). Os campos `by_cohort`/`by_cohort_first_send*`
// não existem mais no tipo `ContactsSummary`.
const sample: ContactsSummary = {
  generated_at: "2026-06-29T12:00:00Z",
  total: 427528,
  brevo: { synced_rows: 29600, has_signal: true },
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

// #3081: priority_points.internal_excluded já era computado por
// clarice-db-summary.ts (#2809) mas nunca propagado ao tipo do worker nem
// exibido no render — cobertura da propagação + exibição.
test("renderContactsSummarySection: exibe 'internos excluídos' quando o campo está presente (#3081)", () => {
  const withInternal: ContactsSummary = {
    ...sample,
    priority_points: { ...sample.priority_points, internal_excluded: 7 },
  };
  const html = renderContactsSummarySection(withInternal);
  assert.match(html, /internos excluídos/);
  assert.match(html, /<strong>7<\/strong>/);
});

test("renderContactsSummarySection: sem internal_excluded (KV pré-#3081) → mostra '—', não 0 (#3081)", () => {
  const html = renderContactsSummarySection(sample); // sample não tem o campo
  assert.match(html, /internos excluídos: <strong>—<\/strong>/);
});

test("renderContactsSummarySection: sem priority_points_histogram (KV pré-#2731) → cai pras faixas antigas", () => {
  // `sample` não tem priority_points_histogram — confirma o fallback gracioso.
  const html = renderContactsSummarySection(sample);
  assert.match(html, /41–80/, "faixa antiga presente (fallback)");
  assert.doesNotMatch(html, /valor exato/, "não deve mostrar o cabeçalho do histograma novo sem o campo");
});

test("renderContactsSummarySection: com priority_points_histogram → valores exatos, ordenados DESC (#2731)", () => {
  // #3415: "35" (não "80") — valores ≥40 agora agrupam na linha "40+" (ver
  // describe abaixo); este teste cobre só a ordenação DESC entre valores
  // ABAIXO do corte, que continua inalterada.
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "-3": 2, "0": 427520, "15": 40, "35": 3, null: 12 },
  };
  const html = renderContactsSummarySection(withHistogram);
  assert.match(html, /valor exato/, "cabeçalho do histograma novo presente");
  assert.doesNotMatch(html, /41–80/, "faixas antigas NÃO aparecem quando o histograma existe");
  assert.match(html, /sem pontuação/, "null vira rótulo 'sem pontuação'");
  // Ordem: maior valor primeiro (fila de re-envio, #2731 — comentário do editor).
  // #2805: a linha 0 pode carregar o breakdown de 1º envio no mesmo <td> — o
  // localizador usa regex (>0< ou >0 <span…) em vez de string fixa.
  const idx35 = html.indexOf(">35<");
  const idx15 = html.indexOf(">15<");
  const idx0 = html.search(/<td>0[< ]/);
  const idxNeg3 = html.indexOf(">-3<");
  const idxNull = html.indexOf("sem pontuação");
  assert.ok(idx35 < idx15 && idx15 < idx0 && idx0 < idxNeg3, "ordem numérica DESC: 35 > 15 > 0 > -3");
  assert.ok(idxNeg3 < idxNull, "'sem pontuação' (null) vai por último, depois do menor valor numérico");
});

// ---------------------------------------------------------------------------
// #3415 — valores exatos ≥40 juntam numa única linha "40+" (cauda comprida de
// scores altos, cada um com poucos contatos, inflava a tabela)
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: scores ≥40 juntam numa linha '40+', somando os counts (#3415)", () => {
  const withHigh: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40, "40": 3, "80": 2, "120": 1 },
  };
  const html = renderContactsSummarySection(withHigh);
  assert.match(html, /<td>40\+<\/td><td[^>]*>6<\/td>/, "linha 40+ com contagem somada (3+2+1=6)");
  assert.doesNotMatch(html, /<td>40<\/td>/, "valor exato 40 não aparece mais como linha própria");
  assert.doesNotMatch(html, /<td>80<\/td>/, "valor exato 80 não aparece mais como linha própria");
  assert.doesNotMatch(html, /<td>120<\/td>/, "valor exato 120 não aparece mais como linha própria");
  const idx40Plus = html.indexOf(">40+<");
  const idx15 = html.indexOf(">15<");
  assert.ok(idx40Plus > -1 && idx15 > -1 && idx40Plus < idx15, "40+ vem antes das faixas abaixo de 40 (maior score primeiro)");
});

test("renderContactsSummarySection: '40+' soma também elegíveis/verified/Brevo dos valores agrupados (#3415)", () => {
  const withHighAllCols: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 400, "40": 10, "80": 5 },
    priority_points_histogram_eligible: { "0": 380, "40": 9, "80": 4 },
    priority_points_histogram_verified: { "0": 90, "40": 6, "80": 1 },
    priority_points_histogram_brevo: { "0": 29, "40": 3, "80": 1 },
  };
  const html = renderContactsSummarySection(withHighAllCols);
  const row = html.match(/<tr><td>40\+<\/td>([\s\S]*?)<\/tr>/)?.[1];
  assert.ok(row, "linha 40+ capturável");
  assert.match(row!, /<td[^>]*>15<\/td>/, "contatos somados (10+5=15)");
  assert.match(row!, /<td[^>]*>13<\/td>/, "elegíveis somados (9+4=13)");
  assert.match(row!, /<td[^>]*>7<\/td>/, "verified somado (6+1=7)");
  assert.match(row!, /<td[^>]*>4<\/td>/, "Brevo somado (3+1=4)");
});

test("renderContactsSummarySection: sem valores ≥40 → sem linha '40+' (#3415)", () => {
  const html = renderContactsSummarySection({
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40, "-3": 2 },
  });
  assert.doesNotMatch(html, /40\+/, "linha 40+ não aparece quando não há valores ≥40");
});

test("renderContactsSummarySection: linha Total continua somando TODOS os valores, mesmo agrupados em 40+ (#3415)", () => {
  const html = renderContactsSummarySection({
    ...sample,
    priority_points_histogram: { "0": 400, "15": 40, "40": 3, "80": 2 },
  });
  const totalRowMatch = html.match(/<tr class="total-row"><td>Total<\/td>([\s\S]*?)<\/tr>/);
  assert.ok(totalRowMatch, "linha Total capturável");
  assert.match(totalRowMatch![1], />445</, "total = 400+40+3+2 = 445, independente do agrupamento 40+");
});

test("renderContactsSummarySection: tabela 'Por tier'/'Por safra' não existe — histograma de priority_points é PURO (#2880)", () => {
  // #2805/#2817 tinham breakdown de cohort embutido na linha 0; #2880 removeu
  // esse embutido de vez — o histograma mostra só valor/contatos(/verified/Brevo),
  // sem sub-linhas de cohort.
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40, null: 12 },
  };
  const html = renderContactsSummarySection(withHistogram);
  assert.doesNotMatch(html, /Por tier \(1º envio\)/, "tabela separada não existe (nem por tier, nem por cohort)");
  assert.doesNotMatch(html, /· 1º envio —/, "sem sub-linhas de cohort na linha 0");
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><\/tr>/, "linha 0 sem nada anexado depois");
});

test("renderContactsSummarySection: coluna 'verified' quando o KV traz os campos novos (260702)", () => {
  const withVerified: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_verified: { "0": 81000, "15": 7 },
  };
  const html = renderContactsSummarySection(withVerified);
  assert.match(html, /<th scope="col" style="text-align:right">verified<\/th>/, "header da coluna presente");
  // linha 0: contatos e verified lado a lado
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>81[.,]?000<\/td>/);
  // linha 15
  assert.match(html, /<td>15<\/td><td[^>]*>40<\/td><td[^>]*>7<\/td>/);
});

test("renderContactsSummarySection: KV antigo (sem campos verified) → tabela de 2 colunas, sem header verified", () => {
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
  };
  const html = renderContactsSummarySection(withHistogram);
  // (não usar />verified</ solto — a tabela do MillionVerifier tem a chave
  // "verified" como linha legítima; o que não pode existir é o HEADER da coluna.)
  assert.doesNotMatch(html, /<th[^>]*>verified<\/th>/, "coluna não aparece sem o dado");
});

test("renderContactsSummarySection: ordem das tabelas — priority_points → Inelegíveis → MV (#2806)", () => {
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
  };
  const html = renderContactsSummarySection(withHistogram);
  // #2906: cabeçalho relabelado priority_points → "Score" (só apresentação).
  const idxPp = html.indexOf("Score (valor exato)");
  const idxInelig = html.indexOf("Inelegíveis por razão");
  const idxMv = html.indexOf("MillionVerifier (bucket)");
  assert.ok(idxPp !== -1 && idxInelig !== -1 && idxMv !== -1, "as 3 tabelas presentes");
  assert.ok(idxPp < idxInelig, "Inelegíveis vem DEPOIS do Score (#2806)");
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
// #2880 — unificação: "Por safra" e as sub-linhas "1º envio" saíram do
// dashboard; o eixo cohort vive só na tabela Cohorts (aba Contatos)
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: 'Por safra' e sub-linhas '1º envio —' NÃO aparecem mais; nota aponta pra Cohorts (#2880)", () => {
  const html = renderContactsSummarySection(sample);
  assert.doesNotMatch(html, /Por safra \(cohort\)/, "tabela 'Por safra' removida");
  assert.doesNotMatch(html, /· 1º envio —/, "sub-linhas de 1º envio removidas");
  assert.match(html, /está na tabela <strong>Cohorts<\/strong>/, "nota aponta pra tabela Cohorts");
});

// ---------------------------------------------------------------------------
// #2865 — coluna "Brevo" (brevo_list_ids IS NOT NULL) no histograma de
// priority_points
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: coluna 'Brevo' aparece quando priority_points_histogram_brevo está presente (#2865)", () => {
  const withBrevo: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_brevo: { "0": 29000, "15": 12 },
  };
  const html = renderContactsSummarySection(withBrevo);
  assert.match(html, /<th scope="col" style="text-align:right">Brevo<\/th>/, "header da coluna Brevo presente");
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>29[.,]?000<\/td>/, "linha 0 com valor Brevo");
  assert.match(html, /<td>15<\/td><td[^>]*>40<\/td><td[^>]*>12<\/td>/, "linha 15 com valor Brevo");
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

// ---------------------------------------------------------------------------
// #2880 — coluna "elegíveis" (send_eligible=1) no histograma de priority_points
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: coluna 'elegíveis' aparece quando priority_points_histogram_eligible está presente (#2880)", () => {
  const withEligible: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40 },
    priority_points_histogram_eligible: { "0": 422000, "15": 38 },
  };
  const html = renderContactsSummarySection(withEligible);
  assert.match(html, /<th scope="col" style="text-align:right">elegíveis<\/th>/, "header da coluna elegíveis presente");
  // ordem: contatos | elegíveis → linha 0 com contatos e elegíveis lado a lado
  assert.match(html, /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>422[.,]?000<\/td>/, "linha 0 com valor elegíveis");
  assert.match(html, /<td>15<\/td><td[^>]*>40<\/td><td[^>]*>38<\/td>/, "linha 15 com valor elegíveis");
});

test("renderContactsSummarySection: KV antigo (sem priority_points_histogram_eligible) → sem header/coluna elegíveis (retrocompat, #2880)", () => {
  const noEligible: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
  };
  const html = renderContactsSummarySection(noEligible);
  assert.doesNotMatch(html, /<th[^>]*>elegíveis<\/th>/, "coluna elegíveis não aparece sem o dado");
});

// ---------------------------------------------------------------------------
// #2880 E — linha "Total" nas kvTable (ex: Inelegíveis por razão) e no
// histograma de priority_points
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: kvTable (Inelegíveis por razão) ganha linha Total somando as contagens (#2880 E)", () => {
  const html = renderContactsSummarySection({
    ...sample,
    eligibility: { eligible: 100, ineligible: 15, by_reason: { mv_rejected: 10, dispute: 5 } },
  });
  assert.match(html, /<tr class="total-row"><td>Total<\/td><td[^>]*>15<\/td><\/tr>/, "linha Total soma mv_rejected+dispute = 15");
});

test("renderContactsSummarySection: kvTable com map vazio NÃO ganha linha Total (sem 'Total 0' sem sentido)", () => {
  const html = renderContactsSummarySection({
    ...sample,
    eligibility: { eligible: 100, ineligible: 0, by_reason: {} },
  });
  assert.doesNotMatch(html, /<tr class="total-row"><td>Total<\/td><td[^>]*>0<\/td><\/tr>/);
});

test("renderContactsSummarySection: histograma de priority_points ganha linha Total somando contatos/elegíveis/verified/Brevo (#2880 E)", () => {
  const withAll: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 400, "15": 40, null: 10 },
    priority_points_histogram_eligible: { "0": 380, "15": 38 },
    priority_points_histogram_verified: { "0": 90, "15": 7 },
    priority_points_histogram_brevo: { "0": 29, "15": 3 },
  };
  const html = renderContactsSummarySection(withAll);
  assert.match(html, /<tr class="total-row">/, "linha Total presente no histograma");
  const totalRowMatch = html.match(/<tr class="total-row"><td>Total<\/td>([\s\S]*?)<\/tr>/);
  assert.ok(totalRowMatch, "linha Total do histograma capturável");
  const cells = totalRowMatch![1];
  assert.match(cells, />450</, "contatos somados (400+40+10)");
  assert.match(cells, />418</, "elegíveis somados (380+38)");
  assert.match(cells, />97</, "verified somado (90+7)");
  assert.match(cells, />32</, "Brevo somado (29+3)");
});

test("renderContactsSummarySection: ordem das colunas — contatos | elegíveis | verified | Brevo (#2880)", () => {
  const all: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520 },
    priority_points_histogram_eligible: { "0": 422000 },
    priority_points_histogram_verified: { "0": 81000 },
    priority_points_histogram_brevo: { "0": 29000 },
  };
  const html = renderContactsSummarySection(all);
  // 5 células na mesma linha, na ordem exata contatos → elegíveis → verified → Brevo
  assert.match(
    html,
    /<td>0<\/td><td[^>]*>427[.,]?520<\/td><td[^>]*>422[.,]?000<\/td><td[^>]*>81[.,]?000<\/td><td[^>]*>29[.,]?000<\/td>/,
    "5 células na ordem contatos|elegíveis|verified|Brevo",
  );
  // headers na mesma ordem
  const idxContatos = html.indexOf(">contatos<");
  const idxElegiveis = html.indexOf(">elegíveis<");
  const idxVerified = html.indexOf(">verified<");
  const idxBrevo = html.indexOf(">Brevo<");
  assert.ok(idxContatos < idxElegiveis && idxElegiveis < idxVerified && idxVerified < idxBrevo, "headers na ordem correta");
});

// ---------------------------------------------------------------------------
// #2906 — relabel priority_points → "Score" (só apresentação; identificador
// interno intocado)
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: cabeçalho do histograma mostra 'Score', não 'priority_points' (relabel #2906)", () => {
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "40": 3 },
  };
  const html = renderContactsSummarySection(withHistogram);
  assert.match(html, /<th[^>]*>Score \(valor exato\)<\/th>/, "header relabelado pra Score");
  assert.doesNotMatch(html, /<th[^>]*>priority_points \(valor exato\)<\/th>/, "cabeçalho antigo não existe mais");
});

test("renderContactsSummarySection: fallback (KV pré-#2731) também mostra 'Score', não 'priority_points' (#2906)", () => {
  // `sample` não tem priority_points_histogram → cai na tabela por faixa.
  const html = renderContactsSummarySection(sample);
  assert.match(html, /<th[^>]*>Score \(re-envio, por faixa[^<]*<\/th>/, "header do fallback relabelado");
  assert.doesNotMatch(html, /<th[^>]*>priority_points \(re-envio/, "cabeçalho antigo do fallback não existe mais");
});

test("renderContactsSummarySection: nota deixa claro que 'Score' = priority_points (engajamento), não o score legado (#2906)", () => {
  const html = renderContactsSummarySection({ ...sample, priority_points_histogram: { "0": 427520 } });
  assert.match(html, /"Score"[^<]*<code>priority_points<\/code>/, "nota mapeia Score → priority_points (identificador interno)");
  assert.match(html, /legado/, "nota avisa sobre o 'score' legado desacreditado");
});

test("renderContactsSummarySection: legenda visível abaixo da tabela Score explica a fórmula (#3074)", () => {
  // Antes só existia no title= (tooltip hover) do header — invisível por
  // padrão, inacessível em touch/mobile. A legenda precisa estar num
  // <p class="section-note"> visível (mesmo padrão das demais seções).
  const html = renderContactsSummarySection(sample);
  assert.match(
    html,
    /<p class="section-note">Score = <code>priority_points<\/code>/,
    "legenda de Score existe como section-note visível",
  );
  assert.match(html, /\+40<\/strong> optin/, "explica o bônus de optin");
  assert.match(html, /\+20<\/strong> por e-mail aberto/, "explica o bônus de abertura");
  assert.match(html, /−10<\/strong> por e-mail recebido e não aberto/, "explica o desconto de não-abertura");
});

test("renderContactsSummarySection: identificador interno priority_points intocado — o render lê s.priority_points (faixas) (#2906)", () => {
  // Prova estrutural: um summary com o campo `priority_points` (chave interna
  // preservada) renderiza as faixas — se a chave tivesse sido renomeada, o
  // render não acharia p41_80 e a faixa "41–80" (=1) sumiria.
  const html = renderContactsSummarySection(sample);
  assert.match(html, /41–80/, "faixa lida de s.priority_points.p41_80 (identificador interno vivo)");
});

// ---------------------------------------------------------------------------
// #2908 — Inelegíveis por razão + MillionVerifier (bucket) lado a lado
// ---------------------------------------------------------------------------

test("renderContactsSummarySection: 'Inelegíveis por razão' e 'MillionVerifier (bucket)' num container .side-by-side (#2908)", () => {
  const html = renderContactsSummarySection(sample);
  assert.match(html, /<div class="side-by-side">/, "container flex presente");
  const sbsMatch = html.match(/<div class="side-by-side">([\s\S]*?)<\/div>\s*<p class="section-note">Engajamento Brevo/);
  assert.ok(sbsMatch, "container .side-by-side capturável (fecha antes da nota de Engajamento)");
  const inner = sbsMatch![1];
  assert.match(inner, /Inelegíveis por razão/, "tabela Inelegíveis dentro do container");
  assert.match(inner, /MillionVerifier \(bucket\)/, "tabela MillionVerifier dentro do container");
  assert.ok(
    inner.indexOf("Inelegíveis por razão") < inner.indexOf("MillionVerifier (bucket)"),
    "Inelegíveis antes de MV dentro do container",
  );
});
