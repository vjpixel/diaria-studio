import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAlreadyEscalated, CONTINUO_ESCALATED_LABEL } from "../scripts/lib/continuo-escalate-owner.ts";

describe("isAlreadyEscalated (#7446 item 2)", () => {
  it("label ausente → false (primeira vez, deve notificar)", () => {
    assert.equal(isAlreadyEscalated(["bug", "P1"]), false);
  });

  it("lista de labels vazia → false", () => {
    assert.equal(isAlreadyEscalated([]), false);
  });

  it("label presente → true (já sinalizada, não repetir)", () => {
    assert.equal(isAlreadyEscalated(["bug", CONTINUO_ESCALATED_LABEL]), true);
  });

  it("label presente entre outros → true, independente da posição", () => {
    assert.equal(isAlreadyEscalated([CONTINUO_ESCALATED_LABEL, "P1", "bug"]), true);
  });
});
