/**
 * lint-test-email.test.ts (#603)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runLints } from "../scripts/lint-test-email.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";

const NO_INTENTIONAL: IntentionalError[] = [];

describe("runLints (#603) — version_inconsistency", () => {
  it("blocker quando email tem V4 e V5 no mesmo destaque", () => {
    const email = `DESTAQUE 2 | TENDÊNCIA

V4 da DeepSeek lança hoje.

A versão V5 superou benchmarks anteriores.`;
    const source = `DESTAQUE 2 | TENDÊNCIA

V4 da DeepSeek lança hoje.

A versão V4 superou benchmarks anteriores.`;
    const result = runLints(email, source, "260506", NO_INTENTIONAL);
    const blockers = result.issues.filter((i) => i.type === "blocker" && i.category === "version_inconsistency");
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].destaque, "DESTAQUE 2");
    assert.ok(blockers[0].detail.includes("V4"));
    assert.ok(blockers[0].detail.includes("V5"));
    assert.equal(blockers[0].source_md_value, "V4");
  });

  it("info quando version_inconsistency é intencional", () => {
    const email = `DESTAQUE 2 | TENDÊNCIA

V4 título.

V5 corpo.`;
    const source = `DESTAQUE 2 | TENDÊNCIA

V4 título.

V4 corpo.`;
    const intentional: IntentionalError[] = [
      {
        edition: "260505",
        error_type: "version_inconsistency",
        destaque: 2,
        is_feature: true,
      },
    ];
    const result = runLints(email, source, "260505", intentional);
    const blockers = result.issues.filter((i) => i.type === "blocker" && i.category === "version_inconsistency");
    const infos = result.issues.filter((i) => i.type === "info" && i.category === "intentional_error_confirmed");
    assert.equal(blockers.length, 0, "não deve ser blocker — intencional");
    assert.equal(infos.length, 1);
    assert.equal(infos[0].destaque, "DESTAQUE 2");
  });

  it("sem inconsistência quando todas as versões são iguais", () => {
    const email = `DESTAQUE 1 | X

V4 lança.

V4 superou.`;
    const source = email;
    const result = runLints(email, source, "260506", NO_INTENTIONAL);
    const blockers = result.issues.filter((i) => i.type === "blocker");
    assert.equal(blockers.length, 0);
  });

  it("regression: cenário 260505 (V4 vs V5/V6/V7) é detectado", () => {
    const email = `DESTAQUE 2 | TENDÊNCIA

V4 da DeepSeek muda chips.

V5 superou benchmarks.

V6 lançou hoje.

V7 está em rumores.`;
    const source = `DESTAQUE 2 | TENDÊNCIA

V4 da DeepSeek muda chips.

V4 superou benchmarks.

V4 lançou hoje.

V4 está em rumores.`;
    const result = runLints(email, source, "260506", NO_INTENTIONAL);
    const blockers = result.issues.filter((i) => i.type === "blocker" && i.category === "version_inconsistency");
    assert.equal(blockers.length, 1);
    assert.ok(blockers[0].detail.includes("V4"));
    assert.ok(blockers[0].detail.includes("V5"));
    assert.ok(blockers[0].detail.includes("V6"));
    assert.ok(blockers[0].detail.includes("V7"));
  });
});

describe("runLints (#603) — semantic_drift", () => {
  it("warning quando número diverge entre email e source", () => {
    const email = `DESTAQUE 1 | X

empresa cresceu 12% em 2 anos.`;
    const source = `DESTAQUE 1 | X

empresa cresceu 10% em 2 anos.`;
    const result = runLints(email, source, "260506", NO_INTENTIONAL);
    const warnings = result.issues.filter((i) => i.type === "warning" && i.category === "semantic_drift");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].detail.includes("12%") || warnings[0].detail.includes("10%"));
  });

  it("info quando drift é numeric intencional", () => {
    const email = `DESTAQUE 1 | OUTRAS

220 anos da empresa.`;
    const source = `DESTAQUE 1 | OUTRAS

22 anos da empresa.`;
    const intentional: IntentionalError[] = [
      {
        edition: "260506",
        error_type: "numeric",
        destaque: 1,
        is_feature: true,
      },
    ];
    const result = runLints(email, source, "260506", intentional);
    const warnings = result.issues.filter((i) => i.type === "warning");
    const infos = result.issues.filter((i) => i.type === "info");
    assert.equal(warnings.length, 0);
    assert.equal(infos.length, 1);
  });

  it("sem drift quando números batem", () => {
    const email = `DESTAQUE 1 | X

10% em 2 anos.`;
    const source = email;
    const result = runLints(email, source, "260506", NO_INTENTIONAL);
    assert.equal(result.issues.length, 0);
  });
});

describe("runLints (#603) — summary counts", () => {
  it("conta blockers + warnings + infos", () => {
    const email = `DESTAQUE 1 | X

V4 lança.

V5 corpo.

DESTAQUE 2 | Y

cresceu 12%.`;
    const source = `DESTAQUE 1 | X

V4 lança.

V4 corpo.

DESTAQUE 2 | Y

cresceu 10%.`;
    const result = runLints(email, source, "260506", NO_INTENTIONAL);
    assert.equal(result.summary.blockers, 1, "1 blocker (version inconsistency)");
    assert.ok(result.summary.warnings >= 1, "pelo menos 1 warning (semantic drift)");
    assert.equal(result.summary.infos, 0);
  });
});
