/**
 * test/continuo-ratelimit-watchdog-10070.test.ts (#10070)
 *
 * Regressão: desde o #10064, `pause-cron-on-ratelimit.py` pausa o contínuo em
 * `403 Key limit exceeded` com `resume_after` = 00:05 UTC, mas só o watch
 * diário do Hermes (13:30) o chamava — a retomada atrasava ~13-16h. A task
 * `Diaria-Continuo-Ratelimit-Watchdog` roda o mesmo script de hora em hora.
 *
 * Cobre:
 *   - o cenário real ponta a ponta: marcador com `resume_after` vencido +
 *     job pausado, wrapper rodado com o PATH magro de um unit systemd (sem
 *     `~/.local/bin`) → `hermes cron resume` chamado, marcador removido;
 *   - a task no registro, horária, invocando o wrapper (fora do horário do
 *     watch: a 1ª execução depois de 00:05 UTC é ~1h depois, não 13:30);
 *   - falha do `hermes` vira exit 1 (unit `failed`), silêncio vira exit 0.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildWatchdogEnv,
  classifyWatchdogOutput,
  runContinuoRatelimitWatchdog,
  spawnPauseWatchdog,
  type PythonRunResult,
} from "../scripts/run-continuo-ratelimit-watchdog.ts";
import { getScheduledTaskByName, SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { scheduleToOnCalendar } from "../scripts/lib/systemd-units.ts";

/** #11243: pulado só no Windows (Neo); no CI Linux e no `300` roda normal. */
const SKIP_WIN32 = process.platform === "win32" && "#11243: watchdog systemd do 300 (Linux): wrapper bash com hermes falso e PATH POSIX (~/.local/bin, ':')";

const JOB_ID = "5d791ef6fc2c";
const SYSTEMD_LIKE_PATH = "/usr/bin:/bin";

const PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();

interface FakeHome {
  home: string;
  callsFile: string;
  markerPath: string;
}

function makeFakeHome(opts: { hermesExit: number }): FakeHome {
  const home = mkdtempSync(join(tmpdir(), "ratelimit-watchdog-10070-"));
  const cronDir = join(home, ".hermes", "cron");
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(
    join(cronDir, "jobs.json"),
    JSON.stringify({
      jobs: [
        {
          id: JOB_ID,
          enabled: false,
          failure_streak: 3,
          last_error: "RuntimeError: HTTP 403: Key limit exceeded (daily limit)",
          last_run_at: "2026-10-12T11:00:00Z",
        },
      ],
    }),
  );
  const markerPath = join(cronDir, ".paused-by-watchdog");
  writeFileSync(
    markerPath,
    JSON.stringify({
      job: JOB_ID,
      reason: "key_limit",
      // virada UTC já passou
      resume_after: Date.now() / 1000 - 60,
      paused_last_run_at: "2026-10-12T11:00:00Z",
    }),
  );
  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const callsFile = join(home, "hermes-calls.txt");
  const fakeHermes = join(binDir, "hermes");
  writeFileSync(
    fakeHermes,
    `#!/bin/sh\necho "$@" >> "${callsFile}"\n${opts.hermesExit === 0 ? "" : 'echo "boom" >&2\n'}exit ${opts.hermesExit}\n`,
  );
  chmodSync(fakeHermes, 0o755);
  return { home, callsFile, markerPath };
}

function runWrapper(fake: FakeHome) {
  const logs: string[] = [];
  const events: Array<{ level: string; message: string }> = [];
  const code = runContinuoRatelimitWatchdog({
    runPython: () =>
      spawnPauseWatchdog({ home: fake.home, env: { PATH: SYSTEMD_LIKE_PATH }, pythonBin: PYTHON }),
    log: (m) => logs.push(m),
    recordEvent: (level, message) => events.push({ level, message }),
  });
  return { code, logs, events };
}

describe("#10070 — retomada por execução horária, fora do watch diário", { skip: SKIP_WIN32 }, () => {
  let fake: FakeHome | null = null;
  beforeEach(() => {
    fake = null;
  });
  afterEach(() => {
    if (fake) rmSync(fake.home, { recursive: true, force: true });
  });

  it("resume_after vencido + job pausado → wrapper (PATH de systemd) retoma o job e remove o marcador", () => {
    fake = makeFakeHome({ hermesExit: 0 });
    const { code, events } = runWrapper(fake);
    assert.equal(code, 0);
    assert.ok(existsSync(fake.callsFile), "hermes nunca foi chamado — PATH sem ~/.local/bin?");
    assert.equal(readFileSync(fake.callsFile, "utf8").trim(), `cron resume ${JOB_ID}`);
    assert.equal(existsSync(fake.markerPath), false, "marcador deveria ter sido removido");
    assert.equal(events.length, 1);
    assert.equal(events[0].level, "info");
    assert.match(events[0].message, /retomado/i);
  });

  it("hermes recusa o resume → exit 1 (unit sai failed) e marcador fica", () => {
    fake = makeFakeHome({ hermesExit: 1 });
    const { code, events } = runWrapper(fake);
    assert.equal(code, 1);
    assert.equal(existsSync(fake.markerPath), true);
    assert.equal(events[0]?.level, "error");
  });

  it("máquina sem ~/.hermes → silêncio, exit 0, nenhum evento", () => {
    const home = mkdtempSync(join(tmpdir(), "ratelimit-watchdog-10070-empty-"));
    try {
      const events: string[] = [];
      const code = runContinuoRatelimitWatchdog({
        runPython: () => spawnPauseWatchdog({ home, env: { PATH: SYSTEMD_LIKE_PATH }, pythonBin: PYTHON }),
        log: () => {},
        recordEvent: (_l, m) => events.push(m),
      });
      assert.equal(code, 0);
      assert.deepEqual(events, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("#10070 — Diaria-Continuo-Ratelimit-Watchdog no registro", () => {
  const t = getScheduledTaskByName("Diaria-Continuo-Ratelimit-Watchdog");

  it("existe, invoca o wrapper e é armável (sem enabled:false — o #8153 a arma sozinho)", () => {
    assert.ok(t);
    assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/run-continuo-ratelimit-watchdog.ts"]);
    assert.notEqual(t!.enabled, false);
    assert.equal(t!.issue, "#10070");
    assert.equal(SCHEDULED_TASKS.filter((x) => x.name === t!.name).length, 1);
  });

  it("horária: a 1ª execução depois de resume_after (00:05 UTC) vem em ~1h, não no watch das 13:30", () => {
    assert.deepEqual(t!.schedule, { kind: "interval", hours: 1 });
    assert.equal(scheduleToOnCalendar(t!.schedule), "*-*-* 0/1:00:00 America/Sao_Paulo");
  });
});

describe("#10070 — helpers do wrapper", () => {
  it("buildWatchdogEnv põe ~/.local/bin na frente do PATH, sem duplicar", { skip: SKIP_WIN32 }, () => {
    const env = buildWatchdogEnv({ PATH: "/usr/bin:/bin" }, "/home/x");
    assert.equal(env.PATH, "/home/x/.local/bin:/usr/bin:/bin");
    assert.equal(env.HOME, "/home/x");
    const again = buildWatchdogEnv({ PATH: "/home/x/.local/bin:/usr/bin" }, "/home/x");
    assert.equal(again.PATH, "/home/x/.local/bin:/usr/bin");
  });

  it("classifyWatchdogOutput: vazio, informativo e falha", () => {
    assert.equal(classifyWatchdogOutput(""), "silent");
    assert.equal(classifyWatchdogOutput("  \n"), "silent");
    assert.equal(classifyWatchdogOutput("▶️ **Diária Contínuo retomado** pelo watchdog"), "info");
    assert.equal(classifyWatchdogOutput("⏸️ **Diária Contínuo pausado** pelo watchdog"), "info");
    assert.equal(classifyWatchdogOutput("⚠️ Watchdog tentou retomar 5d791ef6fc2c e falhou: x"), "failure");
    assert.equal(classifyWatchdogOutput("🚨 Watchdog PAUSOU 5d791ef6fc2c mas FALHOU AO GRAVAR"), "failure");
  });

  it("erro de spawn (python3 ausente) → exit 1", () => {
    const res: PythonRunResult = { status: null, stdout: "", stderr: "", error: new Error("spawn python3 ENOENT") };
    const events: string[] = [];
    const code = runContinuoRatelimitWatchdog({
      runPython: () => res,
      log: () => {},
      recordEvent: (_l, m) => events.push(m),
    });
    assert.equal(code, 1);
    assert.match(events[0], /ENOENT/);
  });
});
