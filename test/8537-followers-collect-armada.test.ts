/**
 * test/8537-followers-collect-armada.test.ts — regressão #8537
 *
 * Dois invariantes, ambos derivados do mesmo incidente: a task
 * `Diaria-Social-Followers-Collect` ficou com `enabled: false` desde o
 * #8260 e ninguém percebeu por 3 dias, porque task desarmada aparecia em
 * `--list` idêntica a uma armada.
 *
 * 1. A task de coleta de seguidores está ARMADA e de fato gera unit
 *    systemd — é a asserção que falharia se o `enabled: false` voltasse.
 *    Testar só a flag seria testar o literal; o que importa é que
 *    `setup-systemd-timers.ts` (que filtra por `enabled !== false`) passe
 *    a enxergá-la.
 * 2. `listScheduledTaskRows` expõe `armed`, e uma task desarmada é
 *    distinguível de uma armada na tabela do `--list`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEDULED_TASKS,
  getScheduledTaskByName,
  listScheduledTaskRows,
  renderScheduledTasksTable,
  type ScheduledTaskDefinition,
} from "../scripts/lib/scheduled-tasks.ts";
import { generateSystemdUnits } from "../scripts/setup-systemd-timers.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TASK = "Diaria-Social-Followers-Collect";

describe("#8537 — Diaria-Social-Followers-Collect armada", () => {
  it("a task existe e NÃO está desarmada (enabled !== false)", () => {
    const t = getScheduledTaskByName(TASK);
    assert.ok(t, `${TASK} sumiu do registro`);
    assert.notEqual(
      t.enabled,
      false,
      `${TASK} voltou a enabled:false — setup-systemd-timers.ts filtra por enabled!==false, ` +
        "então ela não gera unit, não aparece em systemctl list-timers e o painel /ads volta a followers:null (#8537)",
    );
  });

  it("gera de fato o par .service/.timer — o filtro de enabled deixa ela passar", () => {
    const t = getScheduledTaskByName(TASK);
    assert.ok(t);
    const out = mkdtempSync(join(tmpdir(), "diaria-8537-units-"));
    try {
      // Mesmo filtro que o CLI aplica (setup-systemd-timers.ts:82). Uma task
      // com enabled:false sai daqui como 0 arquivos — foi exatamente o que
      // `--task Diaria-Social-Followers-Collect` devolveu antes do fix.
      const armadas = [t].filter((x: ScheduledTaskDefinition) => x.enabled !== false);
      const written = generateSystemdUnits(armadas, ROOT, out);
      assert.equal(written.length, 2, "esperava 1 .service + 1 .timer");
      const nomes = readdirSync(out).sort();
      assert.deepEqual(nomes, [
        "diaria-social-followers-collect.service",
        "diaria-social-followers-collect.timer",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("#8537 — task desarmada é visível no --list", () => {
  it("listScheduledTaskRows expõe `armed` para toda task do registro", () => {
    const rows = listScheduledTaskRows();
    assert.equal(rows.length, SCHEDULED_TASKS.length);
    for (const r of rows) assert.equal(typeof r.armed, "boolean", `${r.name} sem campo armed`);
  });

  it("`armed` espelha enabled!==false — desarmada e armada não se confundem", () => {
    const desarmada: ScheduledTaskDefinition = {
      name: "Diaria-Fake-Desarmada-8537",
      description: "fake",
      steps: [{ key: "noop", script: "scripts/does-not-exist.ts" }],
      logPath: "fake/.fake.log",
      schedule: { kind: "daily", hour: 12, minute: 0 },
      enabled: false,
      issue: "#8537 (teste)",
    };
    const armada: ScheduledTaskDefinition = { ...desarmada, name: "Diaria-Fake-Armada-8537", enabled: true };
    const semFlag: ScheduledTaskDefinition = { ...desarmada, name: "Diaria-Fake-SemFlag-8537", enabled: undefined };

    const rows = listScheduledTaskRows([desarmada, armada, semFlag]);
    assert.deepEqual(
      rows.map((r) => r.armed),
      [false, true, true],
      "omitir `enabled` significa ARMADA (default), só o literal false desarma",
    );
  });

  it("a tabela do --list marca DESARMADA — o sinal que faltava no #8537", () => {
    const desarmada: ScheduledTaskDefinition = {
      name: "Diaria-Fake-Desarmada-8537",
      description: "fake",
      steps: [{ key: "noop", script: "scripts/does-not-exist.ts" }],
      logPath: "fake/.fake.log",
      schedule: { kind: "daily", hour: 12, minute: 0 },
      enabled: false,
      issue: "#8537 (teste)",
    };
    const armada: ScheduledTaskDefinition = { ...desarmada, name: "Diaria-Fake-Armada-8537", enabled: true };
    const [linhaDesarmada, linhaArmada] = renderScheduledTasksTable(
      listScheduledTaskRows([desarmada, armada]),
    ).split("\n");
    assert.match(linhaDesarmada, /\tDESARMADA$/);
    assert.match(linhaArmada, /\tarmada$/);
  });
});
