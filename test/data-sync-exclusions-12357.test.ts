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
  renderGdriveDataRootFilterBlock,
  renderGdriveDataRootFilterLines,
  extractGdriveDataRootFilterBlock,
} from "../scripts/lib/data-sync-exclusions.ts";
import { REQUIRED_SKIP_FILE_PATTERNS, planSkipFileConfig } from "../scripts/lib/onedrive-skip-file.ts";

const ROOT = join(import.meta.dirname, "..");
const FILTERS = join(ROOT, "scripts", "systemd", "gdrive-bisync-filters.txt");
const DATA_FILTERS = join(ROOT, "scripts", "systemd", "gdrive-data-bisync-filters.txt");

/** Linhas de regra (não comentário, não vazias) de um arquivo de filtros. */
function ruleLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith("#"));
}

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
    assert.throws(() => renderGdriveDataRootFilterLines(["a/b.json"]));
  });
});

describe("filtro do bisync dedicado de data/ (#12478)", () => {
  const dataText = readFileSync(DATA_FILTERS, "utf8");

  it("tem o bloco gerado relativo à raiz de data/, idêntico ao render", () => {
    const block = extractGdriveDataRootFilterBlock(dataText);
    assert.ok(block, "marcadores BEGIN/END ausentes em gdrive-data-bisync-filters.txt");
    assert.equal(
      block,
      renderGdriveDataRootFilterBlock(),
      "bloco desatualizado: rode `npx tsx scripts/lib/data-sync-exclusions.ts --data-root` e cole no lugar (mudar o arquivo exige --resync no bisync de data/)",
    );
  });

  it("um padrão por linha, sem '/': a raiz do sync já é a pasta de data/", () => {
    const lines = renderGdriveDataRootFilterLines();
    assert.deepEqual(lines, DATA_LOCAL_ONLY_PATTERNS.map((p) => `- ${p}`));
    assert.ok(!dataText.includes("diaria-studio-data/"), "nenhuma regra escopada à pasta: ela é a raiz deste sync");
  });

  it("repete os globais do filtro do Drive inteiro (temporários, WAL/SHM, node_modules)", () => {
    const bigGlobals = ruleLines(readFileSync(FILTERS, "utf8")).filter((l) => !l.startsWith("- diaria-studio-data/"));
    const dataRules = ruleLines(dataText);
    for (const g of bigGlobals) assert.ok(dataRules.includes(g), `global ausente no filtro de data/: ${g}`);
  });

  it("os blocos dos dois arquivos nunca se misturam (marcadores próprios)", () => {
    assert.equal(extractGdriveDataFilterBlock(dataText), null);
    assert.equal(extractGdriveDataRootFilterBlock(readFileSync(FILTERS, "utf8")), null);
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
        // #12412: node_modules em qualquer profundidade sai; .git fica
        "Work/proj/node_modules/pkg/index.js",
        "Work/proj/Node_Modules/pkg/a.js",
        "Work/proj/.git/objects/ab/cdef",
        "Work/proj/src/node_modules.txt",
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
        "Work/proj/.git/objects/ab/cdef",
        "Work/proj/src/node_modules.txt",
        "YouTube/bruto.mp4",
        "diaria-studio-data-x/a.mp4",
      ]);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});

describe("filtro real do rclone, bisync de data/ (#12478)", { skip: existsSync(RCLONE) ? false : "rclone ausente nesta máquina" }, () => {
  it("exclui os locais de data/ em qualquer profundidade a partir da raiz de data/", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-data-filters-12478-"));
    try {
      const files = [
        "a.mp4",
        "A.MP4",
        "editions/2611/b.mp4",
        "run-log.jsonl",
        "run-log-Neo.jsonl",
        "inbox.md",
        "x.db-wal",
        "sessions/s.json.tmp",
        "proj/node_modules/pkg/index.js",
        "keep.json",
        "editions/2611/261108/02-reviewed.md",
        "sessions/s.json.conflict1",
      ];
      for (const f of files) {
        mkdirSync(join(sb, "t", dirname(f)), { recursive: true });
        writeFileSync(join(sb, "t", f), "x");
      }
      const r = spawnSync(RCLONE, ["lsf", "-R", "--files-only", "--ignore-case", "--filter-from", DATA_FILTERS, join(sb, "t")], {
        encoding: "utf8",
        env: { ...process.env, RCLONE_CONFIG: "/dev/null" },
      });
      assert.equal(r.status, 0, r.stderr);
      const listed = r.stdout.split("\n").filter(Boolean).sort();
      assert.deepEqual(listed, ["editions/2611/261108/02-reviewed.md", "keep.json", "sessions/s.json.conflict1"]);
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
