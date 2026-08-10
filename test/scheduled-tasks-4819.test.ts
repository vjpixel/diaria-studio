/**
 * test/scheduled-tasks-4819.test.ts (#4819)
 *
 * Regressão pontual da #4819: no levantamento original da épica #4798, três
 * tasks — `Diaria-Geo-Citation-Monitor` (#4558 Parte C), `Diaria-Geo-
 * Citation-Staleness-Alarm` (#4755) e `Diaria-Hub-Drift-Check` (#4750) — já
 * tinham `.ps1` de setup registrados no Windows, mas ficaram fora do
 * checklist da migração Windows→Linux (#4805/#4806/#4807) porque foram
 * registradas depois do levantamento original ter sido escrito.
 *
 * Verificado ao vivo (sessão #4819, 260810): as 3 já estavam no registro
 * declarativo `scripts/lib/scheduled-tasks.ts` e já tinham timers systemd
 * armados e ativos em `predator` — a implementação de #4805 (PR #4821) já
 * tinha feito o scan correto contra o filesystem (não contra a lista
 * estática da épica) e pego as 3 de qualquer forma. Este teste EXISTE pra
 * travar essa regressão especificamente: se alguém no futuro remover uma
 * das 3 do registro (ex: refactor desavisado), `listExpectedScheduledTasks`
 * volta a classificá-la como órfã (fallback de scan legado) e este teste
 * falha — sem depender de notar isso só quando o alarme correspondente
 * parar de rodar.
 *
 * `Diaria-Overnight-Watchdog` e `Diaria-Edicao-Diaria` são os ÚNICOS nomes
 * que devem sobrar no scan legado — ambos fora de escopo do registro por
 * design (runners que não seguem o padrão `npx tsx <script>.ts`, ver
 * docstring de `scheduled-tasks.ts`), não bugs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getScheduledTaskByName, SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { listExpectedScheduledTasks } from "../scripts/lib/pending-scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ORPHAN_TASK_NAMES = [
  "Diaria-Geo-Citation-Monitor",
  "Diaria-Geo-Citation-Staleness-Alarm",
  "Diaria-Hub-Drift-Check",
] as const;

const EXPECTED_LEGACY_ONLY = ["Diaria-Edicao-Diaria", "Diaria-Overnight-Watchdog"];

describe("#4819 — as 3 tasks órfãs (Geo-Citation-Monitor/Staleness-Alarm, Hub-Drift-Check) estão no registro declarativo", () => {
  for (const name of ORPHAN_TASK_NAMES) {
    it(`${name}: presente em SCHEDULED_TASKS via getScheduledTaskByName`, () => {
      const task = getScheduledTaskByName(name);
      assert.ok(task, `task "${name}" ausente do registro (scripts/lib/scheduled-tasks.ts)`);
    });
  }

  it("nenhuma das 3 órfãs aparece no fallback de scan legado de listExpectedScheduledTasks — só Watchdog e Edicao-Diaria devem restar como legado", () => {
    const expected = listExpectedScheduledTasks(ROOT);
    const registeredNames = new Set(SCHEDULED_TASKS.map((t) => t.name));
    const legacyOnlyNames = expected.filter((t) => !registeredNames.has(t.taskName)).map((t) => t.taskName).sort();

    assert.deepEqual(
      legacyOnlyNames,
      EXPECTED_LEGACY_ONLY,
      `esperava só ${EXPECTED_LEGACY_ONLY.join(", ")} como legado (fora do registro por design); ` +
        `achei: ${legacyOnlyNames.join(", ") || "(nenhuma)"} — se uma das 3 órfãs da #4819 aparece aqui, ela caiu do registro`,
    );

    for (const name of ORPHAN_TASK_NAMES) {
      assert.ok(
        !legacyOnlyNames.includes(name),
        `"${name}" reapareceu como órfã no scan legado — regressão da #4819`,
      );
    }
  });
});
