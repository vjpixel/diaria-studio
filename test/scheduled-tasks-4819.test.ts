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
 * armados e ativos em `predator`. Este teste EXISTE pra travar essa
 * regressão especificamente: se alguém no futuro remover uma das 3 do
 * registro (ex: refactor desavisado), a task some do registro sem nenhum
 * outro sinal — o alarme correspondente simplesmente para de rodar em
 * silêncio.
 *
 * **#5115 (cutover final, 260812):** o segundo describe original checava as
 * 3 contra o fallback de scan legado de `.ps1` (`listExpectedScheduledTasks`,
 * `scripts/lib/pending-scheduled-tasks.ts`) — módulo retirado junto com os
 * 40 `.ps1` (nenhuma máquina Windows roda mais tasks `Diaria-*`). Restou a
 * checagem simples e direta contra o registro, que é a fonte de verdade
 * única desde o #4805.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const ORPHAN_TASK_NAMES = [
  "Diaria-Geo-Citation-Monitor",
  "Diaria-Geo-Citation-Staleness-Alarm",
  "Diaria-Hub-Drift-Check",
] as const;

describe("#4819 — as 3 tasks órfãs (Geo-Citation-Monitor/Staleness-Alarm, Hub-Drift-Check) estão no registro declarativo", () => {
  for (const name of ORPHAN_TASK_NAMES) {
    it(`${name}: presente em SCHEDULED_TASKS via getScheduledTaskByName`, () => {
      const task = getScheduledTaskByName(name);
      assert.ok(task, `task "${name}" ausente do registro (scripts/lib/scheduled-tasks.ts)`);
    });
  }
});
