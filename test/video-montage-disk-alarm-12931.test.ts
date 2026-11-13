/**
 * test/video-montage-disk-alarm-12931.test.ts (#12931)
 *
 * Em 12/11/2026 o `check-video-env.ts --montagem` reprovou o 300 por disco
 * (15,2 GB livres, precisa 25 GB), e isso só apareceu na hora de montar o
 * vídeo, com uma correção genérica ("liberar espaço"). Trava:
 *   - o alarme diário mede contra o MESMO piso do check (25 GB sem bruto);
 *   - a issue do alarme e o item `disk` do check dizem o que liberar;
 *   - o alarme está registrado como task agendada;
 *   - o script do alarme sai com erro (nunca "ok") quando a raiz do cache é
 *     inválida (HD desmontado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateMontageDisk, montageDiskFindings, VIDEO_MONTAGE_DISK_ALARM_FINDING_KEY } from "../scripts/lib/diaria/video-montage-disk-alarm.ts";
import { assessMontageEnv, MONTAGE_DISK_FIX, requiredFreeBytes, type MontageEnvProbes } from "../scripts/lib/diaria/video-montage-env.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = join(import.meta.dirname, "..");
const GB = 1e9;

describe("alarme de disco da montagem (#12931)", () => {
  it("cenário da issue: 15,2 GB livres → dispara contra o piso de 25 GB do check", () => {
    const ev = evaluateMontageDisk(15.2 * GB);
    assert.equal(ev.requiredBytes, requiredFreeBytes(null));
    assert.equal(ev.triggered, true);
    const [f] = montageDiskFindings(ev, "/home/x/.cache/diaria-video-montagem", 2);
    assert.equal(f.fingerprint, VIDEO_MONTAGE_DISK_ALARM_FINDING_KEY);
    assert.equal(f.family, "estado");
    assert.match(f.title, /15\.2 GB livres.*precisa 25\.0 GB/);
    assert.ok(f.body.includes(MONTAGE_DISK_FIX));
  });

  it("no piso ou acima → não dispara, nenhum achado", () => {
    for (const free of [25 * GB, 80 * GB]) {
      const ev = evaluateMontageDisk(free);
      assert.equal(ev.triggered, false);
      assert.deepEqual(montageDiskFindings(ev, "/c", 2), []);
    }
  });

  it("leitura impossível nunca vira ok nem achado", () => {
    for (const bad of [null, Number.NaN, -1]) {
      const ev = evaluateMontageDisk(bad);
      assert.equal(ev.unreadable, true);
      assert.equal(ev.triggered, false);
    }
  });

  it("a correção do item disk do check lista o que liberar (worktrees, cache da montagem, npm)", () => {
    const ok = { ok: true };
    const probes: MontageEnvProbes = { ffmpeg: ok, python: ok, model: ok, opencv: ok, drive: ok, disk: { ok: false, detail: "15.2 GB livres" } };
    const r = assessMontageEnv(probes, "linux", { python: "python", from: "path" });
    const disk = r.items.find((i) => i.id === "disk");
    assert.equal(disk?.fix, MONTAGE_DISK_FIX);
    for (const cmd of ["cleanup-merged-worktrees.ts --dry-run", "prune-video-montage-cache.ts", "npm cache clean"]) {
      assert.ok(MONTAGE_DISK_FIX.includes(cmd), cmd);
    }
  });

  it("registrado como task diária, habilitada, rodando o script do alarme", () => {
    const t = getScheduledTaskByName("Diaria-Video-Montage-Disk-Alarm");
    assert.ok(t, "task registrada");
    assert.equal(t?.schedule.kind, "daily");
    assert.notEqual(t?.enabled, false);
    assert.deepEqual(t?.steps.map((s) => s.script), ["scripts/video-montage-disk-alarm.ts"]);
  });

  it("DIARIA_VIDEO_CACHE_DIR para diretório inexistente (HD desmontado) → exit 1, nunca ok", { skip: process.platform === "win32" ? "POSIX" : false }, () => {
    const sb = mkdtempSync(join(tmpdir(), "vm-disk-alarm-"));
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "video-montage-disk-alarm.ts"), "--dry-run"], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, HOME: sb, DIARIA_VIDEO_CACHE_DIR: join(sb, "hd-desmontado", "cache") },
        timeout: 60_000,
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /DIARIA_VIDEO_CACHE_DIR/);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });

  it("--dry-run com raiz válida mede e não chama gh", { skip: process.platform === "win32" ? "POSIX" : false }, () => {
    const sb = mkdtempSync(join(tmpdir(), "vm-disk-alarm-"));
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "video-montage-disk-alarm.ts"), "--dry-run", "--cache-dir", sb], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, HOME: sb, DIARIA_VIDEO_CACHE_DIR: "" },
        timeout: 60_000,
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /piso=25\.0GB/);
      assert.match(r.stdout, /--dry-run/);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
