/**
 * test/gdrive-bisync-resync-filter-13688.test.ts (#13688)
 *
 * Regressão: o `--resync` de `scripts/systemd/gdrive-bisync.sh` instala o
 * filtro do checkout em `$STATE_DIR/filters.txt` antes de chamar o rclone.
 * Se o resync falhava (lock de outra rodada, 401, rede), o filtro novo ficava
 * instalado sem o estado do bisync (`filters.txt.md5`, listagens) que o
 * acompanha, e o timer passava a sair 7 com "filters changed, must --resync".
 * Agora o par anterior (filtro + `.md5`) volta quando o resync não sai 0.
 *
 * Roda o script real com um `rclone` falso (exit configurável, grava o `.md5`
 * como o bisync faria) num tmp dir. Nunca toca o remote real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");

function run(opts: {
  rcloneExit: number;
  /** Exit do rclone só na pré-checagem `--dry-run` do --force. */
  dryRunExit?: number;
  /** `.md5` já gravado pelo bisync antes da rodada; undefined = não existe. */
  md5Before?: string;
  args: string[];
}) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-13688-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state");
  mkdirSync(stateDir);
  const installed = join(stateDir, "filters.txt");
  writeFileSync(installed, "- velho\n");
  if (opts.md5Before !== undefined) writeFileSync(`${installed}.md5`, opts.md5Before);
  const src = join(sb, "checkout-filters.txt");
  writeFileSync(src, "- novo\n");
  const log = join(sb, "rclone.log");
  const fakeRclone = join(sb, "rclone");
  // Como o bisync real no --resync: grava o hash do filtro em `{filtro}.md5`
  // (antes de a rodada falhar ou não), depois sai com o exit pedido.
  writeFileSync(
    fakeRclone,
    `#!/bin/sh
echo "$@" >> "${log}"
ff=""; prev=""; dry=0
for a in "$@"; do
  [ "$prev" = "--filters-file" ] && ff="$a"
  [ "$a" = "--dry-run" ] && dry=1
  prev="$a"
done
if [ "$dry" -eq 1 ]; then exit ${opts.dryRunExit ?? 0}; fi
[ -n "$ff" ] && printf 'md5-de-%s\\n' "$(cat "$ff")" > "$ff.md5"
exit ${opts.rcloneExit}
`,
  );
  chmodSync(fakeRclone, 0o755);
  const r = spawnSync("/bin/sh", [SCRIPT, ...opts.args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fakeRclone,
      GDRIVE_MOUNTPOINT_CMD: "true",
      GDRIVE_STATE_DIR: stateDir,
      GDRIVE_FILTERS: src,
      GDRIVE_AUTH_RETRY_DELAY: "0",
    },
  });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const out = {
    status: r.status,
    stderr: r.stderr,
    called: existsSync(log),
    installed: read(installed),
    md5: read(`${installed}.md5`),
    prevLeft: existsSync(`${installed}.prev`) || existsSync(`${installed}.md5.prev`),
  };
  rmSync(sb, { recursive: true, force: true });
  return out;
}

describe("gdrive-bisync.sh — --resync que falha devolve o filtro anterior (#13688)", { skip: process.platform === "win32" ? "script POSIX-only" : false }, () => {
  it("resync sai 1 → filtro instalado e .md5 continuam os antigos", () => {
    const r = run({ rcloneExit: 1, md5Before: "md5-de-- velho\n", args: ["--resync"] });
    assert.equal(r.status, 1);
    assert.equal(r.called, true);
    assert.equal(r.installed, "- velho\n");
    assert.equal(r.md5, "md5-de-- velho\n");
    assert.equal(r.prevLeft, false);
    assert.match(r.stderr, /filtro anterior restaurado/);
  });

  it("resync sai 1 sem .md5 anterior → o .md5 gravado na tentativa some", () => {
    const r = run({ rcloneExit: 1, args: ["--resync"] });
    assert.equal(r.status, 1);
    assert.equal(r.installed, "- velho\n");
    assert.equal(r.md5, null);
    assert.equal(r.prevLeft, false);
  });

  it("resync sai 0 → filtro novo fica, com o .md5 dele, sem sobra de .prev", () => {
    const r = run({ rcloneExit: 0, md5Before: "md5-de-- velho\n", args: ["--resync"] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.installed, "- novo\n");
    assert.equal(r.md5, "md5-de-- novo\n");
    assert.equal(r.prevLeft, false);
  });

  it("--resync --force recusado pela pré-checagem → filtro antigo restaurado", () => {
    const r = run({ rcloneExit: 0, dryRunExit: 1, md5Before: "md5-de-- velho\n", args: ["--resync", "--force"] });
    assert.equal(r.status, 75);
    assert.match(r.stderr, /--force RECUSADO/);
    assert.equal(r.installed, "- velho\n");
    assert.equal(r.md5, "md5-de-- velho\n");
    assert.equal(r.prevLeft, false);
  });

  it("rodada sem --resync que falha não mexe no filtro instalado", () => {
    const r = run({ rcloneExit: 1, md5Before: "md5-de-- velho\n", args: [] });
    assert.equal(r.status, 1);
    assert.equal(r.installed, "- velho\n");
    assert.doesNotMatch(r.stderr, /restaurado/);
  });
});
