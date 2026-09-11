/**
 * test/calibration-file-allowlist.test.ts (#7978)
 *
 * Cobre scripts/lib/calibration-file-allowlist.ts — extração de blocos
 * CALIBRATED e a decisão "esse diff conta como mudança de calibração?".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCalibratedBlocks, isCalibrationTouchingFile, CALIBRATION_ALLOWLIST } from "../scripts/lib/calibration-file-allowlist.ts";

describe("extractCalibratedBlocks (#7978)", () => {
  it("extrai 1 bloco simples com start/end na mesma feature", () => {
    const content = ["linha 0", "<!-- CALIBRATED:hands_on:start -->", "conteúdo", "<!-- CALIBRATED:hands_on:end -->", "linha 4"].join("\n");
    const blocks = extractCalibratedBlocks(content);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].feature, "hands_on");
    assert.equal(blocks[0].startLine, 2);
    assert.equal(blocks[0].endLine, 4);
  });

  it("extrai múltiplos blocos sequenciais (não aninhados)", () => {
    const content = [
      "<!-- CALIBRATED:a:start -->",
      "x",
      "<!-- CALIBRATED:a:end -->",
      "<!-- CALIBRATED:b:start -->",
      "y",
      "<!-- CALIBRATED:b:end -->",
    ].join("\n");
    const blocks = extractCalibratedBlocks(content);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].feature, "a");
    assert.equal(blocks[1].feature, "b");
  });

  it("nenhum marcador: retorna array vazio", () => {
    assert.deepEqual(extractCalibratedBlocks("linha 1\nlinha 2"), []);
  });

  it("start sem end correspondente: lança", () => {
    assert.throws(() => extractCalibratedBlocks("<!-- CALIBRATED:x:start -->\nsem fim"), /nunca foi fechado/);
  });

  it("end sem start correspondente: lança", () => {
    assert.throws(() => extractCalibratedBlocks("<!-- CALIBRATED:x:end -->"), /sem start correspondente/);
  });

  it("start/end com nomes de feature divergentes: lança", () => {
    assert.throws(() => extractCalibratedBlocks("<!-- CALIBRATED:a:start -->\nx\n<!-- CALIBRATED:b:end -->"), /nomes de feature divergentes/);
  });

  it("start aninhado (2 starts sem end entre eles): lança", () => {
    assert.throws(
      () => extractCalibratedBlocks("<!-- CALIBRATED:a:start -->\n<!-- CALIBRATED:b:start -->"),
      /marcadores não podem aninhar/,
    );
  });
});

describe("isCalibrationTouchingFile (#7978)", () => {
  const markedContent = ["l1", "<!-- CALIBRATED:hands_on:start -->", "l3", "<!-- CALIBRATED:hands_on:end -->", "l5"].join("\n");

  it("arquivo fora da allowlist: sempre false, mesmo com linhas tocadas", () => {
    assert.equal(isCalibrationTouchingFile("scripts/random-file.ts", new Set([1]), "conteúdo"), false);
  });

  it("arquivo ts-file da allowlist: qualquer linha tocada conta", () => {
    const tsEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "ts-file")!;
    assert.equal(isCalibrationTouchingFile(tsEntry.path, new Set([1]), "qualquer conteúdo"), true);
  });

  it("arquivo ts-file da allowlist sem nenhuma linha tocada (touchedLines vazio): false", () => {
    const tsEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "ts-file")!;
    assert.equal(isCalibrationTouchingFile(tsEntry.path, new Set(), "conteúdo"), false);
  });

  it("arquivo marked-blocks: linha tocada DENTRO do bloco conta", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([3]), markedContent), true);
  });

  it("arquivo marked-blocks: linha tocada FORA de qualquer bloco não conta", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([1]), markedContent), false);
  });

  it("arquivo marked-blocks: linha do marcador start/end em si também conta (mudança estrutural do bloco)", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([2]), markedContent), true);
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([4]), markedContent), true);
  });

  it("arquivo marked-blocks deletado (newContent null): conta como calibração (achado do design — perder o rubrico inteiro é uma mudança real)", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([1]), null), true);
  });

  it("arquivo marked-blocks deletado com touchedLines VAZIO (o caso real que uma deleção pura de diff produz — achado de review do #7978): ainda conta como calibração", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set(), null), true);
  });

  it("achado de review do #7978 (alta confiança): marcador CALIBRATED removido na mesma diff que muda o conteúdo — conta como calibração via oldContent, mesmo sem sobrar bloco no newContent", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    const oldContent = ["l1", "<!-- CALIBRATED:hands_on:start -->", "peso antigo", "<!-- CALIBRATED:hands_on:end -->", "l5"].join("\n");
    const newContent = ["l1", "peso NOVO reescrito sem marcador nenhum", "l5"].join("\n");
    // A linha tocada (2) não cai em nenhum bloco do newContent (não há bloco
    // nenhum) — sem a checagem de oldContent, isso daria false negativo.
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([2]), newContent, oldContent), true);
  });

  it("marcador presente nos dois lados (bloco preservado): não dispara a checagem de remoção — comportamento normal de linha-dentro-do-bloco continua decidindo", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    const content = ["l1", "<!-- CALIBRATED:hands_on:start -->", "l3", "<!-- CALIBRATED:hands_on:end -->", "l5"].join("\n");
    // mesmo conteúdo antes/depois, linha tocada fora do bloco -> false
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([1]), content, content), false);
  });

  it("oldContent omitido (default): comportamento igual ao anterior, sem checar remoção de marcador (back-compat pra chamadores que só têm o conteúdo novo)", () => {
    const mdEntry = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!;
    const newContent = "sem marcador nenhum";
    assert.equal(isCalibrationTouchingFile(mdEntry.path, new Set([1]), newContent), false);
  });
});
