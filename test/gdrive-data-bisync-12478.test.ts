/**
 * test/gdrive-data-bisync-12478.test.ts (#12478, épica #12353)
 *
 * O bisync dedicado de `data/` (`diaria-gdrive-data-bisync.{service,timer}`):
 * o bisync do Drive inteiro leva ~36 min por rodada, e um arquivo que o Neo
 * grava em `data/` levaria até ~70 min pra chegar ao `300` depois do cutover
 * (#12359). A unit nova reusa `gdrive-bisync.sh` trocando remote, pasta
 * local, filtro e state dir por env. Trava aqui:
 *
 *   - a unit aponta pra pasta que o filtro grande exclui (as duas rodadas
 *     nunca tocam os mesmos arquivos);
 *   - filtro e state dir são próprios (o `.md5` e os carimbos de um nunca
 *     viram os do outro);
 *   - rodando o script com o env da unit (rclone falso), o bisync sai com o
 *     remote/pasta/filtro de `data/`, e a trava de sentinela olha DENTRO de
 *     `diaria-studio-data` (a sentinela da raiz do Drive não serve).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DATA_DIR_NAME_IN_DRIVE, GDRIVE_FULL_DRIVE_DATA_EXCLUSION } from "../scripts/lib/data-sync-exclusions.ts";

const ROOT = join(import.meta.dirname, "..");
const SYSTEMD = join(ROOT, "scripts", "systemd");
const SCRIPT = join(SYSTEMD, "gdrive-bisync.sh");
const DATA_SERVICE = readFileSync(join(SYSTEMD, "diaria-gdrive-data-bisync.service"), "utf8");
const DATA_TIMER = readFileSync(join(SYSTEMD, "diaria-gdrive-data-bisync.timer"), "utf8");
const FULL_SERVICE = readFileSync(join(SYSTEMD, "diaria-gdrive-bisync.service"), "utf8");

/** `Environment=K=V` da unit, como mapa. */
function unitEnv(unit: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of unit.split(/\r?\n/)) {
    const m = /^Environment=([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function directive(unit: string, key: string): string | undefined {
  return unit
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

const ENV = unitEnv(DATA_SERVICE);

describe("diaria-gdrive-data-bisync — units (#12478)", () => {
  it("remote e pasta local são a pasta de data/ na raiz do Drive", () => {
    assert.equal(ENV.GDRIVE_REMOTE, `gdrive:${DATA_DIR_NAME_IN_DRIVE}`);
    assert.equal(ENV.GDRIVE_LOCAL, `/mnt/hd-sata/GoogleDrive/${DATA_DIR_NAME_IN_DRIVE}`);
  });

  it("é exatamente a pasta que o filtro do Drive inteiro exclui", () => {
    const folder = ENV.GDRIVE_REMOTE.replace(/^gdrive:/, "");
    assert.equal(GDRIVE_FULL_DRIVE_DATA_EXCLUSION, `- /${folder}/**`);
    const full = readFileSync(join(SYSTEMD, "gdrive-bisync-filters.txt"), "utf8").split(/\r?\n/);
    assert.ok(full.includes(`- /${folder}/**`));
    // a unit grande segue no Drive inteiro, sem env de remote/pasta
    assert.equal(unitEnv(FULL_SERVICE).GDRIVE_REMOTE, undefined);
    assert.equal(unitEnv(FULL_SERVICE).GDRIVE_LOCAL, undefined);
  });

  it("filtro próprio, versionado no checkout do 300", () => {
    assert.equal(ENV.GDRIVE_FILTERS, "/home/vjpixel/diaria-studio/scripts/systemd/gdrive-data-bisync-filters.txt");
    assert.ok(existsSync(join(SYSTEMD, "gdrive-data-bisync-filters.txt")));
  });

  it("state dir próprio (o .md5 do filtro e os carimbos não se misturam com os do bisync grande)", () => {
    assert.equal(ENV.GDRIVE_STATE_DIR, "%h/.cache/diaria/gdrive-data-bisync");
    assert.notEqual(ENV.GDRIVE_STATE_DIR, "%h/.cache/diaria/gdrive-bisync");
  });

  it("mesmo script e mesma ordenação de mount do bisync grande", () => {
    assert.equal(directive(DATA_SERVICE, "ExecStart"), directive(FULL_SERVICE, "ExecStart"));
    assert.equal(directive(DATA_SERVICE, "RequiresMountsFor"), "/mnt/hd-sata");
    assert.equal(directive(DATA_SERVICE, "Type"), "oneshot");
  });

  it("timer: 1 min depois do fim da rodada anterior (o grande é 2 min), armável em timers.target", () => {
    assert.equal(directive(DATA_TIMER, "OnUnitInactiveSec"), "1min");
    assert.equal(directive(DATA_TIMER, "WantedBy"), "timers.target");
  });
});

function runWithUnitEnv(opts: { sentinelInData: boolean; sentinelAtDriveRoot: boolean }) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-data-bisync-"));
  const driveRoot = join(sb, "GoogleDrive");
  // a pasta local da unit, transplantada pro sandbox
  const local = join(driveRoot, ENV.GDRIVE_LOCAL.split("/").pop()!);
  mkdirSync(local, { recursive: true });
  if (opts.sentinelInData) writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  if (opts.sentinelAtDriveRoot) writeFileSync(join(driveRoot, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state-data");
  const log = join(sb, "rclone.log");
  const fakeRclone = join(sb, "rclone");
  writeFileSync(fakeRclone, `#!/bin/sh\necho "$@" > "${log}"\n`);
  chmodSync(fakeRclone, 0o755);
  const r = spawnSync("/bin/sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_MOUNTPOINT_CMD: "true",
      RCLONE_BIN: fakeRclone,
      GDRIVE_REMOTE: ENV.GDRIVE_REMOTE,
      GDRIVE_LOCAL: local,
      // o arquivo real do repo (o da unit aponta pro checkout do 300)
      GDRIVE_FILTERS: join(SYSTEMD, "gdrive-data-bisync-filters.txt"),
      GDRIVE_STATE_DIR: stateDir,
    },
  });
  const out = {
    status: r.status,
    stderr: r.stderr,
    called: existsSync(log),
    args: existsSync(log) ? readFileSync(log, "utf8") : "",
    local,
    installed: existsSync(join(stateDir, "filters.txt")) ? readFileSync(join(stateDir, "filters.txt"), "utf8") : null,
    lastRun: existsSync(join(stateDir, "last-run.json")),
  };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

describe("gdrive-bisync.sh com o env da unit de data/ (#12478)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("bisync de gdrive:diaria-studio-data com a pasta local, o filtro de data/ e carimbos no state dir próprio", () => {
    const r = runWithUnitEnv({ sentinelInData: true, sentinelAtDriveRoot: false });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.args.startsWith(`bisync gdrive:${DATA_DIR_NAME_IN_DRIVE} ${r.local} `), r.args);
    assert.match(r.args, /--check-access --check-filename \.diaria-bisync-sentinel/);
    assert.match(r.args, /--filters-file \S+\/state-data\/filters\.txt/);
    assert.equal(r.installed, readFileSync(join(SYSTEMD, "gdrive-data-bisync-filters.txt"), "utf8"));
    assert.ok(r.lastRun);
  });

  it("sentinela só na raiz do Drive (a do bisync grande) não basta: exit 75 e o rclone nunca é chamado", () => {
    const r = runWithUnitEnv({ sentinelInData: false, sentinelAtDriveRoot: true });
    assert.equal(r.status, 75);
    assert.equal(r.called, false);
    assert.match(r.stderr, /sentinela/);
  });
});
