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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "systemd", "gdrive-bisync.sh");

function run(opts: {
  mounted: boolean;
  sentinel: boolean;
  filters?: boolean;
  args?: string[];
  /** Conteúdo do filtro do checkout (GDRIVE_FILTERS); sem ele, o arquivo real do repo. */
  srcFilters?: string;
  /** Filtro já instalado em `$STATE_DIR/filters.txt` antes da rodada (#12396). */
  installed?: string;
  /** Torna o state dir somente-leitura antes da rodada (simula `cp` que falha). */
  readOnlyState?: boolean;
}) {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-bisync-"));
  const local = join(sb, "GoogleDrive");
  mkdirSync(local);
  if (opts.sentinel) writeFileSync(join(local, ".diaria-bisync-sentinel"), "");
  const stateDir = join(sb, "state");
  if (opts.installed !== undefined) {
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "filters.txt"), opts.installed);
  }
  if (opts.readOnlyState) {
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o555);
  }
  let srcFiltersPath: string | undefined;
  if (opts.srcFilters !== undefined) {
    srcFiltersPath = join(sb, "checkout-filters.txt");
    writeFileSync(srcFiltersPath, opts.srcFilters);
  }
  const log = join(sb, "rclone.log");
  const fakeRclone = join(sb, "rclone");
  writeFileSync(fakeRclone, `#!/bin/sh\necho "$@" > "${log}"\n`);
  chmodSync(fakeRclone, 0o755);
  const r = spawnSync("/bin/sh", [SCRIPT, ...(opts.args ?? [])], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb,
      GDRIVE_MOUNT: sb,
      GDRIVE_LOCAL: local,
      RCLONE_BIN: fakeRclone,
      GDRIVE_MOUNTPOINT_CMD: opts.mounted ? "true" : "false",
      GDRIVE_STATE_DIR: stateDir,
      ...(opts.filters === false ? { GDRIVE_FILTERS: join(sb, "nao-existe.txt") } : {}),
      ...(srcFiltersPath ? { GDRIVE_FILTERS: srcFiltersPath } : {}),
    },
  });
  const args = existsSync(log) ? readFileSync(log, "utf8") : "";
  const usedPath = /--filters-file (\S+)/.exec(args)?.[1];
  const installedPath = join(stateDir, "filters.txt");
  const out = {
    status: r.status,
    stderr: r.stderr,
    called: existsSync(log),
    args,
    filtersCopied: existsSync(installedPath),
    installed: existsSync(installedPath) ? readFileSync(installedPath, "utf8") : null,
    usedFilters: usedPath && existsSync(usedPath) ? readFileSync(usedPath, "utf8") : null,
  };
  if (opts.readOnlyState) chmodSync(stateDir, 0o755);
  rmSync(sb, { recursive: true, force: true });
  return out;
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

  it("arquivo de filtros ausente → exit 75 e o rclone nunca é chamado", () => {
    const r = run({ mounted: true, sentinel: true, filters: false });
    assert.equal(r.status, 75);
    assert.equal(r.called, false);
  });

  it("montado + sentinela → bisync com --check-access, --max-delete e filtros fora do checkout", () => {
    const r = run({ mounted: true, sentinel: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.args, /^bisync gdrive: /);
    assert.match(r.args, /--check-access --check-filename \.diaria-bisync-sentinel/);
    assert.match(r.args, /--max-delete 5/);
    assert.match(r.args, /--drive-skip-gdocs/);
    assert.match(r.args, /--resilient --recover/);
    // o .md5 do bisync nasce ao lado dos filtros: eles precisam estar no state dir, nunca no repo
    assert.match(r.args, /--filters-file \S+\/state\/filters\.txt/);
    assert.ok(r.filtersCopied);
  });

  it("argumentos extras (--resync/--force) chegam ao rclone", () => {
    const r = run({ mounted: true, sentinel: true, args: ["--resync"] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.args, /--resync\s*$/);
  });

  // #12396: o filtro instalado só muda numa rodada --resync real. Antes, o
  // script recopiava o filtro do checkout compartilhado a cada rodada, e uma
  // troca de branch (ou o merge de uma PR em DATA_LOCAL_ONLY_PATTERNS) travava
  // o bisync até alguém rodar --resync no Drive inteiro.
  describe("filtro instalado só muda no --resync (#12396)", () => {
    it("rodada sem --resync, checkout diferente do instalado → instalado não muda, rclone usa o instalado, aviso no log", () => {
      const r = run({ mounted: true, sentinel: true, installed: "- velho\n", srcFilters: "- novo\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.installed, "- velho\n");
      assert.equal(r.usedFilters, "- velho\n");
      assert.match(r.args, /--filters-file \S+\/state\/filters\.txt/);
      assert.match(r.stderr, /difere do filtro instalado/);
    });

    it("--dry-run sem --resync também não troca o instalado", () => {
      const r = run({ mounted: true, sentinel: true, installed: "- velho\n", srcFilters: "- novo\n", args: ["--dry-run"] });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.installed, "- velho\n");
      assert.equal(r.usedFilters, "- velho\n");
    });

    it("--resync instala o filtro do checkout e o rclone roda com ele", () => {
      const r = run({ mounted: true, sentinel: true, installed: "- velho\n", srcFilters: "- novo\n", args: ["--resync"] });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.installed, "- novo\n");
      assert.equal(r.usedFilters, "- novo\n");
    });

    it("--resync --dry-run pré-visualiza com o filtro novo numa cópia à parte, sem tocar o instalado", () => {
      const r = run({ mounted: true, sentinel: true, installed: "- velho\n", srcFilters: "- novo\n", args: ["--resync", "--dry-run"] });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.installed, "- velho\n");
      assert.equal(r.usedFilters, "- novo\n");
      assert.match(r.args, /filters\.dry-run\.txt/);
    });

    it("filtros iguais → nenhum aviso", () => {
      const r = run({ mounted: true, sentinel: true, installed: "- igual\n", srcFilters: "- igual\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /difere/);
    });

    it("sem filtro instalado (1ª rodada) → instala", () => {
      const r = run({ mounted: true, sentinel: true, srcFilters: "- novo\n" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.installed, "- novo\n");
    });

    it("cp do filtro falha → exit 75 e o rclone nunca é chamado", { skip: process.getuid?.() === 0 ? "root ignora permissão" : false }, () => {
      const r = run({ mounted: true, sentinel: true, srcFilters: "- novo\n", readOnlyState: true, args: ["--resync"] });
      assert.equal(r.status, 75);
      assert.equal(r.called, false);
      assert.match(r.stderr, /falha ao instalar o filtro/);
    });
  });

  it("filtros excluem WAL/SHM de SQLite (#12357)", () => {
    const f = readFileSync(join(ROOT, "scripts", "systemd", "gdrive-bisync-filters.txt"), "utf8");
    for (const pat of ["*.db-wal", "*.db-shm", "*.sqlite3-wal", "*.sqlite3-shm"]) assert.ok(f.includes(`- ${pat}`), pat);
  });
});
