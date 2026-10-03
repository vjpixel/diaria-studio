import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { memoizeAccountId } from "../scripts/onboarding-kit-transport-run.ts";

describe("memoizeAccountId (#9489)", () => {
  it("rejeição transitória não fica memoizada: 2ª chamada refaz e tem id", async () => {
    let calls = 0;
    const get = memoizeAccountId(async () => {
      calls++;
      if (calls === 1) throw new Error("503");
      return "acc-1";
    });
    await assert.rejects(get(), /503/);
    assert.equal(await get(), "acc-1");
    assert.equal(await get(), "acc-1");
    assert.equal(calls, 2);
  });

  it("sucesso é memoizado (1 fetch só)", async () => {
    let calls = 0;
    const get = memoizeAccountId(async () => {
      calls++;
      return "acc-2";
    });
    await Promise.all([get(), get()]);
    await get();
    assert.equal(calls, 1);
  });
});
