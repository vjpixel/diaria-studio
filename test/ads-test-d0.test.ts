/**
 * test/ads-test-d0.test.ts (#5845)
 *
 * I/O de `scripts/ads-test-d0.ts` — imutabilidade real (arquivo em disco),
 * complementar aos testes puros de `planRunStateWrite`
 * (`test/ads-test-run-state.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/ads-test-d0.ts";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ads-test-d0-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#5845 — ads-test-d0 (I/O): 1ª gravação", () => {
  it("grava run-state.json com as datas derivadas", () => {
    withTmpDir((dir) => {
      const runStatePath = join(dir, "run-state.json");
      const historyPath = join(dir, "history.jsonl");
      main(["--d0", "2026-08-26"], runStatePath, historyPath, () => new Date("2026-08-26T09:00:00.000Z"));
      assert.equal(process.exitCode, undefined);
      const state = JSON.parse(readFileSync(runStatePath, "utf8"));
      assert.equal(state.d0, "2026-08-26");
      assert.equal(state.fim_janela, "2026-09-09");
      assert.equal(state.apuracao_snapshot >= "2026-10-07", true);
      assert.equal(existsSync(historyPath), false, "1ª gravação não deve criar histórico");
    });
  });

  it("--d0 ausente → exit 1, nada gravado", () => {
    withTmpDir((dir) => {
      const runStatePath = join(dir, "run-state.json");
      const historyPath = join(dir, "history.jsonl");
      main([], runStatePath, historyPath, () => new Date("2026-08-26T09:00:00.000Z"));
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;
      assert.equal(existsSync(runStatePath), false);
    });
  });
});

describe("#5845 — ads-test-d0 (I/O): imutabilidade em disco", () => {
  it("2ª gravação sem --force → RECUSA, arquivo original intacto", () => {
    withTmpDir((dir) => {
      const runStatePath = join(dir, "run-state.json");
      const historyPath = join(dir, "history.jsonl");
      main(["--d0", "2026-08-26"], runStatePath, historyPath, () => new Date("2026-08-26T09:00:00.000Z"));
      process.exitCode = undefined;

      main(["--d0", "2026-08-27"], runStatePath, historyPath, () => new Date("2026-08-27T09:00:00.000Z"));
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;

      const state = JSON.parse(readFileSync(runStatePath, "utf8"));
      assert.equal(state.d0, "2026-08-26", "a 2ª tentativa sem --force NÃO deve ter sobrescrito o D0 original");
    });
  });

  it("--force SEM --reason → recusa, arquivo intacto", () => {
    withTmpDir((dir) => {
      const runStatePath = join(dir, "run-state.json");
      const historyPath = join(dir, "history.jsonl");
      main(["--d0", "2026-08-26"], runStatePath, historyPath, () => new Date("2026-08-26T09:00:00.000Z"));
      process.exitCode = undefined;

      main(["--d0", "2026-08-27", "--force"], runStatePath, historyPath, () => new Date("2026-08-27T09:00:00.000Z"));
      assert.equal(process.exitCode, 1);
      process.exitCode = undefined;

      const state = JSON.parse(readFileSync(runStatePath, "utf8"));
      assert.equal(state.d0, "2026-08-26");
    });
  });

  it("--force COM --reason → sobrescreve, e preserva o estado anterior no histórico", () => {
    withTmpDir((dir) => {
      const runStatePath = join(dir, "run-state.json");
      const historyPath = join(dir, "history.jsonl");
      main(["--d0", "2026-08-26"], runStatePath, historyPath, () => new Date("2026-08-26T09:00:00.000Z"));
      process.exitCode = undefined;

      main(
        ["--d0", "2026-08-27", "--force", "--reason", "D0 real adiado 1 dia"],
        runStatePath,
        historyPath,
        () => new Date("2026-08-27T09:00:00.000Z"),
      );
      assert.equal(process.exitCode, undefined);

      const state = JSON.parse(readFileSync(runStatePath, "utf8"));
      assert.equal(state.d0, "2026-08-27", "regravação com --force --reason deve atualizar o D0");

      assert.equal(existsSync(historyPath), true);
      const historyLines = readFileSync(historyPath, "utf8").trim().split("\n");
      assert.equal(historyLines.length, 1);
      const entry = JSON.parse(historyLines[0]);
      assert.equal(entry.previous_state.d0, "2026-08-26", "histórico deve preservar o D0 ANTERIOR, não o novo");
      assert.equal(entry.reason, "D0 real adiado 1 dia");
    });
  });
});
