/**
 * test/clarice-schedule-group-9638.test.ts (#9638)
 *
 * `checkSendNowGuard` só bloqueava um 2º POST `sendNow` com status ao vivo
 * "queued" ou terminal. A #9634 mostrou que "draft" logo depois de um POST
 * aceito é o envio em processamento (até ~14 min). Uma re-execução manual de
 * `--send-now` nessa janela via "draft" e POSTava de novo.
 *
 * Fix: o instante do POST aceito vai pro registro local da campanha
 * (`CampaignEntry.sendNowAcceptedAt`) e o guard trata "draft" dentro de
 * `SEND_NOW_GUARD_WINDOW_MS` (2x a janela do polling) como em processamento.
 * Relógio injetado (`now`) no lugar de tempo real; `runSendNowLive` testado
 * com Brevo mockada (nenhum envio real).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEND_NOW_PROCESSING_WINDOW_MS, SEND_NOW_GUARD_WINDOW_MS } from "../scripts/lib/brevo-client.ts";
import { checkSendNowGuard, runSendNowLive, applySendNowVerifyResults, type CampaignEntry } from "../scripts/clarice-schedule-group.ts";

const ACCEPTED = "2026-10-06T12:00:00.000Z";
const at = (minutesAfter: number) => new Date(Date.parse(ACCEPTED) + minutesAfter * 60_000);

test("REGRESSÃO (#9638): 'draft' ao vivo 3 min após POST aceito -> recusa novo POST", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: at(3) });
  assert.equal(result.send, false);
  if (result.send) return;
  assert.equal(result.syncLocalAsSent, false);
  assert.match(result.reason, /processamento/);
  assert.match(result.reason, /NÃO re-dispare/);
});

test("#9638: 'draft' ao vivo no último minuto da janela (14 min) -> ainda recusa", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: at(14.9) });
  assert.equal(result.send, false);
});

test("#9638: 'draft' logo DEPOIS do fim do polling (16 min) -> ainda recusa (folga do guard)", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: at(16) });
  assert.equal(result.send, false);
});

test("#9638: 'draft' ao vivo DEPOIS da janela do guard -> libera POST (a Brevo não processou o 1º)", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: at(31) });
  assert.deepEqual(result, { send: true });
});

test("#9638: janela default do guard é 2x a do pollTerminalSendStatus", () => {
  assert.equal(SEND_NOW_PROCESSING_WINDOW_MS, 15 * 60_000);
  assert.equal(SEND_NOW_GUARD_WINDOW_MS, 2 * SEND_NOW_PROCESSING_WINDOW_MS);
  const justBefore = new Date(Date.parse(ACCEPTED) + SEND_NOW_GUARD_WINDOW_MS - 1);
  const atEdge = new Date(Date.parse(ACCEPTED) + SEND_NOW_GUARD_WINDOW_MS);
  assert.equal(checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: justBefore }).send, false);
  assert.equal(checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: atEdge }).send, true);
});

test("#9638: sem registro de POST aceito, 'draft' segue liberando (1º disparo)", () => {
  assert.deepEqual(checkSendNowGuard("draft", "draft", {}), { send: true });
  assert.deepEqual(checkSendNowGuard("draft", "draft"), { send: true });
});

test("#9638: timestamp ilegível + 'draft' -> recusa (erro conservador)", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: "não-é-data", now: at(1) });
  assert.equal(result.send, false);
});

test("#9638: relógio local atrás do registro (elapsed negativo) -> recusa", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: at(-2) });
  assert.equal(result.send, false);
});

test("#9638: status terminal ao vivo vence o registro de POST aceito (sync local)", () => {
  const result = checkSendNowGuard("draft", "sent", { sendNowAcceptedAt: ACCEPTED, now: at(3) });
  assert.equal(result.send, false);
  if (result.send) return;
  assert.equal(result.syncLocalAsSent, true);
});

// --- runSendNowLive (miolo do --send-now de main(), Brevo mockada) ---

function mockRun(opts: { liveStatus: string; pollStatus: string; now: Date; entry?: Partial<CampaignEntry> }) {
  const events: string[] = [];
  const writes: CampaignEntry[][] = [];
  const c: CampaignEntry = {
    key: "novos",
    campaignId: 121,
    listId: 7,
    subject: "s",
    status: "draft",
    ...opts.entry,
  } as CampaignEntry;
  const campaigns = [c];
  const deps = {
    getCampaignFn: async () => {
      events.push("get");
      return { status: opts.liveStatus };
    },
    sendNowFn: async () => {
      events.push("sendNow");
    },
    pollFn: async () => {
      events.push("poll");
      return { status: opts.pollStatus };
    },
    writeFn: (_p: string, content: string) => {
      events.push("write");
      writes.push(JSON.parse(content));
    },
    logFn: () => {},
    nowFn: () => opts.now,
  };
  return { c, campaigns, deps, events, writes };
}

test("REGRESSÃO (#9638): sendNowAcceptedAt é gravado em disco ANTES do poll", async () => {
  const m = mockRun({ liveStatus: "draft", pollStatus: "draft", now: new Date(ACCEPTED) });
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake/group-campaigns.json", "k", m.deps);
  assert.equal(outcome, "unconfirmed");
  assert.deepEqual(m.events.slice(0, 4), ["get", "sendNow", "write", "poll"]);
  assert.equal(m.writes[0][0].sendNowAcceptedAt, ACCEPTED);
  assert.equal(m.writes[0][0].status, "draft");
});

test("#9638: re-execução dentro da janela após 'unconfirmed' NÃO faz 2º POST", async () => {
  const first = mockRun({ liveStatus: "draft", pollStatus: "draft", now: new Date(ACCEPTED) });
  await runSendNowLive(first.c, first.campaigns, "/fake", "k", first.deps);
  const second = mockRun({
    liveStatus: "draft",
    pollStatus: "draft",
    now: at(20),
    entry: { sendNowAcceptedAt: first.c.sendNowAcceptedAt },
  });
  const outcome = await runSendNowLive(second.c, second.campaigns, "/fake", "k", second.deps);
  assert.equal(outcome, "skipped");
  assert.ok(!second.events.includes("sendNow"));
});

test("#9638: poll confirma terminal -> 'sent' e registro local vira sent", async () => {
  const m = mockRun({ liveStatus: "draft", pollStatus: "sent", now: new Date(ACCEPTED) });
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(outcome, "sent");
  assert.equal(m.c.status, "sent");
  assert.equal(m.c.sendNowAcceptedAt, ACCEPTED);
});

test("#9638: followUp de 'draft' no verify cita a janela do guard", () => {
  const logs: string[] = [];
  const c = { key: "novos", campaignId: 1, listId: 1, subject: "s", status: "draft" } as CampaignEntry;
  applySendNowVerifyResults([{ status: "fulfilled", value: { status: "draft" } }], [c], [c], "/fake", () => {}, (m) => logs.push(m));
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`${SEND_NOW_GUARD_WINDOW_MS / 60_000} min`));
  assert.match(logs[0], /#9638/);
});
