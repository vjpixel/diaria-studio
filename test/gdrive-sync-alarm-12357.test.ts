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
  bisyncStampReadFromText,
  STAMP_FUTURE_TOLERANCE_MS,
  DEFAULT_GDRIVE_SYNC_TOLERANCES,
  type BisyncStamp,
} from "../scripts/lib/gdrive-sync-alarm.ts";
import {
  parseRcloneAboutJson,
  evaluateGdriveQuota,
  readRcloneAbout,
  readRcloneAboutDetailed,
  resolveRcloneBin,
  buildGdriveQuotaCauseText,
} from "../scripts/lib/gdrive-quota.ts";
import {
  toSyncAlarmFinding,
  toQuotaAlarmFinding,
  absenceUnmeasured,
  readBisyncStamp,
  quotaFindingVerdict,
  gdriveAlarmDelivered,
  gdriveAlarmIssuesStatePath,
  backendImpactLine,
  buildGdriveAlarmEmail,
} from "../scripts/gdrive-sync-alarm.ts";
import { alarmIssueStateKey, type AlarmFindingOutcome } from "../scripts/lib/alarm-issues.ts";

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

  it("--dry-run não carimba nada, nem last-run (review da #12357)", () => {
    const r = runBisync({ mounted: true, args: ["--dry-run"] });
    assert.equal(r.status, 0);
    assert.equal(r.lastRun, null);
    assert.equal(r.lastSuccess, null);
  });

  it("--dry-run que trava (75) ou falha também não carimba", () => {
    const blocked = runBisync({ mounted: false, args: ["--dry-run"] });
    assert.equal(blocked.status, 75);
    assert.equal(blocked.lastRun, null);
    const failed = runBisync({ mounted: true, rcloneExit: 3, args: ["-n"] });
    assert.equal(failed.status, 3);
    assert.equal(failed.lastRun, null);
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

  it("readBisyncStamp: só ENOENT é ausente; corrompido é unreadable (nunca vira sucesso nem silêncio)", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-readstamp-"));
    try {
      writeFileSync(join(sb, "last-success.json"), "{nao-json");
      assert.equal(readBisyncStamp(join(sb, "last-success.json")).kind, "unreadable");
      writeFileSync(join(sb, "last-run.json"), JSON.stringify({ at: "ontem", exit: 0 }));
      assert.equal(readBisyncStamp(join(sb, "last-run.json")).kind, "unreadable");
      assert.deepEqual(readBisyncStamp(join(sb, "nao-existe.json")), { kind: "absent" });
      // Diretório no lugar do arquivo (EISDIR): existe e não abre.
      mkdirSync(join(sb, "dir.json"));
      assert.equal(readBisyncStamp(join(sb, "dir.json")).kind, "unreadable");
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

// ─── Review da #12357 (fleet de 5 agentes) ─────────────────────────────────

describe("limiares do alarme: fronteira estrita (review #12357)", () => {
  const T = DEFAULT_GDRIVE_SYNC_TOLERANCES;
  it("trava: exatamente 60 min não alarma, +1 ms alarma", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(T.blockedMs, 0), NOW).verdict, "ok");
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(T.blockedMs + 1, 0), NOW).verdict, "alarm-bisync-blocked");
  });
  it("falha: exatamente 30 min não alarma, +1 ms alarma", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 1), stamp(T.failedMs, 0), NOW).verdict, "ok");
    assert.equal(evaluateGdriveSync(stamp(MIN, 1), stamp(T.failedMs + 1, 0), NOW).verdict, "alarm-bisync-failed");
  });
  it("stale: exatamente 6h não alarma, +1 ms alarma", () => {
    assert.equal(evaluateGdriveSync(stamp(T.staleMs, 0), stamp(T.staleMs, 0), NOW).verdict, "ok");
    assert.equal(evaluateGdriveSync(stamp(T.staleMs + 1, 0), stamp(T.staleMs + 1, 0), NOW).verdict, "alarm-sync-stale");
  });
  it("tolerâncias custom valem nos três limiares", () => {
    const tol = { blockedMs: 5 * MIN, failedMs: 2 * MIN, staleMs: H };
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(5 * MIN, 0), NOW, tol).verdict, "ok");
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(5 * MIN + 1, 0), NOW, tol).verdict, "alarm-bisync-blocked");
    assert.equal(evaluateGdriveSync(stamp(MIN, 9), stamp(2 * MIN + 1, 0), NOW, tol).verdict, "alarm-bisync-failed");
    assert.equal(evaluateGdriveSync(stamp(MIN, 0), stamp(H + 1, 0), NOW, tol).verdict, "alarm-sync-stale");
  });
});

describe("precedência e contratos do veredito (review #12357)", () => {
  it("exit 75 + sucesso há 7h → blocked (a trava é mais específica que o stale)", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), stamp(7 * H, 0), NOW).verdict, "alarm-bisync-blocked");
  });
  it("exit != 0 + sucesso há 7h → failed, não stale", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 2), stamp(7 * H, 0), NOW).verdict, "alarm-bisync-failed");
  });
  it("last-run exit 0 sem nenhum sucesso carimbado → stale (idade infinita)", () => {
    const ev = evaluateGdriveSync(stamp(MIN, 0), null, NOW);
    assert.equal(ev.verdict, "alarm-sync-stale");
    assert.equal(ev.successAgeMs, null);
  });
  it("só last-success (last-run sumiu) NÃO é not-installed: o sucesso decide", () => {
    assert.equal(evaluateGdriveSync(null, stamp(10 * MIN, 0), NOW).verdict, "ok");
    assert.equal(evaluateGdriveSync(null, stamp(7 * H, 0), NOW).verdict, "alarm-sync-stale");
    assert.equal(evaluateGdriveSync({ kind: "absent" }, stamp(7 * H, 0), NOW).verdict, "alarm-sync-stale");
  });
  it("nenhum carimbo (null ou absent) → not-installed", () => {
    assert.equal(evaluateGdriveSync({ kind: "absent" }, { kind: "absent" }, NOW).verdict, "not-installed");
  });
});

describe("carimbo ilegível/inválido alarma (review #12357)", () => {
  it("last-run ilegível com last-success ausente → alarm-stamp-unreadable, nunca not-installed", () => {
    const ev = evaluateGdriveSync(bisyncStampReadFromText("{corrompido"), null, NOW);
    assert.equal(ev.verdict, "alarm-stamp-unreadable");
    assert.equal(isAlarmingGdriveSyncVerdict(ev.verdict), true);
    assert.match(ev.invalidStamps[0]!, /last-run\.json: JSON inválido/);
    assert.match(describeGdriveSyncVerdict(ev), /existem mas não servem/);
  });
  it("EACCES/EISDIR (unreadable vindo do disco) também alarma", () => {
    const ev = evaluateGdriveSync({ kind: "unreadable", reason: "não abre (EACCES)" }, stamp(MIN, 0), NOW);
    assert.equal(ev.verdict, "alarm-stamp-unreadable");
    assert.match(ev.invalidStamps.join(), /EACCES/);
  });
  it("carimbo ilegível precede trava/falha", () => {
    assert.equal(evaluateGdriveSync(stamp(MIN, 75), bisyncStampReadFromText("[]"), NOW).verdict, "alarm-stamp-unreadable");
  });
  it("last-success com exit != 0 é inválido", () => {
    const ev = evaluateGdriveSync(stamp(MIN, 0), stamp(MIN, 1), NOW);
    assert.equal(ev.verdict, "alarm-stamp-unreadable");
    assert.match(ev.invalidStamps[0]!, /last-success\.json: carimbo de sucesso com exit 1/);
  });
  it("at no futuro: dentro da folga conta como idade 0; além da folga é inválido", () => {
    const within = evaluateGdriveSync(stamp(-STAMP_FUTURE_TOLERANCE_MS, 0), stamp(-STAMP_FUTURE_TOLERANCE_MS, 0), NOW);
    assert.equal(within.verdict, "ok");
    assert.equal(within.successAgeMs, 0);
    const beyond = evaluateGdriveSync(stamp(MIN, 0), stamp(-(STAMP_FUTURE_TOLERANCE_MS + 1), 0), NOW);
    assert.equal(beyond.verdict, "alarm-stamp-unreadable");
    assert.match(beyond.invalidStamps[0]!, /no futuro/);
    // Um last-run no futuro distante também: nunca segura o stale por idade negativa.
    assert.equal(evaluateGdriveSync(stamp(-24 * H, 0), stamp(7 * H, 0), NOW).verdict, "alarm-stamp-unreadable");
  });
  it("carimbo ilegível congela os outros achados de sync (não fecham sem medida)", () => {
    const frozen = absenceUnmeasured("alarm-stamp-unreadable", "ok");
    for (const f of ["alarm-bisync-blocked", "alarm-bisync-failed", "alarm-sync-stale"]) {
      assert.equal(frozen(alarmIssueStateKey("gdrive-sync", f)), true, f);
    }
    // O próprio achado de carimbo não fica congelado: fecha quando o carimbo sarar.
    assert.equal(frozen(alarmIssueStateKey("gdrive-sync", "alarm-stamp-unreadable")), false);
    assert.equal(frozen(alarmIssueStateKey("gdrive-quota", "quota-near")), false);
  });
});

describe("absenceUnmeasured: congelamentos independentes (review #12357)", () => {
  it("cota sem medida NÃO congela as chaves de sync", () => {
    const f = absenceUnmeasured("ok", "unmeasured");
    assert.equal(f(alarmIssueStateKey("gdrive-sync", "alarm-bisync-blocked")), false);
    assert.equal(f(alarmIssueStateKey("gdrive-quota", "quota-full")), true);
    // Máquina COM bisync: o quota-unmeasured é emitido, então não congela.
    assert.equal(f(alarmIssueStateKey("gdrive-quota", "quota-unmeasured")), false);
  });
  it("not-installed NÃO congela as chaves de cota medida", () => {
    const f = absenceUnmeasured("not-installed", "ok");
    assert.equal(f(alarmIssueStateKey("gdrive-quota", "quota-near")), false);
    assert.equal(f(alarmIssueStateKey("gdrive-sync", "alarm-stamp-unreadable")), true);
  });
  it("nunca congela chave do alarme do OneDrive (outro check)", () => {
    const f = absenceUnmeasured("not-installed", "unmeasured");
    assert.equal(f(alarmIssueStateKey("onedrive-sync", "alarm-service-dead")), false);
    assert.equal(f(alarmIssueStateKey("onedrive-quota", "quota-near")), false);
  });
});

describe("cota: limites e medida ausente (review #12357)", () => {
  it("`{}` e saída sem campo numérico → unmeasured", () => {
    assert.equal(parseRcloneAboutJson("{}"), null);
    assert.equal(evaluateGdriveQuota(parseRcloneAboutJson("{}")).verdict, "unmeasured");
    assert.equal(evaluateGdriveQuota({ total: null, used: null, trashed: null, other: null, free: null }).verdict, "unmeasured");
  });
  it("sem total: free > 0 → ok; só used/other → unmeasured", () => {
    assert.equal(evaluateGdriveQuota({ total: null, used: 5, trashed: null, other: 1, free: 10 }).verdict, "ok");
    assert.equal(evaluateGdriveQuota({ total: null, used: 5, trashed: null, other: 1, free: null }).verdict, "unmeasured");
  });
  it("limite de aviso inclusivo: 89,99% ok, 90% near; 100% full", () => {
    const at = (consumed: number) => evaluateGdriveQuota({ total: 10_000, used: null, trashed: null, other: null, free: 10_000 - consumed }, 90).verdict;
    assert.equal(at(8_999), "ok");
    assert.equal(at(9_000), "quota-near");
    assert.equal(at(9_999), "quota-near");
    assert.equal(at(10_000), "quota-full");
  });
  it("readRcloneAboutDetailed: erro com mensagem + stderr, logado, nunca descartado", () => {
    const lines: string[] = [];
    const boom = () => {
      throw Object.assign(new Error("Command failed: rclone about gdrive: --json"), {
        stderr: "CRITICAL: Failed to create file system: didn't find section in config file",
      });
    };
    const r = readRcloneAboutDetailed("rclone", "gdrive:", boom, (l) => lines.push(l));
    assert.equal(r.about, null);
    assert.match(r.error!, /Command failed/);
    assert.match(r.error!, /stderr: CRITICAL: Failed to create file system/);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /didn't find section/);
  });
  it("readRcloneAboutDetailed: saída não-JSON também vira erro legível", () => {
    const lines: string[] = [];
    const r = readRcloneAboutDetailed("rclone", "gdrive:", () => "not json", (l) => lines.push(l));
    assert.equal(r.about, null);
    assert.match(r.error!, /não é o JSON esperado: not json/);
    assert.equal(lines.length, 1);
    assert.equal(readRcloneAboutDetailed("rclone", "gdrive:", () => ABOUT_SAMPLE, () => {}).error, null);
  });
  it("quota-unmeasured só vira achado (P3) numa máquina que roda o bisync", () => {
    const unmeasured = evaluateGdriveQuota(null);
    assert.equal(quotaFindingVerdict(unmeasured, "not-installed"), null);
    assert.equal(quotaFindingVerdict(unmeasured, "ok"), "quota-unmeasured");
    assert.equal(quotaFindingVerdict(unmeasured, "alarm-bisync-failed"), "quota-unmeasured");
    assert.equal(quotaFindingVerdict(evaluateGdriveQuota(parseRcloneAboutJson(ABOUT_SAMPLE)), "ok"), null);
    const f = toQuotaAlarmFinding(unmeasured, "token expirado");
    assert.equal(f.fingerprint, "quota-unmeasured");
    assert.equal(f.priority, "P3");
    assert.ok(!f.labels?.includes("alarm-acao"));
    assert.match(f.body, /token expirado/);
  });
  it("e-mail de cota sem medida traz o motivo, não um percentual vazio", () => {
    const outcome = { check: "gdrive-quota", fingerprint: "quota-unmeasured", action: "created", issueNumber: 9, url: "u" } as unknown as AlarmFindingOutcome;
    const mail = buildGdriveAlarmEmail([outcome], evaluateGdriveSync(stamp(MIN, 0), stamp(MIN, 0), NOW), evaluateGdriveQuota(null), "rede fora");
    assert.match(mail.subject, /cota quota-unmeasured/);
    assert.match(mail.body, /rede fora/);
  });
});

describe("prioridade por backend e link quebrado pro Drive (review #12357)", () => {
  const ev = evaluateGdriveSync(stamp(MIN, 75), stamp(2 * H, 0), NOW);
  it("gdrive-unreachable é P1 e o texto diz que o data/ está fora do ar", () => {
    const f = toSyncAlarmFinding(ev, "gdrive-unreachable");
    assert.equal(f.priority, "P1");
    assert.match(f.body, /aponta para o Google Drive, mas o alvo NÃO resolve/);
    assert.doesNotMatch(f.body, /ainda não está no Google Drive/);
  });
  it("absent/unsynced/onedrive seguem P2", () => {
    for (const b of ["absent", "unsynced", "onedrive"] as const) {
      assert.equal(toSyncAlarmFinding(ev, b).priority, "P2", b);
      assert.match(backendImpactLine(b), /ainda não está no Google Drive/);
    }
  });
  it("texto da trava: sentinela LOCAL; a do Drive cai no --check-access (falha)", () => {
    assert.match(describeGdriveSyncVerdict(ev), /sentinela LOCAL/);
    assert.match(describeGdriveSyncVerdict(evaluateGdriveSync(stamp(MIN, 2), stamp(2 * H, 0), NOW)), /sentinela ausente do lado do Drive/);
  });
});

describe("entrega e estado do alarme (review #12357)", () => {
  const o = (action: string) => ({ check: "gdrive-sync", fingerprint: "x", action, error: "boom" }) as unknown as AlarmFindingOutcome;
  it("exit 1 só quando havia achado e nenhum canal entregou", () => {
    assert.equal(gdriveAlarmDelivered([], { emailSent: false }), true);
    assert.equal(gdriveAlarmDelivered([o("failed")], { emailSent: false }), false);
    assert.equal(gdriveAlarmDelivered([o("failed"), o("failed")], { emailSent: true }), true);
    assert.equal(gdriveAlarmDelivered([o("failed"), o("reused")], { emailSent: false }), true);
  });
  it("estado das issues fica sempre no state dir, nunca em data/", () => {
    assert.equal(gdriveAlarmIssuesStatePath("/home/x/.cache/diaria/gdrive-bisync"), join("/home/x/.cache/diaria/gdrive-bisync", ".gdrive-sync-alarm-issues.json"));
    const src = readFileSync(join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "utf8");
    assert.doesNotMatch(src, /DATA_DIR/);
  });
});

describe("CLI --dry-run com carimbo corrompido (review #12357)", { skip: process.platform === "win32" ? "rclone falso é shell" : false }, () => {
  it("last-run.json corrompido alarma (antes: not-installed silencioso) e não escreve estado em data/", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-cli-unreadable-12357-"));
    try {
      const state = join(sb, "state");
      mkdirSync(state);
      writeFileSync(join(state, "last-run.json"), "{corrompido");
      const fake = join(sb, "rclone");
      writeFileSync(fake, `#!/bin/sh\necho "CRITICAL: didn't find section" >&2\nexit 1\n`);
      chmodSync(fake, 0o755);
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "gdrive-sync-alarm.ts"), "--dry-run", "--state-dir", state], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, RCLONE_BIN: fake },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /verdict=alarm-stamp-unreadable/);
      assert.match(r.stdout, /cota: verdict=unmeasured .*erro=.*didn't find section/);
      // sync ilegível + cota sem medida numa máquina com carimbo = 2 achados
      assert.match(r.stdout, /--dry-run: 2 ação/);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
