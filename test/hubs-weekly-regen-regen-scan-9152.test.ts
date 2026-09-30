/**
 * test/hubs-weekly-regen-regen-scan-9152.test.ts (#9152)
 *
 * Regressão: o catch do `regen-scan` em `scripts/hubs-weekly-regen.ts`
 * (quando o próprio `planAllHubs` lança) chamava `alarmFailure` SEM os
 * achados `prosa-defasada` já abertos — a reconciliação via lista de prosa
 * vazia e avançava o `missingStreak` de toda issue de prosa aberta rumo ao
 * auto-close, mesmo com o hub ainda defasado. O #9019 só corrigira o catch
 * do `git-worktree-add`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { planAllHubsOrAlarm, openProseFindings } from "../scripts/hubs-weekly-regen.ts";
import type { AlarmFinding } from "../scripts/lib/alarm-issues.ts";

describe("planAllHubsOrAlarm — catch do regen-scan preserva achados de prosa abertos (#9152)", () => {
  let tmpDir: string;
  let statePath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hubs-weekly-regen-9152-"));
    statePath = resolve(tmpDir, "weekly-regen-alarm-issues.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        "hub-aberto:prosa-defasada": { issueNumber: 1, url: "u1", missingStreak: 1, closedAt: null },
        "hub-fechado:prosa-defasada": { issueNumber: 2, url: "u2", missingStreak: 0, closedAt: "2026-09-01T00:00:00Z" },
        "hubs-weekly-regen:falha:git-push": { issueNumber: 3, url: "u3", missingStreak: 0, closedAt: null },
      }),
    );
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("planAllHubs lança -> alarme regen-scan leva as issues de prosa abertas na lista reconciliada", () => {
    const calls: { reason: string; detail: string; alsoWith: AlarmFinding[] }[] = [];
    const result = planAllHubsOrAlarm("2026-09-30", "/nao/importa", {
      plan: () => {
        throw new Error("hub com dado inválido");
      },
      alarm: (reason, detail, alsoWith) => calls.push({ reason, detail, alsoWith }),
      openProse: () => openProseFindings(statePath),
    });

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, "regen-scan");
    assert.match(calls[0].detail, /hub com dado inválido/);
    assert.deepEqual(
      calls[0].alsoWith.map((f) => `${f.check}:${f.fingerprint}`),
      ["hub-aberto:prosa-defasada"],
      "a issue de prosa aberta precisa seguir pendente (senão o missingStreak avança rumo ao auto-close)",
    );
  });

  it("planAllHubs ok -> devolve o plano e não dispara alarme", () => {
    const planned = { hubPlans: [], proseAlarmSlugs: [], proseState: {} };
    let alarmed = false;
    const result = planAllHubsOrAlarm("2026-09-30", "/nao/importa", {
      plan: () => planned,
      alarm: () => {
        alarmed = true;
      },
      openProse: () => openProseFindings(statePath),
    });
    assert.equal(result, planned);
    assert.equal(alarmed, false);
  });

  it("sem openProse injetado, o default é openProseFindings() (não uma lista vazia)", () => {
    const calls: AlarmFinding[][] = [];
    planAllHubsOrAlarm("2026-09-30", "/nao/importa", {
      plan: () => {
        throw new Error("boom");
      },
      alarm: (_r, _d, alsoWith) => calls.push(alsoWith),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], openProseFindings());
  });

  it("main() usa planAllHubsOrAlarm e não sobra catch inline de regen-scan sem os achados de prosa", () => {
    const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "hubs-weekly-regen.ts"), "utf8");
    const mainBody = src.slice(src.indexOf("async function main("));
    assert.match(mainBody, /planAllHubsOrAlarm\(/);
    assert.doesNotMatch(mainBody, /alarmFailure\(\s*"regen-scan"/);
    assert.doesNotMatch(mainBody, /=\s*planAllHubs\(/);
  });

  it("openProseFindings sem arquivo de estado -> lista vazia", () => {
    assert.deepEqual(openProseFindings(resolve(tmpDir, "ausente.json")), []);
  });
});
