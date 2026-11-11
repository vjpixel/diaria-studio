/**
 * scripts/lib/onboarding-top-video.ts (#12542)
 *
 * "O mais assistido até agora" do e-mail 2 do onboarding. A frase vivia fixa
 * no snippet (`data/snippets/onboarding-2.md`) e ficava falsa assim que outro
 * vídeo passasse o citado em views, sem ninguém ver. Agora o snippet traz o
 * placeholder `{{VIDEO_MAIS_ASSISTIDO}}`, resolvido no envio a partir do
 * registro que `scripts/measure-top-youtube-video.ts` grava (task semanal
 * `Diaria-Top-YouTube-Video-Measure`).
 *
 * Fail-soft em camadas, e o placeholder cru nunca sai:
 *   1. registro válido → link do vídeo medido;
 *   2. registro ausente/ilegível → `FALLBACK_TOP_VIDEO` (o último valor
 *      conhecido antes da medição existir, o mesmo que estava fixo no texto);
 *   3. a medição que falha (sem credencial, sem rede) não reescreve o registro,
 *      então o último valor medido continua valendo.
 *
 * Puro, salvo `readTopVideoRecord` (leitura fail-soft do disco).
 */

import { existsSync, readFileSync } from "node:fs";

/** Marcador no corpo do snippet, trocado pelo link do vídeo no envio. */
export const VIDEO_MAIS_ASSISTIDO_PLACEHOLDER = "{{VIDEO_MAIS_ASSISTIDO}}";

/** Registro gravado pela medição, relativo à raiz do repo. */
export const TOP_VIDEO_RECORD_RELPATH = "data/youtube/top-video.json";

export interface TopVideoLink {
  title: string;
  url: string;
}

/** Registro completo gravado pela medição (o envio só usa título e URL). */
export interface TopVideoRecord extends TopVideoLink {
  video_id: string;
  edition: string;
  views: number;
  measured_at: string;
}

/**
 * Último valor conhecido antes da medição automática (o texto fixo do
 * e-mail 2 até a #12542). Usado só quando não há registro legível.
 */
export const FALLBACK_TOP_VIDEO: TopVideoLink = {
  title: "Lula promete uma IA brasileira",
  url: "https://youtu.be/OCtGv0f_6sg",
};

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Título do vídeo como entra na frase: sem o sufixo de série que alguns
 * uploads carregam ("… | diar.ia.br comentada #3").
 */
export function cleanTopVideoTitle(raw: string): string {
  return raw.replace(/\s*\|\s*diar\.ia\.br\s+comentada\b.*$/i, "").trim();
}

/** Pure: registro lido do disco → título + URL, ou `null` se inválido. */
export function parseTopVideoRecord(raw: unknown): TopVideoLink | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? cleanTopVideoTitle(r.title) : "";
  const id = typeof r.video_id === "string" ? r.video_id.trim() : "";
  if (!title || !VIDEO_ID_RE.test(id)) return null;
  return { title, url: `https://youtu.be/${id}` };
}

/** Leitura fail-soft do registro: ausente, ilegível ou inválido → `null`. */
export function readTopVideoRecord(path: string): TopVideoLink | null {
  if (!existsSync(path)) return null;
  try {
    return parseTopVideoRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Link do vídeo no mesmo formato dos demais links do snippet. */
export function renderTopVideoLink(v: TopVideoLink): string {
  return (
    `<a target="_blank" rel="noopener noreferrer nofollow" class="link" href="${escapeHtml(v.url)}">` +
    `${escapeHtml(v.title)}</a>`
  );
}

/**
 * Pure: troca toda ocorrência do placeholder pelo link do vídeo (`topVideo`,
 * ou o fallback quando `null`/ausente). Texto sem o placeholder volta igual.
 */
export function resolveTopVideoPlaceholder(body: string, topVideo?: TopVideoLink | null): string {
  if (!body.includes(VIDEO_MAIS_ASSISTIDO_PLACEHOLDER)) return body;
  const link = renderTopVideoLink(topVideo ?? FALLBACK_TOP_VIDEO);
  return body.split(VIDEO_MAIS_ASSISTIDO_PLACEHOLDER).join(link);
}

/** Pure: monta o registro a gravar, ou `null` sem título utilizável. */
export function buildTopVideoRecord(
  top: { aammdd: string; videoId: string; title: string | null; views: number } | null,
  now: Date,
): TopVideoRecord | null {
  if (!top || !VIDEO_ID_RE.test(top.videoId)) return null;
  const title = cleanTopVideoTitle(top.title ?? "");
  if (!title) return null;
  return {
    title,
    url: `https://youtu.be/${top.videoId}`,
    video_id: top.videoId,
    edition: top.aammdd,
    views: top.views,
    measured_at: now.toISOString(),
  };
}
