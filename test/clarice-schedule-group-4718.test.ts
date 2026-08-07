/**
 * test/clarice-schedule-group-4718.test.ts (#4718)
 *
 * `--send-now` podia redisparar uma campanha já enviada porque o guard de
 * idempotência lia o status LOCAL (`CampaignEntry.status`), não a Brevo ao
 * vivo — e o status local ficava PRESO em "draft" sempre que o GET-verify
 * pós-sendNow pegasse a campanha em "queued" (não-terminal, mas o disparo já
 * tinha sido aceito). Reproduzido ao vivo em 260806 (campanha #121, grupo
 * `novos`, ciclo 2607-08): 1ª invocação leu "queued" no GET imediato e não
 * persistiu sucesso; a mensagem de erro instruiu "re-tente --send-now"; a 2ª
 * invocação, sem checar a Brevo, disparou um 2º POST sendNow na mesma
 * campanha (só não houve envio duplicado observável porque a Brevo
 * aparentemente ignora sendNow em campanha já "sent" — comportamento não
 * documentado, não uma garantia nossa).
 *
 * Cobre os 3 itens da proposta da issue:
 *   1. pollTerminalSendStatus: retry com backoff antes de declarar incerto
 *      (o "queued" costuma resolver em segundos).
 *   2. checkSendNowGuard: idempotência por estado AO VIVO — o item que FECHA
 *      o buraco (teste de regressão sugerido no corpo da issue).
 *   3. describeUncertainSendStatus("queued")/mensagem de
 *      applySendNowVerifyResults: orienta reconsultar, não re-disparar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brevoGetCampaign,
  brevoSendNow,
  pollTerminalSendStatus,
} from "../scripts/lib/brevo-client.ts";
import {
  checkSendNowGuard,
  applySendNowVerifyResults,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

function makeEntry(overrides: Partial<CampaignEntry> = {}): CampaignEntry {
  return { key: "novos-260806", campaignId: 121, listId: 10, subject: "Assunto", status: "draft", ...overrides };
}

// ---------------------------------------------------------------------------
// checkSendNowGuard (item 2 — idempotência por estado AO VIVO)
// ---------------------------------------------------------------------------

test("checkSendNowGuard: local 'draft' + Brevo ao vivo 'draft' -> manda enviar", () => {
  const result = checkSendNowGuard("draft", "draft");
  assert.deepEqual(result, { send: true });
});

test("REGRESSÃO (#4718): local 'draft' (defasado) + Brevo ao vivo 'sent' -> recusa e sinaliza sync do registro local", () => {
  const result = checkSendNowGuard("draft", "sent");
  assert.equal(result.send, false);
  if (result.send) throw new Error("unreachable");
  assert.match(result.reason, /já disparada na Brevo/);
  assert.equal(result.syncLocalAsSent, true);
});

test("REGRESSÃO (#4718): local 'draft' + Brevo ao vivo 'inProcess' -> recusa (terminal ao vivo, não precisa esperar 'sent')", () => {
  const result = checkSendNowGuard("draft", "inProcess");
  assert.equal(result.send, false);
  if (result.send) throw new Error("unreachable");
  assert.equal(result.syncLocalAsSent, true);
});

test("REGRESSÃO (#4718 — cenário exato da issue): local 'draft' + Brevo ao vivo 'queued' -> recusa SEM marcar sent (ainda pode virar outra coisa)", () => {
  const result = checkSendNowGuard("draft", "queued");
  assert.equal(result.send, false);
  if (result.send) throw new Error("unreachable");
  assert.match(result.reason, /NÃO re-dispare/);
  assert.equal(result.syncLocalAsSent, false, "queued não é terminal — não persiste sucesso ainda");
});

test("checkSendNowGuard: local já 'sent' -> recusa, sem precisar do status ao vivo pra decidir a razão", () => {
  const result = checkSendNowGuard("sent", "sent");
  assert.equal(result.send, false);
  if (result.send) throw new Error("unreachable");
  assert.equal(result.syncLocalAsSent, false);
});

// ---------------------------------------------------------------------------
// pollTerminalSendStatus (item 1 — retry com backoff antes de declarar incerto)
// ---------------------------------------------------------------------------

test("pollTerminalSendStatus: 1ª leitura já terminal ('sent') -> retorna sem re-consultar nem dormir", async () => {
  let calls = 0;
  let slept = 0;
  const result = await pollTerminalSendStatus("sk_test", 121, {
    getCampaignFn: async () => {
      calls++;
      return { status: "sent" };
    },
    sleepFn: async () => { slept++; },
  });
  assert.equal(result.status, "sent");
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test("REGRESSÃO (#4718 item 1): 'queued' na 1ª leitura, 'sent' na 2ª -> retorna terminal após 1 retry", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await pollTerminalSendStatus("sk_test", 121, {
    delayMs: 5000,
    getCampaignFn: async () => {
      calls++;
      return calls === 1 ? { status: "queued" } : { status: "sent" };
    },
    sleepFn: async (ms) => { delays.push(ms); },
  });
  assert.equal(result.status, "sent");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [5000]);
});

test("pollTerminalSendStatus: 'queued' em todas as tentativas -> esgota attempts e devolve o último status (não lança)", async () => {
  let calls = 0;
  const result = await pollTerminalSendStatus("sk_test", 121, {
    attempts: 3,
    delayMs: 1,
    getCampaignFn: async () => {
      calls++;
      return { status: "queued" };
    },
    sleepFn: async () => {},
  });
  assert.equal(result.status, "queued");
  assert.equal(calls, 3);
});

test("pollTerminalSendStatus: status não-terminal E não-'queued' (ex: 'in_review') -> retorna já na 1ª leitura, sem retry", async () => {
  let calls = 0;
  const result = await pollTerminalSendStatus("sk_test", 121, {
    getCampaignFn: async () => {
      calls++;
      return { status: "in_review" };
    },
    sleepFn: async () => { throw new Error("não deveria dormir — in_review não é 'queued'"); },
  });
  assert.equal(result.status, "in_review");
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Cenário composto: reproduz a sequência exata da issue via fetch mockado —
// 1ª invocação de --send-now (POST aceito, GET-verify só vê "queued", status
// local NÃO atualizado) seguida de uma 2ª invocação (Brevo já mostra "sent"
// ao vivo) — a 2ª NÃO deve emitir um novo POST sendNow.
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4718 — teste sugerido na issue): 2ª invocação de --send-now NÃO emite POST quando a Brevo já confirma o disparo ao vivo", async () => {
  const c = makeEntry(); // status local: "draft" — nunca é atualizado pela 1ª invocação (GET só viu "queued")
  const campaigns = [c];
  let sendNowPostCount = 0;
  const origFetch = globalThis.fetch;

  // --- 1ª invocação: GET pré-POST (guard) ainda vê "draft" (nada disparado
  // ainda) -> manda enviar; POST sendNow aceito; GET-verify pós-POST (sem
  // retry adicional simulado aqui — já coberto por pollTerminalSendStatus
  // acima) só enxerga "queued" -> applySendNowVerifyResults NÃO marca "sent".
  let getCallCount1 = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/sendNow") && init?.method === "POST") {
      sendNowPostCount++;
      return jsonRes(204, {});
    }
    if (u.endsWith("/emailCampaigns/121")) {
      getCallCount1++;
      const status = getCallCount1 === 1 ? "draft" : "queued"; // GET#1 = guard pré-POST; GET#2+ = verify pós-POST
      return jsonRes(200, { id: 121, name: "Clarice grupo:novos", status });
    }
    throw new Error(`fetch inesperado nesta 1ª invocação: ${u}`);
  }) as typeof fetch;

  try {
    const live1 = await brevoGetCampaign("sk_test", c.campaignId);
    const guard1 = checkSendNowGuard(c.status, live1.status);
    assert.equal(guard1.send, true, "1ª invocação: nada foi disparado ainda, deve mandar enviar");
    await brevoSendNow("sk_test", c.campaignId);
    const verified1 = await pollTerminalSendStatus("sk_test", c.campaignId, { attempts: 1 });
    applySendNowVerifyResults(
      [{ status: "fulfilled", value: verified1 }],
      [c],
      campaigns,
      "/fake/path.json",
      () => {},
      () => {},
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(sendNowPostCount, 1, "1ª invocação deve ter emitido exatamente 1 POST sendNow");
  assert.equal(c.status, "draft", "status local continua defasado — GET-verify só viu 'queued', não-terminal");

  // --- 2ª invocação: o operador segue a orientação de reconsultar (ou
  // re-roda --send-now sem saber que já funcionou). Desta vez a Brevo já
  // mostra "sent" ao vivo — o guard deve barrar ANTES de qualquer POST.
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/sendNow") && init?.method === "POST") {
      sendNowPostCount++; // se isto rodar, o teste falha abaixo — não deveria ser chamado
      return jsonRes(204, {});
    }
    if (u.endsWith("/emailCampaigns/121")) {
      return jsonRes(200, { id: 121, name: "Clarice grupo:novos", status: "sent", sentDate: "2026-08-06T20:54:27-03:00" });
    }
    throw new Error(`fetch inesperado nesta 2ª invocação: ${u}`);
  }) as typeof fetch;

  try {
    const live2 = await brevoGetCampaign("sk_test", c.campaignId);
    const guard2 = checkSendNowGuard(c.status, live2.status);
    assert.equal(guard2.send, false, "2ª invocação: a Brevo já confirma 'sent' — não deve reenviar");
    if (guard2.send) throw new Error("unreachable");
    assert.equal(guard2.syncLocalAsSent, true);
    // Mesma correção de registro local que main() aplica quando guard.send===false:
    if (guard2.syncLocalAsSent) c.status = "sent";
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(sendNowPostCount, 1, "REGRESSÃO: a 2ª invocação NÃO deve emitir um novo POST sendNow");
  assert.equal(c.status, "sent", "registro local deve ser corrigido pra 'sent' na 2ª invocação");
});
