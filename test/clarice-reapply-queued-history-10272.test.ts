/**
 * #10272 — regressão (#633): `queroHtmlForCampaign` só tratava como saída a
 * própria campanha reaplicada. As demais do lote `toUpdate` vêm da fila da
 * Brevo, então também são saídas — mesmo com registro local `draft` (GET-verify
 * falho pré-#10211). Só fixtures — nunca Brevo real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { queroHtmlForCampaign } from "../scripts/clarice-reapply-scheduled-html.ts";
import { hasQueroPhrase } from "../scripts/lib/clarice-quero-phrase.ts";

const HTML =
  '<p>Apresentação.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. Resto.</p>';

const HISTORY = [
  { key: "d1-sab03-A", status: "draft" },
  { key: "d2-dom04-A", status: "scheduled" },
];

test("#10272 d1 draft local mas na fila: d2 é o 2º envio e mantém a frase do quero", () => {
  const queued = new Set(["d1-sab03-A", "d2-dom04-A"]);
  const d2 = queroHtmlForCampaign(HTML, "Clarice 2610 grupo:d2-dom04-A", "2610-11", HISTORY, queued);
  assert.equal(hasQueroPhrase(d2.html), true, "2º envio real mantém a frase");
  const d1 = queroHtmlForCampaign(HTML, "Clarice 2610 grupo:d1-sab03-A", "2610-11", HISTORY, queued);
  assert.equal(hasQueroPhrase(d1.html), false, "1º envio sai sem a frase");
});

test("#10272 sem queuedKeys o comportamento antigo (draft não conta) permanece", () => {
  const d2 = queroHtmlForCampaign(HTML, "Clarice 2610 grupo:d2-dom04-A", "2610-11", HISTORY);
  assert.equal(hasQueroPhrase(d2.html), false);
});
