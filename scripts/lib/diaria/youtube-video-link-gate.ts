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
 *   - `scheduled` (privado com `publishAt` futuro) → com o projeto GCP
 *     auditado (`YOUTUBE_API_PROJECT_AUDITED`, #10865), pode se o `publishAt`
 *     for até o horário do post do D1 do dia (o 1º post que leva o link). Sem
 *     auditoria, pode se o `publishAt` for igual ou anterior ao envio da
 *     newsletter do D1 (06:00 BRT do dia, ou o `scheduled_at` do broadcast em
 *     `_internal/05-published.json`), com aviso (#11548, decisão do editor de
 *     28/10/2026: não recusar o vídeo agendado para o mesmo horário do D1).
 *     `publishAt` depois do envio continua recusado, e o link fica para
 *     `link-video-d1.ts --assume-public`, depois de o editor conferir no Studio;
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
import { DEFAULT_EDITION_SCHEDULE_HHMM, resolveEditionScheduledAt } from "../edition-scheduled-at.ts";
import { extractYouTubeVideoId } from "./d1-video-link.ts";
import { YOUTUBE_API_PROJECT_AUDITED } from "./youtube-video.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./youtube-upload.ts";

/** Offset de America/Sao_Paulo (sem horário de verão desde 2019). */
const BRT_OFFSET = "-03:00";

/**
 * `warning` (#11548): o link passou com uma premissa que vale dizer (agendado
 * sem a auditoria, até o envio da newsletter do D1).
 */
export type VideoLinkVerdict = { ok: true; reason: string; warning?: string } | { ok: false; reason: string };

/** Pure: o vídeo nesse estado relido pode virar link no D1? */
export function videoLinkEligibility(input: {
  state: string | null | undefined;
  publishAt: string | null | undefined;
  /** Horário do post do D1; `null` = desconhecido (então `scheduled` não passa). */
  d1SlotAt: Date | null;
  /**
   * Projeto GCP auditado? Default `YOUTUBE_API_PROJECT_AUDITED` (#10865). Sem
   * auditoria `scheduled` não passa: o `publishAt` pode não tornar o vídeo
   * público (`resolveEffectiveVisibility`).
   */
  projectAudited?: boolean;
  /**
   * #11548: envio da newsletter do D1 (`newsletterSendAt`). Sem auditoria, o
   * vídeo agendado até esse horário passa com aviso. `null`/ausente = recusa
   * como antes (#10865).
   */
  newsletterSendAt?: Date | null;
}): VideoLinkVerdict {
  const state = input.state ?? "unknown";
  if (state === "published") return { ok: true, reason: "vídeo público" };
  if (state === "scheduled") {
    const at = input.publishAt ? Date.parse(input.publishAt) : NaN;
    if (!(input.projectAudited ?? YOUTUBE_API_PROJECT_AUDITED)) {
      const send = input.newsletterSendAt ?? null;
      if (send && Number.isFinite(at) && at <= send.getTime()) {
        return {
          ok: true,
          reason: `vídeo agendado para ${input.publishAt}, até o envio da newsletter do D1 (${send.toISOString()})`,
          warning:
            `agendado para o mesmo horário do D1 (${input.publishAt}, envio ${send.toISOString()}), sem a auditoria do YouTube API Services — ` +
            "link gravado sem --assume-public (#11548); se o vídeo não abrir depois do horário, publique no Studio",
        };
      }
      const after = send && Number.isFinite(at) ? `, DEPOIS do envio da newsletter do D1 (${send.toISOString()})` : "";
      return {
        ok: false,
        reason:
          `vídeo agendado para ${input.publishAt ?? "?"}${after}, e o projeto GCP não tem a auditoria do YouTube API Services — ` +
          "o agendamento pode não torná-lo público; confira no YouTube Studio que ele abre (#10865)",
      };
    }
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

/** Registro do Stage 5 da newsletter (`scheduled_at` do broadcast, #11548). */
export const NEWSLETTER_PUBLISHED_FILE = join("_internal", "05-published.json");

/**
 * #11548: horário de envio da newsletter do D1 — o `scheduled_at` do
 * broadcast em `_internal/05-published.json` quando existe e é legível; senão
 * o horário padrão da edição (06:00 BRT do dia, `resolveEditionScheduledAt`).
 * O vídeo costuma ser linkado ANTES do Stage 5, então o default é o caso
 * comum. Registro ilegível cai no default com `source` dizendo isso: o horário
 * só decide se um agendamento passa com aviso, nunca libera vídeo privado.
 */
export function newsletterSendAt(editionDir: string, aammdd: string): { at: Date | null; source: string } {
  const path = join(editionDir, NEWSLETTER_PUBLISHED_FILE);
  let note = "";
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { scheduled_at?: unknown };
      if (typeof raw.scheduled_at === "string" && Number.isFinite(Date.parse(raw.scheduled_at))) {
        return { at: new Date(raw.scheduled_at), source: `scheduled_at do broadcast (${path})` };
      }
    } catch (e) {
      note = ` (${path} ilegível: ${(e as Error).message})`;
    }
  }
  try {
    return { at: new Date(resolveEditionScheduledAt(aammdd)), source: `horário padrão da edição, ${DEFAULT_EDITION_SCHEDULE_HHMM} BRT${note}` };
  } catch {
    return { at: null, source: `edição inválida${note}` };
  }
}

/** O que o gate lê de `_internal/05-youtube-published.json`. */
export interface YouTubeRecordSummary {
  videoId: string | null;
  url: string | null;
  state: string | null;
  publishAt: string | null;
  /** `in_progress`/`upload_indeterminado` — upload sem vídeo confirmado. */
  sentinel: string | null;
  /**
   * `audit_blocked` gravado pelo upload (#10881 item 2): o plano previa o
   * rebaixamento pra private por falta da auditoria. `null` em registro sem o
   * campo (o gate cai na constante `YOUTUBE_API_PROJECT_AUDITED`).
   */
  auditBlocked: boolean | null;
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
    auditBlocked: typeof raw.audit_blocked === "boolean" ? raw.audit_blocked : null,
    path,
  };
}

export interface VideoLinkGate {
  ok: boolean;
  reason: string;
  /** O registro do upload é deste vídeo (mesmo id)? */
  record_matched: boolean;
  /** #11548: passou com premissa (agendado sem auditoria até o envio do D1). */
  warning?: string;
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
  /**
   * Default: o `audit_blocked` do registro do upload, quando existe (#10881
   * item 2 — a mesma premissa com que `publish-youtube.ts` gravou o link);
   * sem ele, `YOUTUBE_API_PROJECT_AUDITED` (#10865).
   */
  projectAudited?: boolean;
  /** #11548: envio da newsletter do D1 (`newsletterSendAt`). */
  newsletterSendAt?: Date | null;
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
  const v = videoLinkEligibility({
    state: rec.state,
    publishAt: rec.publishAt,
    d1SlotAt: input.d1SlotAt,
    projectAudited: input.projectAudited ?? (rec.auditBlocked == null ? undefined : !rec.auditBlocked),
    newsletterSendAt: input.newsletterSendAt ?? null,
  });
  return { ok: v.ok, reason: v.reason, record_matched: true, ...(v.ok && v.warning ? { warning: v.warning } : {}) };
}

/**
 * Pure: instrução de "o que fazer" quando o link é recusado (#10881 item 2).
 * Sem a auditoria do YouTube API Services, agendar antes do D1 não resolve
 * (#10866: o `publishAt` pode nunca tornar o vídeo público) — só publicar à
 * mão no Studio.
 */
export function videoLinkRemedy(projectAudited: boolean): string {
  return projectAudited
    ? "Publique (ou agende antes do post do D1) no YouTube Studio"
    : "Publique o vídeo no YouTube Studio (agendar não resolve sem a auditoria do YouTube API Services, #10866)";
}
