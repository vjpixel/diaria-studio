/**
 * test/check-editorial-signoff.test.ts (#7978)
 *
 * Cobre scripts/check-editorial-signoff.ts::evaluateCalibrationTouch — a
 * parte pura da decisão "esse conjunto de arquivos mudados toca
 * calibração?", com provedores de linha/conteúdo injetados (sem git real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCalibrationTouch, getPrLabelsWithRetry, SIGNOFF_LABEL, type SpawnFn } from "../scripts/check-editorial-signoff.ts";
import { CALIBRATION_ALLOWLIST } from "../scripts/lib/calibration-file-allowlist.ts";

describe("evaluateCalibrationTouch (#7978)", () => {
  it("diff sem nenhum arquivo da allowlist: não toca calibração", () => {
    const check = evaluateCalibrationTouch(
      ["scripts/random.ts", "README.md"],
      () => new Set([1, 2, 3]),
      () => "conteúdo qualquer",
    );
    assert.deepEqual(check.touchedPaths, []);
  });

  it("diff toca um ts-file da allowlist com linhas tocadas: toca calibração", () => {
    const tsPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "ts-file")!.path;
    const check = evaluateCalibrationTouch(
      [tsPath, "scripts/outro.ts"],
      () => new Set([5]),
      () => "conteúdo",
    );
    assert.deepEqual(check.touchedPaths, [tsPath]);
  });

  it("diff toca arquivo marked-blocks mas SÓ fora de qualquer bloco CALIBRATED: não toca calibração", () => {
    const mdPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!.path;
    const content = ["l1", "<!-- CALIBRATED:x:start -->", "l3", "<!-- CALIBRATED:x:end -->", "l5"].join("\n");
    const check = evaluateCalibrationTouch(
      [mdPath],
      () => new Set([1, 5]), // só linhas fora do bloco (2-4)
      () => content,
      () => content, // oldContent == newContent: nenhum marcador removido
    );
    assert.deepEqual(check.touchedPaths, []);
  });

  it("diff toca arquivo marked-blocks DENTRO de um bloco CALIBRATED: toca calibração", () => {
    const mdPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!.path;
    const content = ["l1", "<!-- CALIBRATED:x:start -->", "l3", "<!-- CALIBRATED:x:end -->", "l5"].join("\n");
    const check = evaluateCalibrationTouch(
      [mdPath],
      () => new Set([3]),
      () => content,
    );
    assert.deepEqual(check.touchedPaths, [mdPath]);
  });

  it("achado de review do #7978: getOldContent omitido usa o default (sempre null) — comportamento back-compat, sem checar remoção de marcador", () => {
    const mdPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!.path;
    const newContent = "sem marcador nenhum";
    const check = evaluateCalibrationTouch([mdPath], () => new Set([1]), () => newContent);
    assert.deepEqual(check.touchedPaths, []);
  });

  it("achado de review do #7978 (alta confiança): marcador removido na mesma diff que muda o valor — detectado via getOldContent, mesmo sem bloco no conteúdo novo", () => {
    const mdPath = CALIBRATION_ALLOWLIST.find((e) => e.kind === "marked-blocks")!.path;
    const oldContent = ["<!-- CALIBRATED:x:start -->", "peso antigo", "<!-- CALIBRATED:x:end -->"].join("\n");
    const newContent = "peso NOVO sem marcador nenhum";
    const check = evaluateCalibrationTouch(
      [mdPath],
      () => new Set([1]),
      () => newContent,
      () => oldContent,
    );
    assert.deepEqual(check.touchedPaths, [mdPath]);
  });

  it("múltiplos arquivos calibráveis tocados: touchedPaths lista todos", () => {
    const paths = CALIBRATION_ALLOWLIST.filter((e) => e.kind === "ts-file").map((e) => e.path);
    const check = evaluateCalibrationTouch(paths, () => new Set([1]), () => "x");
    assert.equal(check.touchedPaths.length, paths.length);
  });

  it("SIGNOFF_LABEL é o literal usado como convenção de label no GitHub (documentação viva)", () => {
    assert.equal(SIGNOFF_LABEL, "editorial-signoff:approved");
  });
});

// ---------------------------------------------------------------------------
// getPrLabelsWithRetry: mesmo padrão de teste de check-pr-bugfix.ts::getPrLabels
// (#7978, achado de review — cobertura ausente na 1ª versão da PR)
// ---------------------------------------------------------------------------

describe("getPrLabelsWithRetry (#7978)", () => {
  const noopSleep = async (_ms: number): Promise<void> => {};

  it("retry 2×fail→pass: retorna labels na 3ª tentativa sem lançar", async () => {
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      if (callCount < 3) return { status: 1, stdout: "", stderr: "HTTP 401: Requires authentication" };
      return { status: 0, stdout: "editorial-signoff:approved\nP1\n", stderr: "" };
    };

    const labels = await getPrLabelsWithRetry("42", mockSpawn, noopSleep, 3);

    assert.equal(callCount, 3);
    assert.deepEqual(labels, ["editorial-signoff:approved", "P1"]);
  });

  it("sucesso na 1ª tentativa: não dorme, não faz retry", async () => {
    let callCount = 0;
    let sleptCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      return { status: 0, stdout: "P2\n", stderr: "" };
    };
    const countingSleep = async (_ms: number): Promise<void> => {
      sleptCount++;
    };

    const labels = await getPrLabelsWithRetry("42", mockSpawn, countingSleep, 3);
    assert.equal(callCount, 1);
    assert.equal(sleptCount, 0);
    assert.deepEqual(labels, ["P2"]);
  });

  it("esgota todas as tentativas: lança mensagem INFRA distinta com o último erro", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => ({ status: 1, stdout: "", stderr: "HTTP 500: Internal Server Error" });

    await assert.rejects(() => getPrLabelsWithRetry("42", mockSpawn, noopSleep, 3), /INFRA.*3 tentativas.*HTTP 500/s);
  });

  it("status null (processo morto por sinal) não vira 'exit null' confuso na mensagem de erro", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => ({ status: null, stdout: "", stderr: "" });

    await assert.rejects(() => getPrLabelsWithRetry("42", mockSpawn, noopSleep, 1), /sinal/);
  });

  it("respeita o backoff exato [10s, 20s] entre tentativas (schedule, não só a contagem)", async () => {
    const delays: number[] = [];
    let callCount = 0;
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => {
      callCount++;
      return { status: 1, stdout: "", stderr: "erro" };
    };
    const recordingSleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };

    await assert.rejects(() => getPrLabelsWithRetry("42", mockSpawn, recordingSleep, 3));
    assert.deepEqual(delays, [10_000, 20_000]);
  });

  it("labels vazias (linhas em branco filtradas): retorna array vazio, não array com strings vazias", async () => {
    const mockSpawn: SpawnFn = (_cmd, _args, _opts) => ({ status: 0, stdout: "\n\n", stderr: "" });
    const labels = await getPrLabelsWithRetry("42", mockSpawn, noopSleep, 1);
    assert.deepEqual(labels, []);
  });
});
