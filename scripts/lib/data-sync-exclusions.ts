/**
 * scripts/lib/data-sync-exclusions.ts (#12357, #12478, épica #12353)
 *
 * FONTE ÚNICA dos arquivos de `data/` que nunca atravessam máquinas, seja qual
 * for o cliente de sync. Três consumidores enquanto durar a transição
 * OneDrive → Google Drive (cutover simultâneo na #12359):
 *
 *   1. OneDrive (`abraunegg/onedrive`, `~/.config/onedrive/config`):
 *      `REQUIRED_SKIP_FILE_PATTERNS` de `onedrive-skip-file.ts` é esta lista,
 *      e `scripts/onedrive-skip-file-config.ts` a grava no `skip_file`.
 *   2. Google Drive (`rclone bisync`, #12354/#12356): o bloco gerado de
 *      `scripts/systemd/gdrive-bisync-filters.txt`, com cada padrão escopado
 *      à pasta `diaria-studio-data` dentro do Drive (`renderGdriveDataFilterBlock`).
 *      `test/data-sync-exclusions-12357.test.ts` trava a paridade entre o
 *      arquivo e esta lista. Mudar esta lista NÃO muda o sync em curso: o
 *      `gdrive-bisync.sh` só instala o filtro novo numa rodada `--resync`
 *      (#12396); até lá o timer segue com o filtro instalado e só avisa a
 *      divergência no journal.
 *   3. Bisync DEDICADO de `data/` (`diaria-gdrive-data-bisync`, #12478): o
 *      bloco gerado de `scripts/systemd/gdrive-data-bisync-filters.txt`
 *      (`renderGdriveDataRootFilterBlock`). A raiz desse bisync JÁ É a pasta
 *      de `data/`, então cada padrão vira uma linha só, sem `/`: o rclone
 *      compila padrão sem `/` inicial como `(^|/)padrão$`, e `- *.mp4` casa
 *      `a.mp4` e `editions/2611/b.mp4` em qualquer profundidade de `data/`
 *      (a mesma semântica do `skip_file` do OneDrive). Marcadores próprios
 *      (`GDRIVE_DATA_ROOT_FILTER_BLOCK_*`), para um bloco nunca ser colado
 *      no arquivo do outro. Mesma regra do `--resync` (#12396).
 *
 * Por que escopar no Drive e não no OneDrive: no OneDrive o `sync_list` do
 * `300` só traz `diaria-studio-data`, então um padrão global de `skip_file`
 * só alcança `data/`. O bisync sincroniza o Drive INTEIRO (#12356): um
 * `- *.mp4` global tiraria do sync os vídeos-fonte da pasta YouTube, que
 * vivem no Drive. Por isso cada padrão vira duas linhas, ancoradas em
 * `diaria-studio-data/` (raiz e subpastas). Medido com o rclone v1.75.2 do
 * `300` em 08/11/2026: `- diaria-studio-data/*.mp4` +
 * `- diaria-studio-data/**\/*.mp4` excluem `.../diaria-studio-data/a.mp4` e
 * `.../diaria-studio-data/editions/2611/b.mp4` em qualquer profundidade do
 * Drive, e deixam `Video/a.mp4` e `diaria-studio-data-x/a.mp4` no sync (o
 * rclone compila padrão sem `/` inicial como `(^|/)diaria-studio-data/...`).
 *
 * A lista é a do `skip_file` VIVO do `300` (17/08/2026, #5548), que tinha
 * divergido do código: `run-log*.jsonl` (variantes por host do run-log),
 * `inbox*.md` e `drive-cache*.json` (escritos com alta frequência, laço de
 * "Online file integrity failure") e `*safeBackup*` (o lixo que esse laço
 * gera). Os temporários de editor (`~*`, `*.tmp`, …) não entram: são o
 * default do cliente OneDrive e, no Drive, filtro GLOBAL do arquivo de
 * filtros (valem pro Drive inteiro).
 */
import { isMainModule } from "./cli-args.ts";

/** Padrões de NOME de arquivo (glob `*`/`?`, sem `/`) que ficam locais por
 * máquina dentro de `data/`. Ordem: os seis históricos do `skip_file`
 * gerado (#5548, #10957), depois os quatro que só existiam na config viva. */
export const DATA_LOCAL_ONLY_PATTERNS: readonly string[] = [
  "*.db-shm",
  "*.db-wal",
  "*.sqlite3-shm",
  "*.sqlite3-wal",
  "run-log.jsonl",
  "*.mp4",
  "run-log*.jsonl",
  "inbox*.md",
  "drive-cache*.json",
  "*safeBackup*",
];

/** Nome da pasta de `data/` dentro do Drive (o mesmo que no OneDrive:
 * `~/OneDrive/Documentos/diaria-studio-data`). Onde ela fica no Drive é
 * decisão do cutover (#12359); os filtros casam a pasta em qualquer
 * profundidade, então não dependem disso. */
export const DATA_DIR_NAME_IN_DRIVE = "diaria-studio-data";

export const GDRIVE_FILTER_BLOCK_BEGIN =
  "# BEGIN data-local-only (#12357) - GERADO de scripts/lib/data-sync-exclusions.ts, nao editar a mao";
export const GDRIVE_FILTER_BLOCK_END = "# END data-local-only";

/** Linhas de filtro do rclone que mantêm `DATA_LOCAL_ONLY_PATTERNS` fora do
 * sync, escopadas a `diaria-studio-data/` (raiz e qualquer subpasta). */
export function renderGdriveDataFilterLines(
  patterns: readonly string[] = DATA_LOCAL_ONLY_PATTERNS,
  dirName: string = DATA_DIR_NAME_IN_DRIVE,
): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (p.includes("/")) throw new Error(`data-sync-exclusions: padrão de nome não pode ter '/': ${p}`);
    out.push(`- ${dirName}/${p}`, `- ${dirName}/**/${p}`);
  }
  return out;
}

/** O bloco inteiro, com os marcadores, como deve aparecer no arquivo de filtros. */
export function renderGdriveDataFilterBlock(): string {
  return [GDRIVE_FILTER_BLOCK_BEGIN, ...renderGdriveDataFilterLines(), GDRIVE_FILTER_BLOCK_END].join("\n");
}

/** Extrai o bloco gerado do texto do arquivo de filtros. `null` = marcadores
 * ausentes ou fora de ordem. */
export function extractGdriveDataFilterBlock(filtersText: string): string | null {
  const lines = filtersText.split(/\r?\n/);
  const begin = lines.indexOf(GDRIVE_FILTER_BLOCK_BEGIN);
  const end = lines.indexOf(GDRIVE_FILTER_BLOCK_END);
  if (begin < 0 || end < begin) return null;
  return lines.slice(begin, end + 1).join("\n");
}

export const GDRIVE_DATA_ROOT_FILTER_BLOCK_BEGIN =
  "# BEGIN data-local-only, raiz de data/ (#12478) - GERADO de scripts/lib/data-sync-exclusions.ts --data-root, nao editar a mao";
export const GDRIVE_DATA_ROOT_FILTER_BLOCK_END = "# END data-local-only, raiz de data/";

/** Linhas de filtro do bisync DEDICADO de `data/` (#12478), cuja raiz é a
 * própria pasta: uma linha por padrão, sem `/`, que casa em qualquer
 * profundidade. */
export function renderGdriveDataRootFilterLines(patterns: readonly string[] = DATA_LOCAL_ONLY_PATTERNS): string[] {
  return patterns.map((p) => {
    if (p.includes("/")) throw new Error(`data-sync-exclusions: padrão de nome não pode ter '/': ${p}`);
    return `- ${p}`;
  });
}

/** O bloco inteiro do filtro de `data/`, com os marcadores próprios. */
export function renderGdriveDataRootFilterBlock(): string {
  return [GDRIVE_DATA_ROOT_FILTER_BLOCK_BEGIN, ...renderGdriveDataRootFilterLines(), GDRIVE_DATA_ROOT_FILTER_BLOCK_END].join(
    "\n",
  );
}

/** Extrai o bloco gerado do filtro de `data/`. `null` = marcadores ausentes
 * ou fora de ordem. */
export function extractGdriveDataRootFilterBlock(filtersText: string): string | null {
  const lines = filtersText.split(/\r?\n/);
  const begin = lines.indexOf(GDRIVE_DATA_ROOT_FILTER_BLOCK_BEGIN);
  const end = lines.indexOf(GDRIVE_DATA_ROOT_FILTER_BLOCK_END);
  if (begin < 0 || end < begin) return null;
  return lines.slice(begin, end + 1).join("\n");
}

// CLI: imprime o bloco pra colar em scripts/systemd/gdrive-bisync-filters.txt;
// com `--data-root`, o de scripts/systemd/gdrive-data-bisync-filters.txt (#12478).
if (isMainModule(import.meta.url)) {
  console.log(process.argv.includes("--data-root") ? renderGdriveDataRootFilterBlock() : renderGdriveDataFilterBlock());
}
