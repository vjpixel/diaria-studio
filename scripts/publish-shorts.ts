#!/usr/bin/env node
/**
 * scripts/publish-shorts.ts (#10769)
 *
 * Publica o vídeo CURTO (vertical) da edição — o recorte do "diar.ia.br
 * comentada" — como Reels nas páginas do Facebook e no Instagram, via Graph
 * API, e monta os passos GUIADOS (Chrome, com o editor) do YouTube Shorts e do
 * perfil pessoal. Miolo puro em `scripts/lib/diaria/short-video.ts`.
 *
 * Uso:
 *   npx tsx scripts/publish-shorts.ts AAMMDD                # plano (dry-run), não publica nada
 *   npx tsx scripts/publish-shorts.ts AAMMDD --publish      # publica os destinos de API
 *     [--only facebook:diaria,instagram] [--now] [--video PATH]
 *     [--edition-dir DIR] [--edition-url URL]
 *   npx tsx scripts/publish-shorts.ts AAMMDD --from-drive FILE_ID
 *                                                           # baixa o vertical do Drive (OAuth do projeto, não o conector)
 *   npx tsx scripts/publish-shorts.ts AAMMDD --mark youtube_shorts=URL
 *                                                           # registra destino GUIADO já feito
 *
 * Destinos (config `publishing.shorts`, default = decisão do editor):
 *   - `facebook:{slug}` (API) — cada slug de `publishing.shorts.facebook_pages`,
 *     credencial pelas env vars da página em `publishing.social.facebook.pages`
 *     (`scripts/lib/facebook-pages.ts`). O `enabled` de lá NÃO vale aqui: ele
 *     liga os posts diários da página, não o Reels. Página sem credencial =
 *     aviso e segue (rode `scripts/facebook-page-token-setup.ts`). Até 90 s
 *     sobe por `video_reels`; acima disso (a API de Reels recusa), por
 *     `/{page-id}/videos` em upload RESUMABLE (start/transfer/finish, #10815:
 *     o POST único dava 413 com o vertical de 275 MB) — vídeo vertical aparece
 *     como Reel.
 *   - `instagram` (API) — Reels no Instagram. Autora: a conta do Instagram
 *     vinculada à página `publishing.shorts.instagram_author_page` (#10790:
 *     conta pessoal do editor, ligada à página VJ pixel, publicando com o
 *     token dessa página); `null` = conta da diar.ia.br
 *     (`INSTAGRAM_BUSINESS_ACCOUNT_ID` + `INSTAGRAM_ACCESS_TOKEN`). Contas de
 *     `instagram_collaborators` entram como collab (aceitam o convite no app);
 *     depois do publish o script relê os collaborators da mídia e avisa se o
 *     convite foi descartado (#10820). No dry-run confere também se o token da
 *     página tem `instagram_content_publish` (#10820).
 *   - `linkedin_profile` (API, #10772) — vídeo NATIVO no perfil pessoal do
 *     editor pela Videos API (`scripts/lib/linkedin-video.ts`), com o token do
 *     4º post (`LINKEDIN_PERSONAL_*`, nenhum segredo novo). Texto com o vídeo
 *     completo do YouTube (`_internal/05-video-url.txt`) e a edição com
 *     `utm_source=linkedin&utm_medium=video&utm_campaign={AAMMDD}`. A Posts API
 *     não agenda: antes do horário fica `pending_schedule` (rode de novo depois,
 *     ou `--now`). Envio ambíguo grava `send_unknown` e nunca re-posta.
 *   - `linkedin_page_repost` (guiado, #10772) — repost do vídeo do perfil pela
 *     página, no horário que a grade da PÁGINA permite (`planLinkedInRepostSlot`:
 *     2 h dos posts da rotação #10305, picos, ≥30 min depois do perfil). Guiado
 *     porque não há token de organização local (a página publica pelo Worker).
 *   - `x` (guiado, #10772) — X @diariabr pela Buffer (MCP, só a skill alcança).
 *     O plano traz texto (≤280 ponderado) e `dueAt`; o `--publish` sobe o
 *     vertical pro R2 e devolve `results[].buffer.videoUrl`. Registro com
 *     `--mark x=buffer:{id} --scheduled-at {dueAt}`.
 *   - `youtube_shorts` e `facebook_profile` (guiados) — o JSON traz título,
 *     descrição, horário e legenda; o skill `/diaria-shorts` executa no Chrome
 *     e grava com `--mark`. Sem comentário fixado: link em comentário de Short
 *     não é clicável (#10831).
 *
 * Horário (#10831): o do vertical, `resolveShortTime` — teste de 2 semanas
 * alternando 12:00/19:00 BRT a partir de 261022 (`publishing.shorts.schedule`),
 * nunca as 06:00 do horizontal. Com pelo menos 10 min de folga o Facebook
 * agenda (a folga é reconferida antes de cada página); senão publica na hora.
 * O Instagram não agenda Reels pela API — com horário futuro o Reels vai pra
 * FILA do Worker `diaria-linkedin-cron` (#10823), que publica no horário: o
 * vertical sobe pro R2 (`scripts/lib/r2-object-upload.ts`, a Graph baixa pelo
 * `video_url` público) e a entry leva a conta (`ig_account`) e os collabs.
 * Sem Worker (`DIARIA_LINKEDIN_CRON_URL`/`_TOKEN`), sem R2 (`R2_*`,
 * `SHORTS_R2_*`) ou com autora que o Worker não conhece, cai no comportamento
 * de antes: fica pendente até rodar de novo depois do horário (ou `--now`).
 *
 * Grade (#10819, `planShortSlots`): o plano lê o que já está agendado no dia
 * (`_internal/06-social-published.json` + `06-shorts-published.json`). Durante
 * o teste do #10831 o horário do teste vale pra todos os destinos e a grade só
 * avisa quando ele cola num post da mesma conta; fora do teste, cada destino
 * de API tem o próprio horário (`slots` no plano) pelo `social-slot-planner`.
 *
 * Link da edição: `--edition-url` > `_internal/05-edition-url.txt` (gravado no
 * Stage 5) > slug derivado do título do D1 (aviso).
 *
 * Registro por destino em `{edição}/_internal/06-shorts-published.json`
 * (escrita atômica, logo após cada destino). Destino registrado é pulado.
 * Registro ilegível ABORTA (nunca vira "nada publicado", o que duplicaria
 * Reels públicos). Se a plataforma aceitar e a gravação falhar, o erro mostra
 * o id/URL e o comando `--mark` pra registrar à mão.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques } from "./extract-destaques.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { loadResolvedFacebookPages, type ResolvedFacebookPage } from "./lib/facebook-pages.ts";
import {
  SHORTS_PUBLISHED_FILE,
  buildReelsCaption,
  buildYouTubeShortMetadata,
  facebookDestinationId,
  facebookUploadRoute,
  instagramReelsApiFit,
  isDestinationDone,
  knownDestinationIds,
  listShortDestinations,
  loadInstagramApiMaxSeconds,
  loadShortScheduleConfig,
  loadShortsConfig,
  mp4DurationSeconds,
  parseShortsPublishedFile,
  planShortSlots,
  resolveReelsSchedule,
  resolveShortTime,
  buildShortSocialText,
  planLinkedInRepostSlot,
  shortVideoFileName,
  upsertShortEntry,
  type ShortDestination,
  type ShortPublishedEntry,
  type ShortSlot,
  type ShortsConfig,
  type ShortsPublishedFile,
  type ShortTime,
  type YouTubeShortMetadata,
} from "./lib/diaria/short-video.ts";
import { stripInlineMarkdown, youtubeVideoFileName } from "./lib/diaria/youtube-video.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { DRIVE_API } from "./lib/drive-constants.ts";
import { gridFromLinkedInPersonalIntent, gridFromShortsPublished, gridFromSocialPublished, type ScheduledSlot } from "./lib/social-slot-planner.ts";
import { loadR2UploadConfig, uploadToR2 } from "./lib/r2-object-upload.ts";
import { buildReelsQueuePayload, postToWorkerQueue, WorkerQueueError, type WorkerQueuePayload } from "./lib/worker-queue-client.ts";
import { resolveShortEntryState, resolveWorkerQueueState } from "./lib/publish-state.ts";
import { LINKEDIN_PERSONAL_ENV, MAX_FIRE_LATENESS_MS, PERSONAL_INTENT_FILE, defaultLinkedInApiVersion, postUrlFromUrn, readPersonalCreds, type PersonalCreds } from "./lib/linkedin-personal.ts";
import { postVideoToPersonalProfile, type LinkedInVideoDeps } from "./lib/linkedin-video.ts";
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH = "https://graph.facebook.com";
const GRAPH_VIDEO = "https://graph-video.facebook.com";
const RUPLOAD = "https://rupload.facebook.com";

/** Destinos que só o skill faz (Chrome; o X pela Buffer MCP, #10772). */
export const GUIDED_DESTINATIONS = new Set(["youtube_shorts", "facebook_profile", "linkedin_page_repost", "x"]);

/**
 * Destinos que `--mark` aceita: os guiados + o `instagram`, que vira passo
 * guiado quando o vertical passa do teto de duração da API (#10893) — o editor
 * posta no app e registra, e a próxima rodada não tenta o rupload de novo.
 */
export const MARKABLE_DESTINATIONS = new Set([...GUIDED_DESTINATIONS, "instagram", "linkedin_profile"]);

export type ShortsPlanItem =
  /** `title`: título da mídia (vídeo do LinkedIn pessoal, #10772). */
  | { destination: string; mode: "api"; action: "publish"; caption: string; scheduledAt: string | null; title?: string }
  | { destination: string; mode: "api"; action: "pending_schedule"; caption: string; scheduledAt: string; detail: string }
  /** #10823: Reels do Instagram com horário futuro, entregue à fila do Worker. */
  | { destination: string; mode: "api"; action: "enqueue"; caption: string; scheduledAt: string; igAccount: WorkerInstagramAccount }
  | { destination: string; mode: "api" | "guided"; action: "skip_done" }
  /** `skip_late` (#10772 F4): o horário do destino passou além do teto de atraso — vira passo manual. */
  | { destination: string; mode: "api" | "guided"; action: "skip_missing_credentials" | "skip_invalid" | "skip_late"; detail: string }
  /** `at`: horário planejado do passo guiado quando não é o `shortTime` (repost da página, #10772). */
  | { destination: string; mode: "guided"; action: "guided"; caption?: string; detail: string; at?: string }
  /**
   * #10772: X via Buffer (MCP, só a skill chama). `scheduledAt` null = postar
   * já. A URL pública do vídeo só existe no `--publish` (sobe pro R2): vem em
   * `results[].buffer`.
   */
  | { destination: string; mode: "guided"; action: "buffer"; caption: string; scheduledAt: string | null; detail: string };

export interface ShortsPlan {
  aammdd: string;
  editionUrl: string;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  longVideo: string;
  youtube: YouTubeShortMetadata;
  /** Horário do vertical (#10831): HH:MM BRT, ISO no dia da edição, de onde veio. Base dos destinos guiados. */
  shortTime: ShortTime & { at: string };
  /** Horário de cada destino de API desta rodada contra a grade já agendada (#10819). */
  slots: ShortSlot[];
  items: ShortsPlanItem[];
  premises: string[];
  warnings: string[];
}

export interface ShortsPlanInput {
  aammdd: string;
  reviewedMd: string;
  now: Date;
  config: unknown;
  pages: ResolvedFacebookPage[];
  instagramReady: boolean;
  /** Por que o Instagram não está pronto (vira o aviso do plano). */
  instagramNotReadyReason?: string;
  /** Avisos do Instagram pronto mas não totalmente conferido (ex.: escopo do token, #10820). */
  instagramWarnings?: string[];
  /**
   * #10823: dá pra agendar o Reels pela fila do Worker? Ausente = não (o
   * Instagram com horário futuro fica `pending_schedule`, como antes).
   */
  instagramQueue?: InstagramQueueReadiness;
  published: ShortsPublishedFile;
  /**
   * #10772: credencial do perfil pessoal do LinkedIn (`readPersonalCreds`).
   * Ausente = não conferida → o destino é pulado com aviso.
   */
  linkedinPersonal?: { ready: true } | { ready: false; reason: string };
  /**
   * #10772: dá pra servir o vertical por URL pública (R2)? O X (Buffer) só
   * recebe vídeo por URL. Ausente = não → X pulado com aviso.
   */
  publicVideo?: { ready: true } | { ready: false; reason: string };
  /** #10772: URL do vídeo completo no YouTube (`_internal/05-video-url.txt`); null/ausente = link do canal. */
  youtubeVideoUrl?: string | null;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  /**
   * #10893: duração do vertical (`mp4DurationSeconds`). Ausente = não medida;
   * null = medida mas ilegível. Nos dois casos o Instagram segue pela API
   * (com aviso no null, se o vídeo existe).
   */
  videoDurationSeconds?: number | null;
  editionUrl?: string;
  /** De onde veio o `editionUrl` (só pra premissa). */
  editionUrlSource?: string;
  forceNow?: boolean;
  only?: string[] | null;
  /**
   * Posts já agendados/publicados no dia, por conta (#10819) — `06-social-published.json`
   * + `06-shorts-published.json`. Ausente = grade vazia.
   */
  grid?: ScheduledSlot[];
}

/** Miolo puro: o que cada destino faria, sem I/O. Lança em config/`--only` inconsistentes. */
export function planShortsPublish(input: ShortsPlanInput): ShortsPlan {
  const premises: string[] = [];
  const warnings: string[] = [];
  const d1 = parseDestaques(input.reviewedMd).find((d) => d.n === 1);
  if (!d1) throw new Error("02-reviewed.md sem DESTAQUE 1 — nada para derivar o vídeo curto");

  const editionUrl: string = input.editionUrl ?? deriveEditionUrl(d1.title);
  if (input.editionUrl) {
    premises.push(`link da edição: ${editionUrl} (${input.editionUrlSource ?? "--edition-url"})`);
  } else {
    warnings.push(`link da edição derivado do slug do título do D1: ${editionUrl} — confira; passe --edition-url se o publicado divergir`);
  }
  const d1In = { title: d1.title, body: d1.body };
  const youtube = buildYouTubeShortMetadata({ d1: d1In });

  // #10831: o vertical tem horário próprio (nunca as 06:00 do horizontal).
  const time = resolveShortTime(loadShortScheduleConfig(input.config), input.aammdd);
  const shortTime = { ...time, at: resolveEditionScheduledAt(input.aammdd, time.hhmm) };
  premises.push(`horário do vertical: ${time.hhmm} BRT (${time.reason})`);
  if (input.forceNow) premises.push("--now: publica na hora");
  if (!input.video.exists) warnings.push(`vídeo curto ausente em ${input.video.path} — nada a publicar até ele existir`);

  const cfg = loadShortsConfig(input.config);
  for (const slug of cfg.facebookPages) {
    if (!input.pages.some((p) => p.slug === slug)) {
      throw new Error(`publishing.shorts.facebook_pages: página "${slug}" não existe em publishing.social.facebook.pages`);
    }
  }
  // #10820: mesmo tratamento do facebook_pages — slug inválido é erro de config, não aviso de runtime.
  if (cfg.instagram && cfg.instagramAuthorPage !== null && !input.pages.some((p) => p.slug === cfg.instagramAuthorPage)) {
    throw new Error(`publishing.shorts.instagram_author_page: página "${cfg.instagramAuthorPage}" não existe em publishing.social.facebook.pages`);
  }
  const known = knownDestinationIds(cfg);
  const only = input.only && input.only.length ? new Set(input.only) : null;
  if (only) {
    const unknown = [...only].filter((d) => !known.has(d));
    if (unknown.length) throw new Error(`--only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...known].join(", ")})`);
  }

  const destinations = listShortDestinations(cfg).filter((d) => !only || only.has(d.id));
  // #10893: Reels acima do teto medido da API do Instagram vira passo guiado
  // ANTES do upload, em vez de falhar no rupload depois de subir o arquivo.
  const igMax = loadInstagramApiMaxSeconds(input.config);
  const igFit = instagramReelsApiFit(input.videoDurationSeconds ?? null, igMax);
  // Sem credencial (ou acima do teto, no Instagram) o destino não sai pela API — não disputa a grade nem gera premissa de horário.
  function publishable(d: ShortDestination): boolean {
    if (d.kind === "facebook_page") return !input.pages.find((p) => p.slug === d.slug)!.missing.length;
    if (d.kind === "instagram") return input.instagramReady && igFit.fits;
    if (d.kind === "linkedin_profile") return input.linkedinPersonal?.ready === true;
    if (d.kind === "x") return input.publicVideo?.ready === true;
    return false;
  }
  // #10819: só os destinos que esta rodada ainda vai publicar disputam a grade;
  // os já registrados entram nela pelo `06-shorts-published.json`.
  const slots = planShortSlots({
    aammdd: input.aammdd,
    time,
    timeAt: shortTime.at,
    destinations: destinations.filter((d) => !isDestinationDone(input.published, d.id) && publishable(d)),
    cfg,
    grid: input.grid ?? [],
  });
  const slotOf = new Map(slots.map((s) => [s.destination, s]));
  for (const s of slots) {
    if (s.rule !== "test-schedule") premises.push(`${s.destination}: ${s.hhmm} BRT (grade #10819: ${s.premise})`);
    if (s.warning) warnings.push(s.warning);
  }
  const scheduleFor = (s: ShortSlot) => (input.forceNow ? ({ mode: "immediate" } as const) : resolveReelsSchedule(s.at, input.now));
  for (const s of slots) {
    if (input.forceNow) continue;
    const sch = scheduleFor(s);
    premises.push(
      sch.mode === "scheduled"
        ? `${s.destination}: ${s.destination !== "instagram" ? "agendado para" : input.instagramQueue?.ready ? "fila do Worker para" : "pendente até"} ${sch.at} (${s.hhmm} BRT do dia da edição)`
        : `${s.destination}: ${s.hhmm} BRT do dia da edição já passou (ou falta <10 min) — publica na hora`,
    );
  }

  const socialText = (platform: "linkedin" | "x") =>
    buildShortSocialText({ platform, aammdd: input.aammdd, d1: d1In, editionUrl, videoUrl: input.youtubeVideoUrl ?? null });

  // #10772 F4: a Posts API do LinkedIn não agenda — o vídeo sai quando a rodada
  // roda. Sem teto, uma rodada horas depois (ou no dia seguinte) publicaria fora
  // do horário do teste (#10831). Mesmo teto do `--fire-due` do 4º post; `--now`
  // é a exceção explícita.
  const profileLate = ((): string | null => {
    const slot = slotOf.get("linkedin_profile");
    if (!slot || input.forceNow) return null;
    const lateMs = input.now.getTime() - Date.parse(slot.at);
    if (!(lateMs > MAX_FIRE_LATENESS_MS)) return null;
    return `${slot.hhmm} BRT passou há ${Math.round(lateMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h)`;
  })();

  // #10772 F1: o repost da página só existe se o vídeo do perfil já está
  // registrado ou sai nesta rodada (publish/pending_schedule). Sem isso a skill
  // receberia um passo de repost de um vídeo que não existe.
  const profileBlocker = ((): string | null => {
    if (isDestinationDone(input.published, "linkedin_profile")) return null;
    const dest = destinations.find((d) => d.kind === "linkedin_profile");
    if (!dest) return "o vídeo do perfil (linkedin_profile) não está registrado nem nesta rodada";
    if (!publishable(dest)) return "o vídeo do perfil (linkedin_profile) não sai nesta rodada (sem credencial)";
    if (profileLate) return `o vídeo do perfil (linkedin_profile) não sai nesta rodada (${profileLate})`;
    try {
      socialText("linkedin");
    } catch (e) {
      return `o vídeo do perfil (linkedin_profile) não sai nesta rodada (${(e as Error).message})`;
    }
    return null;
  })();

  // #10772: repost da página — depois do vídeo do perfil, num horário da grade da página.
  const repostSlot = (() => {
    if (!destinations.some((d) => d.kind === "linkedin_page_repost") || isDestinationDone(input.published, "linkedin_page_repost")) return null;
    if (profileBlocker) return null;
    const profileEntry = input.published.entries.find((e) => e.destination === "linkedin_profile");
    const profileAt = profileEntry ? (profileEntry.scheduled_at ?? profileEntry.at) : (slotOf.get("linkedin_profile")?.at ?? shortTime.at);
    const plannedGrid = [...(input.grid ?? []), ...slots.map((s) => ({ account: s.account, at: s.at, label: `shorts ${s.destination}` }))];
    const s = planLinkedInRepostSlot({ aammdd: input.aammdd, profileAt: Number.isNaN(Date.parse(profileAt)) ? shortTime.at : profileAt, grid: plannedGrid });
    premises.push(`linkedin_page_repost: ${s.hhmm} BRT (grade da página #10819: ${s.premise})`);
    if (s.warning) warnings.push(s.warning);
    return s;
  })();
  if (destinations.some((d) => d.kind === "linkedin_profile" || d.kind === "x") && !input.youtubeVideoUrl) {
    premises.push("LinkedIn/X: sem _internal/05-video-url.txt — o texto aponta pro canal do YouTube em vez do vídeo completo");
  }

  const items: ShortsPlanItem[] = destinations.map((dest) => planDestination(dest));

  function planDestination(dest: ShortDestination): ShortsPlanItem {
    if (isDestinationDone(input.published, dest.id)) {
      return { destination: dest.id, mode: dest.mode, action: "skip_done" };
    }
    if (dest.kind === "youtube_shorts") {
      return { destination: dest.id, mode: "guided", action: "guided", detail: "YouTube Studio no Chrome (API trava em private sem auditoria, #10659)" };
    }
    if (dest.kind === "linkedin_profile") {
      if (input.linkedinPersonal?.ready !== true) {
        const reason = input.linkedinPersonal?.ready === false ? input.linkedinPersonal.reason : "credencial LINKEDIN_PERSONAL_* não conferida";
        warnings.push(`linkedin_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason };
      }
      if (profileLate) {
        const detail =
          `${profileLate} — fora do horário do teste (#10831), não publica sozinho. ` +
          `Publique à mão no perfil e registre com --mark linkedin_profile=URL, ou rode com --now para publicar mesmo assim`;
        warnings.push(`linkedin_profile: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      let text: string;
      try {
        text = socialText("linkedin");
      } catch (e) {
        warnings.push(`linkedin_profile: ${(e as Error).message}`);
        return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      const title = stripInlineMarkdown(d1In.title).replace(/\s+/g, " ").trim();
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption: text,
          scheduledAt: schedule.at,
          detail: `a Posts API do LinkedIn não agenda — rode de novo depois das ${slot.hhmm} BRT (ou use --now)`,
        };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null, title };
    }
    if (dest.kind === "linkedin_page_repost") {
      if (profileBlocker) {
        const detail = `${profileBlocker} — repost só depois que o vídeo do perfil sair (ou for registrado com --mark linkedin_profile=URL)`;
        warnings.push(`linkedin_page_repost: ${detail}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail };
      }
      const profile = input.published.entries.find((e) => e.destination === "linkedin_profile");
      const where = profile?.url ? ` (${profile.url})` : profile ? "" : " — depois que o vídeo do perfil (linkedin_profile) sair";
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        at: repostSlot!.at,
        detail:
          `repost pela página diar.ia.br às ${repostSlot!.hhmm} BRT: no Chrome, como a página, "Repostar" o vídeo do perfil${where}. ` +
          `Sem token de organização local, por isso guiado; registre com --mark linkedin_page_repost=URL`,
      };
    }
    if (dest.kind === "x") {
      if (input.publicVideo?.ready !== true) {
        const reason = `o X recebe o vídeo por URL pública e o R2 não está pronto (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`x: ${reason}`);
        return { destination: dest.id, mode: "guided", action: "skip_missing_credentials", detail: reason };
      }
      let text: string;
      try {
        text = socialText("x");
      } catch (e) {
        warnings.push(`x: ${(e as Error).message}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      return {
        destination: dest.id,
        mode: "guided",
        action: "buffer",
        caption: text,
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
        detail:
          "Buffer create_post no canal @diariabr com o vídeo de results[].buffer.videoUrl (o --publish sobe o vertical pro R2); " +
          "registre com --mark x=buffer:{id do post} --scheduled-at {dueAt}",
      };
    }
    if (dest.kind === "facebook_profile") {
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        caption: buildReelsCaption({ platform: "facebook", aammdd: input.aammdd, d1: d1In, editionUrl, utmContent: "perfil" }),
        detail: "perfil pessoal: a Graph API não publica em perfil de pessoa — Chrome, ou compartilhar o Reels da página",
      };
    }
    if (dest.kind === "facebook_page") {
      const page = input.pages.find((p) => p.slug === dest.slug)!;
      if (page.missing.length) {
        warnings.push(`${dest.id}: sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: page.missing.join(", ") };
      }
      const schedule = scheduleFor(slotOf.get(dest.id)!);
      return {
        destination: dest.id,
        mode: "api",
        action: "publish",
        caption: buildReelsCaption({ platform: "facebook", aammdd: input.aammdd, d1: d1In, editionUrl, utmContent: page.utmContent }),
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
      };
    }
    // instagram
    if (!igFit.fits) {
      const collab = cfg.instagramCollaborators.length ? ` com ${cfg.instagramCollaborators.map((c) => `@${c}`).join(", ")} em collab` : "";
      const detail =
        `${igFit.reason} — poste à mão no app do Instagram${collab}, no horário do vertical (${time.hhmm} BRT), ` +
        `e registre com --mark instagram=URL`;
      warnings.push(`instagram: ${detail}`);
      let caption: string | undefined;
      try {
        caption = buildReelsCaption({ platform: "instagram", aammdd: input.aammdd, d1: d1In, editionUrl });
      } catch (e) {
        warnings.push(`instagram: ${(e as Error).message}`);
      }
      return { destination: dest.id, mode: "guided", action: "guided", ...(caption ? { caption } : {}), detail };
    }
    // Só quando o caller MEDIU e não conseguiu ler (null); ausente = não medido (testes, chamadas antigas).
    if (input.videoDurationSeconds === null && igMax !== null && input.video.exists && input.instagramReady) {
      warnings.push(`instagram: duração do vertical não lida do MP4 — sobe pela API sem conferir o teto de ~${igMax} s (#10893); se o rupload der ProcessingFailedError, poste à mão`);
    }
    for (const w of input.instagramWarnings ?? []) warnings.push(`instagram: ${w}`);
    if (!input.instagramReady) {
      warnings.push(`instagram: ${input.instagramNotReadyReason ?? "sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN"}`);
      return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: input.instagramNotReadyReason ?? "INSTAGRAM_*" };
    }
    let caption: string;
    try {
      caption = buildReelsCaption({ platform: "instagram", aammdd: input.aammdd, d1: d1In, editionUrl });
    } catch (e) {
      // Legenda grande demais só derruba o Instagram, não os outros destinos.
      warnings.push(`instagram: ${(e as Error).message}`);
      return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
    }
    const slot = slotOf.get(dest.id)!;
    const schedule = scheduleFor(slot);
    if (schedule.mode === "scheduled") {
      // #10823: a fila do Worker publica no horário (o Instagram não agenda Reels pela API).
      if (input.instagramQueue?.ready) {
        return { destination: dest.id, mode: "api", action: "enqueue", caption, scheduledAt: schedule.at, igAccount: input.instagramQueue.account };
      }
      const why = input.instagramQueue ? ` Fila do Worker indisponível: ${input.instagramQueue.reason}.` : "";
      if (input.instagramQueue) warnings.push(`instagram: sem fila do Worker (${input.instagramQueue.reason}) — fica pendente até ${slot.hhmm} BRT`);
      return {
        destination: dest.id,
        mode: "api",
        action: "pending_schedule",
        caption,
        scheduledAt: schedule.at,
        detail: `o Instagram não agenda Reels pela API — rode de novo depois das ${slot.hhmm} BRT (ou use --now).${why}`,
      };
    }
    return { destination: dest.id, mode: "api", action: "publish", caption, scheduledAt: null };
  }

  return { aammdd: input.aammdd, editionUrl, video: input.video, longVideo: youtubeVideoFileName(input.aammdd), youtube, shortTime, slots, items, premises, warnings };
}

/** Contas do Instagram que a fila do Worker sabe publicar (`ig_account`, #10823). */
export type WorkerInstagramAccount = "diaria" | "vjpixel";

export type InstagramQueueReadiness = { ready: true; account: WorkerInstagramAccount } | { ready: false; reason: string };

/**
 * Pure (#10823): a fila do Worker consegue agendar o Reels desta autora? Precisa
 * do Worker (URL + token), do R2 pro `video_url` público e de uma autora que o
 * Worker conhece: `instagram_author_page` null = conta da diar.ia.br
 * (`diaria`); `vjpixel` = a conta vinculada à página VJ pixel (secrets
 * `INSTAGRAM_VJPIXEL_*` no Worker). Qualquer outra página não tem credencial
 * no Worker.
 */
export function resolveInstagramQueueReadiness(input: {
  authorPage: string | null;
  workerUrl: string;
  workerToken: string;
  r2Missing: string[];
}): InstagramQueueReadiness {
  const account: WorkerInstagramAccount | null = input.authorPage === null ? "diaria" : input.authorPage === "vjpixel" ? "vjpixel" : null;
  if (!account) return { ready: false, reason: `o Worker só publica nas contas diaria e vjpixel, não na da página ${input.authorPage}` };
  const missing = [
    ...(input.workerUrl ? [] : ["DIARIA_LINKEDIN_CRON_URL"]),
    ...(input.workerToken ? [] : ["DIARIA_LINKEDIN_CRON_TOKEN"]),
    ...input.r2Missing,
  ];
  if (missing.length) return { ready: false, reason: `falta ${missing.join(", ")}` };
  return { ready: true, account };
}

/**
 * Pure (#10820): esta rodada precisa resolver a autora do Instagram? Não quando
 * o Instagram está desligado, fora do `--only`, ou já registrado (skip_done) —
 * aí a resolução seria só uma chamada à Graph (e um aviso) à toa.
 */
export function wantsInstagram(cfg: Pick<ShortsConfig, "instagram">, only: string[] | null, published: ShortsPublishedFile): boolean {
  if (!cfg.instagram) return false;
  if (only && only.length && !only.includes("instagram")) return false;
  return !isDestinationDone(published, "instagram");
}

// ── Graph API ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (msg: string) => void;
}

export const defaultGraphDeps: GraphDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  log: (m) => console.error(m),
};

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

async function graphPost(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string, base = GRAPH): Promise<any> {
  const res = await deps.fetch(`${base}/${apiVersion}/${path}`, { method: "POST", body: new URLSearchParams(params) });
  const json = await readJson(res);
  if (!res.ok || json.error) throw new Error(`POST ${path}: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

async function graphGet(deps: GraphDeps, path: string, params: Record<string, string>, apiVersion: string): Promise<any> {
  const res = await deps.fetch(`${GRAPH}/${apiVersion}/${path}?${new URLSearchParams(params)}`);
  const json = await readJson(res);
  if (!res.ok || json.error) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

/** Envia o arquivo inteiro num POST ao rupload (offset 0). Só `success: true` conta. */
async function ruploadBinary(deps: GraphDeps, url: string, token: string, file: Buffer): Promise<void> {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(file.length) },
    body: new Uint8Array(file),
  });
  const json = await readJson(res);
  if (!res.ok || json.success !== true) throw new Error(`rupload: ${res.status} ${JSON.stringify(json.error ?? json)}`);
}

/** Folga mínima do Facebook pra agendar (10 min); abaixo disso, publica na hora. */
function stillSchedulable(scheduledAt: string | null, now: Date): string | null {
  if (!scheduledAt) return null;
  return Date.parse(scheduledAt) - now.getTime() > 10 * 60_000 ? scheduledAt : null;
}

/**
 * Espera o Facebook processar o vídeo (até 5 min). Erro de processamento
 * lança; tempo esgotado só avisa (o vídeo pode terminar depois) — o registro
 * sai com `unconfirmed` pra o relatório dizer "confira".
 */
async function waitFacebookProcessing(deps: GraphDeps, videoId: string, token: string, apiVersion: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    let st: any;
    try {
      st = (await graphGet(deps, videoId, { fields: "status", access_token: token }, apiVersion)).status ?? {};
    } catch (e) {
      deps.log(`[aviso] status do vídeo ${videoId}: ${(e as Error).message} — tentando de novo`);
      await deps.sleep(10_000);
      continue;
    }
    const phases = [st.uploading_phase, st.processing_phase, st.publishing_phase].map((p: any) => p?.status);
    if (st.video_status === "error" || st.video_status === "expired" || phases.includes("error")) {
      throw new Error(`Facebook recusou o vídeo ${videoId} no processamento: ${JSON.stringify(st)}`);
    }
    if (st.video_status === "ready" || st.processing_phase?.status === "complete") return true;
    await deps.sleep(10_000);
  }
  return false;
}

export interface PublishOutcome {
  entry: ShortPublishedEntry;
  /** true quando o processamento não foi confirmado no tempo de espera. */
  unconfirmed?: boolean;
  /** Avisos pós-publicação (ex.: convite de collab descartado, #10820). */
  warnings?: string[];
}

/** Teto de blocos do upload resumable — só existe pra nunca virar loop infinito (o servidor dita o tamanho do bloco). */
const FACEBOOK_RESUMABLE_MAX_CHUNKS = 10_000;
/** Tentativas por bloco no `transfer` (falha transitória não joga fora o que já subiu). */
const FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS = 3;

/**
 * Upload RESUMABLE em `/{page-id}/videos` (#10815): `start` (tamanho) →
 * `transfer` dos blocos que o servidor pedir (offsets devolvidos a cada
 * resposta) → `finish` com legenda e agendamento. Substitui o POST único,
 * que dava `413` com o vertical exportado (275 MB em 261022). Devolve o
 * `video_id`.
 */
export async function uploadFacebookVideoResumable(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  scheduledAt: string | null,
): Promise<string> {
  const path = `${page.pageId}/videos`;
  const start = await graphPost(deps, path, { upload_phase: "start", file_size: String(file.length), access_token: page.token }, apiVersion, GRAPH_VIDEO);
  const sessionId: string | undefined = start.upload_session_id;
  const videoId: string | undefined = start.video_id;
  if (!sessionId || !videoId) throw new Error(`POST ${path} (start) sem upload_session_id/video_id: ${JSON.stringify(start)}`);
  let from = Number(start.start_offset);
  let to = Number(start.end_offset);
  for (let chunk = 0; from < file.length; chunk++) {
    if (chunk >= FACEBOOK_RESUMABLE_MAX_CHUNKS) throw new Error(`POST ${path} (transfer): mais de ${FACEBOOK_RESUMABLE_MAX_CHUNKS} blocos — abortado`);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > file.length) {
      throw new Error(`POST ${path} (transfer): offsets inválidos do servidor (start ${from}, end ${to}, arquivo ${file.length})`);
    }
    let json: any;
    for (let attempt = 1; ; attempt++) {
      const form = new FormData();
      form.append("access_token", page.token);
      form.append("upload_phase", "transfer");
      form.append("upload_session_id", sessionId);
      form.append("start_offset", String(from));
      form.append("video_file_chunk", new Blob([new Uint8Array(file.subarray(from, to))], { type: "application/octet-stream" }), "chunk");
      const res = await deps.fetch(`${GRAPH_VIDEO}/${apiVersion}/${path}`, { method: "POST", body: form });
      json = await readJson(res);
      if (res.ok && !json.error) break;
      const msg = `POST ${path} (transfer ${from}-${to}): ${res.status} ${JSON.stringify(json.error ?? json)}`;
      if (attempt >= FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS) throw new Error(msg);
      deps.log(`[aviso] ${msg} — tentando o bloco de novo (${attempt}/${FACEBOOK_RESUMABLE_CHUNK_ATTEMPTS})`);
      await deps.sleep(5_000);
    }
    const next = Number(json.start_offset);
    if (!Number.isInteger(next) || next <= from) {
      throw new Error(`POST ${path} (transfer): o upload não avançou (start ${from} → ${json.start_offset})`);
    }
    from = next;
    to = Number(json.end_offset);
  }
  const finish: Record<string, string> = { upload_phase: "finish", upload_session_id: sessionId, description: caption, access_token: page.token };
  if (scheduledAt) {
    finish.published = "false";
    finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
  }
  const done = await graphPost(deps, path, finish, apiVersion, GRAPH_VIDEO);
  if (done.success !== true) throw new Error(`POST ${path} (finish) sem success: ${JSON.stringify(done)}`);
  return videoId;
}

/** Reels numa Página. ≤90 s: `video_reels` (start → rupload → finish). >90 s: `/videos` resumable (#10815). */
export async function publishFacebookReel(
  deps: GraphDeps,
  page: ResolvedFacebookPage,
  apiVersion: string,
  file: Buffer,
  caption: string,
  plannedScheduledAt: string | null,
): Promise<PublishOutcome> {
  const scheduledAt = stillSchedulable(plannedScheduledAt, deps.now());
  if (plannedScheduledAt && !scheduledAt) deps.log(`[premissa] ${facebookDestinationId(page.slug)}: menos de 10 min pro horário — publicando na hora`);
  const route = facebookUploadRoute(mp4DurationSeconds(file));
  let videoId: string;

  if (route === "video_reels") {
    const start = await graphPost(deps, `${page.pageId}/video_reels`, { upload_phase: "start", access_token: page.token }, apiVersion);
    videoId = start.video_id;
    if (!videoId) throw new Error(`video_reels start sem video_id: ${JSON.stringify(start)}`);
    await ruploadBinary(deps, start.upload_url ?? `${RUPLOAD}/video-upload/${apiVersion}/${videoId}`, page.token, file);
    const finish: Record<string, string> = { upload_phase: "finish", video_id: videoId, description: caption, access_token: page.token };
    if (scheduledAt) {
      finish.video_state = "SCHEDULED";
      finish.scheduled_publish_time = String(Math.floor(Date.parse(scheduledAt) / 1000));
    } else {
      finish.video_state = "PUBLISHED";
    }
    const done = await graphPost(deps, `${page.pageId}/video_reels`, finish, apiVersion);
    if (done.success !== true) throw new Error(`video_reels finish sem success: ${JSON.stringify(done)}`);
  } else {
    videoId = await uploadFacebookVideoResumable(deps, page, apiVersion, file, caption, scheduledAt);
  }

  const confirmed = await waitFacebookProcessing(deps, videoId, page.token, apiVersion);
  return {
    entry: {
      destination: facebookDestinationId(page.slug),
      status: scheduledAt ? "scheduled" : "published",
      id: videoId,
      url: route === "video_reels" ? `https://www.facebook.com/reel/${videoId}` : `https://www.facebook.com/${page.pageId}/videos/${videoId}`,
      scheduled_at: scheduledAt,
      at: deps.now().toISOString(),
    },
    unconfirmed: !confirmed,
  };
}

/** Autora do Reels no Instagram, resolvida pra uma conta + token (#10790). */
export type InstagramAuthor =
  | { ready: true; igUserId: string; token: string; username: string | null; source: string; warnings?: string[] }
  | { ready: false; reason: string };

/** Escopo que o token da página precisa pra publicar no Instagram vinculado. */
export const INSTAGRAM_PUBLISH_SCOPE = "instagram_content_publish";

/**
 * Escopos do token via `debug_token` (#10820). `error` = não deu pra conferir
 * (erro da Graph ou resposta sem `scopes`): o caller avisa e segue, porque
 * recusar aí bloquearia um token válido por falha de leitura.
 */
async function readTokenScopes(deps: Pick<GraphDeps, "fetch">, token: string, apiVersion: string): Promise<{ scopes: string[] } | { error: string }> {
  try {
    const json = await graphGet(deps as GraphDeps, "debug_token", { input_token: token, access_token: token }, apiVersion);
    const scopes = json?.data?.scopes;
    if (!Array.isArray(scopes)) return { error: "debug_token sem lista de escopos" };
    return { scopes: scopes.filter((x: unknown): x is string => typeof x === "string") };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Resolve a conta do Instagram que publica o Reels (faz um GET na Graph, inclusive no
 * dry-run). Com `authorPage`, é a conta
 * VINCULADA a essa página do Facebook, usando o token da página (precisa de
 * `instagram_content_publish`). Sem vínculo ou sem token → não pronto, com o
 * passo que destrava: nunca cai em silêncio na conta da diar.ia.br.
 */
export async function resolveInstagramAuthor(
  deps: Pick<GraphDeps, "fetch">,
  authorPage: string | null,
  pages: ResolvedFacebookPage[],
  apiVersion: string,
  envAccount: { igUserId: string; token: string },
): Promise<InstagramAuthor> {
  if (authorPage === null) {
    if (!envAccount.igUserId || !envAccount.token) return { ready: false, reason: "sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN" };
    return { ready: true, igUserId: envAccount.igUserId, token: envAccount.token, username: null, source: "conta da diar.ia.br (env)" };
  }
  const page = pages.find((p) => p.slug === authorPage);
  if (!page) return { ready: false, reason: `instagram_author_page "${authorPage}" não existe em publishing.social.facebook.pages` };
  if (page.missing.length || !page.token || !page.pageId) {
    return { ready: false, reason: `página ${authorPage} sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts --pages ${authorPage}` };
  }
  let json: any;
  try {
    json = await graphGet(deps as GraphDeps, page.pageId, { fields: "instagram_business_account{id,username}", access_token: page.token }, apiVersion);
  } catch (e) {
    return { ready: false, reason: `não foi possível ler a conta do Instagram vinculada à página ${authorPage}: ${(e as Error).message}` };
  }
  const ig = json?.instagram_business_account;
  if (!ig?.id) {
    return {
      ready: false,
      reason:
        `nenhuma conta do Instagram vinculada à página ${authorPage} — torne a conta pessoal profissional (criador), ` +
        `vincule-a à página no Facebook e gere de novo o token da página com instagram_content_publish ` +
        `(scripts/facebook-page-token-setup.ts --pages ${authorPage})`,
    };
  }
  // #10820: ler a conta vinculada não prova que o token PUBLICA — sem o escopo, a falha só apareceria no --publish.
  const scopeCheck = await readTokenScopes(deps, page.token, apiVersion);
  const warnings: string[] = [];
  if ("scopes" in scopeCheck) {
    if (!scopeCheck.scopes.includes(INSTAGRAM_PUBLISH_SCOPE)) {
      return {
        ready: false,
        reason:
          `o token da página ${authorPage} lê a conta vinculada mas não tem o escopo ${INSTAGRAM_PUBLISH_SCOPE} — ` +
          `gere de novo com esse escopo (scripts/facebook-page-token-setup.ts --pages ${authorPage})`,
      };
    }
  } else {
    warnings.push(`não deu pra conferir se o token da página ${authorPage} tem ${INSTAGRAM_PUBLISH_SCOPE} (${scopeCheck.error}) — a falha, se houver, aparece no --publish`);
  }
  return {
    ready: true,
    igUserId: ig.id,
    token: page.token,
    username: ig.username ?? null,
    source: `conta vinculada à página ${authorPage}`,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Reels no Instagram: container resumable → rupload → espera FINISHED → media_publish. */
export async function publishInstagramReel(
  deps: GraphDeps,
  igUserId: string,
  token: string,
  apiVersion: string,
  file: Buffer,
  caption: string,
  collaborators: string[] = [],
): Promise<PublishOutcome> {
  const params: Record<string, string> = { media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true", access_token: token };
  // #10790: collab — a Graph API recebe a lista como JSON; cada conta aceita o convite no app.
  if (collaborators.length) params.collaborators = JSON.stringify(collaborators);
  const container = await graphPost(deps, `${igUserId}/media`, params, apiVersion);
  const containerId: string = container.id;
  if (!containerId) throw new Error(`media (REELS) sem id: ${JSON.stringify(container)}`);
  try {
    await ruploadBinary(deps, container.uri ?? `${RUPLOAD}/ig-api-upload/${apiVersion}/${containerId}`, token, file);
  } catch (e) {
    const msg = (e as Error).message;
    // #10893: é assim que o teto de duração aparece — o rupload aceita os bytes e recusa no processamento.
    if (/ProcessingFailedError/.test(msg)) {
      throw new Error(
        `${msg} — padrão do teto de duração do Reels pela API (#10893); poste à mão no app e registre com --mark instagram=URL ` +
          `(ajuste publishing.shorts.instagram_api_max_seconds se o teto mudou)`,
      );
    }
    throw e;
  }
  let last = "";
  for (let i = 0; ; i++) {
    if (i >= 60) throw new Error(`container ${containerId} não ficou pronto em 10 min (último: ${last || "sem resposta"})`);
    let st: any;
    try {
      st = await graphGet(deps, containerId, { fields: "status_code,status", access_token: token }, apiVersion);
    } catch (e) {
      // Falha transitória na consulta não joga fora o upload — tenta de novo até o teto.
      last = (e as Error).message;
      deps.log(`[aviso] instagram: status do container falhou (${last}) — tentando de novo`);
      await deps.sleep(10_000);
      continue;
    }
    last = st.status_code;
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`container ${containerId}: ${st.status_code} ${st.status ?? ""}`);
    await deps.sleep(10_000);
  }
  const pub = await graphPost(deps, `${igUserId}/media_publish`, { creation_id: containerId, access_token: token }, apiVersion);
  if (!pub.id) throw new Error(`media_publish sem id: ${JSON.stringify(pub)}`);
  let url: string | undefined;
  try {
    url = (await graphGet(deps, pub.id, { fields: "permalink", access_token: token }, apiVersion)).permalink;
  } catch (e) {
    deps.log(`[aviso] instagram: permalink indisponível (${(e as Error).message}) — o id ${pub.id} identifica o Reels`);
  }
  const warnings = collaborators.length ? await checkInstagramCollaborators(deps, pub.id, token, apiVersion, collaborators) : [];
  return {
    entry: { destination: "instagram", status: "published", id: pub.id, url, scheduled_at: null, at: deps.now().toISOString() },
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Relê os collaborators da mídia publicada (#10820): o Instagram pode descartar
 * o convite sem erro no `media_publish` (conta inexistente, conta que não
 * aceita collab). Nunca lança — o Reels já está no ar; devolve avisos.
 */
export async function checkInstagramCollaborators(
  deps: Pick<GraphDeps, "fetch">,
  mediaId: string,
  token: string,
  apiVersion: string,
  expected: string[],
): Promise<string[]> {
  let json: any;
  try {
    json = await graphGet(deps as GraphDeps, `${mediaId}/collaborators`, { fields: "username,invite_status", access_token: token }, apiVersion);
  } catch (e) {
    return [`não deu pra conferir o convite de collab (${(e as Error).message}) — confira no app`];
  }
  if (!Array.isArray(json?.data)) return ["resposta de collaborators sem lista — confira o convite de collab no app"];
  const found = new Set(json.data.map((c: any) => String(c?.username ?? "").toLowerCase()));
  const missing = expected.filter((u) => !found.has(u.toLowerCase()));
  return missing.length ? [`convite de collab descartado pelo Instagram: ${missing.map((u) => `@${u}`).join(", ")} — convide à mão no app`] : [];
}

export interface InstagramEnqueueDeps {
  /** Sobe o vertical e devolve a URL pública (R2). */
  uploadVideo: () => Promise<string>;
  /** `POST /queue` do Worker. */
  enqueue: (payload: WorkerQueuePayload) => Promise<{ key: string; scheduled_at: string }>;
  now: () => Date;
}

/**
 * #10823: agenda o Reels pela fila do Worker — sobe o vertical, enfileira com a
 * conta e os collabs, e registra como `scheduled` com a key da fila no `id`.
 * O 202 do Worker só prova que a entry está na fila, nunca que saiu
 * (`resolveWorkerQueueState`, #573): o registro nunca diz `published`.
 */
export async function enqueueInstagramReel(
  deps: InstagramEnqueueDeps,
  item: { caption: string; scheduledAt: string; igAccount: WorkerInstagramAccount },
  collaborators: string[],
): Promise<PublishOutcome> {
  const videoUrl = await deps.uploadVideo();
  let queued: { key: string; scheduled_at: string };
  try {
    queued = await deps.enqueue(
      buildReelsQueuePayload({ caption: item.caption, videoUrl, scheduledAt: item.scheduledAt, account: item.igAccount, collaborators }),
    );
  } catch (e) {
    if (e instanceof WorkerQueueError && e.code === "instagram_account_creds_missing") {
      throw new Error(
        `o Worker recusou a conta ${item.igAccount}: faltam os secrets INSTAGRAM_VJPIXEL_ACCOUNT_ID/INSTAGRAM_VJPIXEL_ACCESS_TOKEN no diaria-linkedin-cron (${e.message})`,
      );
    }
    throw e;
  }
  const state = resolveWorkerQueueState({ key: queued.key, scheduled_at: queued.scheduled_at }, deps.now());
  return {
    entry: { destination: "instagram", status: "scheduled", id: queued.key, scheduled_at: queued.scheduled_at, at: deps.now().toISOString() },
    ...(state === "scheduled" ? {} : { warnings: [`fila do Worker devolveu scheduled_at ${queued.scheduled_at} (estado ${state}) — confira se a entry não disparou na hora`] }),
  };
}

/**
 * #10772: vertical nativo no perfil pessoal do LinkedIn (Videos API + Posts
 * API, `scripts/lib/linkedin-video.ts`). Falha antes do envio lança (nada no
 * perfil, pode re-tentar). Envio AMBÍGUO (timeout/5xx no POST do post) volta
 * como `send_unknown`: o registro passa a contar o destino como feito e a
 * próxima rodada não re-posta — o editor confere o perfil e registra com
 * `--mark linkedin_profile=URL`.
 */
export async function publishLinkedInProfileVideo(
  deps: LinkedInVideoDeps & { now: () => Date },
  creds: PersonalCreds,
  apiVersion: string,
  file: Buffer,
  text: string,
  title: string,
): Promise<PublishOutcome> {
  // CONFERIR NA 1ª EXECUÇÃO REAL (#10772 F3): `new Uint8Array(file)` copia o
  // vertical inteiro (275 MB em 261022). Se a memória do processo apertar, trocar
  // por `new Uint8Array(file.buffer, file.byteOffset, file.length)` (sem cópia).
  const r = await postVideoToPersonalProfile({ deps, creds, apiVersion, text, title, bytes: new Uint8Array(file) });
  const at = deps.now().toISOString();
  if (r.ok) {
    const url = postUrlFromUrn(r.postUrn);
    return {
      entry: { destination: "linkedin_profile", status: "published", id: r.postUrn ?? `sem-urn-${at}`, ...(url ? { url } : {}), scheduled_at: null, at },
      ...(r.postUrn ? {} : { warnings: ["a LinkedIn aceitou o post sem devolver a URN (x-restli-id) — confira o perfil"] }),
    };
  }
  if (r.phase === "ambiguous") {
    return {
      entry: { destination: "linkedin_profile", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at },
      warnings: [`envio ambíguo (${r.reason}) — confira o perfil antes de qualquer nova tentativa e registre com --mark linkedin_profile=URL`],
    };
  }
  throw new Error(r.reason);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function readPublished(path: string, aammdd: string): ShortsPublishedFile {
  if (!existsSync(path)) return { aammdd, entries: [] };
  return parseShortsPublishedFile(readFileSync(path, "utf8"), aammdd, path);
}

function writePublished(path: string, file: ShortsPublishedFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(file, null, 2) + "\n");
}

/**
 * Grade já agendada do dia (#10819): posts sociais da edição + o que o vertical
 * já registrou. Store social ausente = só o do vertical; ilegível = aviso e
 * segue sem ele (a grade só ajusta horário; nunca é motivo pra não publicar).
 */
export function loadScheduledGrid(dir: string, published: ShortsPublishedFile, instagramAccount: string | null, warn: (m: string) => void): ScheduledSlot[] {
  const grid = gridFromShortsPublished(published, instagramAccount ?? "diaria");
  // #10772: o 4º post no perfil pessoal do LinkedIn (#9568) disputa a mesma conta que o vertical nativo.
  const personal = join(dir, "_internal", PERSONAL_INTENT_FILE);
  if (existsSync(personal)) {
    try {
      grid.push(...gridFromLinkedInPersonalIntent(JSON.parse(readFileSync(personal, "utf8"))));
    } catch (e) {
      warn(`${personal} ilegível (${(e as Error).message}) — grade sem o 4º post do perfil pessoal`);
    }
  }
  const p = join(dir, "_internal", "06-social-published.json");
  if (!existsSync(p)) return grid;
  try {
    return [...gridFromSocialPublished(JSON.parse(readFileSync(p, "utf8"))), ...grid];
  } catch (e) {
    warn(`${p} ilegível (${(e as Error).message}) — grade #10819 sem os posts sociais do dia`);
    return grid;
  }
}

/**
 * `--mark DESTINO=URL`: só destinos guiados (+ `instagram`, #10893, e
 * `linkedin_profile`, #10772, depois de conferir um envio ambíguo), só URL
 * http(s). O X aceita também `x=buffer:{id}` (#10772): o post agendado na
 * Buffer ainda não tem URL.
 */
export function parseMarkArg(raw: string): { destination: string; url: string | null; bufferId?: string } {
  const buf = raw.match(/^x=buffer:([A-Za-z0-9_-]+)$/);
  if (buf) return { destination: "x", url: null, bufferId: buf[1] };
  const m = raw.match(/^([a-z_]+)=(https?:\/\/\S+)$/);
  if (!m) throw new Error(`--mark espera DESTINO=URL (http/https), recebido ${JSON.stringify(raw)}`);
  if (!MARKABLE_DESTINATIONS.has(m[1])) {
    throw new Error(`--mark só registra destinos guiados (${[...MARKABLE_DESTINATIONS].join(", ")}); "${m[1]}" é publicado pelo script`);
  }
  return { destination: m[1], url: m[2] };
}

/**
 * Entrada que o `--mark` grava (#10772 F6). `x=buffer:{id}` vira `scheduled`
 * com o `--scheduled-at` (ISO) — sem ele, `scheduled_at` null (estado
 * `unknown` até conferir). Os demais viram `published` com a URL.
 */
export function buildMarkEntry(
  mark: ReturnType<typeof parseMarkArg>,
  scheduledAt: string | undefined,
  at: string,
): { ok: true; entry: ShortPublishedEntry } | { ok: false; error: string } {
  if (scheduledAt !== undefined && (!mark.bufferId || Number.isNaN(Date.parse(scheduledAt)))) {
    return { ok: false, error: "--scheduled-at só vale com --mark x=buffer:{id} e precisa ser ISO 8601" };
  }
  if (mark.bufferId) {
    return {
      ok: true,
      entry: { destination: "x", status: "scheduled", id: `buffer:${mark.bufferId}`, scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null, at },
    };
  }
  return { ok: true, entry: { destination: mark.destination, status: "published", id: mark.url!, url: mark.url!, at } };
}

/** O que o `--publish` devolve pro destino do X (#10772): a URL pública do vertical pra Buffer, ou o erro. */
export interface BufferPrepResult {
  destination: string;
  ok: boolean;
  error?: string;
  buffer?: { text: string; dueAt: string | null; videoUrl: string };
}

/**
 * Ramo `buffer` do `--publish` (#10772 F6): só sobe o vertical (R2) e devolve o
 * que a skill passa pra Buffer `create_post`. Nada é registrado aqui — o
 * registro vem do `--mark x=buffer:{id}` depois do `create_post`.
 */
export async function prepareBufferItem(
  item: Extract<ShortsPlanItem, { action: "buffer" }>,
  uploadVideo: () => Promise<string>,
): Promise<BufferPrepResult> {
  try {
    const videoUrl = await uploadVideo();
    return { destination: item.destination, ok: true, buffer: { text: item.caption, dueAt: item.scheduledAt, videoUrl } };
  } catch (e) {
    return { destination: item.destination, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * #10772 F1 (em runtime): o plano oferece o repost da página contando com o
 * vídeo do perfil desta rodada; se o `--publish` falhar no perfil (sem nada
 * registrado), o repost vira `skip_invalid` em vez de passo guiado de um vídeo
 * que não existe.
 */
export function blockRepostOnProfileFailure(items: ShortsPlanItem[], results: Array<{ destination: string; ok: boolean; entry?: unknown; error?: string }>): ShortsPlanItem[] {
  const failed = results.some((r) => r.destination === "linkedin_profile" && !r.ok && !r.entry);
  if (!failed) return items;
  return items.map((i) =>
    i.destination === "linkedin_page_repost" && i.action === "guided"
      ? {
          destination: i.destination,
          mode: "guided",
          action: "skip_invalid",
          detail: "o vídeo do perfil (linkedin_profile) falhou nesta rodada — repost só depois que ele sair (ou for registrado com --mark linkedin_profile=URL)",
        }
      : i,
  );
}

/** Link da edição: --edition-url > `_internal/05-edition-url.txt` > (derivado, no plano). */
function resolveEditionUrlInput(dir: string, flag: string | undefined): { url?: string; source?: string } {
  if (flag) return { url: flag, source: "--edition-url" };
  const p = join(dir, "_internal", "05-edition-url.txt");
  if (existsSync(p)) {
    const url = readFileSync(p, "utf8").trim();
    if (/^https?:\/\//.test(url)) return { url, source: "_internal/05-edition-url.txt" };
  }
  return {};
}

const USAGE =
  "uso: publish-shorts.ts AAMMDD [--publish] [--only dest1,dest2] [--now] [--video PATH | --from-drive FILE_ID]\n" +
  "                       [--edition-dir DIR] [--edition-url URL] [--edition AAMMDD]\n" +
  "     publish-shorts.ts AAMMDD --mark youtube_shorts=URL | facebook_profile=URL | linkedin_page_repost=URL\n" +
  "     publish-shorts.ts AAMMDD --mark x=buffer:ID [--scheduled-at ISO]";

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  const publishedPath = join(dir, SHORTS_PUBLISHED_FILE);
  let published = readPublished(publishedPath, aammdd);

  if (values["mark"]) {
    let mark: ReturnType<typeof parseMarkArg>;
    try {
      mark = parseMarkArg(values["mark"]);
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
    const built = buildMarkEntry(mark, values["scheduled-at"], new Date().toISOString());
    if (!built.ok) {
      console.error(built.error);
      return 2;
    }
    published = upsertShortEntry(published, built.entry);
    writePublished(publishedPath, published);
    console.log(JSON.stringify({ marked: mark.destination, url: mark.url, ...(mark.bufferId ? { buffer_id: mark.bufferId } : {}) }));
    return 0;
  }

  const reviewedPath = join(dir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) {
    console.error(`publish-shorts: ${reviewedPath} não existe`);
    return 1;
  }
  const videoPath = resolve(values["video"] ?? join(dir, shortVideoFileName(aammdd)));
  if (values["from-drive"]) {
    const id = values["from-drive"];
    if (!/^[\w-]{10,}$/.test(id)) {
      console.error(`--from-drive espera o id do arquivo no Drive, recebido ${JSON.stringify(id)}`);
      return 2;
    }
    const res = await gFetchRetry(`${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`);
    if (!res.ok) {
      console.error(`publish-shorts: download do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return 1;
    }
    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!type.startsWith("video/") || buf.length === 0) {
      console.error(`publish-shorts: o arquivo ${id} do Drive não é vídeo (content-type "${type}", ${buf.length} bytes) — nada gravado`);
      return 1;
    }
    if (existsSync(videoPath)) console.error(`[aviso] substituindo ${videoPath} pelo arquivo do Drive`);
    mkdirSync(dirname(videoPath), { recursive: true });
    const tmp = `${videoPath}.part`;
    writeFileAtomic(tmp, buf);
    renameSync(tmp, videoPath);
    console.error(`[ok] vídeo curto baixado do Drive (${(buf.length / 1e6).toFixed(1)} MB) → ${videoPath}`);
  }
  const videoExists = existsSync(videoPath);
  // #10893: a duração decide já no plano (dry-run incluso) se o Instagram vai pela API ou vira passo guiado.
  const file = videoExists ? readFileSync(videoPath) : null;
  const duration = file ? mp4DurationSeconds(file) : null;
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const igApiVersion = process.env.INSTAGRAM_API_VERSION || apiVersion;
  let shortsCfg: ReturnType<typeof loadShortsConfig>;
  try {
    shortsCfg = loadShortsConfig(config);
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  const onlyList = values["only"] ? values["only"].split(",").map((s) => s.trim()).filter(Boolean) : null;
  const igAuthor: InstagramAuthor = wantsInstagram(shortsCfg, onlyList, published)
    ? await resolveInstagramAuthor(defaultGraphDeps, shortsCfg.instagramAuthorPage, pages, igApiVersion, {
        igUserId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "",
        token: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
      })
    : { ready: false, reason: "fora desta rodada" };
  if (igAuthor.ready) {
    const collab = shortsCfg.instagramCollaborators.length ? ` + collab ${shortsCfg.instagramCollaborators.map((c) => `@${c}`).join(", ")}` : "";
    console.error(`[premissa] Instagram: autora ${igAuthor.username ? `@${igAuthor.username}` : igAuthor.igUserId} (${igAuthor.source})${collab}`);
  }
  const editionUrlIn = resolveEditionUrlInput(dir, values["edition-url"]);
  // #10823: fila do Worker pro Reels com horário futuro (mesmas vars do publish-instagram.ts --schedule).
  const workerUrl: string =
    process.env.DIARIA_LINKEDIN_CRON_URL ??
    config?.publishing?.social?.instagram?.cloudflare_worker_url ??
    config?.publishing?.social?.linkedin?.cloudflare_worker_url ??
    "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  const r2 = loadR2UploadConfig(process.env);
  // #10772: LinkedIn pessoal (mesmo token do 4º post) e o vídeo completo do YouTube pro texto.
  const liCreds = readPersonalCreds(process.env, new Date());
  const liApiVersion = process.env[LINKEDIN_PERSONAL_ENV.apiVersion]?.trim() || defaultLinkedInApiVersion(new Date());
  const ytVideo = readD1VideoUrl(dir);
  if (ytVideo.warning) console.error(`[aviso] ${ytVideo.warning}`);
  const instagramQueue = resolveInstagramQueueReadiness({
    authorPage: shortsCfg.instagramAuthorPage,
    workerUrl,
    workerToken,
    r2Missing: r2.ready ? [] : r2.missing,
  });

  let plan: ShortsPlan;
  try {
    plan = planShortsPublish({
      aammdd,
      reviewedMd: readFileSync(reviewedPath, "utf8"),
      now: new Date(),
      config,
      pages,
      instagramReady: igAuthor.ready,
      instagramNotReadyReason: igAuthor.ready ? undefined : igAuthor.reason,
      instagramWarnings: igAuthor.ready ? igAuthor.warnings : undefined,
      instagramQueue,
      linkedinPersonal: liCreds.ok ? { ready: true } : { ready: false, reason: liCreds.reason },
      publicVideo: r2.ready ? { ready: true } : { ready: false, reason: `falta ${r2.missing.join(", ")}` },
      youtubeVideoUrl: ytVideo.url,
      published,
      video: { path: videoPath, exists: videoExists, sizeBytes: videoExists ? statSync(videoPath).size : null },
      videoDurationSeconds: duration,
      editionUrl: editionUrlIn.url,
      editionUrlSource: editionUrlIn.source,
      forceNow: flags.has("now"),
      only: onlyList,
      grid: loadScheduledGrid(dir, published, shortsCfg.instagramAuthorPage, (m) => console.error(`[aviso] ${m}`)),
    });
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  for (const p of plan.premises) console.error(`[premissa] ${p}`);
  for (const w of plan.warnings) console.error(`[aviso] ${w}`);

  if (!flags.has("publish")) {
    console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
    return 0;
  }
  if (!file) {
    console.error(`publish-shorts: vídeo curto ausente em ${videoPath}`);
    return 1;
  }

  console.error(`[premissa] duração ${duration === null ? "desconhecida" : `${duration.toFixed(1)} s`} → Facebook via ${facebookUploadRoute(duration)}`);
  const deps = defaultGraphDeps;
  const results: Array<{
    destination: string;
    ok: boolean;
    entry?: ShortPublishedEntry;
    unconfirmed?: boolean;
    warnings?: string[];
    error?: string;
    /** #10772: o que a skill passa pra Buffer `create_post` (nada é registrado até o `--mark`). */
    buffer?: { text: string; dueAt: string | null; videoUrl: string };
  }> = [];
  // Sobe o vertical no máximo uma vez por rodada (só o Instagram agendado usa).
  let uploaded: Promise<string> | null = null;
  const uploadVideo = () => {
    if (!r2.ready) throw new Error(`R2 não configurado (${r2.missing.join(", ")})`);
    uploaded ??= uploadToR2({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config, `shorts/${shortVideoFileName(aammdd)}`, file, "video/mp4");
    return uploaded;
  };
  for (const item of plan.items) {
    if (item.action === "buffer") {
      // #10772: só sobe o vídeo; a Buffer é chamada pela skill (MCP), que registra com --mark.
      const r = await prepareBufferItem(item, uploadVideo);
      results.push(r);
      console.error(r.ok ? `[ok] ${item.destination}: vídeo no R2 (${r.buffer!.videoUrl}) — falta o create_post na Buffer (skill)` : `[erro] ${item.destination}: ${r.error}`);
      continue;
    }
    if (item.action !== "publish" && item.action !== "enqueue") continue;
    let outcome: PublishOutcome;
    try {
      if (item.action === "enqueue") {
        outcome = await enqueueInstagramReel(
          {
            uploadVideo,
            enqueue: (payload) => postToWorkerQueue(workerUrl, workerToken, payload, 2, "publish-shorts"),
            now: () => new Date(),
          },
          item,
          shortsCfg.instagramCollaborators,
        );
      } else if (item.destination === "linkedin_profile") {
        if (!liCreds.ok) throw new Error(liCreds.reason); // o plano não marca publish sem credencial
        outcome = await publishLinkedInProfileVideo(
          { fetchFn: (u, i) => fetch(u, i), sleep: deps.sleep, log: deps.log, now: deps.now },
          liCreds.creds,
          liApiVersion,
          file,
          item.caption,
          item.title ?? plan.youtube.title,
        );
      } else if (item.destination === "instagram") {
        if (!igAuthor.ready) throw new Error(igAuthor.reason); // o plano não marca publish sem autora pronta
        outcome = await publishInstagramReel(deps, igAuthor.igUserId, igAuthor.token, igApiVersion, file, item.caption, shortsCfg.instagramCollaborators);
      } else {
        const page = pages.find((p) => facebookDestinationId(p.slug) === item.destination)!;
        outcome = await publishFacebookReel(deps, page, apiVersion, file, item.caption, item.scheduledAt);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ destination: item.destination, ok: false, error: msg });
      console.error(`[erro] ${item.destination}: ${msg}`);
      continue;
    }
    const { entry, unconfirmed } = outcome;
    // #573: o status do registro é o que o script fez; o estado normalizado é o que se relata.
    const state = resolveShortEntryState(entry, new Date());
    try {
      published = upsertShortEntry(published, entry);
      writePublished(publishedPath, published); // grava a cada destino — reduz a janela de duplicação num crash
    } catch (e) {
      // A plataforma JÁ aceitou: não pode virar "falhou" (a próxima rodada duplicaria).
      console.error(
        `[erro] ${item.destination}: ${entry.status === "scheduled" ? "AGENDADO" : "PUBLICADO"} (${entry.url ?? entry.id}) mas o registro não foi gravado: ${(e as Error).message}. ` +
          `NÃO rode --publish de novo para este destino sem antes registrá-lo em ${publishedPath}.`,
      );
      results.push({ destination: item.destination, ok: false, entry, error: `registro não gravado: ${(e as Error).message}` });
      continue;
    }
    results.push({ destination: item.destination, ok: true, entry, unconfirmed, ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}) });
    const where = item.action === "enqueue" ? `na fila do Worker para ${entry.scheduled_at} (key ${entry.id})` : (entry.url ?? entry.id);
    console.error(`[ok] ${item.destination}: ${entry.status} (estado ${state}) ${where}${unconfirmed ? " (processamento não confirmado em 5 min — confira)" : ""}`);
    for (const w of outcome.warnings ?? []) console.error(`[aviso] ${item.destination}: ${w}`);
  }
  const finalItems = blockRepostOnProfileFailure(plan.items, results);
  if (finalItems !== plan.items) {
    console.error("[aviso] linkedin_page_repost: o vídeo do perfil falhou nesta rodada — repost não oferecido");
    plan = { ...plan, items: finalItems };
  }
  const summary = {
    published: results.filter((r) => r.ok && r.entry?.status === "published").length,
    scheduled: results.filter((r) => r.ok && r.entry?.status === "scheduled").length,
    failed: results.filter((r) => !r.ok).length,
    /** #10772: envio ambíguo — conferir na rede antes de dizer "publicado". */
    unknown: results.filter((r) => r.ok && r.entry?.status === "send_unknown").length,
    buffer: results.filter((r) => r.ok && r.buffer).length,
    pending: plan.items.filter((i) => i.action === "pending_schedule").length,
    skipped: plan.items.filter((i) => i.action.startsWith("skip_") && i.action !== "skip_done").length,
    guided: plan.items.filter((i) => i.action === "guided").length,
  };
  console.log(JSON.stringify({ dry_run: false, ...plan, results, summary }, null, 2));
  return summary.failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("publish-shorts:", e instanceof Error ? e.message : e) });
}
