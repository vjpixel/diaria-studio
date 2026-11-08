/**
 * test/gdrive-sync-alarm-12357.test.ts (#12357, épica #12353)
 *
 * Alarme do `rclone bisync` do Google Drive: carimbos gravados pelo
 * `scripts/systemd/gdrive-bisync.sh` (rclone falso, nunca toca o remote),
 * veredito puro (trava persistente, falha persistente, sem sucesso há tempo
 * demais, não instalado), cota via `rclone about --json` e o CLI em
 * `--dry-run` (sem gh, sem e-mail).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseBisyncStamp,
  evaluateGdriveSync,
  isAlarmingGdriveSyncVerdict,
  describeGdriveSyncVerdict,
  type BisyncStamp,
} from "../scripts/lib/gdrive-sync-alarm.ts";
import {
  parseRcloneAboutJson,
  evaluateGdriveQuota,
  readRcloneAbout,
  resolveRcloneBin,
  buildGdriveQuotaCauseText,
} from "../scripts/lib/gdrive-quota.ts";
import { toSyncAlarmFinding, toQuotaAlarmFinding, absenceUnmeasured, readBisyncStamp } from "../scripts/gdrive-sync-alarm.ts";
import { alarmIssueStateKey } from "../scripts/lib/alarm-issues.ts";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");

function runBisync(opts: { mounted: boolean; rcloneExit?: number; args?: string[] }) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-stamp-12357-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const log = join(sb, "rclone.log");
  const fake = join(sb, "rclone");
  writeFileSync(fake, `#!/bin/sh\necho "$@" > "${log}"\nexit ${opts.rcloneExit ?? 0}\n`);
  chmodSync(fake, 0o755);
  const state = join(sb, "state");
  const r = spawnSync("/bin/sh", [SCRIPT, ...(opts.args ?? [])], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fake,
      GDRIVE_MOUNTPOINT_CMD: opts.mounted ? "true" : "false",
      GDRIVE_STATE_DIR: state,
    },
  });
  const read = (n: string) => (existsSync(join(state, n)) ? JSON.parse(readFileSync(join(state, n), "utf8")) : null);
  const out = { status: r.status, args: existsSync(log) ? readFileSync(log, "utf8") : "", lastRun: read("last-run.json"), lastSuccess: read("last-success.json") };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

describe("gdrive-bisync.sh — carimbos pro alarme (#12357)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("rodada OK carimba last-run (exit 0) e last-success", () => {
    const r = runBisync({ mounted: true });
    assert.equal(r.status, 0);
    assert.equal(r.lastRun?.exit, 0);
    assert.ok(parseBisyncStamp(r.lastRun));
    assert.equal(r.lastSuccess?.exit, 0);
  });

  it("trava (HD desmontado) carimba last-run exit 75 e NÃO carimba sucesso", () => {
    const r = runBisync({ mounted: false });
    assert.equal(r.status, 75);
    assert.equal(r.lastRun?.exit, 75);
    assert.equal(r.lastSuccess, null);
  });

  it("falha do rclone preserva o exit code e não carimba sucesso", () => {
    const r = runBisync({ mounted: true, rcloneExit: 7 });
    assert.equal(r.status, 7);
    assert.equal(r.lastRun?.exit, 7);
    assert.equal(r.lastSuccess, null);
  });

  it("--dry-run não conta como sucesso", () => {
    const r = runBisync({ mounted: true, args: ["--dry-run"] });
    assert.equal(r.status, 0);
    assert.equal(r.lastRun?.exit, 0);
    assert.equal(r.lastSuccess, null);
  });

  it("passa --ignore-case (paridade com o skip_file do OneDrive)", () => {
    assert.match(runBisync({ mounted: true }).args, /--filters-file \S+ --ignore-case/);
  });
});

const NOW = new Date("2026-11-08T12:00:00Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const stamp = (msAgo: number, exit: number): BisyncStamp => ({ at: ago(msAgo), exit });
const MIN = 60_000;
const H = 60 * MIN;

describe("evaluateGdriveSync (#12357)", () => {
  it("sem last-run = not-installed, silencioso", () => {
    const ev = evaluateGdriveSync(null, null, NOW);
    assert.equal(ev.verdict, "not-installed");
    assert.equal(isAlarmingGdriveSyncVerdict(ev.verdict), false);
  });

  it("rodando bem = ok", () => {
    assert.equal(evaluateGdriveSync(stamp(2 * MIN, 0), stamp(2 * MIN, 0), NOW).verdict, "ok");
  });

  it("trava (75) curta não alarma; persistente além de 1h alarma", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(20 * MIN, 0), NOW).verdict, "ok");
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(61 * MIN, 0), NOW).verdict, "alarm-bisync-blocked");
  });

  it("falha (exit != 0, != 75) persistente além de 30 min alarma", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 2), stamp(10 * MIN, 0), NOW).verdict, "ok");
    assert.equal(evaluateGdriveSync(stamp(MIN, 2), stamp(31 * MIN, 0), NOW).verdict, "alarm-bisync-failed");
  });

  it("nunca houve sucesso carimbado + rodada travada/falhando = alarma na hora", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), null, NOW).verdict, "alarm-bisync-blocked");
    assert.equal(evaluateGdriveSync(stamp(MIN, 1), null, NOW).verdict, "alarm-bisync-failed");
  });

  it("sem sucesso há mais de 6h, mesmo com última rodada exit 0 (timer parado) = stale", () => {
    assert.equal(evaluateGdriveSync(stamp(7 * H, 0), stamp(7 * H, 0), NOW).verdict, "alarm-sync-stale");
  });

  it("descrição traz o passo que resolve", () => {
    const ev = evaluateGdriveSync(stamp(MIN, 75), stamp(2 * H, 0), NOW);
    assert.match(describeGdriveSyncVerdict(ev), /mountpoint \/mnt\/hd-sata/);
  });

  it("carimbo inválido é tratado como ausente", () => {
    assert.equal(parseBisyncStamp({ at: "ontem", exit: 0 }), null);
    assert.equal(parseBisyncStamp({ at: NOW.toISOString(), exit: "0" }), null);
    assert.equal(parseBisyncStamp([]), null);
  });

  it("readBisyncStamp: arquivo corrompido → null (nunca vira sucesso)", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-readstamp-"));
    try {
      writeFileSync(join(sb, "last-success.json"), "{nao-json");
      assert.equal(readBisyncStamp(join(sb, "last-success.json")), null);
      assert.equal(readBisyncStamp(join(sb, "nao-existe.json")), null);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});

describe("achados e congelamento (#12357)", () => {
  it("P1 quando data/ já está no Drive, P2 antes; trava/falha pedem ação", () => {
    const ev = evaluateGdriveSync(stamp(MIN, 75), stamp(2 * H, 0), NOW);
    const onDrive = toSyncAlarmFinding(ev, "gdrive");
    assert.equal(onDrive.priority, "P1");
    assert.ok(onDrive.labels?.includes("alarm-acao"));
    assert.equal(toSyncAlarmFinding(ev, "onedrive").priority, "P2");
    const stale = toSyncAlarmFinding(evaluateGdriveSync(stamp(7 * H, 0), stamp(7 * H, 0), NOW), "onedrive");
    assert.ok(!stale.labels?.includes("alarm-acao"));
    assert.equal(stale.fingerprint, "alarm-sync-stale");
  });

  it("not-installed e cota unmeasured congelam as issues abertas (não fecham por falta de medida)", () => {
    const frozen = absenceUnmeasured("not-installed", "unmeasured");
    assert.equal(frozen(alarmIssueStateKey("gdrive-sync", "alarm-bisync-blocked")), true);
    assert.equal(frozen(alarmIssueStateKey("gdrive-quota", "quota-near")), true);
    const live = absenceUnmeasured("ok", "ok");
    assert.equal(live(alarmIssueStateKey("gdrive-sync", "alarm-bisync-blocked")), false);
  });
});

// Saída real do `rclone about gdrive: --json` no 300 (08/11/2026).
const ABOUT_SAMPLE = `{
	"total": 429496729600,
	"used": 174606077777,
	"trashed": 1667219855,
	"other": 173457514248,
	"free": 81433137575
}`;

describe("cota do Google Drive (#12357)", () => {
  it("parse da saída real e consumo = total - free (Gmail/Fotos contam)", () => {
    const about = parseRcloneAboutJson(ABOUT_SAMPLE);
    assert.ok(about);
    const ev = evaluateGdriveQuota(about, 90);
    assert.equal(ev.verdict, "ok");
    assert.equal(ev.consumedBytes, 429496729600 - 81433137575);
    assert.ok(ev.usedPct! > 80 && ev.usedPct! < 82);
    assert.equal(evaluateGdriveQuota(about, 80).verdict, "quota-near");
  });

  it("free zerado = quota-full; sem medida = unmeasured", () => {
    assert.equal(evaluateGdriveQuota({ total: 100, used: 60, trashed: 0, other: 40, free: 0 }).verdict, "quota-full");
    assert.equal(evaluateGdriveQuota(null).verdict, "unmeasured");
    assert.equal(parseRcloneAboutJson("CRITICAL: didn't find section"), null);
    assert.equal(parseRcloneAboutJson("[]"), null);
  });

  it("texto da causa cita lixeira e resto da conta", () => {
    const text = buildGdriveQuotaCauseText(evaluateGdriveQuota(parseRcloneAboutJson(ABOUT_SAMPLE), 80));
    assert.match(text, /lixeira do Drive/);
    assert.match(text, /Gmail, Fotos/);
  });

  it("fail-soft: rclone ausente / remote inexistente → null", () => {
    const boom = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    assert.equal(readRcloneAbout("/nao/existe/rclone", "gdrive:", boom), null);
    assert.equal(readRcloneAbout("rclone", "gdrive:", () => ABOUT_SAMPLE)?.free, 81433137575);
  });

  it("binário: RCLONE_BIN vence o default ~/.local/bin/rclone", () => {
    assert.equal(resolveRcloneBin({ RCLONE_BIN: "/x/rclone" }), "/x/rclone");
    assert.match(resolveRcloneBin({}), /\.local[/\\]bin[/\\]rclone$/);
  });

  it("achado de cota: full é P1, near é P2", () => {
    const full = evaluateGdriveQuota({ total: 100, used: 60, trashed: 0, other: 40, free: 0 });
    assert.equal(toQuotaAlarmFinding(full).priority, "P1");
    assert.equal(toQuotaAlarmFinding(evaluateGdriveQuota(parseRcloneAboutJson(ABOUT_SAMPLE), 80)).priority, "P2");
  });
});

describe("CLI --dry-run (#12357)", { skip: process.platform === "win32" ? "rclone falso é shell" : false }, () => {
  it("trava persistente vira 1 ação de issue; nada de gh nem e-mail", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-cli-12357-"));
    try {
      const state = join(sb, "state");
      mkdirSync(state);
      writeFileSync(join(state, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), exit: 75 }));
      writeFileSync(join(state, "last-success.json"), JSON.stringify({ at: new Date(Date.now() - 3 * H).toISOString(), exit: 0 }));
      const fake = join(sb, "rclone");
      writeFileSync(fake, `#!/bin/sh\necho '${ABOUT_SAMPLE.replace(/\s+/g, "")}'\n`);
      chmodSync(fake, 0o755);
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", state], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, RCLONE_BIN: fake },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /verdict=alarm-bisync-blocked/);
      assert.match(r.stdout, /cota: verdict=ok/);
      assert.match(r.stdout, /--dry-run: 1 ação/);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
