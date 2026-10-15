/**
 * #10278 — sinal mecânico de "PR retida para o editor".
 *
 * Regressão do incidente: a PR #10221 foi retida pelo overnight 261014b só em
 * prosa de comentário ("NÃO mergeado pela rodada") e mergeada pelo continuo
 * horas depois — nenhum gate lia o "retido". Estes testes travam (a) a lógica
 * pura do sinal, (b) que os dois pontos de merge (portão do continuo e CLI do
 * overnight) de fato consultam esse sinal, e (c) que a SKILL do overnight
 * manda aplicar a label e checar o gate antes do merge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  evaluatePrRetido,
  RETIDO_PARA_EDITOR_LABEL,
  RETIDO_PARA_EDITOR_MARKER,
} from "../scripts/lib/pr-retido-para-editor.ts";

const ROOT = join(import.meta.dirname, "..");

describe("evaluatePrRetido (#10278)", () => {
  it("label retido-para-editor (formato gh pr view: [{name}]) → retido", () => {
    const r = evaluatePrRetido({ labels: [{ name: "bug" }, { name: RETIDO_PARA_EDITOR_LABEL }], body: "" });
    assert.equal(r.retido, true);
  });

  it("label com caixa/espaço diferentes ainda casa", () => {
    const r = evaluatePrRetido({ labels: [{ name: " Retido-Para-Editor " }], body: null });
    assert.equal(r.retido, true);
  });

  it("marcador no corpo, sem label → retido", () => {
    const r = evaluatePrRetido({ labels: [], body: `Resumo\n\n${RETIDO_PARA_EDITOR_MARKER}\n` });
    assert.equal(r.retido, true);
  });

  it("cenário da PR #10221: só prosa ('NÃO mergeado pela rodada') sem label nem marcador → livre (é por isso que a label é obrigatória)", () => {
    const r = evaluatePrRetido({ labels: [{ name: "continuo" }], body: "NÃO mergeado pela rodada — decisão do editor" });
    assert.equal(r.retido, false);
  });

  it("labels ausentes/malformadas → null (fail-closed)", () => {
    assert.equal(evaluatePrRetido({ labels: undefined, body: "" }).retido, null);
    assert.equal(evaluatePrRetido({ labels: "retido-para-editor", body: "" }).retido, null);
    assert.equal(evaluatePrRetido({ labels: [{ nome: "x" }], body: "" }).retido, null);
  });

  it("corpo ausente não é ilegibilidade — PR sem corpo e sem label é livre", () => {
    assert.equal(evaluatePrRetido({ labels: [], body: undefined }).retido, false);
  });

  it("label vizinha não conta (sem match por substring)", () => {
    assert.equal(evaluatePrRetido({ labels: [{ name: "retido-para-editor-antigo" }], body: "" }).retido, false);
  });
});

describe("pontos de merge consultam o sinal (#10278)", () => {
  it("check-continuo-merge-gate.ts pede `labels` ao gh e passa retidoParaEditor ao gate", () => {
    const src = readFileSync(join(ROOT, "scripts/check-continuo-merge-gate.ts"), "utf8");
    assert.match(src, /"--json",\s*"[^"]*\blabels\b[^"]*"/);
    assert.match(src, /evaluatePrRetido\(\{ labels: payload\.labels, body: payload\.body \}\)/);
    assert.match(src, /retidoParaEditor: retido\.retido/);
  });

  it("check-pr-retido-gate.ts sem --pr sai 3 (uso inválido, nunca 'livre')", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/check-pr-retido-gate.ts")], { encoding: "utf8" });
    assert.equal(r.status, 3);
  });

  it("SKILL do overnight exige check-pr-retido-gate antes do merge (gate determinístico e pickup 2b) e manda aplicar a label", () => {
    const skill = readFileSync(join(ROOT, ".claude/skills/diaria-overnight/SKILL.md"), "utf8");
    const occurrences = skill.split("scripts/check-pr-retido-gate.ts").length - 1;
    assert.ok(occurrences >= 2, `esperava o gate citado no pickup 2b e na Fase 1 (achei ${occurrences})`);
    assert.match(skill, /gh pr edit \{N\} --add-label retido-para-editor/);
  });
});
