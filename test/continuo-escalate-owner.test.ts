import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAlreadyEscalated,
  CONTINUO_ESCALATED_LABEL,
  formatEscalateHeadMarker,
  lastEscalatedHead,
  needsEscalateHeadMarker,
} from "../scripts/lib/continuo-escalate-owner.ts";

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

describe("marcador de head escalado (#9184)", () => {
  it("sem marcador → null e precisa marcar", () => {
    assert.equal(lastEscalatedHead(["oi", "review ok"]), null);
    assert.equal(needsEscalateHeadMarker([], "abc1234"), true);
  });

  it("re-escalada de head novo (label já presente) precisa de marcador novo", () => {
    assert.equal(needsEscalateHeadMarker([formatEscalateHeadMarker("aaaaaaa1")], "bbbbbbb2"), true);
  });

  it("mesmo head já marcado → não duplica; último marcador vence", () => {
    const bodies = [formatEscalateHeadMarker("aaaaaaa1"), "x", formatEscalateHeadMarker("bbbbbbb2")];
    assert.equal(lastEscalatedHead(bodies), "bbbbbbb2");
    assert.equal(needsEscalateHeadMarker(bodies, "bbbbbbb2"), false);
    assert.equal(needsEscalateHeadMarker(bodies, "aaaaaaa1"), true);
  });
});
