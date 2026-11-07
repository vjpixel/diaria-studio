/**
 * test/gdrive-bisync-12356.test.ts (#12356, épica #12353)
 *
 * Regressão da trava contra pasta vazia do `scripts/systemd/gdrive-bisync.sh`:
 * com o HD desmontado ou sem o arquivo-sentinela, o script NUNCA pode chegar
 * ao `rclone bisync` (senão a pasta vazia vira "tudo apagado" na nuvem).
 * Roda o script real com um `rclone` falso que só grava a invocação, e um
 * `mountpoint` falso controlado por env. Nunca toca o remote real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");

function run(opts: { mounted: boolean; sentinel: boolean }) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  if (opts.sentinel) writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
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
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fakeRclone,
      GDRIVE_MOUNTPOINT_CMD: opts.mounted ? "true" : "false",
    },
  });
  return { status: r.status, stderr: r.stderr, called: existsSync(log), args: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("gdrive-bisync.sh — trava contra pasta vazia (#12356)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("HD desmontado → exit 75 e o rclone nunca é chamado", () => {
    const r = run({ mounted: false, sentinel: true });
    assert.equal(r.status, 75);
    assert.equal(r.called, false);
    assert.match(r.stderr, /nao esta montado/);
  });

  it("sentinela ausente → exit 75 e o rclone nunca é chamado", () => {
    const r = run({ mounted: true, sentinel: false });
    assert.equal(r.status, 75);
    assert.equal(r.called, false);
    assert.match(r.stderr, /sentinela/);
  });

  it("montado + sentinela → bisync com --check-access, --max-delete e filtros", () => {
    const r = run({ mounted: true, sentinel: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.args, /^bisync gdrive: /);
    assert.match(r.args, /--check-access --check-filename \.diaria-bisync-sentinel/);
    assert.match(r.args, /--max-delete 5/);
    assert.match(r.args, /--filters-file \S+gdrive-bisync-filters\.txt/);
  });

  it("a unit exige o HD montado (RequiresMountsFor)", () => {
    const unit = readFileSync(join(ROOT, "scripts", "systemd", "diaria-gdrive-bisync.service"), "utf8");
    assert.match(unit, /^RequiresMountsFor=\/mnt\/hd-sata$/m);
  });

  it("filtros excluem WAL/SHM de SQLite (#12357)", () => {
    const f = readFileSync(join(ROOT, "scripts", "systemd", "gdrive-bisync-filters.txt"), "utf8");
    for (const pat of ["*.db-wal", "*.db-shm", "*.sqlite3-wal", "*.sqlite3-shm"]) assert.ok(f.includes(`- ${pat}`), pat);
  });
});
