/**
 * test/data-sync-exclusions-12357.test.ts (#12357, épica #12353)
 *
 * Paridade entre os dois backends de sync de `data/` na transição
 * OneDrive → Google Drive: os arquivos que ficam locais por máquina saem de
 * UMA lista (`DATA_LOCAL_ONLY_PATTERNS`), que vira o `skip_file` do OneDrive
 * e o bloco gerado do filtro do `rclone bisync`. Se alguém acrescenta um
 * padrão num lado só, um arquivo local-only começa a atravessar máquinas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  DATA_LOCAL_ONLY_PATTERNS,
  renderGdriveDataFilterBlock,
  renderGdriveDataFilterLines,
  extractGdriveDataFilterBlock,
} from "../scripts/lib/data-sync-exclusions.ts";
import { REQUIRED_SKIP_FILE_PATTERNS, planSkipFileConfig } from "../scripts/lib/onedrive-skip-file.ts";

const ROOT = join(import.meta.dirname, "..");
const FILTERS = join(ROOT, "scripts", "systemd", "gdrive-bisync-filters.txt");

describe("data-sync-exclusions — fonte única (#12357)", () => {
  it("o skip_file do OneDrive é a mesma lista", () => {
    assert.deepEqual([...REQUIRED_SKIP_FILE_PATTERNS], [...DATA_LOCAL_ONLY_PATTERNS]);
  });

  it("cobre os padrões da config viva do 300 (#5548) e os do #10957", () => {
    for (const p of ["run-log*.jsonl", "inbox*.md", "drive-cache*.json", "*.mp4", "*safeBackup*", "*.db-wal", "*.db-shm"]) {
      assert.ok(DATA_LOCAL_ONLY_PATTERNS.includes(p), p);
    }
  });

  it("config viva do 300 (17/08/2026) já tem tudo: --apply não muda nada numa máquina no OneDrive", () => {
    const live =
      'sync_dir = "~/OneDrive"\nskip_file = "~*|.~*|*.tmp|*.swp|*.partial|*.db-shm|*.db-wal|*.sqlite3-shm|*.sqlite3-wal|run-log*.jsonl|inbox*.md|drive-cache*.json|*safeBackup*|run-log.jsonl|*.mp4"\n';
    assert.equal(planSkipFileConfig(live).changed, false);
  });

  it("o arquivo de filtros do bisync tem o bloco gerado, idêntico ao render", () => {
    const block = extractGdriveDataFilterBlock(readFileSync(FILTERS, "utf8"));
    assert.ok(block, "marcadores BEGIN/END ausentes em gdrive-bisync-filters.txt");
    assert.equal(
      block,
      renderGdriveDataFilterBlock(),
      "bloco desatualizado: rode `npx tsx scripts/lib/data-sync-exclusions.ts` e cole no lugar (mudar o arquivo exige --resync no bisync)",
    );
  });

  it("todo padrão de data/ é escopado a diaria-studio-data (nunca global no Drive inteiro)", () => {
    const lines = renderGdriveDataFilterLines();
    assert.equal(lines.length, DATA_LOCAL_ONLY_PATTERNS.length * 2);
    for (const l of lines) assert.match(l, /^- diaria-studio-data\/(\*\*\/)?[^/]+$/);
    assert.ok(!readFileSync(FILTERS, "utf8").split("\n").includes("- *.mp4"), "*.mp4 global tiraria a pasta YouTube do sync");
  });

  it("padrão com '/' é recusado (a lista é de nomes)", () => {
    assert.throws(() => renderGdriveDataFilterLines(["a/b.json"]));
  });
});

// Semântica real do filtro, com o rclone instalado (no `300`, em
// ~/.local/bin/rclone). Sem o binário (CI), pula: o formato já está travado
// acima, e o comportamento foi medido à mão em 08/11/2026.
const RCLONE = process.env.RCLONE_BIN ?? join(homedir(), ".local", "bin", "rclone");
describe("filtro real do rclone (#12357)", { skip: existsSync(RCLONE) ? false : "rclone ausente nesta máquina" }, () => {
  it("exclui os locais de data/ em qualquer profundidade e mantém .mp4 fora de diaria-studio-data", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-filters-12357-"));
    try {
      const files = [
        "YouTube/bruto.mp4",
        "Docs/diaria-studio-data/a.mp4",
        "Docs/diaria-studio-data/A.MP4",
        "Docs/diaria-studio-data/editions/2611/b.mp4",
        "Docs/diaria-studio-data/run-log-Neo.jsonl",
        "Docs/diaria-studio-data/inbox.md",
        "Docs/diaria-studio-data/x.db-wal",
        "Docs/diaria-studio-data/keep.json",
        "Docs/diaria-studio-data/editions/2611/261108/02-reviewed.md",
        "diaria-studio-data-x/a.mp4",
      ];
      for (const f of files) {
        mkdirSync(join(sb, "t", dirname(f)), { recursive: true });
        writeFileSync(join(sb, "t", f), "x");
      }
      const r = spawnSync(RCLONE, ["lsf", "-R", "--files-only", "--ignore-case", "--filter-from", FILTERS, join(sb, "t")], {
        encoding: "utf8",
        env: { ...process.env, RCLONE_CONFIG: "/dev/null" },
      });
      assert.equal(r.status, 0, r.stderr);
      const listed = r.stdout.split("\n").filter(Boolean).sort();
      assert.deepEqual(listed, [
        "Docs/diaria-studio-data/editions/2611/261108/02-reviewed.md",
        "Docs/diaria-studio-data/keep.json",
        "YouTube/bruto.mp4",
        "diaria-studio-data-x/a.mp4",
      ]);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
