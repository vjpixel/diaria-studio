/**
 * #10179 — frase do "quero" da Clarice News: fora do 1º envio do ciclo,
 * presente no 2º e no 3º (e do 4º em diante, premissa registrada no PR).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyQueroPhrase,
  describeQueroApplication,
  describeQueroOutcome,
  hasQueroPhrase,
  queroIncludedForSend,
  resolveEnvioIndex,
  sendSlotOf,
} from "../scripts/lib/clarice-quero-phrase.ts";
import { buildInvocationSummary, type CampaignEntry } from "../scripts/clarice-schedule-group.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Trecho real do cloudflare-preview.html de 2609-10 (render de `draftToEmail`).
const P_STYLE = `style="margin:0 0 16px 0;font-family:'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;"`;
const HTML =
  `<p ${P_STYLE}>Esta é a newsletter mensal da <a href="https://clarice.ai/?via=diaria">Clarice</a>: uma curadoria.</p>\n` +
  `<p ${P_STYLE}>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. ` +
  `Se quiser receber tutoriais e notícias de IA todos os dias, se cadastre gratuitamente ` +
  `<a href="https://diar.ia.br/?utm_source=clarice">aqui</a>.</p>\n` +
  `<p ${P_STYLE}>Você está recebendo esse e-mail porque se cadastrou na Clarice. <a href="{{ unsubscribe }}">descadastrar aqui</a>.</p>`;

/** O marcador do critério de aceite da issue, em texto plano. */
function containsQueroMarker(html: string): boolean {
  return html.replace(/&quot;/g, '"').includes('dizendo "quero"');
}

test('#10179 aceite: num ciclo com 3 envios, o 1º sai sem `dizendo "quero"` e o 2º e 3º com', () => {
  // Ondas do ciclo na ordem de criação, como em group-campaigns.json.
  const history: string[] = [];
  const outputs: string[] = [];
  for (const key of ["d1-sab03", "d2-dom04", "novos-261005-0900"]) {
    const idx = resolveEnvioIndex(history, key);
    outputs.push(applyQueroPhrase(HTML, idx).html);
    history.push(key);
  }
  assert.equal(containsQueroMarker(outputs[0]), false, "envio 1 não pode ter a frase");
  assert.equal(containsQueroMarker(outputs[1]), true, "envio 2 tem a frase");
  assert.equal(containsQueroMarker(outputs[2]), true, "envio 3 tem a frase");
});

test("#10179 envio 1: tira só a frase do quero — o resto da APRESENTAÇÃO fica", () => {
  const r = applyQueroPhrase(HTML, 1);
  assert.equal(r.included, false);
  assert.equal(r.foundInSource, true);
  assert.ok(r.html.includes(`<p ${P_STYLE}>Se quiser receber tutoriais e notícias de IA todos os dias`));
  assert.ok(r.html.includes("Esta é a newsletter mensal"));
  assert.ok(r.html.includes("{{ unsubscribe }}"));
  assert.equal(hasQueroPhrase(r.html), false);
});

test("#10179 envio 4 em diante mantém a frase (premissa: estende o 2º/3º)", () => {
  for (const idx of [2, 3, 4, 9]) {
    assert.equal(queroIncludedForSend(idx), true, `envio ${idx}`);
    const r = applyQueroPhrase(HTML, idx);
    assert.equal(r.html, HTML);
    assert.equal(r.included, true);
  }
  assert.equal(queroIncludedForSend(1), false);
  assert.throws(() => queroIncludedForSend(0));
});

test("#10179 frase como parágrafo próprio: o <p> vazio some junto", () => {
  const html = `<p>Antes.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo “quero”.</p>\n<p>Depois.</p>`;
  const r = applyQueroPhrase(html, 1);
  assert.equal(r.html, `<p>Antes.</p>\n<p>Depois.</p>`);
});

test("#10179 variações de render: aspas retas, curvas e entidade de você", () => {
  for (const v of [
    'Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo "quero".',
    "Se voc&ecirc; quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &ldquo;quero&rdquo;.",
  ]) {
    assert.equal(hasQueroPhrase(v), true, v);
    assert.equal(applyQueroPhrase(`<p>${v} Resto.</p>`, 1).html, "<p>Resto.</p>");
  }
});

test("#10179 draft sem a frase: nada é injetado e o relatório avisa no 2º envio", () => {
  const html = "<p>Sem frase.</p>";
  const r = applyQueroPhrase(html, 2);
  assert.equal(r.html, html);
  assert.equal(r.included, false);
  assert.equal(r.foundInSource, false);
  assert.match(describeQueroApplication(r), /AUSENTE no envio 2/);
  assert.match(describeQueroOutcome(2, false), /AUSENTE no envio 2/);
  assert.match(describeQueroOutcome(1, false), /fora \(envio 1/);
  assert.match(describeQueroOutcome(3, true), /INCLUÍDA \(envio 3/);
});

test("#10179 células da mesma onda são o MESMO envio; key já registrada é estável", () => {
  assert.equal(sendSlotOf("d6-qui06-A"), "d6-qui06");
  assert.equal(sendSlotOf("d6-qui06-H09"), "d6-qui06");
  assert.equal(sendSlotOf("d6-qui06-VB"), "d6-qui06");
  assert.equal(sendSlotOf("novos-261005-0900"), "novos-261005-0900");

  assert.equal(resolveEnvioIndex([], "d1-sab03-A"), 1);
  assert.equal(resolveEnvioIndex(["d1-sab03-A"], "d1-sab03-B"), 1, "outra célula da onda 1 ainda é o envio 1");
  assert.equal(resolveEnvioIndex(["d1-sab03-A", "d1-sab03-B", "d1-sab03-C"], "d2-dom04-A"), 2);
  assert.equal(resolveEnvioIndex(["d1-sab03-A", "d2-dom04-A"], "d1-sab03-A"), 1, "re-execução idempotente mantém o índice");
});

test("#10179 resumo da invocação ecoa envioIndex/queroIncluded pra o relatório do caller", () => {
  const c: CampaignEntry = {
    key: "d1-sab03",
    campaignId: 1,
    listId: 2,
    subject: "s",
    status: "scheduled",
    envioIndex: 1,
    queroIncluded: false,
  };
  const s = buildInvocationSummary("d1-sab03", 2, { create: false, updateHtml: false, sendTest: false, schedule: true }, c, [c]);
  assert.equal(s.envioIndex, 1);
  assert.equal(s.queroIncluded, false);

  const legacy: CampaignEntry = { key: "x", campaignId: 3, listId: 2, subject: "s", status: "sent" };
  const s2 = buildInvocationSummary("x", 2, { create: false, updateHtml: false, sendTest: false, schedule: false }, legacy, [legacy]);
  assert.equal("envioIndex" in s2, false, "campanha anterior ao #10179 não ganha campo inventado");
});

test("#10179 clarice-schedule-group aplica a regra no htmlContent (wiring)", () => {
  const src = readFileSync(resolve(ROOT, "scripts/clarice-schedule-group.ts"), "utf8");
  // A regra roda ANTES de qualquer POST/PUT de htmlContent (create/update-html).
  const applyAt = src.indexOf("applyQueroPhrase(");
  const firstHtmlWrite = src.indexOf("htmlContent: html");
  assert.ok(applyAt > 0 && firstHtmlWrite > applyAt, "applyQueroPhrase precisa vir antes do 1º htmlContent");
  assert.match(src, /getIntArg\(argv, "envio-index"/);
  assert.match(src, /envioIndex: quero\.envioIndex/);
});
