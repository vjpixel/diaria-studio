/**
 * check-watchdog-armed.test.ts (#2768)
 *
 * Cobre o parser puro `isWatchdogTaskScheduled` com fixtures de output real
 * (task presente / ausente / malformado) e a decisão pura
 * `decideWatchdogArmingAction`. NUNCA chama `schtasks` real nem
 * `setup-watchdog-schedule.ps1` (instrução explícita da issue #2768) —
 * apenas strings fixture, mesmo padrão de `test/exec-mode.test.ts` e
 * `test/overnight-watchdog.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isWatchdogTaskScheduled,
  decideWatchdogArmingAction,
  buildWatchdogWarningMessage,
  WATCHDOG_TASK_NAME,
} from "../scripts/lib/check-watchdog-armed.ts";

// ---------------------------------------------------------------------------
// Fixtures de output real do `schtasks /query /tn "..." /fo LIST`
// ---------------------------------------------------------------------------

const FIXTURE_TASK_PRESENT = `
Folder: \\
HostName:                             DESKTOP-PIXEL
TaskName:                             \\Diaria-Overnight-Watchdog
Next Run Time:                        7/1/2026 6:00:00 PM
Status:                               Ready
Logon Mode:                           Interactive/Background
Last Run Time:                        6/30/2026 11:50:00 PM
Last Result:                          0
Author:                               DESKTOP-PIXEL\\pixel
Task To Run:                          npx tsx "C:\\Users\\pixel\\Projects\\diaria-studio\\scripts\\overnight-watchdog.ts"
Start In:                             C:\\Users\\pixel\\Projects\\diaria-studio
Comment:                               Diar.ia: watchdog de stall overnight (#2688) — roda a cada 10 min entre 18:00-09:00.
Scheduled Task State:                 Enabled
Repeat: Every:                        0 Hours, 10 Minutes
Repeat: Until: Time:                  None
Repeat: Until: Duration:              15 Hours, 0 Minutes
Repeat: Stop If Still Running:        Disabled
`;

const FIXTURE_TASK_ABSENT = `ERROR: The system cannot find the file specified.\r\n`;

const FIXTURE_TASK_ABSENT_STDOUT_VARIANT = `INFO: No matching tasks were found.\r\n`;

const FIXTURE_MALFORMED_TRUNCATED = `
Folder: \\
HostName:                             DESKTOP-PIXEL
`;

const FIXTURE_MALFORMED_GARBAGE = `<<<not even close to schtasks output>>>\n\x00\x01random binary noise`;

const FIXTURE_DIFFERENT_TASK_PRESENT = `
Folder: \\
HostName:                             DESKTOP-PIXEL
TaskName:                             \\SomeOtherScheduledTask
Next Run Time:                        7/1/2026 6:00:00 PM
Status:                               Ready
`;

// ---------------------------------------------------------------------------
// isWatchdogTaskScheduled
// ---------------------------------------------------------------------------

describe("isWatchdogTaskScheduled", () => {
  it("retorna true quando a task está presente (fixture real /fo LIST)", () => {
    assert.equal(isWatchdogTaskScheduled(FIXTURE_TASK_PRESENT), true);
  });

  it("retorna false quando a task está ausente (ERROR: system cannot find)", () => {
    assert.equal(isWatchdogTaskScheduled(FIXTURE_TASK_ABSENT), false);
  });

  it("retorna false quando a task está ausente (variante 'No matching tasks')", () => {
    assert.equal(isWatchdogTaskScheduled(FIXTURE_TASK_ABSENT_STDOUT_VARIANT), false);
  });

  it("retorna false para output malformado/truncado (sem linha TaskName:)", () => {
    assert.equal(isWatchdogTaskScheduled(FIXTURE_MALFORMED_TRUNCATED), false);
  });

  it("retorna false para output completamente malformado/lixo binário", () => {
    assert.equal(isWatchdogTaskScheduled(FIXTURE_MALFORMED_GARBAGE), false);
  });

  it("retorna false quando outra task existe mas não a do watchdog", () => {
    assert.equal(isWatchdogTaskScheduled(FIXTURE_DIFFERENT_TASK_PRESENT), false);
  });

  it("retorna false para string vazia", () => {
    assert.equal(isWatchdogTaskScheduled(""), false);
  });

  it("retorna false para string só com espaços/whitespace", () => {
    assert.equal(isWatchdogTaskScheduled("   \n\t  \r\n  "), false);
  });

  it("é case-insensitive e tolera prefixo de barra invertida da pasta raiz", () => {
    const fixture = `TaskName: \\diaria-overnight-watchdog\n`;
    assert.equal(isWatchdogTaskScheduled(fixture), true);
  });

  it("bate mesmo sem o prefixo de barra invertida (task não-raiz hipotética)", () => {
    const fixture = `TaskName: Diaria-Overnight-Watchdog\n`;
    assert.equal(isWatchdogTaskScheduled(fixture), true);
  });
});

// ---------------------------------------------------------------------------
// decideWatchdogArmingAction
// ---------------------------------------------------------------------------

describe("decideWatchdogArmingAction", () => {
  it("modo cloud → skip_cloud independente de armed", () => {
    assert.equal(decideWatchdogArmingAction("cloud", true), "skip_cloud");
    assert.equal(decideWatchdogArmingAction("cloud", false), "skip_cloud");
  });

  it("modo local + armado → armed", () => {
    assert.equal(decideWatchdogArmingAction("local", true), "armed");
  });

  it("modo local + não armado → not_armed_warn", () => {
    assert.equal(decideWatchdogArmingAction("local", false), "not_armed_warn");
  });
});

// ---------------------------------------------------------------------------
// buildWatchdogWarningMessage
// ---------------------------------------------------------------------------

describe("buildWatchdogWarningMessage", () => {
  it("menciona o nome da task e o script de setup", () => {
    const msg = buildWatchdogWarningMessage();
    assert.match(msg, new RegExp(WATCHDOG_TASK_NAME));
    assert.match(msg, /setup-watchdog-schedule\.ps1/);
  });
});
