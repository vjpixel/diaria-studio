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
 * `SEND_NOW_PROCESSING_WINDOW_MS` como em processamento. Relógio injetado
 * (`now`) no lugar de tempo real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEND_NOW_PROCESSING_WINDOW_MS } from "../scripts/lib/brevo-client.ts";
import { checkSendNowGuard } from "../scripts/clarice-schedule-group.ts";

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

test("#9638: 'draft' ao vivo DEPOIS da janela -> libera POST (a Brevo não processou o 1º)", () => {
  const result = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: ACCEPTED, now: at(16) });
  assert.deepEqual(result, { send: true });
});

test("#9638: janela default é a mesma do pollTerminalSendStatus (15 min)", () => {
  assert.equal(SEND_NOW_PROCESSING_WINDOW_MS, 15 * 60_000);
  const justBefore = new Date(Date.parse(ACCEPTED) + SEND_NOW_PROCESSING_WINDOW_MS - 1);
  const atEdge = new Date(Date.parse(ACCEPTED) + SEND_NOW_PROCESSING_WINDOW_MS);
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
