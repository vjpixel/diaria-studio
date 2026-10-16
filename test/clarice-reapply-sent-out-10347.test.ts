/**
 * #10347 — regressão (#633): o reapply contava como saída só a fila da Brevo
 * (`queued`/`scheduled`, #10272). Uma onda já ENVIADA (`sent`) com registro
 * local `draft` (GET-verify falho pré-#10211) saiu da fila e não contava por
 * nenhum dos dois lados — a d2 agendada virava "1º envio" e perdia a frase do
 * "quero". Só fixtures — nunca Brevo real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectCycleOutKeys,
  queroHtmlForCampaign,
  type BrevoCampaignListItem,
} from "../scripts/clarice-reapply-scheduled-html.ts";
import { hasQueroPhrase } from "../scripts/lib/clarice-quero-phrase.ts";

const HTML =
  '<p>Apresentação.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. Resto.</p>';
const P = "Clarice 2610 grupo:";
const CYCLE = "2610-11";

function camp(id: number, name: string, status: string): BrevoCampaignListItem {
  return { id, name, status } as BrevoCampaignListItem;
}

test("#10347 d1 enviada na Brevo (local draft, sem marcador) conta: d2 agendada é o 2º envio", () => {
  const d1 = camp(10, `${P}d1-sab03-A`, "sent");
  const d2 = camp(20, `${P}d2-dom04-A`, "queued");
  // API lista em ordem decrescente de criação (#10300).
  const all = [d2, d1, camp(5, "Clarice 2609 grupo:d1-sab01-A", "sent"), camp(6, "Outra coisa", "sent")];
  const toUpdate = [d2];
  const history = [
    { key: "d1-sab03-A", status: "draft" as const },
    { key: "d2-dom04-A", status: "scheduled" as const },
  ];

  const keys = collectCycleOutKeys(toUpdate, all, CYCLE);
  assert.deepEqual([...keys], ["d1-sab03-A", "d2-dom04-A"], "enviada do ciclo entra, outro ciclo/nome não");

  const r = queroHtmlForCampaign(HTML, d2.name, CYCLE, history, keys);
  assert.equal(hasQueroPhrase(r.html), true, "d2 é 2º envio — frase do quero fica");
  assert.match(r.line, /^d2-dom04-A: /);
});

test("#10347 enviada ausente do histórico local entra antes da agendada (ordem de criação)", () => {
  const d1 = camp(10, `${P}d1-sab03-A`, "sent");
  const d2 = camp(20, `${P}d2-dom04-A`, "scheduled");
  const keys = collectCycleOutKeys([d2], [d2, d1], CYCLE);
  const r = queroHtmlForCampaign(HTML, d2.name, CYCLE, [], keys);
  assert.equal(hasQueroPhrase(r.html), true);
});

test("#10347 inProcess conta como saída; draft/suspended na Brevo não", () => {
  const all = [
    camp(10, `${P}d1-sab03-A`, "inProcess"),
    camp(11, `${P}novos-x`, "draft"),
    camp(12, `${P}novos-y`, "suspended"),
  ];
  assert.deepEqual([...collectCycleOutKeys([], all, CYCLE)], ["d1-sab03-A"]);
});

test("#10347 sem listagem (modo --campaign-id): só o lote, comportamento do #10272", () => {
  const d2 = camp(20, `${P}d2-dom04-A`, "queued");
  const keys = collectCycleOutKeys([d2], [], CYCLE);
  assert.deepEqual([...keys], ["d2-dom04-A"]);
  const r = queroHtmlForCampaign(HTML, d2.name, CYCLE, [{ key: "d1-sab03-A", status: "draft" }], keys);
  assert.equal(hasQueroPhrase(r.html), false, "sem fonte que diga que a d1 saiu, d2 segue como 1º envio");
});
