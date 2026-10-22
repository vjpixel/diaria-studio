/**
 * scripts/lib/diaria/youtube-video-link-gate.ts (#10858)
 *
 * Portão entre o upload do vídeo diário (`publish-youtube.ts --upload`,
 * #10659) e o link do vídeo no post do D1 (`_internal/05-video-url.txt`,
 * #10772): só vira link no D1 o vídeo que o leitor consegue abrir.
 *
 * Sem a auditoria do YouTube API Services o upload via API pode sair travado
 * em `private`; copiar a `url` do registro para o D1 publicaria um link que o
 * leitor não abre. Regra (estado RELIDO, nunca o pedido — #573):
 *   - `published` (público) → pode;
 *   - `scheduled` (privado com `publishAt` futuro) → pode só se o `publishAt`
 *     não passar do horário do post do D1 do dia (o 1º post que leva o link);
 *   - `draft` (privado sem agendamento), `unknown` ou qualquer outro → não.
 *
 * Premissa: o "primeiro slot social" do #10858 é o do post do D1 —
 * `resolveDailyPostTime(…, "d1")`, rotação do #10305 incluída — porque é o
 * único post que recebe o link (#10772). O post do Use Melhor sai antes,
 * mas não leva o vídeo.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatCivilDate,
  publishDateForEdition,
  resolveDailyPostTime,
} from "../social-schedule-rotation.ts";
import { extractYouTubeVideoId } from "./d1-video-link.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";

/** Offset de America/Sao_Paulo (sem horário de verão desde 2019). */
const BRT_OFFSET = "-03:00";

export type VideoLinkVerdict = { ok: true; reason: string } | { ok: false; reason: string };

/** Pure: o vídeo nesse estado relido pode virar link no D1? */
export function videoLinkEligibility(input: {
  state: string | null | undefined;
  publishAt: string | null | undefined;
  /** Horário do post do D1; `null` = desconhecido (então `scheduled` não passa). */
  d1SlotAt: Date | null;
}): VideoLinkVerdict {
  const state = input.state ?? "unknown";
  if (state === "published") return { ok: true, reason: "vídeo público" };
  if (state === "scheduled") {
    const at = input.publishAt ? Date.parse(input.publishAt) : NaN;
    if (!Number.isFinite(at)) {
      return { ok: false, reason: "vídeo agendado sem publishAt legível — não dá para garantir que fica público antes do D1" };
    }
    if (!input.d1SlotAt) {
      return { ok: false, reason: `vídeo agendado para ${input.publishAt}, mas o horário do post do D1 é desconhecido` };
    }
    if (at <= input.d1SlotAt.getTime()) {
      return { ok: true, reason: `vídeo agendado para ${input.publishAt}, antes do post do D1 (${input.d1SlotAt.toISOString()})` };
    }
    return {
      ok: false,
      reason: `vídeo agendado para ${input.publishAt}, DEPOIS do post do D1 (${input.d1SlotAt.toISOString()}) — o link sairia antes do vídeo abrir`,
    };
  }
  if (state === "draft") {
    return { ok: false, reason: "vídeo privado sem agendamento (provável trava da auditoria do YouTube API Services) — o leitor não abre o link" };
  }
  return { ok: false, reason: `estado do vídeo não confirmado (${state}) — confira no YouTube Studio` };
}

/**
 * Pure: horário (BRT) do post do D1 da edição `aammdd`, pela mesma conta dos
 * publicadores (`day_offset` + rotação do #10305). `null` se não der para
 * derivar (edição inválida, D1 sem horário no config).
 */
export function d1SocialSlotAt(aammdd: string, social: Record<string, unknown> | null | undefined): Date | null {
  const date = publishDateForEdition(aammdd, social);
  if (!date) return null;
  const { time } = resolveDailyPostTime(social, date, "d1");
  if (!time) return null;
  const d = new Date(`${formatCivilDate(date)}T${time}:00${BRT_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** O que o gate lê de `_internal/05-youtube-published.json`. */
export interface YouTubeRecordSummary {
  videoId: string | null;
  url: string | null;
  state: string | null;
  publishAt: string | null;
  /** `in_progress`/`upload_indeterminado` — upload sem vídeo confirmado. */
  sentinel: string | null;
  path: string;
}

/**
 * Lê o registro do upload. `null` se o arquivo não existe; lança se existe e
 * não é JSON (registro corrompido não pode virar "sem registro" e liberar o link).
 */
export function readYouTubeRecordSummary(editionDir: string): YouTubeRecordSummary | null {
  const path = join(editionDir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path} ilegível (${(e as Error).message}) — confira o registro do upload`);
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const reread = (raw.rereadStatus ?? null) as { publishAt?: unknown } | null;
  const requested = (raw.requested ?? null) as { publishAt?: unknown } | null;
  const status = str(raw.status);
  return {
    videoId: str(raw.videoId),
    url: str(raw.url),
    state: str(raw.state),
    publishAt: str(reread?.publishAt) ?? str(requested?.publishAt),
    sentinel: status === "in_progress" || status === "upload_indeterminado" ? status : null,
    path,
  };
}

export interface VideoLinkGate {
  ok: boolean;
  reason: string;
  /** O registro do upload é deste vídeo (mesmo id)? */
  record_matched: boolean;
}

/**
 * Pure: decide se `videoUrl` pode virar link no D1, dado o registro do upload.
 * Sem registro deste vídeo (upload à mão no Studio, ou outro vídeo) o gate não
 * tem o que conferir e libera — a responsabilidade é de quem passou a URL.
 */
export function gateVideoLink(input: {
  videoUrl: string;
  record: YouTubeRecordSummary | null;
  d1SlotAt: Date | null;
}): VideoLinkGate {
  const id = extractYouTubeVideoId(input.videoUrl);
  const rec = input.record;
  if (!rec || !rec.videoId || rec.videoId !== id) {
    return {
      ok: true,
      record_matched: false,
      reason: rec?.sentinel
        ? `registro do upload em estado incerto (${rec.sentinel}) e sem este vídeo — confira no Studio que o vídeo é público`
        : "sem registro de upload deste vídeo — confira no Studio que ele é público",
    };
  }
  const v = videoLinkEligibility({ state: rec.state, publishAt: rec.publishAt, d1SlotAt: input.d1SlotAt });
  return { ok: v.ok, reason: v.reason, record_matched: true };
}
