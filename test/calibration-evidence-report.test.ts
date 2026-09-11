/**
 * test/calibration-evidence-report.test.ts (#7978)
 *
 * Cobre scripts/lib/calibration-evidence-report.ts — template determinístico
 * de 3 partes (o que muda / evidência / revert) e o limite de 5 casos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderCalibrationEvidenceReport, type CalibrationEvidenceInput } from "../scripts/lib/calibration-evidence-report.ts";

function baseInput(overrides: Partial<CalibrationEvidenceInput> = {}): CalibrationEvidenceInput {
  return {
    feature: "hands_on",
    whatChanges: "peso do bônus hands_on: +8 → +10 pontos",
    cases: [{ edition: "260901", url: "https://x.com/a", action: "editor promoveu a destaque" }],
    revertCommand: "git revert abc1234",
    ...overrides,
  };
}

describe("renderCalibrationEvidenceReport (#7978)", () => {
  it("gera as 3 seções na ordem: o que muda, evidência, como reverter", () => {
    const md = renderCalibrationEvidenceReport(baseInput());
    const iWhat = md.indexOf("## O que muda");
    const iEvidence = md.indexOf("## Evidência concreta");
    const iRevert = md.indexOf("## Como reverter");
    assert.ok(iWhat >= 0 && iEvidence > iWhat && iRevert > iEvidence);
  });

  it("inclui a REGRA DE OURO no rodapé", () => {
    const md = renderCalibrationEvidenceReport(baseInput());
    assert.match(md, /REGRA DE OURO/);
    assert.match(md, /editorial-signoff:approved/);
  });

  it("lista cada caso com edição+URL+ação", () => {
    const md = renderCalibrationEvidenceReport(baseInput());
    assert.match(md, /260901/);
    assert.match(md, /https:\/\/x\.com\/a/);
    assert.match(md, /editor promoveu a destaque/);
  });

  it("comando de revert aparece em bloco de código", () => {
    const md = renderCalibrationEvidenceReport(baseInput());
    assert.match(md, /```bash\ngit revert abc1234\n```/);
  });

  it("cases vazio: lança (evidência vazia não é aceitável)", () => {
    assert.throws(() => renderCalibrationEvidenceReport(baseInput({ cases: [] })), /não pode ser vazio/);
  });

  it("mais de 5 casos: lança, nunca trunca silenciosamente", () => {
    const cases = Array.from({ length: 6 }, (_, i) => ({ edition: `26090${i}`, url: `https://x.com/${i}`, action: "ação" }));
    assert.throws(() => renderCalibrationEvidenceReport(baseInput({ cases })), /máximo permitido é 5/);
  });

  it("exatamente 5 casos: aceito (limite inclusivo)", () => {
    const cases = Array.from({ length: 5 }, (_, i) => ({ edition: `26090${i}`, url: `https://x.com/${i}`, action: "ação" }));
    assert.doesNotThrow(() => renderCalibrationEvidenceReport(baseInput({ cases })));
  });

  it("evidenceSummary e sourceIssue opcionais aparecem quando presentes", () => {
    const md = renderCalibrationEvidenceReport(baseInput({ evidenceSummary: "n=966, p=0.02", sourceIssue: "#7990" }));
    assert.match(md, /n=966, p=0\.02/);
    assert.match(md, /#7990/);
  });

  it("sem evidenceSummary/sourceIssue: não aparecem linhas vazias/quebradas", () => {
    const md = renderCalibrationEvidenceReport(baseInput());
    assert.doesNotMatch(md, /Resumo da evidência/);
    assert.doesNotMatch(md, /Origem:/);
  });
});
