/**
 * test/clarice-schedule-group-9714.test.ts (#9714)
 *
 * Ramo 4xx de `runSendNowLive`: (1) relê o disco e só restaura/remove a marca
 * de tentativa se ainda for a deste processo (um --send-now concorrente pode
 * ter gravado marca/aceite); (2) a mensagem não afirma "nada foi enviado".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSendNowLive, type CampaignEntry } from "../scripts/clarice-schedule-group.ts";
import { BrevoHttpError } from "../scripts/lib/brevo-client.ts";

const T0 = "2026-10-06T12:00:00.000Z";

function setup(diskAfterPost: (own: CampaignEntry) => CampaignEntry[] | "unreadable") {
  const c = { key: "novos", campaignId: 121, listId: 7, subject: "s", status: "draft" } as CampaignEntry;
  const campaigns = [c];
  let disk = JSON.stringify(campaigns);
  const writes: CampaignEntry[][] = [];
  const logs: string[] = [];
  let unreadable = false;
  const deps = {
    getCampaignFn: async () => ({ status: "draft" }),
    sendNowFn: async (): Promise<void> => {
      // Simula o processo concorrente gravando no disco durante o POST.
      const next = diskAfterPost(JSON.parse(disk)[0]);
      if (next === "unreadable") unreadable = true;
      else disk = JSON.stringify(next);
      throw new BrevoHttpError("Brevo API 400 campanha ja em envio", 400);
    },
    pollFn: async () => ({ status: "sent" }),
    writeFn: (_p: string, content: string) => {
      writes.push(JSON.parse(content));
      disk = content;
    },
    readFn: () => {
      if (unreadable) throw new Error("EIO");
      return disk;
    },
    logFn: (m: string) => logs.push(m),
    nowFn: () => new Date(T0),
  };
  return { c, campaigns, deps, logs, writes, getDisk: () => JSON.parse(disk) as CampaignEntry[] };
}

test("REGRESSÃO (#9714): 4xx NÃO apaga marca/aceite gravados por execução concorrente", async () => {
  const other = { sendNowAttemptedAt: "2026-10-06T12:00:01.000Z", sendNowAcceptedAt: "2026-10-06T12:00:02.000Z" };
  const m = setup((own) => [{ ...own, ...other }]);
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(outcome, "failed");
  const d = m.getDisk()[0];
  assert.equal(d.sendNowAttemptedAt, other.sendNowAttemptedAt);
  assert.equal(d.sendNowAcceptedAt, other.sendNowAcceptedAt);
  assert.ok(m.logs.some((l) => /concorrente/.test(l)));
});

test("REGRESSÃO (#9714): marca de OUTRO processo (sem aceite) também é preservada", async () => {
  const m = setup((own) => [{ ...own, sendNowAttemptedAt: "2026-10-06T12:00:05.000Z" }]);
  await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(m.getDisk()[0].sendNowAttemptedAt, "2026-10-06T12:00:05.000Z");
});

test("#9714: marca ainda é a deste processo -> removida do disco (comportamento #9706 mantido)", async () => {
  const m = setup((own) => [own]);
  await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(m.getDisk()[0].sendNowAttemptedAt, undefined);
});

test("#9714: disco ilegível -> marca mantida (lado seguro), segue 'failed'", async () => {
  const m = setup(() => "unreadable");
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(outcome, "failed");
  assert.equal(m.getDisk()[0].sendNowAttemptedAt, T0);
  assert.ok(m.logs.some((l) => /não foi possível reler/.test(l)));
});

test("REGRESSÃO (#9714): mensagem do 4xx não afirma 'nada foi enviado' e manda conferir a Brevo", async () => {
  const m = setup((own) => [own]);
  await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  const msg = m.logs.find((l) => /RECUSOU/.test(l)) ?? "";
  assert.doesNotMatch(msg, /nada foi enviado/i);
  assert.match(msg, /confira o status na Brevo/);
});
