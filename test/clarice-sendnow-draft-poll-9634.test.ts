/**
 * test/clarice-sendnow-draft-poll-9634.test.ts (#9634)
 *
 * GET-verify pós-`sendNow` do `clarice-schedule-group.ts --send-now` marcava
 * "disparo INCERTO (status=draft)" em ~59% das rodadas do `clarice-novos`,
 * embora as 99 campanhas `grupo:novos-*` estivessem `sent` na Brevo (sentDate
 * até ~14 min após o createdAt). Causa: `pollTerminalSendStatus` só insistia
 * em `"queued"` — `"draft"` voltava já na 1ª leitura — e a janela total era
 * de ~10s.
 *
 * Fix: `"draft"` logo após um POST sendNow aceito é tratado como "em
 * processamento" e reconsultado com backoff até ~15 min. Nunca declara
 * sucesso sem status terminal; não emite POST nenhum (o guard de reenvio
 * `checkSendNowGuard` segue intocado). Tudo mockado — zero chamada à Brevo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollTerminalSendStatus, SEND_NOW_IN_FLIGHT_STATUSES } from "../scripts/lib/brevo-client.ts";
import { checkSendNowGuard } from "../scripts/clarice-schedule-group.ts";

test("REGRESSÃO (#9634): 'draft' após POST aceito NÃO é devolvido na 1ª leitura — reconsulta até 'sent'", async () => {
  // Cenário real: Brevo leva minutos pra sair de "draft" depois do sendNow.
  const seq = ["draft", "draft", "draft", "draft", "sent"];
  let calls = 0;
  const delays: number[] = [];
  const result = await pollTerminalSendStatus("sk_test", 200, {
    getCampaignFn: async () => ({ status: seq[Math.min(calls++, seq.length - 1)] }),
    sleepFn: async (ms) => { delays.push(ms); },
  });
  assert.equal(result.status, "sent");
  assert.equal(calls, 5);
  // Backoff exponencial a partir de 5s.
  assert.deepEqual(delays, [5000, 10_000, 20_000, 40_000]);
});

test("#9634: janela default cobre os ~14 min medidos (draft até 13 min de espera ainda confirma 'sent')", async () => {
  let waited = 0;
  let calls = 0;
  const result = await pollTerminalSendStatus("sk_test", 200, {
    getCampaignFn: async () => {
      calls++;
      return { status: waited >= 13 * 60_000 ? "sent" : "draft" };
    },
    sleepFn: async (ms) => { waited += ms; },
  });
  assert.equal(result.status, "sent");
  // Rate limit da família /emailCampaigns é 100 req/HORA (#5215) — a espera
  // longa não pode virar dezenas de GETs.
  assert.ok(calls <= 15, `GETs demais na janela: ${calls}`);
});

test("#9634: 'draft' persistente esgota a janela (maxWaitMs) e devolve 'draft' — chamador segue tratando como INCERTO, nunca 'sent'", async () => {
  let waited = 0;
  let calls = 0;
  const result = await pollTerminalSendStatus("sk_test", 200, {
    getCampaignFn: async () => { calls++; return { status: "draft" }; },
    sleepFn: async (ms) => { waited += ms; },
  });
  assert.equal(result.status, "draft");
  assert.ok(waited <= 15 * 60_000, `esperou além da janela default: ${waited}ms`);
  assert.ok(waited >= 10 * 60_000, `janela curta demais pro lag medido: ${waited}ms`);
  assert.ok(calls <= 15, `GETs demais: ${calls}`);
});

test("#9634: maxWaitMs/maxDelayMs injetáveis limitam a espera", async () => {
  const delays: number[] = [];
  const result = await pollTerminalSendStatus("sk_test", 200, {
    delayMs: 100,
    maxDelayMs: 300,
    maxWaitMs: 1000,
    getCampaignFn: async () => ({ status: "queued" }),
    sleepFn: async (ms) => { delays.push(ms); },
  });
  assert.equal(result.status, "queued");
  // 100 + 200 + 300 = 600; próximo 300 -> 900 <= 1000; próximo 300 -> 1200 > 1000 para.
  assert.deepEqual(delays, [100, 200, 300, 300]);
});

test("#9634: 'in_review' continua saindo na 1ª leitura (não é estado de trânsito pós-sendNow)", async () => {
  assert.equal(SEND_NOW_IN_FLIGHT_STATUSES.has("in_review"), false);
  let calls = 0;
  const result = await pollTerminalSendStatus("sk_test", 200, {
    getCampaignFn: async () => { calls++; return { status: "in_review" }; },
    sleepFn: async () => { throw new Error("não deveria dormir"); },
  });
  assert.equal(result.status, "in_review");
  assert.equal(calls, 1);
});

test("#9634: erro num GET de retentativa não aborta a espera nem vira sucesso", async () => {
  let calls = 0;
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await pollTerminalSendStatus("sk_test", 200, {
      getCampaignFn: async () => {
        calls++;
        if (calls === 1) return { status: "draft" };
        if (calls === 2) throw new Error("ECONNRESET");
        return { status: "sent" };
      },
      sleepFn: async () => {},
    });
    assert.equal(result.status, "sent");
    assert.equal(calls, 3);
  } finally {
    console.error = origErr;
  }
});

test("#9634: retentativas sempre falhando devolvem o último status lido ('draft'), nunca terminal", async () => {
  let calls = 0;
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await pollTerminalSendStatus("sk_test", 200, {
      attempts: 4,
      getCampaignFn: async () => {
        calls++;
        if (calls === 1) return { status: "draft" };
        throw new Error("503");
      },
      sleepFn: async () => {},
    });
    assert.equal(result.status, "draft");
    assert.equal(calls, 4);
  } finally {
    console.error = origErr;
  }
});

test("#9634: erro na 1ª leitura propaga (sem status nenhum a devolver)", async () => {
  await assert.rejects(
    pollTerminalSendStatus("sk_test", 200, {
      getCampaignFn: async () => { throw new Error("401"); },
      sleepFn: async () => {},
    }),
    /401/,
  );
});

test("#9634: guard de reenvio inalterado — 'queued'/'sent' ao vivo nunca liberam novo POST", () => {
  assert.equal(checkSendNowGuard("draft", "queued").send, false);
  assert.equal(checkSendNowGuard("draft", "sent").send, false);
  assert.equal(checkSendNowGuard("draft", "in_process").send, false);
});
