/**
 * #11779 — todo agendamento acontece no `300` (decisão do editor, 01/11/2026).
 * Task local do app Claude desktop só existe como exceção justificada: cada
 * entrada de `DESKTOP_SCHEDULED_TASKS` precisa dizer por que não roda no
 * `300`, em que issue o editor manteve a exceção e quando o motivo foi
 * reconferido. A listagem `--desktop` mostra isso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DESKTOP_SCHEDULED_TASKS, renderDesktopScheduledTasksTable } from "../scripts/lib/scheduled-tasks.ts";

describe("#11779 — exceção ao 300 das tasks locais do app", () => {
  it("toda task local tem motivo, issue da decisão e data de revisão válida", () => {
    assert.ok(DESKTOP_SCHEDULED_TASKS.length > 0);
    for (const t of DESKTOP_SCHEDULED_TASKS) {
      const ex = t.serverException;
      assert.ok(ex.reason.trim().length >= 40, `${t.taskId}: motivo vazio ou curto demais`);
      assert.match(ex.decidedIn, /^#\d+$/, `${t.taskId}: decidedIn deve ser #N`);
      assert.match(ex.reviewedOn, /^\d{4}-\d{2}-\d{2}$/, `${t.taskId}: reviewedOn deve ser AAAA-MM-DD`);
      assert.ok(!Number.isNaN(Date.parse(`${ex.reviewedOn}T00:00:00Z`)), `${t.taskId}: reviewedOn não é data`);
    }
  });

  it("a listagem --desktop mostra a exceção de cada task", () => {
    const lines = renderDesktopScheduledTasksTable().split("\n");
    assert.equal(lines.length, DESKTOP_SCHEDULED_TASKS.length);
    DESKTOP_SCHEDULED_TASKS.forEach((t, i) => {
      assert.ok(lines[i].startsWith(`${t.taskId}\t`));
      assert.ok(lines[i].includes(`exceção ao 300: ${t.serverException.decidedIn}`), lines[i]);
    });
  });

  it("o rollout de 08/11 saiu do Neo: não é task local do app", () => {
    assert.ok(!DESKTOP_SCHEDULED_TASKS.some((t) => t.taskId.includes("rollout")));
  });

  it("o registro em prosa documenta a exceção e a saída do rollout", () => {
    const doc = readFileSync(new URL("../docs/scheduled-tasks-registry.md", import.meta.url), "utf8");
    assert.match(doc, /#11779/);
    assert.match(doc, /diaria-rollout-11226/);
  });
});
