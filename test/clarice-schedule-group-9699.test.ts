/**
 * test/clarice-schedule-group-9699.test.ts (#9699)
 *
 * `sendNowAcceptedAt` (#9638) só era gravado DEPOIS do POST sendNow voltar
 * 2xx. Se a Brevo aceitasse e a resposta se perdesse (reset/timeout), nada
 * ficava registrado, o erro virava "falhou" e uma re-execução de --send-now
 * lia "draft" ao vivo sem registro → 2º POST (envio duplicado). Mesma classe
 * se o writeFn logo após o POST lançasse.
 *
 * Fix: `sendNowAttemptedAt` gravado ANTES do POST e honrado pelo guard como o
 * `sendNowAcceptedAt`; erro no POST/poll vira "unconfirmed" (exit 2); falha
 * de escrita pós-POST só loga. Brevo mockada — nenhum envio real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSendNowGuard, runSendNowLive, type CampaignEntry } from "../scripts/clarice-schedule-group.ts";

const T0 = "2026-10-06T12:00:00.000Z";
const at = (minutesAfter: number) => new Date(Date.parse(T0) + minutesAfter * 60_000);

function mockRun(opts: {
  liveStatus: string;
  now: Date;
  entry?: Partial<CampaignEntry>;
  sendNowThrows?: boolean;
  pollStatus?: string;
  pollThrows?: boolean;
  writeThrowsOn?: (writeIndex: number) => boolean;
}) {
  const events: string[] = [];
  const writes: CampaignEntry[][] = [];
  const logs: string[] = [];
  let writeCount = 0;
  const c = { key: "novos", campaignId: 121, listId: 7, subject: "s", status: "draft", ...opts.entry } as CampaignEntry;
  const campaigns = [c];
  const deps = {
    getCampaignFn: async () => {
      events.push("get");
      return { status: opts.liveStatus };
    },
    sendNowFn: async () => {
      events.push("sendNow");
      if (opts.sendNowThrows) throw new TypeError("fetch failed: ECONNRESET");
    },
    pollFn: async () => {
      events.push("poll");
      if (opts.pollThrows) throw new Error("fetch failed: ETIMEDOUT");
      return { status: opts.pollStatus ?? "draft" };
    },
    writeFn: (_p: string, content: string) => {
      const idx = writeCount++;
      events.push("write");
      if (opts.writeThrowsOn?.(idx)) throw new Error("EIO: disco");
      writes.push(JSON.parse(content));
    },
    logFn: (m: string) => logs.push(m),
    nowFn: () => opts.now,
  };
  return { c, campaigns, deps, events, writes, logs };
}

// --- guard puro ---

test("REGRESSÃO (#9699): só sendNowAttemptedAt + 'draft' ao vivo dentro da janela -> recusa", () => {
  const r = checkSendNowGuard("draft", "draft", { sendNowAttemptedAt: T0, now: at(5) });
  assert.equal(r.send, false);
  if (r.send) return;
  assert.match(r.reason, /TENTADO/);
  assert.match(r.reason, /NÃO re-dispare/);
});

test("#9699: sendNowAttemptedAt depois da janela -> libera", () => {
  assert.deepEqual(checkSendNowGuard("draft", "draft", { sendNowAttemptedAt: T0, now: at(31) }), { send: true });
});

test("#9699: com os dois, a janela conta do MAIS RECENTE (tentativa nova após aceite antigo)", () => {
  const oldAccepted = at(-60).toISOString();
  const r = checkSendNowGuard("draft", "draft", { sendNowAcceptedAt: oldAccepted, sendNowAttemptedAt: T0, now: at(5) });
  assert.equal(r.send, false);
});

test("#9699: sendNowAttemptedAt ilegível -> recusa, nomeando o campo", () => {
  const r = checkSendNowGuard("draft", "draft", { sendNowAttemptedAt: "lixo", now: at(1) });
  assert.equal(r.send, false);
  if (r.send) return;
  assert.match(r.reason, /sendNowAttemptedAt/);
});

// --- runSendNowLive ---

test("REGRESSÃO (#9699): sendNowAttemptedAt vai pro disco ANTES do POST", async () => {
  const m = mockRun({ liveStatus: "draft", now: at(0), pollStatus: "sent" });
  await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.deepEqual(m.events.slice(0, 3), ["get", "write", "sendNow"]);
  assert.equal(m.writes[0][0].sendNowAttemptedAt, T0);
  assert.equal(m.writes[0][0].sendNowAcceptedAt, undefined);
});

test("REGRESSÃO (#9699): sendNowFn lança -> 'unconfirmed' (não exceção) e re-execução na janela NÃO faz 2º POST", async () => {
  const first = mockRun({ liveStatus: "draft", now: at(0), sendNowThrows: true });
  const outcome = await runSendNowLive(first.c, first.campaigns, "/fake", "k", first.deps);
  assert.equal(outcome, "unconfirmed");
  assert.ok(!first.events.includes("poll"));
  assert.ok(first.logs.some((l) => /INCERTO/.test(l)));
  // o registro que ficou em disco é o que a próxima invocação lê
  const onDisk = first.writes[first.writes.length - 1][0];
  assert.equal(onDisk.sendNowAttemptedAt, T0);

  const second = mockRun({ liveStatus: "draft", now: at(10), entry: onDisk });
  const outcome2 = await runSendNowLive(second.c, second.campaigns, "/fake", "k", second.deps);
  assert.equal(outcome2, "skipped");
  assert.ok(!second.events.includes("sendNow"));
});

test("#9699: writeFn falha ANTES do POST -> lança e o POST não sai", async () => {
  const m = mockRun({ liveStatus: "draft", now: at(0), writeThrowsOn: (i) => i === 0 });
  await assert.rejects(runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps), /EIO/);
  assert.ok(!m.events.includes("sendNow"));
});

test("REGRESSÃO (#9699): writeFn falha DEPOIS do POST -> não lança, segue pro poll e confirma 'sent'", async () => {
  const m = mockRun({ liveStatus: "draft", now: at(0), pollStatus: "sent", writeThrowsOn: (i) => i >= 1 });
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(outcome, "sent");
  assert.ok(m.events.includes("poll"));
  assert.ok(m.logs.some((l) => /falha ao gravar o registro local pós-POST/.test(l)));
  // o que chegou ao disco é a tentativa, que mantém o guard fechado
  assert.equal(m.writes.length, 1);
  assert.equal(m.writes[0][0].sendNowAttemptedAt, T0);
});

test("#9699: pollFn lança -> 'unconfirmed', não exceção", async () => {
  const m = mockRun({ liveStatus: "draft", now: at(0), pollThrows: true });
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(outcome, "unconfirmed");
  assert.equal(m.c.status, "draft");
  assert.equal(m.c.sendNowAcceptedAt, T0);
});
