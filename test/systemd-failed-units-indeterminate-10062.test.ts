/**
 * test/systemd-failed-units-indeterminate-10062.test.ts (#10062 item 2)
 *
 * Regressão do ciclo da #9310: o sweep de units failed rodava no mesmo
 * minuto da unit (13:00Z), via a unit `activating` (o timer limpou o
 * `failed` anterior), registrava "não reproduz mais", a unit falhava de novo
 * segundos depois e o sweep seguinte a achava `failed` — comentar/reabrir
 * sem nunca fechar. Unit executando agora = ausência indeterminada: congela
 * a entry em vez de contar como ausência.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import {
  indeterminateTrackedUnits,
  parseActiveStateShowOutput,
} from "../scripts/lib/systemd-failed-units-alarm.ts";
import { buildIndeterminateAllowlist, readUnitActiveState } from "../scripts/systemd-failed-units-alarm.ts";
import { applyAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";

const UNIT = "diaria-microsoft-ads-editorial-reasons.service";
const KEY = `systemd-failed-units:${UNIT}`;

function openState(): AlarmIssuesState {
  return { [KEY]: { issueNumber: 9310, url: "u", missingStreak: 0, closedAt: null, family: "estado" } };
}

describe("ausência indeterminada (#10062 item 2 — sweep no mesmo minuto da unit)", () => {
  it("parseActiveStateShowOutput extrai ActiveState", () => {
    assert.equal(parseActiveStateShowOutput("ActiveState=activating\n"), "activating");
    assert.equal(parseActiveStateShowOutput("Foo=bar\n"), null);
  });

  it("indeterminateTrackedUnits: activating/null congelam; inactive e já-failed não", () => {
    const states: Record<string, string | null> = { a: "activating", b: "inactive", c: null, d: "failed" };
    assert.deepEqual(
      indeterminateTrackedUnits(["a", "b", "c", "d"], ["d"], (u) => states[u] ?? null),
      ["a", "c"],
    );
  });

  it("readUnitActiveState só lê (`show`), nunca muta a unit", () => {
    const calls: string[][] = [];
    const fake = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return "ActiveState=activating\n";
    }) as unknown as typeof execFileSync;
    assert.equal(readUnitActiveState(UNIT, fake), "activating");
    assert.deepEqual(calls[0]!.slice(0, 2), ["--user", "show"]);
  });

  it("cenário real #9310: sweep vê a unit `activating` → nenhum gh, streak intocado", () => {
    const state = openState();
    const allowlist = buildIndeterminateAllowlist(state, [], () => "activating", "2026-10-12");
    assert.equal(allowlist.length, 1);
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    const { nextState } = applyAlarmReconciliation([], state, { cwd: ".", closeAfterRuns: 2, run, allowlist });
    assert.equal(calls.length, 0, "não comenta 'não reproduz mais'");
    assert.equal(nextState[KEY]!.missingStreak, 0);
  });

  it("unit terminou com sucesso (`inactive`) → ausência real, streak avança", () => {
    const state = openState();
    const allowlist = buildIndeterminateAllowlist(state, [], () => "inactive", "2026-10-12");
    assert.equal(allowlist.length, 0);
    const run = () => ({ status: 0, stdout: "", stderr: "" });
    const { nextState } = applyAlarmReconciliation([], state, { cwd: ".", closeAfterRuns: 2, run, allowlist });
    assert.equal(nextState[KEY]!.missingStreak, 1);
  });

  it("entries fechadas ou de outro check não são consultadas", () => {
    const state: AlarmIssuesState = {
      [KEY]: { issueNumber: 1, url: "u", missingStreak: 2, closedAt: "2026-10-01T00:00:00Z", family: "estado" },
      "outro-check:x": { issueNumber: 2, url: "u", missingStreak: 0, closedAt: null, family: "estado" },
    };
    const consulted: string[] = [];
    buildIndeterminateAllowlist(
      state,
      [],
      (u) => {
        consulted.push(u);
        return "activating";
      },
      "2026-10-12",
    );
    assert.deepEqual(consulted, []);
  });
});
