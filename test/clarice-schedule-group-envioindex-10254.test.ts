/**
 * #10254 — regressão (#633): `clarice-schedule-group.ts` reusava o
 * `envioIndex` gravado em `group-campaigns.json` quando a campanha já tinha
 * saído, enquanto o reapply (#10195) recalcula pelo histórico. Uma campanha
 * gravada com índice antigo (contando um `novos-*` em rascunho, pré-#10189)
 * recebia frase do "quero" diferente nos dois scripts. Só fixtures — nunca
 * Brevo real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveQueroEnvioIndex } from "../scripts/clarice-schedule-group.ts";
import { queroHtmlForCampaign } from "../scripts/clarice-reapply-scheduled-html.ts";
import { applyQueroPhrase, hasQueroPhrase, type EnvioHistoryEntry } from "../scripts/lib/clarice-quero-phrase.ts";

const HTML =
  '<p>Apresentação.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. Resto.</p>';

// `novos-261001` ficou em rascunho (nunca saiu); `d1-sab03-A` foi o 1º envio
// real, mas foi gravado com envioIndex 2 (contagem pré-#10189 incluía o rascunho).
const HISTORY: (EnvioHistoryEntry & { envioIndex?: number })[] = [
  { key: "novos-261001", status: "draft", envioIndex: 1 },
  { key: "d1-sab03-A", status: "scheduled", envioIndex: 2 },
];

test("#10254 campanha que já saiu com envioIndex antigo: histórico decide, não o gravado", () => {
  const r = resolveQueroEnvioIndex({ key: "d1-sab03-A", history: HISTORY, existing: HISTORY[1] });
  assert.equal(r.envioIndex, 1, "1º envio real do ciclo é o envio 1, apesar do gravado 2");
  assert.equal(hasQueroPhrase(applyQueroPhrase(HTML, r.envioIndex).html), false, "1º envio sai sem a frase");
  assert.match(r.divergence ?? "", /gravado \(2\) diverge do recalculado pelo histórico \(1\)/);
});

test("#10254 schedule-group e reapply concordam sobre a frase da mesma campanha", () => {
  const schedule = applyQueroPhrase(
    HTML,
    resolveQueroEnvioIndex({ key: "d1-sab03-A", history: HISTORY, existing: HISTORY[1] }).envioIndex,
  ).html;
  const reapply = queroHtmlForCampaign(HTML, "Clarice 2610 grupo:d1-sab03-A", "2610-11", HISTORY).html;
  assert.equal(hasQueroPhrase(schedule), hasQueroPhrase(reapply));
});

test("#10254 gravado igual ao recalculado: sem aviso", () => {
  const history: EnvioHistoryEntry[] = [{ key: "d1-sab03-A", status: "sent" }];
  const r = resolveQueroEnvioIndex({ key: "d2-sab10-A", history, existing: { envioIndex: 2 } });
  assert.equal(r.envioIndex, 2);
  assert.equal(r.divergence, undefined);
});

test("#10254 --envio-index sobrepõe o histórico e não gera aviso de divergência", () => {
  const r = resolveQueroEnvioIndex({ key: "d1-sab03-A", history: HISTORY, existing: HISTORY[1], override: 3 });
  assert.equal(r.envioIndex, 3);
  assert.equal(r.divergence, undefined);
});

test("#10254 campanha nova (sem entrada gravada) usa o histórico", () => {
  const r = resolveQueroEnvioIndex({ key: "d2-sab10-A", history: HISTORY });
  assert.equal(r.envioIndex, 2);
  assert.equal(r.divergence, undefined);
});
