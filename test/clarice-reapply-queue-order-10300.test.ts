/**
 * #10300 — regressão (#633): keys da fila fora do histórico entravam na ordem
 * da API (decrescente por criação), invertendo o "quero" entre d1 e d2.
 * Só fixtures — nunca Brevo real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectQueuedKeys, queroHtmlForCampaign } from "../scripts/clarice-reapply-scheduled-html.ts";
import { hasQueroPhrase } from "../scripts/lib/clarice-quero-phrase.ts";

const HTML =
  '<p>Apresentação.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. Resto.</p>';
const P = "Clarice 2610 grupo:";

test("#10300 lote em ordem decrescente da API: d1 sem frase, d2 com frase", () => {
  const apiOrder = [
    { id: 20, name: `${P}d2-dom04-A` },
    { id: 10, name: `${P}d1-sab03-A` },
  ];
  const keys = collectQueuedKeys(apiOrder, P);
  assert.deepEqual([...keys], ["d1-sab03-A", "d2-dom04-A"]);
  const d2 = queroHtmlForCampaign(HTML, `${P}d2-dom04-A`, "2610-11", [], keys);
  const d1 = queroHtmlForCampaign(HTML, `${P}d1-sab03-A`, "2610-11", [], keys);
  assert.equal(hasQueroPhrase(d2.html), true);
  assert.equal(hasQueroPhrase(d1.html), false);
});
