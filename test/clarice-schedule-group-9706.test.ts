/**
 * test/clarice-schedule-group-9706.test.ts (#9706)
 *
 * O `catch` de `sendNowFn` em `runSendNowLive` tratava QUALQUER erro como
 * incerto (exit 2), inclusive a recusa 4xx da Brevo (remetente inválido,
 * lista vazia, IP fora da allowlist) — falha determinística mascarada, e o
 * guard bloqueava o reenvio legítimo por 30 min.
 *
 * Fix: `brevoSendNow` lança `BrevoHttpError` com `status`; 4xx definitivo →
 * "failed" (exit 1) com a marca de tentativa restaurada; rede/timeout/5xx/429
 * e os 4xx ambíguos (408/409/425) seguem "unconfirmed". Brevo mockada —
 * nenhum envio real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySendNowVerifyResults,
  isDefinitiveSendNowRejection,
  runSendNowLive,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";
import { BrevoHttpError, BrevoRateLimitError, brevoSendNow } from "../scripts/lib/brevo-client.ts";

const T0 = "2026-10-06T12:00:00.000Z";
const at = (minutesAfter: number) => new Date(Date.parse(T0) + minutesAfter * 60_000);

function mockRun(opts: { now: Date; sendNowError: unknown; entry?: Partial<CampaignEntry> }) {
  const events: string[] = [];
  const writes: CampaignEntry[][] = [];
  const logs: string[] = [];
  const c = { key: "novos", campaignId: 121, listId: 7, subject: "s", status: "draft", ...opts.entry } as CampaignEntry;
  const campaigns = [c];
  const deps = {
    getCampaignFn: async () => {
      events.push("get");
      return { status: "draft" };
    },
    sendNowFn: async (): Promise<void> => {
      events.push("sendNow");
      throw opts.sendNowError;
    },
    pollFn: async () => {
      events.push("poll");
      return { status: "sent" };
    },
    writeFn: (_p: string, content: string) => {
      events.push("write");
      writes.push(JSON.parse(content));
    },
    logFn: (m: string) => logs.push(m),
    nowFn: () => opts.now,
  };
  return { c, campaigns, deps, events, writes, logs };
}

// --- classificação pura ---

test("#9706: 4xx tipado é recusa definitiva; 408/409/425/429/5xx/rede não", () => {
  for (const s of [400, 401, 402, 403, 404, 422]) {
    assert.equal(isDefinitiveSendNowRejection(new BrevoHttpError("x", s)), true, `status ${s}`);
  }
  for (const s of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isDefinitiveSendNowRejection(new BrevoHttpError("x", s)), false, `status ${s}`);
  }
  assert.equal(isDefinitiveSendNowRejection(new TypeError("fetch failed: ECONNRESET")), false);
  assert.equal(isDefinitiveSendNowRejection(new BrevoRateLimitError("429", 60)), false);
  // Error genérico com "400" na mensagem NÃO conta — só o tipo decide.
  assert.equal(isDefinitiveSendNowRejection(new Error("Brevo API 400")), false);
});

test("#9706: brevoSendNow lança BrevoHttpError com status na resposta !ok", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"code":"invalid_parameter","message":"sender invalid"}', { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(brevoSendNow("k", 121, async () => {}), (err: unknown) => {
      assert.ok(err instanceof BrevoHttpError);
      assert.equal(err.status, 400);
      assert.match(err.message, /sendNow/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- runSendNowLive ---

test("REGRESSÃO (#9706): POST recusado com 4xx -> 'failed' (não 'unconfirmed'), sem poll", async () => {
  const m = mockRun({ now: at(0), sendNowError: new BrevoHttpError("Brevo API 400 sender invalid", 400) });
  const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(outcome, "failed");
  assert.ok(!m.events.includes("poll"));
  assert.ok(m.logs.some((l) => /FALHOU/.test(l) && /HTTP 400/.test(l)));
  assert.ok(!m.logs.some((l) => /INCERTO/.test(l)));
});

test("REGRESSÃO (#9706): 4xx restaura a marca de tentativa -> reenvio após o conserto NÃO é barrado", async () => {
  const first = mockRun({ now: at(0), sendNowError: new BrevoHttpError("Brevo API 403 IP", 403) });
  await runSendNowLive(first.c, first.campaigns, "/fake", "k", first.deps);
  const onDisk = first.writes[first.writes.length - 1][0];
  assert.equal(onDisk.sendNowAttemptedAt, undefined);
  assert.equal(onDisk.sendNowAcceptedAt, undefined);

  // 5 min depois (dentro da janela), conserto feito: o POST sai.
  const second = mockRun({ now: at(5), sendNowError: undefined, entry: onDisk });
  second.deps.sendNowFn = async () => {
    second.events.push("sendNow");
  };
  const outcome2 = await runSendNowLive(second.c, second.campaigns, "/fake", "k", second.deps);
  assert.equal(outcome2, "sent");
  assert.ok(second.events.includes("sendNow"));
});

test("#9706: 4xx preserva marca de tentativa ANTERIOR (incerta) em vez de apagá-la", async () => {
  const prior = at(-40).toISOString(); // fora da janela, por isso o guard liberou
  const m = mockRun({ now: at(0), sendNowError: new BrevoHttpError("Brevo API 400", 400), entry: { sendNowAttemptedAt: prior } });
  await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
  assert.equal(m.writes[m.writes.length - 1][0].sendNowAttemptedAt, prior);
});

for (const [label, err] of [
  ["5xx", new BrevoHttpError("Brevo API 502", 502)],
  ["409", new BrevoHttpError("Brevo API 409", 409)],
  ["rede", new TypeError("fetch failed: ECONNRESET")],
  ["429 esgotado", new BrevoRateLimitError("Brevo API 429 após 3 tentativas", null)],
] as const) {
  test(`#9706: POST com erro ${label} continua 'unconfirmed' e mantém a marca de tentativa`, async () => {
    const m = mockRun({ now: at(0), sendNowError: err });
    const outcome = await runSendNowLive(m.c, m.campaigns, "/fake", "k", m.deps);
    assert.equal(outcome, "unconfirmed");
    assert.equal(m.writes[m.writes.length - 1][0].sendNowAttemptedAt, T0);
    assert.ok(m.logs.some((l) => /INCERTO/.test(l)));
  });
}

// --- mensagem do ramo rejected (P3) ---

test("#9706: poll rejeitado após POST aceito avisa da janela e manda conferir a Brevo", () => {
  const c = { key: "novos", campaignId: 121, listId: 7, subject: "s", status: "draft" } as CampaignEntry;
  const logs: string[] = [];
  applySendNowVerifyResults(
    [{ status: "rejected", reason: new Error("ETIMEDOUT") }],
    [c],
    [c],
    "/fake",
    () => {},
    (m) => logs.push(m),
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /recusado pelo guard/);
  assert.match(logs[0], /confira na Brevo/);
  assert.doesNotMatch(logs[0], /re-tente --send-now\.$/);
});
