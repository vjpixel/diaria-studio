/**
 * #10189 — regressão (#633): a contagem de envios do ciclo para a frase do
 * "quero" (#10179) só considera campanhas que DE FATO SAÍRAM. Antes, um
 * `novos-*` em `draft` que nunca foi disparado levava o índice 1 e o 1º
 * envio real já saía com a frase (verificado no group-campaigns.json real do
 * ciclo 2608-09: `novos-260822` draft na 1ª posição, 1º envio real na 4ª).
 * Só fixtures — nunca Brevo real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyQueroPhrase,
  envioWentOut,
  hasQueroPhrase,
  resolveEnvioIndex,
  type EnvioHistoryEntry,
} from "../scripts/lib/clarice-quero-phrase.ts";
import { queroHtmlForCampaign, runApplyBatch, type BrevoCampaignListItem } from "../scripts/clarice-reapply-scheduled-html.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML =
  '<p>Apresentação.</p>\n<p>Se você quiser receber essa newsletter com prioridade, responda a este e-mail dizendo &quot;quero&quot;. Resto.</p>';

// Forma do group-campaigns.json real de 2608-09 (keys/status), reduzida.
const CICLO_2608_09: EnvioHistoryEntry[] = [
  { key: "novos-260822", status: "draft" },
  { key: "novos-260822-2", status: "draft" },
  { key: "novos-260823", status: "draft" },
];

test("#10189 novos em draft antes do 1º envio real não gasta a exceção do envio 1", () => {
  const idx = resolveEnvioIndex(CICLO_2608_09, "novos-260823-2");
  assert.equal(idx, 1, "1º envio efetivo do ciclo é o envio 1");
  assert.equal(hasQueroPhrase(applyQueroPhrase(HTML, idx).html), false, "1º envio efetivo sai sem a frase");

  // Depois que ele sai, o próximo é o envio 2 (com a frase) — os rascunhos seguem fora.
  const after = [...CICLO_2608_09, { key: "novos-260823-2", status: "sent" }];
  assert.equal(resolveEnvioIndex(after, "d1-sab29-A"), 2);
  assert.equal(resolveEnvioIndex(after, "novos-260823-2"), 1, "re-execução da onda que saiu mantém o índice");
});

test("#10189 novos minúsculo em draft antes da d1 não empurra a rampa para o envio 2", () => {
  const history: EnvioHistoryEntry[] = [{ key: "novos-261001", status: "draft" }];
  assert.equal(resolveEnvioIndex(history, "d1-sab03-A"), 1);
});

test("#10189 premissa: novos que SAIU antes da d1 é o 1º envio do ciclo (rampa e novos contam juntas)", () => {
  const history: EnvioHistoryEntry[] = [{ key: "novos-261001", status: "sent" }];
  assert.equal(resolveEnvioIndex(history, "d1-sab03-A"), 2);
});

test("#10189 o que conta como 'saiu': sent, scheduled ou sendNow aceito", () => {
  assert.equal(envioWentOut({ key: "a", status: "sent" }), true);
  assert.equal(envioWentOut({ key: "a", status: "scheduled" }), true);
  assert.equal(envioWentOut({ key: "a", status: "draft", sendNowAcceptedAt: "2026-10-01T12:00:00Z" }), true);
  assert.equal(envioWentOut({ key: "a", status: "draft" }), false);
  assert.equal(envioWentOut({ key: "a", status: "draft", sendNowAcceptedAt: "" }), false);

  const history: EnvioHistoryEntry[] = [
    { key: "d1-sab03-A", status: "draft", sendNowAcceptedAt: "2026-10-03T09:00:00Z" },
    { key: "novos-261004", status: "draft" },
  ];
  assert.equal(resolveEnvioIndex(history, "d2-dom04-A"), 2, "sendNow aceito conta mesmo com status local draft");
});

test("#10189 clarice-schedule-group: recalcula o índice pelo histórico em vez de reusar o gravado", () => {
  const src = readFileSync(resolve(ROOT, "scripts/clarice-schedule-group.ts"), "utf8");
  // #10254: nem rascunho nem campanha que já saiu reusam o gravado — o histórico decide sempre.
  assert.doesNotMatch(src, /existing\.envioIndex : undefined/);
  // #10212: o histórico passa por buildContentEnvioHistory (ciclo de conteúdo), ainda com as entradas completas.
  assert.match(src, /segmentsHistory: campaigns,/, "passa as entradas com status, não só as keys");
  assert.match(src, /resolveQueroEnvioIndex\(\{ key, history: envioHistory,/);
});

test("#10189 reapply: 1º envio ainda agendado sai sem a frase; envio 2 com a frase", () => {
  const history = [
    { key: "novos-261001", status: "draft" },
    { key: "d1-sab03-A", status: "scheduled" },
    { key: "d2-dom04-A", status: "scheduled" },
  ];
  const r1 = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:d1-sab03-A", "2609-10", history);
  assert.equal(hasQueroPhrase(r1.html), false);
  assert.match(r1.line, /d1-sab03-A: .*RETIRADA/);
  const r2 = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:d2-dom04-A", "2609-10", history);
  assert.equal(r2.html, HTML);
});

test("#10195 reapply: histórico vence o envioIndex gravado (gravado só avisa); campanha fora do histórico conta como saída; nome legado fica intacto", () => {
  // Cenário da issue: novos-* em rascunho levou o índice 1 pela regra antiga e
  // a d1 foi gravada com envioIndex 2, mas na prática é o 1º envio.
  const d1 = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:d1-sab03-A", "2609-10", [
    { key: "novos-261001", status: "draft", envioIndex: 1 },
    { key: "d1-sab03-A", status: "scheduled", envioIndex: 2 },
  ]);
  assert.equal(hasQueroPhrase(d1.html), false, "1º envio real sai sem a frase apesar do 2 gravado");
  assert.match(d1.line, /gravado \(2\) diverge do recalculado pelo histórico \(1\)/);

  // Sentido inverso: gravado 1, mas um envio já saiu antes → é o envio 2.
  const d3 = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:d3-seg05", "2609-10", [
    { key: "d1-sab03", status: "sent" },
    { key: "d3-seg05", status: "scheduled", envioIndex: 1 },
  ]);
  assert.equal(d3.html, HTML, "envio 2 mantém a frase apesar do 1 gravado");
  assert.match(d3.line, /gravado \(1\) diverge/);

  // Gravado concorda com o histórico → sem aviso.
  const agree = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:d3-seg05", "2609-10", [
    { key: "d1-sab03", status: "sent" },
    { key: "d3-seg05", status: "scheduled", envioIndex: 2 },
  ]);
  assert.doesNotMatch(agree.line, /diverge/);

  const outside = queroHtmlForCampaign(HTML, "Clarice 2609 grupo:extra", "2609-10", []);
  assert.equal(hasQueroPhrase(outside.html), false, "ciclo vazio + campanha agendada = envio 1");

  const legacy = queroHtmlForCampaign(HTML, "Clarice News 2609 d01-A", "2609-10", []);
  assert.equal(legacy.html, HTML);
  assert.match(legacy.line, /regra não aplicada/);
});

test("#10189 runApplyBatch aceita HTML por campanha", async () => {
  const seen: Record<number, string> = {};
  const origFetch = globalThis.fetch;
  const origError = console.error;
  console.error = (() => {}) as typeof console.error;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.brevo.com/v3", "");
    const method = init?.method ?? "GET";
    const id = Number(path.match(/\/emailCampaigns\/(\d+)/)?.[1]);
    if (method === "PUT" && path.endsWith("/status")) return new Response(null, { status: 204 });
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if ("htmlContent" in body) seen[id] = body.htmlContent;
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/contacts/lists/")) {
      return new Response(JSON.stringify({ id: 55, name: "lista", totalSubscribers: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        id,
        name: `Clarice 2609 grupo:k${id}`,
        status: "queued",
        subject: "Assunto",
        scheduledAt: "2026-10-27T14:00:00.000Z",
        recipients: { lists: [55] },
        htmlContent: seen[id] ?? "<html>velho</html>",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    const item = (id: number): BrevoCampaignListItem => ({
      id,
      name: `Clarice 2609 grupo:k${id}`,
      status: "queued",
      subject: "Assunto",
      scheduledAt: "2026-10-27T14:00:00.000Z",
      recipients: { lists: [55] },
    });
    const r = await runApplyBatch("fake-key", "2609-10", [item(1), item(2)], (c) => `<html>${c.id}</html>`);
    assert.equal(r.failedIds.length, 0);
    assert.equal(seen[1], "<html>1</html>");
    assert.equal(seen[2], "<html>2</html>");
  } finally {
    globalThis.fetch = origFetch;
    console.error = origError;
  }
});
