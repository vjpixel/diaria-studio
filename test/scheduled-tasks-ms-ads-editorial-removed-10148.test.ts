/**
 * test/scheduled-tasks-ms-ads-editorial-removed-10148.test.ts (#10148)
 *
 * Decisão do editor no briefing overnight 261014: a task
 * `Diaria-Microsoft-Ads-Editorial-Reasons` sai do registro declarativo. O
 * timer já estava parado à mão na `300` e o `Diaria-Task-Never-Armed-Alarm`
 * reabria a issue toda execução enquanto a task seguisse declarada.
 *
 * Trava: (1) a task não volta ao registro por engano; (2) o nome fica em
 * `RETIRED_TASK_NAMES`, então o unit ainda instalado na `300` vira no-op
 * (exit 0) em vez de "Task desconhecida" (exit 1, que alimentaria o
 * `Diaria-Systemd-Failed-Units-Alarm`); (3) nenhuma task agendada aponta
 * pro CLI. Desde o #10755 (canal Microsoft Ads encerrado) o próprio CLI saiu
 * do repo — a asserção de "segue no repo para uso manual" virou a inversa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getScheduledTaskByName,
  isRetiredTaskName,
  listScheduledTaskNames,
  RETIRED_TASK_NAMES,
  SCHEDULED_TASKS,
} from "../scripts/lib/scheduled-tasks.ts";
import { main as runTaskMain } from "../scripts/run-task.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASK = "Diaria-Microsoft-Ads-Editorial-Reasons";
const SCRIPT = "scripts/microsoft-ads-editorial-reasons.ts";

describe("#10148 — Diaria-Microsoft-Ads-Editorial-Reasons removida do registro", () => {
  it("não está mais em SCHEDULED_TASKS nem na listagem de nomes", () => {
    assert.equal(getScheduledTaskByName(TASK), undefined);
    assert.ok(!listScheduledTaskNames().includes(TASK));
  });

  it("nenhuma task agendada aponta pro CLI, e o CLI saiu do repo com o canal (#10755)", () => {
    const refs = SCHEDULED_TASKS.filter((t) => t.steps.some((s) => s.script === SCRIPT)).map((t) => t.name);
    assert.deepEqual(refs, []);
    assert.ok(!existsSync(join(ROOT, SCRIPT)), `${SCRIPT} deveria ter saído do repo no encerramento do canal (#10755)`);
  });

  it("está em RETIRED_TASK_NAMES — nome retirado conhecido, não typo", () => {
    assert.ok(RETIRED_TASK_NAMES.has(TASK));
    assert.equal(isRetiredTaskName(TASK), true);
  });

  it("nenhum nome retirado coexiste com uma task ativa do registro", () => {
    const active = new Set(listScheduledTaskNames());
    assert.deepEqual([...RETIRED_TASK_NAMES].filter((n) => active.has(n)), []);
  });

  it("run-task.ts --task com o nome retirado -> exit 0, no-op (nunca 'Task desconhecida')", () => {
    const originalLog = console.log;
    const originalError = console.error;
    const logLines: string[] = [];
    const errorLines: string[] = [];
    console.log = (msg: string) => logLines.push(msg);
    console.error = (msg: string) => errorLines.push(msg);
    try {
      const code = runTaskMain(["--task", TASK], ROOT);
      assert.equal(code, 0);
      assert.match(logLines.join("\n"), /retirada do registro/);
      assert.doesNotMatch(errorLines.join("\n"), /Task desconhecida/);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
