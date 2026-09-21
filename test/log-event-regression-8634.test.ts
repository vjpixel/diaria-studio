/**
 * Regressão #8634 — log-event não deve lançar quando append falha persistente
 * (OneDrive lock / EBUSY / UNKNOWN errno=-4094). Must not throw; must degrade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logEvent } from "../scripts/lib/run-log.ts";

describe("#8634 log-event retry + degradacao", () => {
  it("degradar a false (não lança) quando append persistente falha", () => {
    const failAlways = () => {
      throw new Error("UNKNOWN: unknown error, write (errno -4094)");
    };
    const result = logEvent(
      { edition: "260921", stage: 5, agent: "log-event", level: "info", message: "teste" },
      process.cwd(),
      failAlways,
    );
    assert.equal(result, false, "logEvent deve devolver false, não lançar");
  });

  it("não lança mesmo com erro genérico de I/O", () => {
    const failGeneric = () => {
      throw new Error("EPERM: operation not permitted");
    };
    assert.doesNotThrow(() =>
      logEvent(
        { edition: "260921", stage: 5, agent: "log-event", level: "warn", message: "x" },
        process.cwd(),
        failGeneric,
      ),
    );
  });
});
