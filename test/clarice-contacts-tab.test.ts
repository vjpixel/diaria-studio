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
  // #2805: o universo da antiga tabela "Por tier (1º envio)" (firstSend =
  // send_eligible=1 + sends_count=0, #2732) é EXATAMENTE a linha
  // priority_points=0 do histograma — as duas visões duplicavam informação.
  // A tabela sai; o breakdown por tier aparece inline na linha 0.
  const withHistogram: ContactsSummary = {
    ...sample,
    priority_points_histogram: { "0": 427520, "15": 40, null: 12 },
  };
  const html = renderContactsSummarySection(withHistogram);
  assert.doesNotMatch(html, /Por tier \(1º envio\)/, "tabela separada não existe mais");
  // breakdown na linha 0 — by_tier {1:1167, 2:7269, null:131}, tier ASC, sem tier por último
  assert.match(html, /T01: 1[.,]?167/);
  assert.match(html, /T02: 7[.,]?269/);
  assert.match(html, /sem tier: 131/);
  const idxT01 = html.indexOf("T01:");
  const idxT02 = html.indexOf("T02:");
  const idxSem = html.indexOf("sem tier:");
  assert.ok(idxT01 < idxT02 && idxT02 < idxSem, "ordem da fila de 1º envio: T01 → T02 → sem tier");
  // o breakdown fica NA célula do valor 0 (mesmo <td>), não na linha do 15
  assert.match(html, /<td>0 <span[^>]*>· T01:/);
  assert.doesNotMatch(html, /<td>15[^<]*T01:/);
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
