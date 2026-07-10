/**
 * lib/video-youtube-resolve.ts (#3202)
 *
 * Resolve itens do bucket `video` cuja URL NÃO é do YouTube para a URL
 * canônica do YouTube equivalente, usando resultados de busca já coletados
 * (`discovery-searcher` scoped a `site:youtube.com`, disparado pelo
 * orchestrator — ver `.claude/agents/orchestrator-stage-1-research.md`
 * passo 1m-quinquies).
 *
 * Motivação (#3202): na 260709 o editor pediu o vídeo "Introducing GPT-Live".
 * A página oficial da OpenAI (que hospeda a livestream) bloqueou o bot (403)
 * e não havia URL de YouTube canônica verificável — o orchestrator acabou
 * usando a própria página oficial (mesma URL do D1, gerando duplicação), até
 * o editor fornecer manualmente o link do YouTube. Regra editorial nova
 * (`context/editorial-rules.md` — Seção "Vídeos"): itens de VÍDEOS usam
 * SEMPRE link do YouTube.
 *
 * Este módulo é puro/determinístico — NÃO faz a busca (isso é responsabilidade
 * do orchestrator via `discovery-searcher`/WebSearch, scoped a youtube.com).
 * Recebe candidatos JÁ buscados e decide, por similaridade de título
 * (`subjectSimilarity` — mesmo helper usado pelo dedup), se algum é uma
 * correspondência confiável o bastante pra substituir a URL.
 *
 * Princípio invariável (CLAUDE.md — nunca fabricar URL): se nenhum candidato
 * bate com confiança, o item NUNCA cai de volta pra URL não-YouTube
 * silenciosamente — fica marcado `video_url_unverified: true` pra o
 * orchestrator flagar no gate humano ("vídeo sem URL de YouTube verificável —
 * cole o link").
 */

import { subjectSimilarity } from "./title-similarity.ts";

/**
 * Threshold de confiança pro Jaccard de título (mesma escala de
 * `subjectSimilarity` — 0 a 1). Candidato precisa ter ≥ este score contra o
 * título do artigo original pra ser aceito como "o mesmo vídeo". Mais
 * permissivo que o 0.6 usado pelo dedup de tema (aqui os títulos costumam
 * divergir mais — ex: "Introducing GPT-Live" (artigo) vs "Introducing
 * GPT-Live | OpenAI" (YouTube) — mas ainda alto o bastante pra recusar
 * matches genéricos ("OpenAI livestream", "AI news roundup").
 */
export const YOUTUBE_MATCH_THRESHOLD = 0.34;

export interface VideoSearchCandidate {
  url: string;
  title?: string;
  source_name?: string;
  [key: string]: unknown;
}

export interface VideoArticleLike {
  url: string;
  title?: string;
  video_url_resolved?: { from: string; to: string; matched_title?: string; score?: number };
  video_url_unverified?: boolean;
  video_url_search_reason?: string;
  [key: string]: unknown;
}

/**
 * Retorna true se a URL é uma URL de vídeo do YouTube (`youtube.com/watch`
 * ou `youtu.be`). Deliberadamente MAIS ESTRITO que `isVideoUrl` de
 * `launch-heuristics.ts` (que também aceita `vimeo.com` — usado só pra
 * categorização inicial em `video`, não pra validação final da seção). A
 * regra editorial #3202 exige especificamente YouTube.
 */
export function isYoutubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return true;
    if (host === "youtube.com" && u.pathname.startsWith("/watch")) return true;
    return false;
  } catch {
    return false;
  }
}

export type VideoMatchResult =
  | {
      matched: true;
      url: string;
      title?: string;
      score: number;
    }
  | {
      matched: false;
      reason: string;
      bestScore?: number;
    };

/**
 * Escolhe o melhor candidato de busca (já filtrado ou não por domínio) que
 * seja: (a) uma URL de YouTube válida, (b) com título suficientemente
 * similar ao título do artigo original (>= YOUTUBE_MATCH_THRESHOLD).
 *
 * Pure — não faz I/O nem network. `candidates` já vem da busca feita pelo
 * caller (discovery-searcher/WebSearch scoped a site:youtube.com).
 */
export function pickBestYoutubeCandidate(
  articleTitle: string,
  candidates: VideoSearchCandidate[],
  threshold: number = YOUTUBE_MATCH_THRESHOLD,
): VideoMatchResult {
  const youtubeCandidates = candidates.filter((c) => isYoutubeUrl(c.url));
  if (youtubeCandidates.length === 0) {
    return {
      matched: false,
      reason: candidates.length === 0
        ? "busca não retornou nenhum candidato"
        : "nenhum candidato retornado está em youtube.com/youtu.be",
    };
  }

  let best: { candidate: VideoSearchCandidate; score: number } | null = null;
  for (const c of youtubeCandidates) {
    const score = subjectSimilarity(articleTitle, c.title ?? "");
    if (!best || score > best.score) {
      best = { candidate: c, score };
    }
  }

  if (!best || best.score < threshold) {
    return {
      matched: false,
      reason:
        `melhor candidato YouTube não bateu o threshold de confiança ` +
        `(score ${(best?.score ?? 0).toFixed(2)} < ${threshold})`,
      bestScore: best?.score,
    };
  }

  return {
    matched: true,
    url: best.candidate.url,
    title: best.candidate.title,
    score: best.score,
  };
}

/**
 * Resolve UM artigo de vídeo: se já é YouTube, no-op. Senão, tenta achar um
 * candidato confiável em `candidates` — se achar, substitui a URL e anota
 * `video_url_resolved`; se não achar, marca `video_url_unverified: true`
 * (NUNCA fabrica/mantém a URL não-YouTube silenciosamente — o orchestrator
 * usa essa flag pra bloquear/avisar no gate).
 *
 * Pure — retorna um NOVO objeto (não muta `article`).
 */
export function resolveVideoArticle<T extends VideoArticleLike>(
  article: T,
  candidates: VideoSearchCandidate[],
): T {
  if (isYoutubeUrl(article.url)) {
    return article;
  }

  const match = pickBestYoutubeCandidate(article.title ?? "", candidates);

  if (match.matched) {
    const updated = { ...article };
    updated.video_url_resolved = {
      from: article.url,
      to: match.url,
      matched_title: match.title,
      score: match.score,
    };
    updated.url = match.url;
    delete updated.video_url_unverified;
    delete updated.video_url_search_reason;
    return updated;
  }

  const updated = { ...article };
  updated.video_url_unverified = true;
  updated.video_url_search_reason = match.reason;
  return updated;
}

export interface ResolveVideoBucketResult<T extends VideoArticleLike> {
  articles: T[];
  resolved: Array<{ from: string; to: string; title?: string; score: number }>;
  flagged: Array<{ url: string; title?: string; reason: string }>;
  alreadyYoutube: number;
}

/**
 * Resolve todo o bucket `video`. `searchResultsByUrl` mapeia a URL ORIGINAL
 * (pré-resolução) do artigo pros candidatos de busca já coletados pro
 * orchestrator (chave ausente = busca não foi disparada/retornou vazio —
 * tratado como "sem candidatos", item cai em flagged).
 */
export function resolveVideoBucket<T extends VideoArticleLike>(
  videoBucket: T[],
  searchResultsByUrl: Record<string, VideoSearchCandidate[]>,
): ResolveVideoBucketResult<T> {
  const articles: T[] = [];
  const resolved: ResolveVideoBucketResult<T>["resolved"] = [];
  const flagged: ResolveVideoBucketResult<T>["flagged"] = [];
  let alreadyYoutube = 0;

  for (const article of videoBucket) {
    if (isYoutubeUrl(article.url)) {
      alreadyYoutube++;
      articles.push(article);
      continue;
    }
    const candidates = searchResultsByUrl[article.url] ?? [];
    const updated = resolveVideoArticle(article, candidates);
    articles.push(updated);
    if (updated.video_url_resolved) {
      resolved.push({
        from: updated.video_url_resolved.from,
        to: updated.video_url_resolved.to,
        title: updated.video_url_resolved.matched_title,
        score: updated.video_url_resolved.score ?? 0,
      });
    } else if (updated.video_url_unverified) {
      flagged.push({
        url: article.url,
        title: article.title,
        reason: updated.video_url_search_reason ?? "sem motivo registrado",
      });
    }
  }

  return { articles, resolved, flagged, alreadyYoutube };
}
