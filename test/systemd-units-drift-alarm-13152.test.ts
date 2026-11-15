/**
 * test/systemd-units-drift-alarm-13152.test.ts
 *
 * Alarme agendado de units systemd instaladas defasadas (#13152): a lógica
 * pura (`scripts/lib/systemd-units-drift-alarm.ts`), o `main` do script com
 * I/O injetado (nunca `gh` real nem `~/.config/systemd/user/` real) e a
 * entrada no registro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledUnitDiff } from "../scripts/lib/systemd-node-binary.ts";
import {
  buildSystemdUnitsDriftFinding,
  MAX_UNITS_IN_BODY,
  SYSTEMD_UNITS_DRIFT_CHECK,
  systemdUnitsDriftFingerprint,
} from "../scripts/lib/systemd-units-drift-alarm.ts";
import { getScheduledTaskByName, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import { buildSystemdUnitFiles } from "../scripts/lib/systemd-units.ts";
import { collectInstalledUnitDiffs } from "../scripts/setup-systemd-timers.ts";
import { isLinkedWorktreeRoot, main } from "../scripts/systemd-units-drift-alarm.ts";
import type { NotifyEditorFinding, NotifyEditorResult } from "../scripts/lib/editor-notify.ts";

const differs = (fileName: string, onlyInstalled: string[], onlyGenerated: string[]): InstalledUnitDiff => ({
  fileName,
  status: "differs",
  onlyInstalled,
  onlyGenerated,
});
const same = (fileName: string): InstalledUnitDiff => ({ fileName, status: "same", onlyInstalled: [], onlyGenerated: [] });
const notInstalled = (fileName: string): InstalledUnitDiff => ({
  fileName,
  status: "not-installed",
  onlyInstalled: [],
  onlyGenerated: [],
});

describe("buildSystemdUnitsDriftFinding (#13152)", () => {
  it("sem unit divergente -> null (não instalada não conta)", () => {
    assert.equal(buildSystemdUnitsDriftFinding([same("a.service"), notInstalled("b.timer")], "/u"), null);
  });

  it("unit divergente -> achado com as linhas - instalada / + gerada e as contagens", () => {
    const f = buildSystemdUnitsDriftFinding(
      [differs("a.service", ["Description=velha"], ["Description=nova"]), same("a.timer"), notInstalled("b.timer")],
      "/home/x/.config/systemd/user",
    );
    assert.ok(f);
    assert.match(f.subject, /1 unit\(s\)/);
    assert.match(f.body, /`a\.service`/);
    assert.match(f.body, /- Description=velha/);
    assert.match(f.body, /\+ Description=nova/);
    assert.match(f.body, /1 igual\(is\), 1 não instalada\(s\), 3 no total/);
    assert.match(f.body, /#5140/, "corpo lembra o catch-up do Persistent=true ao rearmar");
  });

  it("fingerprint é do CONJUNTO: independe da ordem, muda quando a divergência muda", () => {
    const a = differs("a.service", ["X=1"], ["X=2"]);
    const b = differs("b.timer", ["OnCalendar=1"], ["OnCalendar=2"]);
    assert.equal(systemdUnitsDriftFingerprint([a, b]), systemdUnitsDriftFingerprint([b, a]));
    assert.notEqual(systemdUnitsDriftFingerprint([a, b]), systemdUnitsDriftFingerprint([a]));
    assert.notEqual(
      systemdUnitsDriftFingerprint([a]),
      systemdUnitsDriftFingerprint([differs("a.service", ["X=1"], ["X=3"])]),
    );
  });

  it("muitas units -> corpo limitado com a contagem do resto", () => {
    const many = Array.from({ length: MAX_UNITS_IN_BODY + 5 }, (_, i) => differs(`u${i}.service`, ["A=1"], ["A=2"]));
    const f = buildSystemdUnitsDriftFinding(many, "/u");
    assert.ok(f);
    assert.match(f.body, /\+5 unit\(s\)/);
    assert.doesNotMatch(f.body, new RegExp(`u${MAX_UNITS_IN_BODY}\\.service`));
  });
});

describe("collectInstalledUnitDiffs — cenário real da issue (#13152)", () => {
  it("unit instalada com Description= velha sai como divergente; igual e ausente não", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-13152-"));
    try {
      const task = getScheduledTaskByName("Diaria-Npm-Version-Drift-Alarm")!;
      const f = buildSystemdUnitFiles(task, "/repo", "/n/node");
      writeFileSync(join(dir, f.serviceFileName), f.serviceContent.replace(/^Description=.*$/m, "Description=velha"));
      writeFileSync(join(dir, f.timerFileName), f.timerContent);
      const other = getScheduledTaskByName("Diaria-GA4-Sync")!;
      const diffs = collectInstalledUnitDiffs([task, other], "/repo", "/n/node", dir);
      const byName = new Map(diffs.map((d) => [d.fileName, d.status]));
      assert.equal(byName.get(f.serviceFileName), "differs");
      assert.equal(byName.get(f.timerFileName), "same");
      assert.equal(diffs.filter((d) => d.status === "not-installed").length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pasta ilegível lança (nada verificado nunca vira 'sem divergência')", () => {
    assert.throws(() => collectInstalledUnitDiffs([], "/repo", "/n/node", "/nao/existe/13152"));
  });
});

describe("isLinkedWorktreeRoot (#13152)", () => {
  it(".git arquivo -> worktree; .git diretório -> checkout principal", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-13152-"));
    const main = mkdtempSync(join(tmpdir(), "main-13152-"));
    try {
      writeFileSync(join(wt, ".git"), "gitdir: /x/.git/worktrees/y\n");
      mkdirSync(join(main, ".git"));
      assert.equal(isLinkedWorktreeRoot(wt), true);
      assert.equal(isLinkedWorktreeRoot(main), false);
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });
});

describe("main (#13152) — I/O injetado", () => {
  const DIFF = [differs("a.service", ["Description=velha"], ["Description=nova"])];
  const okNotify = async (): Promise<NotifyEditorResult> => ({
    severity: "acao",
    emailPolicy: "urgent_only",
    emailSent: false,
    issue: { issueNumber: 42, url: "u", action: "created" } as NotifyEditorResult["issue"],
  });

  function harness(over: Partial<Parameters<typeof main>[1]> = {}) {
    const notified: NotifyEditorFinding[] = [];
    const closed: Array<string | null> = [];
    const deps: Parameters<typeof main>[1] = {
      repoRootAbs: "/repo",
      isWorktree: () => false,
      resolveNodeBin: () => "/n/node",
      tasks: [] as ScheduledTaskDefinition[],
      collect: () => DIFF,
      notify: async (f) => {
        notified.push(f);
        return okNotify();
      },
      closeSuperseded: (_c, fp) => {
        closed.push(fp);
        return { closed: [], failed: [], listed: true };
      },
      ...over,
    };
    return { deps, notified, closed };
  }

  async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const [log, err, warn] = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = () => {};
    try {
      return await fn();
    } finally {
      [console.log, console.error, console.warn] = [log, err, warn];
    }
  }

  it("divergência -> issue de alarme (acao/estado/P3) com fingerprint do conjunto, fecha a anterior, sai 0", async () => {
    const h = harness();
    const code = await quiet(() => main([], h.deps));
    assert.equal(code, 0);
    assert.equal(h.notified.length, 1);
    const f = h.notified[0];
    assert.equal(f.check, SYSTEMD_UNITS_DRIFT_CHECK);
    assert.equal(f.severity, "acao");
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P3");
    assert.equal(f.fingerprint, systemdUnitsDriftFingerprint(DIFF));
    assert.deepEqual(h.closed, [f.fingerprint]);
  });

  it("sem divergência -> nenhuma issue nova e fecha as abertas (fingerprint null)", async () => {
    const h = harness({ collect: () => [same("a.service")] });
    const code = await quiet(() => main([], h.deps));
    assert.equal(code, 0);
    assert.equal(h.notified.length, 0);
    assert.deepEqual(h.closed, [null]);
  });

  it("rodado de worktree -> exit 2, nada comparado nem alarmado", async () => {
    let collected = false;
    const h = harness({
      isWorktree: () => true,
      collect: () => {
        collected = true;
        return DIFF;
      },
    });
    const code = await quiet(() => main([], h.deps));
    assert.equal(code, 2);
    assert.equal(collected, false);
    assert.equal(h.notified.length, 0);
    assert.equal(h.closed.length, 0);
  });

  it("pasta ilegível / node não resolvido -> exit 1 sem fechar issue aberta", async () => {
    for (const over of [
      {
        collect: () => {
          throw new Error("ENOENT");
        },
      },
      {
        resolveNodeBin: () => {
          throw new Error("Nenhum node que case com o .nvmrc");
        },
      },
    ]) {
      const h = harness(over);
      const code = await quiet(() => main([], h.deps));
      assert.equal(code, 1);
      assert.equal(h.notified.length, 0);
      assert.equal(h.closed.length, 0);
    }
  });

  it("gh falhou ao registrar -> exit 1 e não fecha a issue anterior", async () => {
    const h = harness({
      notify: async () => ({
        severity: "acao",
        emailPolicy: "urgent_only",
        emailSent: false,
        issue: { issueNumber: null, url: null, action: "failed", error: "gh 500" } as NotifyEditorResult["issue"],
      }),
    });
    const code = await quiet(() => main([], h.deps));
    assert.equal(code, 1);
    assert.equal(h.closed.length, 0);
  });

  it("--dry-run -> nem gh de issue nem de fechamento", async () => {
    const h = harness();
    const code = await quiet(() => main(["--dry-run"], h.deps));
    assert.equal(code, 0);
    assert.equal(h.notified.length, 0);
    assert.equal(h.closed.length, 0);
  });

  it("flag desconhecida -> exit 1 antes de qualquer I/O (#12503)", async () => {
    const h = harness({
      collect: () => {
        throw new Error("não devia comparar");
      },
    });
    const code = await quiet(() => main(["--bogus"], h.deps));
    assert.equal(code, 1);
    assert.equal(h.notified.length + h.closed.length, 0);
  });

  it("tasks desabilitadas (enabled: false) ficam fora da comparação", async () => {
    let seen: string[] = [];
    const h = harness({
      tasks: [
        { name: "A", enabled: false } as ScheduledTaskDefinition,
        { name: "B" } as ScheduledTaskDefinition,
      ],
      collect: (tasks) => {
        seen = tasks.map((t) => t.name);
        return [];
      },
    });
    await quiet(() => main([], h.deps));
    assert.deepEqual(seen, ["B"]);
  });
});

describe("registro (#13152)", () => {
  it("Diaria-Systemd-Units-Drift-Alarm declarada, diária 18:40, roda o script do alarme", () => {
    const t = getScheduledTaskByName("Diaria-Systemd-Units-Drift-Alarm");
    assert.ok(t);
    assert.deepEqual(t.schedule, { kind: "daily", hour: 18, minute: 40 });
    assert.deepEqual(
      t.steps.map((s) => s.script),
      ["scripts/systemd-units-drift-alarm.ts"],
    );
    assert.equal(t.successExitCodes, undefined, "exit 1 é falha real; o achado vira issue e sai 0");
  });
});
