/**
 * scripts/lib/audience-history-retention.ts (#7129)
 *
 * Política de retenção pra `docs/audience-history/` (achado do crítico de
 * cobertura da #7112, fatia 17 do epic #7112): 54 arquivos / 8.282 linhas de
 * snapshots que `scripts/update-audience.ts` escreve semanalmente (na
 * prática, com cadência bem mais frequente que semanal) e ninguém relê fora
 * do próprio archive guard — crescimento monotônico versionado, para
 * sempre.
 *
 * **Decisão do editor via subagente overnight (#7129), aceitando a ressalva
 * do cético da #7112:** não apagar sem política — snapshot histórico tem
 * valor de série temporal que não se reconstrói depois de apagado. A
 * política escolhida é **manter os N dias mais recentes como arquivo
 * individual (`YYYY-MM-DD.md`) + consolidar os mais antigos num único
 * arquivo append-only (`_consolidated.md`)** — nunca deleta conteúdo, só
 * muda a granularidade do armazenamento pra parar o crescimento de
 * contagem de arquivos sem perder nenhum byte do histórico.
 *
 * `RETENTION_DAYS = 90` — mesma janela já usada em outras decisões deste
 * repo (o decay exponencial do próprio profile de audiência usa time
 * constant de 90d; `MONTHLY_BUDGET_FLOOR_BRL`/outras janelas do projeto
 * também operam em blocos de 30-90 dias) — escolhida por consistência com
 * o resto do código, não por medição específica deste caso.
 *
 * Todas as funções aqui são PURAS (parsing/decisão de partição) — I/O real
 * (ler/escrever/apagar arquivos) fica em `scripts/prune-audience-history.ts`,
 * que importa este módulo. Mantido como script standalone (não wireado no
 * caminho de escrita de `scripts/update-audience.ts`, que é
 * business-crítico e roda a cada edição) — mesmo padrão de manutenção
 * periódica de `scripts/verify-emails-mv.ts`: o editor/cron roda quando
 * quiser, sem risco de regressão no pipeline diário.
 */

const HISTORY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;

export const RETENTION_DAYS = 90;

export const CONSOLIDATED_FILENAME = "_consolidated.md";

/** Extrai a data (UTC, meia-noite) de um nome de arquivo `YYYY-MM-DD.md`. `null` se não bater o padrão. */
export function parseHistoryFilenameDate(filename: string): Date | null {
  const m = HISTORY_FILE_RE.exec(filename);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Guard contra datas inválidas tipo "2026-02-30" (Date normaliza silenciosamente pra março).
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    return null;
  }
  return date;
}

export interface RetentionPartition {
  /** Arquivos que permanecem individuais (dentro da janela de retenção, ou não batem o padrão de data — nunca tocados). */
  keep: string[];
  /** Arquivos elegíveis pra consolidação (mais antigos que `retentionDays`), em ordem cronológica ascendente. */
  consolidate: string[];
}

/**
 * Pure: decide quais arquivos de `docs/audience-history/` continuam
 * individuais e quais são candidatos a consolidação, dado "hoje" e a janela
 * de retenção em dias. `files` é a listagem crua do diretório (pode incluir
 * `_consolidated.md`, `.gitkeep`, etc. — tudo que não bate `YYYY-MM-DD.md`
 * vai pra `keep` sem ser tocado, nunca pra `consolidate`).
 */
export function partitionHistoryFilesForRetention(
  files: string[],
  today: Date,
  retentionDays: number = RETENTION_DAYS,
): RetentionPartition {
  const cutoff = new Date(today.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const dated: { file: string; date: Date }[] = [];
  const keep: string[] = [];

  for (const file of files) {
    const date = parseHistoryFilenameDate(file);
    if (date === null) {
      keep.push(file);
      continue;
    }
    if (date.getTime() < cutoff.getTime()) {
      dated.push({ file, date });
    } else {
      keep.push(file);
    }
  }

  dated.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { keep, consolidate: dated.map((d) => d.file) };
}

/**
 * Pure: monta o bloco de texto a ser anexado em `_consolidated.md` para um
 * snapshot individual — cabeçalho com a data (idempotência de dedup fica a
 * cargo do chamador: nunca reprocessar um `file` cujo cabeçalho já exista
 * no consolidado) seguido do conteúdo original sem modificação.
 */
export function buildConsolidatedEntry(filename: string, content: string): string {
  const date = filename.replace(/\.md$/, "");
  return [`\n\n---\n\n<!-- audience-history-consolidated: ${date} -->\n`, `## Snapshot ${date}`, "", content.trimEnd(), ""].join("\n");
}

/** Pure: o marcador que identifica se `filename` já foi consolidado em `_consolidated.md` (evita reprocessar em reruns). */
export function consolidatedMarkerFor(filename: string): string {
  const date = filename.replace(/\.md$/, "");
  return `<!-- audience-history-consolidated: ${date} -->`;
}
