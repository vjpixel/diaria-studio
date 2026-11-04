/**
 * scripts/lib/top-edition-video.ts (#12081)
 *
 * "O vídeo mais visto" de um conjunto de edições: o horizontal do D1 com mais
 * views no YouTube entre as edições de um período. Usado pelo post semanal da
 * Stack e pela newsletter semanal do LinkedIn (vídeo da semana) e pela mensal
 * (vídeo do mês) — decisão do editor de 03/11/2026 na #12081.
 *
 * Os vídeos vêm do disco de cada edição (`readEditionVideoMeta`: só edição com
 * `_internal/05-video-url.txt`, sem marcador de sem-vídeo). As views vêm da
 * YouTube Data API (`videos.list?part=statistics`, só leitura, mesmo token do
 * upload — `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`YOUTUBE_REFRESH_TOKEN`).
 *
 * Fail-soft: sem credencial, sem rede ou com erro da API, devolve `null` e
 * avisa no log — a superfície sai sem a linha do vídeo, nunca com um vídeo
 * escolhido sem medição (o editor pediu o MAIS VISTO, não "algum vídeo").
 */

import { readEditionVideoMeta } from "./edition-video-meta.ts";
import {
  YOUTUBE_API_BASE,
  refreshYouTubeAccessToken,
  type FetchLike,
} from "./diaria/youtube-upload.ts";

export interface EditionVideoRef {
  aammdd: string;
  videoId: string;
  videoUrl: string;
  /** Título do vídeo (registro do upload), ou `null`. */
  title: string | null;
}

export interface TopEditionVideo extends EditionVideoRef {
  views: number;
}

/** Vídeos das edições, na ordem dada, sem repetir o mesmo vídeo. */
export function collectEditionVideos(aammdds: readonly string[], dirFor: (aammdd: string) => string): EditionVideoRef[] {
  const seen = new Set<string>();
  const out: EditionVideoRef[] = [];
  for (const aammdd of aammdds) {
    const meta = readEditionVideoMeta(dirFor(aammdd));
    if (!meta || seen.has(meta.videoId)) continue;
    seen.add(meta.videoId);
    out.push({ aammdd, videoId: meta.videoId, videoUrl: meta.videoUrl, title: meta.title });
  }
  return out;
}

/**
 * Pure: o mais visto. Vídeo sem contagem (privado, removido, fora da resposta)
 * não concorre; empate fica com a edição mais recente (o vídeo novo ainda está
 * acumulando views). `null` sem nenhum vídeo medido.
 */
export function pickTopVideo(refs: readonly EditionVideoRef[], views: ReadonlyMap<string, number>): TopEditionVideo | null {
  let best: TopEditionVideo | null = null;
  for (const r of refs) {
    const v = views.get(r.videoId);
    if (v === undefined) continue;
    if (!best || v > best.views || (v === best.views && r.aammdd > best.aammdd)) best = { ...r, views: v };
  }
  return best;
}

/** `videos.list?part=statistics` em lotes de 50 ids. Lança em erro HTTP. */
export async function fetchVideoViewCounts(fetch: FetchLike, token: string, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(`${YOUTUBE_API_BASE}/videos?part=statistics&id=${batch.map(encodeURIComponent).join(",")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`videos.list (statistics) devolveu HTTP ${res.status}`);
    const json = (await res.json()) as { items?: Array<{ id?: string; statistics?: { viewCount?: string } }> };
    for (const item of json.items ?? []) {
      const n = Number(item.statistics?.viewCount);
      if (item.id && Number.isFinite(n)) out.set(item.id, n);
    }
  }
  return out;
}

export interface ResolveTopEditionVideoInput {
  aammdds: readonly string[];
  dirFor: (aammdd: string) => string;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  log?: (m: string) => void;
}

/** Credenciais de LEITURA (o id do canal não é necessário para ler views). */
export function missingYouTubeReadCredentials(env: Record<string, string | undefined>): string[] {
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"].filter((k) => !(env[k] ?? "").trim());
}

/** O vídeo mais visto das edições, ou `null` (sem vídeo, sem credencial, erro). */
export async function resolveTopEditionVideo(input: ResolveTopEditionVideoInput): Promise<TopEditionVideo | null> {
  const log = input.log ?? ((m: string) => console.warn(m));
  const refs = collectEditionVideos(input.aammdds, input.dirFor);
  if (refs.length === 0) {
    log("[top-video] nenhuma edição do período com vídeo — sem linha do vídeo");
    return null;
  }
  const missing = missingYouTubeReadCredentials(input.env);
  if (missing.length > 0) {
    log(`[top-video] sem ${missing.join(", ")} — views não medidas, sem linha do vídeo`);
    return null;
  }
  const fetch: FetchLike = input.fetch ?? ((url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }));
  try {
    const token = await refreshYouTubeAccessToken(
      { fetch, now: () => new Date() },
      {
        clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      },
    );
    const views = await fetchVideoViewCounts(fetch, token, refs.map((r) => r.videoId));
    const top = pickTopVideo(refs, views);
    if (!top) log("[top-video] a API não devolveu views para os vídeos do período — sem linha do vídeo");
    return top;
  } catch (e) {
    log(`[top-video] views não lidas (${(e as Error).message}) — sem linha do vídeo`);
    return null;
  }
}
