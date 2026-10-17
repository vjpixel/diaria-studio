/**
 * test/clarice-schedule-group-send-now-guard-10366.test.ts (#10366)
 *
 * `checkSendNowGuard` só recusava terminal ("sent"/"inProcess"), "queued" e
 * "draft" dentro da janela; qualquer outro status ao vivo caía em
 * `send: true`. Cenário: `--send-now` aceito, GET-verify falha, a Brevo move
 * a campanha pra "in_review" (#4364); um 2º `--send-now` manual na mesma chave
 * repetia o POST sendNow numa campanha que já tinha saído pra revisão.
 *
 * Fix: fail-closed — só "draft" ao vivo (fora da janela) libera o POST.
 * `runSendNowLive` testado com Brevo mockada (nenhum envio real).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSendNowGuard, runSendNowLive, type CampaignEntry } from "../scripts/clarice-schedule-group.ts";

const NON_DRAFT = ["in_review", "suspended", "archive", "scheduled", "status_novo_desconhecido", ""];

for (const live of NON_DRAFT) {
  test(`REGRESSÃO (#10366): guard puro recusa status ao vivo "${live}" sem marca de sendNow`, () => {
    const r = checkSendNowGuard("draft", live);
    assert.equal(r.send, false);
    if (r.send) return;
    assert.equal(r.syncLocalAsSent, false, "status não-terminal nunca corrige o registro pra 'sent'");
    assert.match(r.reason, /não é "draft"/);
    assert.match(r.reason, /NÃO re-dispare/);
  });
}

test("REGRESSÃO (#10366): 'in_review' com sendNowAcceptedAt antigo (fora da janela) continua recusando", () => {
  const r = checkSendNowGuard("draft", "in_review", {
    sendNowAcceptedAt: "2026-10-01T12:00:00.000Z",
    now: new Date("2026-10-17T12:00:00.000Z"),
  });
  assert.equal(r.send, false);
  if (r.send) return;
  assert.match(r.reason, /in_review/);
  assert.match(r.reason, /revisão da própria Brevo/, "reusa a mensagem específica de describeUncertainSendStatus");
});

test("#10366: 'draft' ao vivo sem marca continua liberando (comportamento preservado)", () => {
  assert.deepEqual(checkSendNowGuard("draft", "draft"), { send: true });
});

for (const live of ["in_review", "suspended", "archive"]) {
  test(`REGRESSÃO (#10366): runSendNowLive com status ao vivo "${live}" NÃO faz POST sendNow nem grava registro`, async () => {
    const events: string[] = [];
    const c = {
      key: "c1-e1",
      campaignId: 121,
      listId: 7,
      subject: "s",
      status: "draft",
      // cenário da issue: 1º POST aceito há muito tempo, GET-verify não confirmou
      sendNowAcceptedAt: "2026-10-01T12:00:00.000Z",
    } as CampaignEntry;
    const result = await runSendNowLive(c, [c], "/nao/existe.json", "k", {
      getCampaignFn: async () => {
        events.push("get");
        return { status: live };
      },
      sendNowFn: async () => {
        events.push("sendNow");
      },
      pollFn: async () => {
        events.push("poll");
        return { status: "sent" };
      },
      writeFn: () => {
        events.push("write");
      },
      logFn: () => {},
      nowFn: () => new Date("2026-10-17T12:00:00.000Z"),
    });
    assert.equal(result, "skipped");
    assert.deepEqual(events, ["get"], "só o GET ao vivo — nenhum POST, poll ou escrita");
    assert.equal(c.status, "draft");
  });
}
