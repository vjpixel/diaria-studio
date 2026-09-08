import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAlreadyRejectLabeled, CONTINUO_REJECTED_LABEL } from "../scripts/lib/continuo-reject-owner.ts";

describe("isAlreadyRejectLabeled (#7567)", () => {
  it("label ausente → false (primeira vez, deve notificar)", () => {
    assert.equal(isAlreadyRejectLabeled(["bug", "P1"]), false);
  });

  it("lista de labels vazia → false", () => {
    assert.equal(isAlreadyRejectLabeled([]), false);
  });

  it("label presente → true (já sinalizada, não repetir)", () => {
    assert.equal(isAlreadyRejectLabeled(["bug", CONTINUO_REJECTED_LABEL]), true);
  });

  it("label presente entre outros → true, independente da posição", () => {
    assert.equal(isAlreadyRejectLabeled([CONTINUO_REJECTED_LABEL, "P1", "bug"]), true);
  });
});
