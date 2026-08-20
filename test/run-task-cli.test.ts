/**
 * test/run-task-cli.test.ts (#4805 Fase 2)
 *
 * Cobertura de `scripts/run-task.ts` — só os caminhos de argumento (uso sem
 * `--task`, `--task` desconhecido), que não têm efeito colateral e não
 * exigem credenciais. Rodar `--task <task-real>` de ponta a ponta invocaria
 * scripts que precisam de credenciais/junction `data/` reais (fora do
 * escopo de um teste automatizado) — a lógica de execução em si já está
 * coberta por `test/task-runner.test.ts` via `runScheduledTask` diretamente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runTaskMain } from "../scripts/run-task.ts";
import { listScheduledTaskNames } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "run-task.ts");

describe("run-task.ts main() — em processo (unit)", () => {
  it("sem --task -> retorna 1, imprime uso com a lista de tasks conhecidas", () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (msg: string) => lines.push(msg);
    try {
      const code = runTaskMain([], ROOT);
      assert.equal(code, 1);
      const output = lines.join("\n");
      for (const name of listScheduledTaskNames()) {
        assert.match(output, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    } finally {
      console.error = originalError;
    }
  });

  it("--task com nome desconhecido -> retorna 1, imprime a task desconhecida", () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (msg: string) => lines.push(msg);
    try {
      const code = runTaskMain(["--task", "Diaria-Nao-Existe-4805"], ROOT);
      assert.equal(code, 1);
      assert.match(lines.join("\n"), /Task desconhecida: "Diaria-Nao-Existe-4805"/);
    } finally {
      console.error = originalError;
    }
  });

  // #5733: unit systemd instalado ainda invoca `Diaria-Clarice-Novos-Abort-Alarm`,
  // removida do registro no #5660. Isto deve virar no-op (exit 0), não "task
  // desconhecida" (exit 1) — diferente de um nome que nunca existiu (typo real,
  // caso coberto pelo teste acima).
  it("--task com nome RETIRADO conhecido -> retorna 0, no-op (nunca 'task desconhecida')", () => {
    const originalLog = console.log;
    const originalError = console.error;
    const logLines: string[] = [];
    const errorLines: string[] = [];
    console.log = (msg: string) => logLines.push(msg);
    console.error = (msg: string) => errorLines.push(msg);
    try {
      const code = runTaskMain(["--task", "Diaria-Clarice-Novos-Abort-Alarm"], ROOT);
      assert.equal(code, 0);
      assert.match(logLines.join("\n"), /retirada do registro/);
      assert.doesNotMatch(errorLines.join("\n"), /Task desconhecida/);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it("--task sem valor (flag solta) -> retorna 1 (getStringArg lança, main captura)", () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (msg: string) => lines.push(msg);
    try {
      const code = runTaskMain(["--task"], ROOT);
      assert.equal(code, 1);
    } finally {
      console.error = originalError;
    }
  });
});

describe("run-task.ts — spawn real do processo CLI (argumentos)", () => {
  it("sem argumentos -> exit 1 (processo real, sem side effects)", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Uso: run-task\.ts --task/);
  });

  it("--task desconhecido -> exit 1 (processo real, sem side effects)", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--task", "Diaria-Nao-Existe-4805"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Task desconhecida/);
  });

  it("--task retirado conhecido (#5733) -> exit 0 (processo real, sem side effects)", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--task", "Diaria-Clarice-Novos-Abort-Alarm"],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /retirada do registro/);
  });
});
