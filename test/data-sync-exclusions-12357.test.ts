/**
 * test/data-sync-exclusions-12357.test.ts (#12357, #12478, épica #12353)
 *
 * Paridade entre os dois backends de sync de `data/` na transição
 * OneDrive → Google Drive: os arquivos que ficam locais por máquina saem de
 * UMA lista (`DATA_LOCAL_ONLY_PATTERNS`), que vira o `skip_file` do OneDrive
 * e o bloco gerado do filtro do `rclone bisync` dedicado de `data/` (#12478).
 * Se alguém acrescenta um padrão num lado só, um arquivo local-only começa a
 * atravessar máquinas.
 *
 * Desde a #12478 o bisync do Drive INTEIRO exclui a pasta de `data/` e não
 * carrega mais o bloco: os dois filtros são travados aqui (globais repetidos,
 * exclusão da pasta, nenhuma regra de `data/` sobrando no filtro grande).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  DATA_LOCAL_ONLY_PATTERNS,
  DATA_DIR_NAME_IN_DRIVE,
  GDRIVE_FULL_DRIVE_DATA_EXCLUSION,
  renderGdriveDataFilterBlock,
  renderGdriveDataFilterLines,
  extractGdriveDataFilterBlock,
} from "../scripts/lib/data-sync-exclusions.ts";
import { REQUIRED_SKIP_FILE_PATTERNS, planSkipFileConfig } from "../scripts/lib/onedrive-skip-file.ts";

const ROOT = join(import.meta.dirname, "..");
/** Filtro do bisync do Drive INTEIRO (#12356). */
const FULL_FILTERS = join(ROOT, "scripts", "systemd", "gdrive-bisync-filters.txt");
/** Filtro do bisync dedicado de `data/` (#12478). */
const DATA_FILTERS = join(ROOT, "scripts", "systemd", "gdrive-data-bisync-filters.txt");

function ruleLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[-+] /.test(l));
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

  it("o filtro do bisync de data/ tem o bloco gerado, idêntico ao render (#12478)", () => {
    const block = extractGdriveDataFilterBlock(readFileSync(DATA_FILTERS, "utf8"));
    assert.ok(block, "marcadores BEGIN/END ausentes em gdrive-data-bisync-filters.txt");
    assert.equal(
      block,
      renderGdriveDataFilterBlock(),
      "bloco desatualizado: rode `npx tsx scripts/lib/data-sync-exclusions.ts` e cole no lugar (mudar o arquivo exige --resync no bisync de data/)",
    );
  });

  it("no filtro de data/ cada padrão é uma linha sem '/', que casa em qualquer profundidade da pasta", () => {
    const lines = renderGdriveDataFilterLines();
    assert.equal(lines.length, DATA_LOCAL_ONLY_PATTERNS.length);
    for (const l of lines) assert.match(l, /^- [^/]+$/);
  });

  it("padrão com '/' é recusado (a lista é de nomes)", () => {
    assert.throws(() => renderGdriveDataFilterLines(["a/b.json"]));
  });
});

describe("filtro do Drive inteiro sem data/ (#12478)", () => {
  const full = ruleLines(FULL_FILTERS);

  it("exclui a pasta de data/ na raiz do Drive, como diretório (/**)", () => {
    assert.equal(GDRIVE_FULL_DRIVE_DATA_EXCLUSION, `- /${DATA_DIR_NAME_IN_DRIVE}/**`);
    assert.ok(full.includes(GDRIVE_FULL_DRIVE_DATA_EXCLUSION), "o bisync grande voltaria a tocar data/ junto com o dedicado");
  });

  it("não sobra regra de data/ no filtro grande (o bloco gerado mudou de arquivo)", () => {
    assert.equal(extractGdriveDataFilterBlock(readFileSync(FULL_FILTERS, "utf8")), null);
    for (const l of full) {
      if (l === GDRIVE_FULL_DRIVE_DATA_EXCLUSION) continue;
      assert.doesNotMatch(l, new RegExp(DATA_DIR_NAME_IN_DRIVE), l);
    }
  });

  it("nenhum padrão de data/ virou global no Drive inteiro (*.mp4 tiraria a pasta YouTube do sync)", () => {
    for (const l of renderGdriveDataFilterLines(["*.mp4", "run-log.jsonl", "inbox*.md", "drive-cache*.json"])) {
      assert.ok(!full.includes(l), l);
    }
  });

  it("o filtro de data/ repete todas as regras globais do filtro grande", () => {
    const data = ruleLines(DATA_FILTERS);
    for (const l of full) {
      if (l === GDRIVE_FULL_DRIVE_DATA_EXCLUSION) continue;
      assert.ok(data.includes(l), `regra global ausente do filtro de data/: ${l}`);
    }
    assert.ok(!data.includes(GDRIVE_FULL_DRIVE_DATA_EXCLUSION), "o filtro de data/ excluiria a própria raiz");
  });
});

// Semântica real do filtro, com o rclone instalado (no `300`, em
// ~/.local/bin/rclone). Sem o binário (CI), pula: o formato já está travado
// acima, e o comportamento do bloco escopado foi medido à mão em 08/11/2026.
const RCLONE = process.env.RCLONE_BIN ?? join(homedir(), ".local", "bin", "rclone");
function rcloneList(filters: string, files: string[]): string[] {
  const sb = mkdtempSync(join(tmpdir(), "gdrive-filters-12478-"));
  try {
    for (const f of files) {
      mkdirSync(join(sb, "t", dirname(f)), { recursive: true });
      writeFileSync(join(sb, "t", f), "x");
    }
    const r = spawnSync(RCLONE, ["lsf", "-R", "--files-only", "--ignore-case", "--filter-from", filters, join(sb, "t")], {
      encoding: "utf8",
      env: { ...process.env, RCLONE_CONFIG: "/dev/null" },
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split("\n").filter(Boolean).sort();
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
}

describe("filtro real do rclone (#12357, #12478)", { skip: existsSync(RCLONE) ? false : "rclone ausente nesta máquina" }, () => {
  it("Drive inteiro: tira /diaria-studio-data inteira e node_modules, mantém .mp4 e pastas homônimas mais fundas", () => {
    const listed = rcloneList(FULL_FILTERS, [
      "YouTube/bruto.mp4",
      "diaria-studio-data/keep.json",
      "diaria-studio-data/editions/2611/261108/02-reviewed.md",
      "Docs/diaria-studio-data/keep.json",
      "diaria-studio-data-x/a.mp4",
      // #12412: node_modules em qualquer profundidade sai; .git fica
      "Work/proj/node_modules/pkg/index.js",
      "Work/proj/Node_Modules/pkg/a.js",
      "Work/proj/.git/objects/ab/cdef",
      "Work/proj/src/node_modules.txt",
    ]);
    assert.deepEqual(listed, [
      "Docs/diaria-studio-data/keep.json",
      "Work/proj/.git/objects/ab/cdef",
      "Work/proj/src/node_modules.txt",
      "YouTube/bruto.mp4",
      "diaria-studio-data-x/a.mp4",
    ]);
  });

  it("data/: exclui os locais por máquina em qualquer profundidade e mantém o resto", () => {
    const listed = rcloneList(DATA_FILTERS, [
      "a.mp4",
      "A.MP4",
      "editions/2611/b.mp4",
      "run-log-Neo.jsonl",
      "inbox.md",
      "x.db-wal",
      "editions/2611/261108/run-log.jsonl",
      "keep.json",
      "editions/2611/261108/02-reviewed.md",
      ".diaria-bisync-sentinel",
    ]);
    assert.deepEqual(listed, [".diaria-bisync-sentinel", "editions/2611/261108/02-reviewed.md", "keep.json"]);
  });
});
