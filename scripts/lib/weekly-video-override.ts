/**
 * scripts/lib/weekly-video-override.ts (#13820)
 *
 * Troca do "vídeo da semana" por escolha do editor (`--video-edition AAMMDD` ou
 * `--video-url URL`) no LinkedIn semanal e no post da Stack, em vez do mais visto
 * da janela (#12081). Título e URL vêm do que a edição gravou
 * (`_internal/05-youtube-published.json` + `05-video-url.txt`), e a edição pode
 * estar FORA da janela da semana.
 *
 * O override é gravado em `videoOverride` ao lado de `video` na seleção, para a
 * re-seleção (`--require-approved`, `--reselect`) reaplicar em vez de apagar.
 * Trocar o vídeo invalida o que foi escrito sobre o anterior (`pitch` do
 * LinkedIn, #13045; `description` da Stack, #12549): `applyVideoOverride` os descarta.
 */

import { collectEditionVideos } from "./top-edition-video.ts";
import { readEditionVideoMeta } from "./edition-video-meta.ts";
import { extractYouTubeVideoId } from "./diaria/d1-video-link.ts";
import { enumerateEditionDirs, resolveEditionDir } from "./find-current-edition.ts";

export interface WeeklyVideoOverrideMarker {
  editionDate: string;
  url: string;
}

export interface OverriddenVideo {
  title: string;
  url: string;
  editionDate: string;
}

export type ResolveVideoOverrideResult =
  | { ok: true; video: OverriddenVideo; marker: WeeklyVideoOverrideMarker }
  | { ok: false; error: string };

/**
 * Resolve `--video-edition`/`--video-url` contra o disco. `fallbackTitle` é o
 * título do D1 quando o registro do upload não tem título. Sem `--video-edition`,
 * `--video-url` procura a edição pelo id do vídeo.
 */
export function resolveVideoOverride(opts: {
  editionsRoot: string;
  videoEdition?: string;
  videoUrl?: string;
  fallbackTitle?: (aammdd: string) => string;
}): ResolveVideoOverrideResult {
  const edition = (opts.videoEdition ?? "").trim();
  const urlArg = (opts.videoUrl ?? "").trim();
  if (!edition && !urlArg) return { ok: false, error: "informe --video-edition AAMMDD ou --video-url URL" };
  if (edition && !/^\d{6}$/.test(edition)) return { ok: false, error: `--video-edition inválido: ${edition} (esperado AAMMDD)` };
  const urlId = urlArg ? extractYouTubeVideoId(urlArg) : null;
  if (urlArg && !urlId) return { ok: false, error: `--video-url não é uma URL de vídeo do YouTube: ${urlArg}` };

  let aammdd = edition;
  if (!aammdd) {
    const dates = [...enumerateEditionDirs(opts.editionsRoot).keys()].sort();
    const hit = collectEditionVideos(dates, (d) => resolveEditionDir(opts.editionsRoot, d)).find((r) => r.videoId === urlId);
    if (!hit) return { ok: false, error: `nenhuma edição em ${opts.editionsRoot} tem o vídeo ${urlId} — passe também --video-edition AAMMDD` };
    aammdd = hit.aammdd;
  }
  const meta = readEditionVideoMeta(resolveEditionDir(opts.editionsRoot, aammdd));
  if (!meta) return { ok: false, error: `edição ${aammdd} sem vídeo (05-video-url.txt ausente, inválido ou edição marcada sem vídeo)` };
  if (urlId && urlId !== meta.videoId) {
    return { ok: false, error: `--video-url (${urlId}) não é o vídeo da edição ${aammdd} (${meta.videoId})` };
  }
  const title = (meta.title ?? "").trim() || (opts.fallbackTitle?.(aammdd) ?? "").trim();
  if (!title) return { ok: false, error: `edição ${aammdd} sem título do vídeo (05-youtube-published.json) nem D1 para usar no lugar` };
  return { ok: true, video: { title, url: meta.videoUrl, editionDate: aammdd }, marker: { editionDate: aammdd, url: meta.videoUrl } };
}

/** Pure: lê o marcador gravado numa seleção anterior, ou `null`. */
export function readVideoOverrideMarker(selection: unknown): WeeklyVideoOverrideMarker | null {
  if (!selection || typeof selection !== "object") return null;
  const m = (selection as { videoOverride?: unknown }).videoOverride as Record<string, unknown> | null | undefined;
  if (!m || typeof m.editionDate !== "string" || typeof m.url !== "string") return null;
  return { editionDate: m.editionDate, url: m.url };
}

/**
 * Pure: aplica o override a uma seleção. Descarta `pitch`/`description` do vídeo
 * anterior (o texto era sobre OUTRO vídeo) e devolve o que foi invalidado.
 */
export function applyVideoOverride<T extends Record<string, unknown>>(
  selection: T,
  resolved: { video: OverriddenVideo; marker: WeeklyVideoOverrideMarker },
): { selection: T & { video: OverriddenVideo; videoOverride: WeeklyVideoOverrideMarker }; invalidated: string[] } {
  const prev = (selection.video ?? null) as { editionDate?: string; url?: string; pitch?: string; description?: string } | null;
  const invalidated: string[] = [];
  if (prev && (prev.url !== resolved.video.url || prev.editionDate !== resolved.video.editionDate)) {
    if (prev.pitch) invalidated.push("video.pitch (frase do vídeo, #13045)");
    if (prev.description) invalidated.push("video.description (descrição do vídeo da Stack, #12549)");
    return { selection: { ...selection, video: resolved.video, videoOverride: resolved.marker }, invalidated };
  }
  // Mesmo vídeo: mantém o texto já escrito.
  return {
    selection: { ...selection, video: { ...(prev ?? {}), ...resolved.video }, videoOverride: resolved.marker } as never,
    invalidated,
  };
}
