/**
 * scripts/lib/edition-video-retention.ts (#10957)
 *
 * Política PURA de retenção por data dos vídeos (`*.mp4`) em
 * `data/editions/`. O vídeo da edição (`diaria-comentada-{AAMMDD}.mp4`, o
 * vertical `-short*.mp4`, a versão `-short-instagram-chrome.mp4` em
 * `_internal/`) pesa 0,3 a 0,6 GB e já tem cópias fora do disco: YouTube,
 * R2 pros verticais e a fonte no Drive (`fetch-drive-video.ts`). Depois de
 * alguns dias a cópia local só ocupa espaço.
 *
 * A data é a da EDIÇÃO (o diretório `AAMMDD` mais próximo do arquivo),
 * nunca o mtime: reprocessar um vídeo velho (`--force`, ffmpeg) não pode
 * renovar a retenção dele, e o mtime atravessando o OneDrive não é
 * confiável. Arquivo sem diretório `AAMMDD` no caminho fica de fora —
 * sem data, sem decisão.
 *
 * Só decide. Quem apaga é `scripts/prune-edition-videos.ts`, e só com
 * `--apply`.
 */

export const DEFAULT_VIDEO_KEEP_DAYS = 14;

export interface VideoFileEntry {
  /** Caminho relativo a `data/editions/`, com `/` como separador. */
  relPath: string;
  sizeBytes: number;
}

export interface VideoRetentionCandidate extends VideoFileEntry {
  edition: string;
  ageDays: number;
}

export interface VideoRetentionPlan {
  remove: VideoRetentionCandidate[];
  keep: VideoRetentionCandidate[];
  /** `.mp4` sem diretório de edição reconhecível no caminho. */
  undated: VideoFileEntry[];
  removeBytes: number;
}

/** AAMMDD do diretório de edição mais próximo do arquivo; `null` se não há. */
export function editionFromVideoPath(relPath: string): string | null {
  const parts = relPath.split("/").slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d{6}$/.test(parts[i]) && editionToUtcDate(parts[i]) !== null) return parts[i];
  }
  return null;
}

/** AAMMDD → Date UTC 00:00 (século 2000); `null` se a data não existe. */
export function editionToUtcDate(edition: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(edition);
  if (!m) return null;
  const y = 2000 + Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** Dias inteiros entre a data da edição e `today` (só a parte de data). */
export function editionAgeDays(edition: string, today: Date): number | null {
  const ed = editionToUtcDate(edition);
  if (!ed) return null;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((t - ed.getTime()) / 86_400_000);
}

export function isEditionVideo(relPath: string): boolean {
  return /\.mp4$/i.test(relPath);
}

/**
 * Pura — separa os `.mp4` em remover (edição com MAIS de `keepDays` dias)
 * e manter. `keepDays` < 1 é recusado: apagar o vídeo do dia antes da
 * Etapa 5 publicá-lo quebraria `/diaria-youtube`/`/diaria-shorts`.
 */
export function planVideoRetention(
  files: readonly VideoFileEntry[],
  today: Date,
  keepDays: number = DEFAULT_VIDEO_KEEP_DAYS,
): VideoRetentionPlan {
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new Error(`keepDays deve ser inteiro ≥ 1, recebido ${keepDays}`);
  }
  const plan: VideoRetentionPlan = { remove: [], keep: [], undated: [], removeBytes: 0 };
  for (const f of files) {
    if (!isEditionVideo(f.relPath)) continue;
    const edition = editionFromVideoPath(f.relPath);
    const ageDays = edition ? editionAgeDays(edition, today) : null;
    if (!edition || ageDays === null) {
      plan.undated.push(f);
      continue;
    }
    const c: VideoRetentionCandidate = { ...f, edition, ageDays };
    if (ageDays > keepDays) {
      plan.remove.push(c);
      plan.removeBytes += f.sizeBytes;
    } else {
      plan.keep.push(c);
    }
  }
  plan.remove.sort((a, b) => a.relPath.localeCompare(b.relPath));
  plan.keep.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return plan;
}
