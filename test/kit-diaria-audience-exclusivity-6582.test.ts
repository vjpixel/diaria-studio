/**
 * test/kit-diaria-audience-exclusivity-6582.test.ts (#6582 item 5)
 *
 * Cobre o miolo puro da auditoria bidirecional: "existe alguém na tag do
 * Kit que não está ativo na Beehiiv (esperado), e alguém ativo na Beehiiv
 * que está na tag (perigoso — edição em dobro)?"
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  auditKitTagAgainstBeehiivActive,
  decideAuditExitCode,
  maskAuditResult,
  formatAuditReport,
} from "../scripts/lib/kit-diaria-audience-exclusivity.ts";

describe("#6582 auditKitTagAgainstBeehiivActive", () => {
  it("partição íntegra (o caso da onda 0/1): tag e Beehiiv disjuntas ⇒ overlapping vazio", () => {
    const r = auditKitTagAgainstBeehiivActive(
      ["a@x.com", "b@x.com"],
      ["c@x.com", "d@x.com"],
    );
    assert.deepEqual(r.onlyInKitTag, ["a@x.com", "b@x.com"]);
    assert.deepEqual(r.overlapping, []);
    assert.equal(r.kitTagTotal, 2);
    assert.equal(r.beehiivActiveTotal, 2);
  });

  it("REGRESSÃO do cenário perigoso: alguém na tag do Kit E ativo na Beehiiv ⇒ overlapping não-vazio", () => {
    const r = auditKitTagAgainstBeehiivActive(
      ["a@x.com", "b@x.com"],
      ["b@x.com", "c@x.com"],
    );
    assert.deepEqual(r.onlyInKitTag, ["a@x.com"]);
    assert.deepEqual(r.overlapping, ["b@x.com"]);
  });

  it("normaliza (trim + lowercase) antes de comparar — mesmo e-mail em capitalização diferente não escapa a detecção", () => {
    const r = auditKitTagAgainstBeehiivActive(["  A@X.com "], ["a@x.com"]);
    assert.deepEqual(r.overlapping, ["a@x.com"]);
    assert.deepEqual(r.onlyInKitTag, []);
  });

  it("tag do Kit vazia ⇒ nada a auditar, sem lançar", () => {
    const r = auditKitTagAgainstBeehiivActive([], ["a@x.com", "b@x.com"]);
    assert.equal(r.kitTagTotal, 0);
    assert.deepEqual(r.onlyInKitTag, []);
    assert.deepEqual(r.overlapping, []);
  });
});

describe("#6582 decideAuditExitCode — só overlapping bloqueia", () => {
  it("overlapping vazio ⇒ exit 0", () => {
    const r = auditKitTagAgainstBeehiivActive(["a@x.com"], ["b@x.com"]);
    assert.deepEqual(decideAuditExitCode(r), { exitCode: 0, blocking: false });
  });

  it("overlapping não-vazio ⇒ exit 1 (BLOQUEANTE)", () => {
    const r = auditKitTagAgainstBeehiivActive(["a@x.com"], ["a@x.com"]);
    assert.deepEqual(decideAuditExitCode(r), { exitCode: 1, blocking: true });
  });
});

describe("#6582 maskAuditResult / formatAuditReport", () => {
  it("maskAuditResult mascara os e-mails, preserva as contagens", () => {
    const r = auditKitTagAgainstBeehiivActive(["ana@x.com"], ["ana@x.com"]);
    const masked = maskAuditResult(r);
    assert.equal(masked.kitTagTotal, 1);
    assert.notDeepEqual(masked.overlapping, r.overlapping, "não pode vazar o e-mail cru");
    assert.notEqual(masked.overlapping[0], "ana@x.com");
  });

  it("formatAuditReport nomeia o resultado bloqueante quando há overlap", () => {
    const r = auditKitTagAgainstBeehiivActive(["ana@x.com"], ["ana@x.com"]);
    const report = formatAuditReport(r, decideAuditExitCode(r));
    assert.match(report, /BLOQUEANTE/);
    assert.match(report, /DOBRO/);
  });

  it("formatAuditReport nomeia o resultado íntegro quando não há overlap", () => {
    const r = auditKitTagAgainstBeehiivActive(["ana@x.com"], ["outra@x.com"]);
    const report = formatAuditReport(r, decideAuditExitCode(r));
    assert.match(report, /íntegra/);
    assert.doesNotMatch(report, /BLOQUEANTE/);
  });
});
