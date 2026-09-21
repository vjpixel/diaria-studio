import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claimCompleteRegistrationSend } from "../scripts/lib/shared/meta-capi.ts";

function fakeKv() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
  };
}

describe("claimCompleteRegistrationSend (#8577)", () => {
  it("1º claim envia, reenvio do mesmo event_id não", async () => {
    const kv = fakeKv();
    assert.equal(await claimCompleteRegistrationSend(kv as never, "abc"), true);
    assert.equal(await claimCompleteRegistrationSend(kv as never, "abc"), false);
    assert.equal(await claimCompleteRegistrationSend(kv as never, "def"), true);
  });
  it("chave usa o event_id, nunca e-mail", async () => {
    const kv = fakeKv();
    await claimCompleteRegistrationSend(kv as never, "hash123");
    assert.deepEqual([...kv.m.keys()], ["capi:cr:hash123"]);
  });
  it("fail-open: sem KV, sem id ou KV com erro → envia", async () => {
    assert.equal(await claimCompleteRegistrationSend(undefined, "x"), true);
    assert.equal(await claimCompleteRegistrationSend(fakeKv() as never, undefined), true);
    const broken = { get: async () => { throw new Error("kv"); }, put: async () => {} };
    assert.equal(await claimCompleteRegistrationSend(broken as never, "x"), true);
  });
});

import { releaseClaimOnSendFailure } from "../scripts/lib/shared/meta-capi.ts";
describe("releaseClaimOnSendFailure (#8577)", () => {
  it("falha libera o claim; sucesso mantém", async () => {
    const kv = { m: new Map([["capi:cr:a", "1"], ["capi:cr:b", "1"]]),
      get: async () => null, put: async () => {},
      delete: async function (k: string) { (this as any).m.delete(k); } };
    await releaseClaimOnSendFailure(Promise.resolve({ ok: false, status: 500, reason: "meta_error" }), kv as never, "a");
    await releaseClaimOnSendFailure(Promise.resolve({ ok: true, status: 200 }), kv as never, "b");
    assert.deepEqual([...kv.m.keys()], ["capi:cr:b"]);
  });
});
