/**
 * scripts/lib/diaria/video-montage-cache-retention.ts (#12365)
 *
 * Política PURA de retenção do cache do `/diaria-video-montagem` no modo API
 * (`{raiz}/{AAMMDD}/` com `bruto/`, `work/`, `out/`, `final/`; raiz em
 * `videoCacheRoot`, `video-montage-drive.ts`). Uma edição ocupa de 6 a 17 GB
 * e o cache não tinha retenção nenhuma: 33 GB em 3 edições no raiz do 300.
 * Mesmo molde da retenção dos `.mp4` de `data/editions/` (#10957,
 * `edition-video-retention.ts`).
 *
 * O que sai do disco tem cópia fora dele: o bruto e os exports (`Final/`)
 * seguem na pasta da edição no Drive, as saídas do `out/` sobem para lá, e o
 * vídeo publicado está no YouTube. O `work/` (áudio 16 kHz, clipes da prévia)
 * é refeito pelo próprio comando.
 *
 * Regras, nesta ordem:
 *   - só diretório de verdade com nome AAMMDD válido entra; symlink, arquivo
 *     solto e nome fora do padrão ficam de fora (`skipped`), nunca apagados;
 *   - a data é a da EDIÇÃO (o nome do diretório), nunca o mtime: reprocessar
 *     uma edição velha não renova a retenção dela;
 *   - edição com até `keepDays` dias fica (janela de correção: legenda
 *     refeita com `srt --from-final`, review-final, novo export);
 *   - passada a janela, sai se o vídeo da edição está PUBLICADO (sinal lido
 *     pelo chamador: `_internal/05-youtube-published.json` com `videoId` ou
 *     `_internal/05-video-url.txt` com link);
 *   - sem publicação, fica até `unpublishedMaxDays` dias e então sai: vídeo
 *     abandonado (ou edição só de áudio) não pode segurar 17 GB para sempre,
 *     e o bruto continua no Drive;
 *   - publicação DESCONHECIDA (`data/` ausente nesta máquina) nunca sai: sem
 *     o sinal não há como distinguir "abandonado" de "ainda vai sair".
 *
 * Só decide. Quem apaga é `scripts/prune-video-montage-cache.ts`, e só com
 * `--apply`.
 */

import { editionAgeDays } from "../edition-video-retention.ts";

/**
 * 3 dias depois da data da edição (#12365). A edição é D+1 e o vídeo é
 * montado e publicado na véspera ou no próprio dia; os 3 dias cobrem a
 * janela em que ainda se refaz legenda ou export. Mais que isso não cabe no
 * raiz do 300 (13 GB livres para edições de até 17 GB) enquanto o cache não
 * vai para o HD (#12352).
 */
export const DEFAULT_CACHE_KEEP_DAYS = 3;

/** Teto para edição SEM vídeo publicado (#12365): duas semanas, depois disso o vídeo não sai mais. */
export const DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS = 14;

export interface CacheEntry {
  /** Nome do item direto na raiz do cache. */
  name: string;
  kind: "dir" | "symlink" | "other";
  /** Soma dos arquivos (sem seguir symlink interno); 0 para o que não é diretório. */
  sizeBytes: number;
  /** Vídeo da edição publicado? `null` = desconhecido (sem `data/editions` nesta máquina). */
  published: boolean | null;
}

export type CacheRemoveReason = "publicado" | "teto-sem-publicacao";
export type CacheKeepReason = "na-janela" | "aguardando-publicacao" | "publicacao-desconhecida";
export type CacheSkipReason = "symlink" | "nao-diretorio" | "nome-invalido";

export interface CacheEditionDecision {
  edition: string;
  sizeBytes: number;
  ageDays: number;
  published: boolean | null;
}

export interface CacheRetentionPlan {
  remove: (CacheEditionDecision & { reason: CacheRemoveReason })[];
  keep: (CacheEditionDecision & { reason: CacheKeepReason })[];
  skipped: { name: string; reason: CacheSkipReason }[];
  removeBytes: number;
}

export interface CacheRetentionOptions {
  keepDays?: number;
  unpublishedMaxDays?: number;
}

export function planCacheRetention(entries: readonly CacheEntry[], today: Date, opts: CacheRetentionOptions = {}): CacheRetentionPlan {
  const keepDays = opts.keepDays ?? DEFAULT_CACHE_KEEP_DAYS;
  const maxDays = opts.unpublishedMaxDays ?? DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS;
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error(`keepDays deve ser inteiro ≥ 1, recebido ${keepDays}`);
  if (!Number.isInteger(maxDays) || maxDays < keepDays) {
    throw new Error(`unpublishedMaxDays deve ser inteiro ≥ keepDays (${keepDays}), recebido ${maxDays}`);
  }
  const plan: CacheRetentionPlan = { remove: [], keep: [], skipped: [], removeBytes: 0 };
  for (const e of entries) {
    if (e.kind === "symlink") {
      plan.skipped.push({ name: e.name, reason: "symlink" });
      continue;
    }
    if (e.kind !== "dir") {
      plan.skipped.push({ name: e.name, reason: "nao-diretorio" });
      continue;
    }
    const ageDays = /^\d{6}$/.test(e.name) ? editionAgeDays(e.name, today) : null;
    if (ageDays === null) {
      plan.skipped.push({ name: e.name, reason: "nome-invalido" });
      continue;
    }
    const d: CacheEditionDecision = { edition: e.name, sizeBytes: e.sizeBytes, ageDays, published: e.published };
    if (ageDays <= keepDays) plan.keep.push({ ...d, reason: "na-janela" });
    else if (e.published === true) plan.remove.push({ ...d, reason: "publicado" });
    else if (e.published === null) plan.keep.push({ ...d, reason: "publicacao-desconhecida" });
    else if (ageDays > maxDays) plan.remove.push({ ...d, reason: "teto-sem-publicacao" });
    else plan.keep.push({ ...d, reason: "aguardando-publicacao" });
  }
  for (const r of plan.remove) plan.removeBytes += r.sizeBytes;
  plan.remove.sort((a, b) => a.edition.localeCompare(b.edition));
  plan.keep.sort((a, b) => a.edition.localeCompare(b.edition));
  plan.skipped.sort((a, b) => a.name.localeCompare(b.name));
  return plan;
}
