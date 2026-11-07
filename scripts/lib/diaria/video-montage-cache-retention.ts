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
 *   - a idade é a da EDIÇÃO (o nome do diretório), nunca o mtime: reprocessar
 *     uma edição velha não renova a retenção dela;
 *   - edição com até `keepDays` dias fica (janela de correção: legenda
 *     refeita com `srt --from-final`, review-final, novo export);
 *   - modificada nas últimas `inUseHours` horas fica (`em-uso`): o mtime aqui
 *     é sinal de que alguém está mexendo nela agora, não de idade;
 *   - upload para o Drive pendente (`drive-uploads.json` com `pending`) fica:
 *     o arquivo pendente só existe no `out/` deste cache; registro ilegível
 *     também fica;
 *   - passada a janela, sai se o vídeo da edição está publicado (ou já
 *     enviado ao YouTube): sinal lido pelo chamador,
 *     `_internal/05-youtube-published.json` com `videoId` ou
 *     `_internal/05-video-url.txt` com link;
 *   - sem publicação, fica até `unpublishedMaxDays` dias e então sai: vídeo
 *     abandonado (ou edição só de áudio) não pode segurar 17 GB para sempre,
 *     e o bruto continua no Drive;
 *   - publicação DESCONHECIDA (`data/` ausente nesta máquina, ou a pasta da
 *     edição ausente nele) nunca sai: sem o sinal não há como distinguir
 *     "abandonado" de "ainda vai sair".
 *
 * Só decide. Quem apaga é `scripts/prune-video-montage-cache.ts`, e só com
 * `--apply`.
 */

import { editionAgeDays } from "../edition-video-retention.ts";

/**
 * Edições com mais de 3 dias saem (#12365). A edição é D+1 e o vídeo é
 * montado e publicado na véspera ou no próprio dia; os 3 dias cobrem a
 * janela em que ainda se refaz legenda ou export. Mais que isso não cabe no
 * raiz do 300 (13 GB livres para edições de até 17 GB) enquanto o cache não
 * vai para o HD (#12352).
 */
export const DEFAULT_CACHE_KEEP_DAYS = 3;

/** Teto para edição SEM vídeo publicado (#12365): duas semanas, depois disso o vídeo não sai mais. */
export const DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS = 14;

/** Modificação mais recente dentro do diretório nestas horas = edição em uso, não sai. */
export const DEFAULT_CACHE_IN_USE_HOURS = 6;

export interface CacheEntry {
  /** Nome do item direto na raiz do cache. */
  name: string;
  kind: "dir" | "symlink" | "other";
  /** Soma dos arquivos (sem seguir symlink interno); 0 para o que não é diretório. */
  sizeBytes: number;
  /** Vídeo da edição publicado? `null` = desconhecido. */
  published: boolean | null;
  /** `drive-uploads.json` da edição com `pending` não vazio? `null` = registro ilegível. */
  pendingUpload?: boolean | null;
  /** mtime mais recente dentro do diretório (ms); `null`/ausente = não medido. */
  lastModifiedMs?: number | null;
}

export type CacheRemoveReason = "publicado" | "teto-sem-publicacao";
export type CacheKeepReason =
  | "na-janela"
  | "em-uso"
  | "upload-pendente"
  | "registro-de-upload-ilegivel"
  | "aguardando-publicacao"
  | "publicacao-desconhecida";
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
  inUseHours?: number;
  /** Instante de referência do `em-uso` (default: `today`). */
  nowMs?: number;
}

/** `today` = data civil de referência (BRT, em UTC 00:00), só a parte de data conta. */
export function planCacheRetention(entries: readonly CacheEntry[], today: Date, opts: CacheRetentionOptions = {}): CacheRetentionPlan {
  const keepDays = opts.keepDays ?? DEFAULT_CACHE_KEEP_DAYS;
  const maxDays = opts.unpublishedMaxDays ?? DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS;
  const inUseMs = (opts.inUseHours ?? DEFAULT_CACHE_IN_USE_HOURS) * 3_600_000;
  const nowMs = opts.nowMs ?? today.getTime();
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
    const keep = (reason: CacheKeepReason) => plan.keep.push({ ...d, reason });
    if (ageDays <= keepDays) keep("na-janela");
    else if (e.lastModifiedMs != null && nowMs - e.lastModifiedMs < inUseMs) keep("em-uso");
    else if (e.pendingUpload === true) keep("upload-pendente");
    else if (e.pendingUpload === null) keep("registro-de-upload-ilegivel");
    else if (e.published === true) plan.remove.push({ ...d, reason: "publicado" });
    else if (e.published === null) keep("publicacao-desconhecida");
    else if (ageDays > maxDays) plan.remove.push({ ...d, reason: "teto-sem-publicacao" });
    else keep("aguardando-publicacao");
  }
  for (const r of plan.remove) plan.removeBytes += r.sizeBytes;
  plan.remove.sort((a, b) => a.edition.localeCompare(b.edition));
  plan.keep.sort((a, b) => a.edition.localeCompare(b.edition));
  plan.skipped.sort((a, b) => a.name.localeCompare(b.name));
  return plan;
}
