/**
 * #12923 — depois da virada do `data/` para o Google Drive (#12359, 11/11/2026)
 * o timer do `Diaria-OneDrive-Sync-Alarm` foi parado de propósito no `300`, e o
 * `Diaria-Task-Never-Armed-Alarm` abriu issue de "task parada deliberadamente".
 * A task sai do registro ativo com `enabled: false`: o alarme de nunca-armada
 * deixa de acusá-la, e o rearme automático não a religa (religada, ela
 * acusaria o `onedrive.service`, mascarado de propósito, como serviço morto).
 * Quando a #12360 remover a task do registro, este teste sai junto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getScheduledTaskByName, listDisabledScheduledTaskNames, listScheduledTaskNames } from "../scripts/lib/scheduled-tasks.ts";
import { evaluateTaskNeverArmed, type UnitLoadActiveState } from "../scripts/lib/task-never-armed-alarm.ts";

const TASK = "Diaria-OneDrive-Sync-Alarm";
const UNIT = "diaria-onedrive-sync-alarm";

describe("#12923: alarme do OneDrive desativado depois da virada", () => {
  it("a task continua no registro, mas com enabled: false", () => {
    assert.equal(getScheduledTaskByName(TASK)?.enabled, false);
    assert.ok(listDisabledScheduledTaskNames().includes(TASK));
  });

  it("timer parado de propósito não vira achado de task-stopped-deliberately", () => {
    const states = new Map<string, UnitLoadActiveState>([[UNIT, { loadState: "loaded", activeState: "inactive" }]]);
    // Discrimina: sem o enabled: false, o mesmo estado da unit é o achado da #12923.
    const semDesativar = evaluateTaskNeverArmed([TASK], [], [], states);
    assert.deepEqual(semDesativar.stoppedDeliberately, [TASK]);
    const ev = evaluateTaskNeverArmed(listScheduledTaskNames(), [], listDisabledScheduledTaskNames(), states);
    assert.ok(!ev.neverArmed.includes(TASK));
    assert.ok(!ev.stoppedDeliberately.includes(TASK));
  });

  it("o alarme do Google Drive, que o substitui, segue ativo", () => {
    assert.notEqual(getScheduledTaskByName("Diaria-GDrive-Sync-Alarm")?.enabled, false);
  });
});
