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
