/** #12279: replacement is restricted to future scheduled posts. No I/O here. */
import { videoVersionOf } from './drive-video-source.ts';
import type { ShortPublishedEntry } from './short-video.ts';

export interface ShortReplacementItem {
  entry: ShortPublishedEntry;
  action: 'replace' | 'buffer' | 'skip';
  reason?: string;
}

export function planScheduledReplacements(entries: readonly ShortPublishedEntry[], now: Date, only: readonly string[] | null = null, videoHash?: string): ShortReplacementItem[] {
  if (only?.some(d => !entries.some(e => e.destination === d))) throw new Error('--only contém destino sem registro');
  return entries.filter(e => !only || only.includes(e.destination)).map(entry => {
    if (videoHash && entry.video_sha256 === videoHash) return { entry, action: 'skip', reason: 'mesmos bytes já registrados; nada a substituir' };
    if (entry.status !== 'scheduled' || !entry.scheduled_at || !(Date.parse(entry.scheduled_at) > now.getTime() + 1_800_000)) {
      return { entry, action: 'skip', reason: 'exige agendamento futuro com mais de 30 min; publicado, ambíguo ou horário desconhecido não é substituído' };
    }
    if ((entry.destination === 'x' || entry.destination === 'tiktok') && /^buffer:.+/.test(entry.id)) return { entry, action: 'buffer' };
    if (entry.destination === 'youtube_shorts' || /^facebook:.+/.test(entry.destination)) return { entry, action: 'replace' };
    return { entry, action: 'skip', reason: 'destino sem API de substituição de agendado' };
  });
}

export function shortVideoChangeWarnings(entries: readonly ShortPublishedEntry[], hash: string): string[] {
  return entries.filter(e => e.video_sha256 && e.video_sha256 !== hash)
    .map(e => `${e.destination}: vídeo local diferente do vídeo registrado; use --replace-scheduled para trocar a mídia agendada`);
}

/** Compare the selected Drive export with the source recorded for each upload. */
export function newerShortVersionWarnings(entries: readonly ShortPublishedEntry[], candidateName: string): string[] {
  const next = videoVersionOf(candidateName);
  if (next === null) return [];
  return entries.flatMap(e => {
    const prior = e.video_source_name ? videoVersionOf(e.video_source_name) : null;
    return prior !== null && next > prior ? [`${e.destination}: ${candidateName} (V${next}) é mais novo que ${e.video_source_name} (V${prior}) já registrado; use --replace-scheduled para trocar a mídia agendada`] : [];
  });
}
