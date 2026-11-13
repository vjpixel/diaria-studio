/**
 * scripts/lib/diaria/short-published-update.ts (#12936)
 *
 * Miolo do `publish-shorts.ts (AAMMDD | --corte SLUG) --update-published`:
 * troca o TEXTO de um vertical que JÁ ESTÁ NO AR. Em 12/11/2026 (corte
 * `jensen-huang-261112`) isso saiu à mão, destino por destino; o
 * `--update-scheduled` (#11795) recusa o que já foi publicado por desenho, e
 * o `--cancel`/`--reschedule` (#13000) nunca tocam post no ar.
 *
 * O que cada destino registrado como publicado recebe:
 *   - `youtube_shorts`: `videos.update` do título e da descrição, com releitura
 *     (`updatePublishedVideoText` em `youtube-upload.ts`); vídeo ainda agendado
 *     é do `--update-scheduled`;
 *   - `facebook:{slug}`: `POST /{video-id}` com a descrição, relida depois;
 *   - `linkedin_profile` com URN de post: `PARTIAL_UPDATE` do `commentary`. O
 *     token não lê o post (`GET` dá 403), então o resultado volta como
 *     `done_unverified` e o título do vídeo (fora do que a Posts API edita)
 *     fica o antigo;
 *   - Instagram: só pela UI (Gerenciar post → Editar), o plano devolve o texto;
 *   - Threads pessoal: só pela UI e só até 15 min depois de publicar;
 *   - X (sem plano Plus na @diariabr) e TikTok: não editam depois de publicar;
 *   - o repost da página herda o texto do perfil (nada a fazer).
 * Envio ambíguo, agendamento cancelado ou ainda no futuro: fora, com o motivo.
 *
 * O plano é puro (`planPublishedTextUpdates`); o executor recebe o I/O
 * injetado (`executePublishedTextUpdates`) e uma falha não para os outros.
 */

import { resolveShortEntryState } from "../publish-state.ts";
import {
  buildReelsCaption,
  buildShortSocialText,
  buildYouTubeShortMetadata,
  diariaFollowLine,
  type DiariaProfiles,
  type ShortD1Input,
  type ShortPublishedEntry,
} from "./short-video.ts";

/** O Threads só deixa editar o post até 15 min depois da publicação (pela UI). */
export const THREADS_EDIT_WINDOW_MS = 15 * 60_000;

const LINKEDIN_POST_URN_RE = /^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/;

export type PublishedUpdateItem =
  | { destination: string; action: "api_youtube"; videoId: string; title: string; description: string }
  | { destination: string; action: "api_facebook"; slug: string; videoId: string; description: string }
  | { destination: string; action: "api_linkedin"; postUrn: string; text: string; note: string }
  /** Só pela UI da plataforma (Claude in Chrome ou app): o texto novo vai no plano. */
  | { destination: string; action: "ui"; text: string; how: string; url?: string }
  /** A plataforma não edita o post depois de publicado (ou a janela passou). */
  | { destination: string; action: "not_editable"; reason: string }
  | { destination: string; action: "skip"; reason: string };

/** Pure: o que o `--update-published` faria em cada destino registrado. */
export function planPublishedTextUpdates(input: {
  entries: readonly ShortPublishedEntry[];
  d1: ShortD1Input;
  now: Date;
  /** Título do horizontal citado na descrição do Short (#12191); `null` = sem citação (corte). */
  horizontalTitle?: string | null;
  /** Link do horizontal (#12735) no Facebook e no LinkedIn; `null` = sem link. */
  horizontalLink?: string | null;
  diariaProfiles?: DiariaProfiles;
  only?: readonly string[] | null;
  /** Ids que o config conhece: `--only` com nome fora deles e do registro lança. */
  known?: ReadonlySet<string>;
}): PublishedUpdateItem[] {
  const only = input.only && input.only.length ? new Set(input.only) : null;
  if (only && input.known) {
    const valid = new Set([...input.known, ...input.entries.map((e) => e.destination)]);
    const unknown = [...only].filter((d) => !valid.has(d));
    if (unknown.length) throw new Error(`--only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...valid].join(", ")})`);
  }
  const nowMs = input.now.getTime();
  const out: PublishedUpdateItem[] = [];
  for (const e of input.entries) {
    if (only && !only.has(e.destination)) continue;
    if (e.cancelled_at) {
      out.push({ destination: e.destination, action: "skip", reason: `agendamento cancelado em ${e.cancelled_at} (#13000): não há post no ar` });
      continue;
    }
    if (e.status === "send_unknown") {
      out.push({ destination: e.destination, action: "skip", reason: "envio ambíguo (send_unknown): confira na plataforma e registre com --mark antes" });
      continue;
    }
    const state = resolveShortEntryState(e, input.now);
    if (state === "scheduled") {
      out.push({ destination: e.destination, action: "skip", reason: `ainda agendado para ${e.scheduled_at}: troque com --update-scheduled (este comando só mexe no que já está no ar)` });
      continue;
    }
    if (e.destination === "youtube_shorts") {
      const meta = buildYouTubeShortMetadata({ d1: input.d1, horizontalTitle: input.horizontalTitle });
      out.push({ destination: e.destination, action: "api_youtube", videoId: e.id, title: meta.title, description: meta.description });
    } else if (e.destination.startsWith("facebook:")) {
      out.push({
        destination: e.destination,
        action: "api_facebook",
        slug: e.destination.slice("facebook:".length),
        videoId: e.id,
        description: buildReelsCaption({ platform: "facebook", d1: input.d1, follow: diariaFollowLine(e.destination, input.diariaProfiles), horizontalLink: input.horizontalLink }),
      });
    } else if (e.destination === "linkedin_profile") {
      const text = buildShortSocialText({ platform: "linkedin", d1: input.d1, follow: diariaFollowLine("linkedin_profile", input.diariaProfiles), horizontalLink: input.horizontalLink });
      if (LINKEDIN_POST_URN_RE.test(e.id)) {
        out.push({
          destination: e.destination,
          action: "api_linkedin",
          postUrn: e.id,
          text,
          note: "o token não lê o post (GET 403): confira o texto na página logada; o título do vídeo não muda pela API",
        });
      } else {
        out.push({ destination: e.destination, action: "ui", text, how: "registro sem URN do post (--mark): troque o texto pela página do post (Editar post)", ...(e.url ? { url: e.url } : {}) });
      }
    } else if (e.destination === "instagram") {
      out.push({
        destination: e.destination,
        action: "ui",
        text: buildReelsCaption({ platform: "instagram", d1: input.d1 }),
        how: "a API do Instagram não edita legenda: Gerenciar post → Editar (Claude in Chrome ou app)",
        ...(e.url ? { url: e.url } : {}),
      });
    } else if (e.destination === "threads_profile") {
      const atMs = Date.parse(e.at);
      if (!Number.isNaN(atMs) && nowMs - atMs <= THREADS_EDIT_WINDOW_MS) {
        out.push({
          destination: e.destination,
          action: "ui",
          text: buildShortSocialText({ platform: "threads", d1: input.d1, follow: diariaFollowLine("threads_profile", input.diariaProfiles) }),
          how: `o Threads só edita pela UI e até 15 min depois de publicar (até ${new Date(atMs + THREADS_EDIT_WINDOW_MS).toISOString()})`,
          ...(e.url ? { url: e.url } : {}),
        });
      } else {
        out.push({ destination: e.destination, action: "not_editable", reason: `o Threads só edita até 15 min depois de publicar (publicado em ${e.at})` });
      }
    } else if (e.destination === "x") {
      out.push({ destination: e.destination, action: "not_editable", reason: "o X só edita post com plano Plus, que a @diariabr não tem: fica o texto antigo" });
    } else if (e.destination === "tiktok") {
      out.push({ destination: e.destination, action: "not_editable", reason: "o TikTok não edita a legenda depois de publicar: fica o texto antigo" });
    } else if (e.destination === "linkedin_page_repost") {
      out.push({ destination: e.destination, action: "skip", reason: "o repost da página herda o texto do linkedin_profile" });
    } else {
      out.push({ destination: e.destination, action: "not_editable", reason: "o script não sabe editar este destino depois de publicado: faça na plataforma" });
    }
  }
  return out;
}

/**
 * Pure: por que o `--update-published` do corte não pode gravar título/gancho
 * novos no `corte.json` (`[]` = pode). O `corte.json` é o texto que o timer do
 * 300 publica e que o `--update-scheduled` reaplica: com destino ainda por
 * sair, trocar o texto ali sem a queda do "pode publicar" (#11912) mudaria o
 * que o editor aprovou. Com tudo no ar, a troca não mexe em autorização
 * nenhuma (as consumidas ficam como estão).
 */
export function corteTextChangeBlockers(input: {
  /** Destinos com "pode publicar" do corte (`corteAuthorizedDestinations`), ou `null`. */
  authorizedDestinations: readonly string[] | null;
  /** Destinos que o timer do 300 publica (`CORTE_TIMER_DESTINATIONS`). */
  timerDestinations: readonly string[];
  entries: readonly ShortPublishedEntry[];
  now: Date;
}): string[] {
  const registered = new Set(input.entries.map((e) => e.destination));
  const pendingTimer = (input.authorizedDestinations ?? []).filter((d) => input.timerDestinations.includes(d) && !registered.has(d));
  const scheduled = input.entries.filter((e) => !e.cancelled_at && resolveShortEntryState(e, input.now) === "scheduled").map((e) => e.destination);
  const out: string[] = [];
  if (pendingTimer.length) {
    out.push(`${pendingTimer.join(", ")} ainda não saiu (timer do 300): mude o texto com --title/--hook no fluxo normal (derruba o "pode publicar") e o --update-scheduled --publish, e use o --update-published depois que tudo estiver no ar`);
  }
  if (scheduled.length) {
    out.push(`${scheduled.join(", ")} ainda está agendado: troque primeiro com --update-scheduled (o --update-published só mexe no que já está no ar)`);
  }
  return out;
}

/** I/O do executor, injetável nos testes. Cada função lança na falha (nada alterado ou estado incerto, com a causa). */
export interface PublishedUpdateDeps {
  youtube: (videoId: string, input: { title: string; description: string }) => Promise<void>;
  facebook: (slug: string, videoId: string, description: string) => Promise<void>;
  linkedin: (postUrn: string, text: string) => Promise<void>;
  persist: (entry: ShortPublishedEntry) => void;
  now: () => Date;
}

export interface PublishedUpdateResult {
  destination: string;
  ok: boolean;
  /**
   * `done`: trocado e relido; `done_unverified`: a API aceitou e não há como
   * reler (LinkedIn); `ui`: falta a troca pela UI; `not_editable`/`skipped`:
   * nada feito; `failed`: a chamada falhou.
   */
  outcome: "done" | "done_unverified" | "ui" | "not_editable" | "skipped" | "failed";
  error?: string;
  reason?: string;
  warning?: string;
  ui?: { text: string; how: string; url?: string };
}

/**
 * Aplica o plano. YouTube e Facebook gravam `updated_at` no registro (escritor
 * `main`, o mesmo que os publicou); o LinkedIn não grava (o registro dele pode
 * ser de um timer, que tem o arquivo próprio). Falha de um não para os outros.
 */
export async function executePublishedTextUpdates(
  items: readonly PublishedUpdateItem[],
  entries: readonly ShortPublishedEntry[],
  deps: PublishedUpdateDeps,
): Promise<PublishedUpdateResult[]> {
  const results: PublishedUpdateResult[] = [];
  for (const item of items) {
    if (item.action === "skip") {
      results.push({ destination: item.destination, ok: true, outcome: "skipped", reason: item.reason });
      continue;
    }
    if (item.action === "not_editable") {
      results.push({ destination: item.destination, ok: true, outcome: "not_editable", reason: item.reason });
      continue;
    }
    if (item.action === "ui") {
      results.push({ destination: item.destination, ok: true, outcome: "ui", ui: { text: item.text, how: item.how, ...(item.url ? { url: item.url } : {}) } });
      continue;
    }
    try {
      if (item.action === "api_youtube") await deps.youtube(item.videoId, { title: item.title, description: item.description });
      else if (item.action === "api_facebook") await deps.facebook(item.slug, item.videoId, item.description);
      else await deps.linkedin(item.postUrn, item.text);
    } catch (e) {
      results.push({ destination: item.destination, ok: false, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (item.action === "api_linkedin") {
      results.push({ destination: item.destination, ok: true, outcome: "done_unverified", warning: item.note });
      continue;
    }
    let warning: string | undefined;
    const entry = entries.find((e) => e.destination === item.destination);
    if (entry) {
      try {
        deps.persist({ ...entry, updated_at: deps.now().toISOString() });
      } catch (e) {
        warning = `texto trocado na plataforma, mas o registro não gravou o updated_at: ${(e as Error).message}`;
      }
    }
    results.push({ destination: item.destination, ok: true, outcome: "done", ...(warning ? { warning } : {}) });
  }
  return results;
}
