/**
 * scripts/lib/data-sync-exclusions.ts (#12357, #12478, épica #12353)
 *
 * FONTE ÚNICA dos arquivos de `data/` que nunca atravessam máquinas, seja qual
 * for o cliente de sync. Dois consumidores, um por backend, enquanto durar a
 * transição OneDrive → Google Drive (cutover simultâneo na #12359):
 *
 *   1. OneDrive (`abraunegg/onedrive`, `~/.config/onedrive/config`):
 *      `REQUIRED_SKIP_FILE_PATTERNS` de `onedrive-skip-file.ts` é esta lista,
 *      e `scripts/onedrive-skip-file-config.ts` a grava no `skip_file`.
 *   2. Google Drive: o bloco gerado de
 *      `scripts/systemd/gdrive-data-bisync-filters.txt`, o filtro do bisync
 *      DEDICADO da pasta `diaria-studio-data` (`diaria-gdrive-data-bisync`,
 *      #12478), que sincroniza só `gdrive:diaria-studio-data` ↔
 *      `/mnt/hd-sata/GoogleDrive/diaria-studio-data` a cada minuto
 *      (`renderGdriveDataFilterBlock`). `test/data-sync-exclusions-12357.test.ts`
 *      trava a paridade entre o arquivo e esta lista. Mudar esta lista NÃO
 *      muda o sync em curso: o `gdrive-bisync.sh` só instala o filtro novo
 *      numa rodada `--resync` (#12396); até lá o timer segue com o filtro
 *      instalado e só avisa a divergência no journal.
 *
 * O bisync do Drive INTEIRO (`diaria-gdrive-bisync`, #12356) leva ~34 min
 * por rodada (listagem de ~149 GB). Até a #12478 era ele que sincronizava
 * `data/`, com este bloco escopado à pasta (`- diaria-studio-data/*.mp4`
 * etc.: um `- *.mp4` global tiraria do sync os vídeos-fonte da pasta
 * YouTube). Desde a #12478 o filtro dele exclui a pasta inteira
 * (`GDRIVE_FULL_DRIVE_DATA_EXCLUSION`), para as duas rodadas nunca tocarem
 * os mesmos arquivos, e o bloco foi para o filtro do bisync dedicado, cuja
 * raiz JÁ É a pasta de `data/`. Lá cada padrão vira uma linha só, sem `/`:
 * o rclone compila padrão sem `/` inicial como `(^|/)padrão$`, então
 * `- *.mp4` exclui `a.mp4` e `editions/2611/b.mp4` em qualquer profundidade
 * de `data/` (a mesma semântica do `skip_file` do OneDrive, cujo `sync_list`
 * no `300` só traz `diaria-studio-data`).
 *
 * A lista é a do `skip_file` VIVO do `300` (17/08/2026, #5548), que tinha
 * divergido do código: `run-log*.jsonl` (variantes por host do run-log),
 * `inbox*.md` e `drive-cache*.json` (escritos com alta frequência, laço de
 * "Online file integrity failure") e `*safeBackup*` (o lixo que esse laço
 * gera). Os temporários de editor (`~*`, `*.tmp`, …) não entram: são o
 * default do cliente OneDrive e, no Drive, filtro GLOBAL dos dois arquivos
 * de filtros (`test/data-sync-exclusions-12357.test.ts` trava que o filtro
 * de `data/` repete os globais do filtro do Drive inteiro).
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

/** Pasta de `data/` no Drive: na RAIZ do Meu Drive (`gdrive:diaria-studio-data`,
 * #12478). É o remote do `diaria-gdrive-data-bisync.service` e o alvo da
 * exclusão do bisync do Drive inteiro; mudar de lugar no cutover (#12359)
 * exige mudar os dois (o teste trava que apontam pra mesma pasta). */
export const DATA_DIR_NAME_IN_DRIVE = "diaria-studio-data";

/** Linha do filtro do bisync do Drive INTEIRO que tira `data/` dele (#12478).
 * Ancorada na raiz (`/`): é o complemento exato do remote do bisync dedicado,
 * e outra pasta chamada `diaria-studio-data` mais funda no Drive segue no
 * sync grande. O `/**` deixa o rclone pular o diretório sem listá-lo. */
export const GDRIVE_FULL_DRIVE_DATA_EXCLUSION = `- /${DATA_DIR_NAME_IN_DRIVE}/**`;

export const GDRIVE_FILTER_BLOCK_BEGIN =
  "# BEGIN data-local-only (#12357) - GERADO de scripts/lib/data-sync-exclusions.ts, nao editar a mao";
export const GDRIVE_FILTER_BLOCK_END = "# END data-local-only";

/** Linhas de filtro do rclone que mantêm `DATA_LOCAL_ONLY_PATTERNS` fora do
 * bisync dedicado de `data/`, cuja raiz é a própria pasta: uma linha por
 * padrão, sem `/`, que casa em qualquer profundidade. */
export function renderGdriveDataFilterLines(patterns: readonly string[] = DATA_LOCAL_ONLY_PATTERNS): string[] {
  return patterns.map((p) => {
    if (p.includes("/")) throw new Error(`data-sync-exclusions: padrão de nome não pode ter '/': ${p}`);
    return `- ${p}`;
  });
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

// CLI: imprime o bloco pra colar em scripts/systemd/gdrive-data-bisync-filters.txt.
if (isMainModule(import.meta.url)) {
  console.log(renderGdriveDataFilterBlock());
}
