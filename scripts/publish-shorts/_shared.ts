/**
 * Constantes, tipos do plano, donos por destino (timers do 300) e leitura da pasta da edição, usados por todos os destinos.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishConfirmSuffix } from "../lib/diaria/publish-confirm.ts";
import { PAGE_REPOST_DESTINATION } from "../lib/diaria/video-publish-plan.ts";
import { editionDir as editionDirFor } from "../lib/edition-paths.ts";
import {
  CORTE_TIMER_DESTINATIONS,
  CORTE_TIMER_TASK,
  ALLOW_UNWATCHED_DIR_FLAG,
  corteBaseCommand,
  realpathLenient,
  samePathOnPlatform,
  shellQuote,
} from "../lib/diaria/short-corte.ts";
import { blocoNaVertical, ROTEIRO_FALAS_FILE } from "../lib/diaria/roteiro-videos.ts";
import type { BlockKey } from "../lib/diaria/video-montage.ts";
import type { ResolvedFacebookPage } from "../lib/facebook-pages.ts";
import {
  resolveVerticalBioCta,
  type ShortSlot,
  type ShortsPublishedFile,
  type ShortTime,
  type InstagramBackend,
  type WorkerInstagramAccount,
  type YouTubeShortMetadata,
  shortHorizontalRoute,
  type ShortHorizontalRoute,
} from "../lib/diaria/short-video.ts";
import { D1_VIDEO_URL_FILE } from "../lib/diaria/d1-video-link.ts";
import { editionVideoLink } from "../lib/shared/latest-video-redirect.ts";
import { readEditionHorizontalUrl } from "../set-latest-video-redirect.ts";
import type { ShortsRegistryWriter } from "../lib/diaria/shorts-published-store.ts";
import { describeCorteTimerHeartbeat, type CorteTimerHeartbeat } from "../lib/diaria/corte-timer-heartbeat.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../lib/diaria/youtube-upload.ts";
import { isNoVideoEdition } from "../lib/diaria/d1-no-video.ts";
import type { ScheduledSlot } from "../lib/social-slot-planner.ts";
import { THREADS_PROFILE_DESTINATION } from "../lib/threads-personal-video.ts";
import type { ChromeUploadPlanFile } from "../lib/diaria/instagram-chrome-upload.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** #11795: link de referência do corte avulso (nenhum texto do vertical leva link, #11617). */
export const DIARIA_HOME_URL = "https://diar.ia.br";
export const GRAPH = "https://graph.facebook.com";
export const GRAPH_VIDEO = "https://graph-video.facebook.com";
export const RUPLOAD = "https://rupload.facebook.com";

/**
 * #10982: por que o `linkedin_profile` não sai nesta rodada quando o timer do
 * 300 é o dono dele (`publishing.shorts.linkedin_profile_via_timer`).
 */
export const LINKEDIN_TIMER_DETAIL =
  "sai pelo timer do 300 (Diaria-Shorts-LinkedIn-Profile, publishing.shorts.linkedin_profile_via_timer) no horário do vertical; " +
  "para publicar desta máquina mesmo assim, rode só esse destino com --only linkedin_profile --linkedin-timer --publish --confirm-publish AAMMDD " +
  "(confira antes que o 300 não publicou; o --linkedin-timer recusa qualquer outro destino)";

/**
 * #11265: por que o `instagram` não sai nesta rodada quando o timer do 300 é
 * o dono dele (`publishing.shorts.instagram_backend: "timer-300"`).
 */
export const INSTAGRAM_TIMER_DETAIL =
  "sai pelo timer do 300 (Diaria-Shorts-Instagram, publishing.shorts.instagram_backend = timer-300) no horário do vertical, " +
  "com o vertical único do Drive pela API; se não conseguir, volta a tentar sozinho de hora em hora até 3 h depois do horário do vertical " +
  "e, se ainda assim o Reels não sair (acima do teto da API, credencial, falha), abre um alarme para o editor. " +
  "Para publicar pela API mesmo assim, rode NO 300 (de outra máquina vira um segundo escritor: o lock do timer não cruza máquina e o Reels sai duplicado) " +
  "só esse destino com --only instagram --instagram-timer --publish --confirm-publish AAMMDD " +
  "(confira antes que o 300 não publicou; o --instagram-timer recusa qualquer outro destino)";

/**
 * #11410: por que o `threads_profile` não sai nesta rodada quando o timer do
 * 300 é o dono dele (`publishing.shorts.threads_profile_via_timer`).
 */
export const THREADS_TIMER_DETAIL =
  "sai pelo timer do 300 (Diaria-Shorts-Threads-Profile, publishing.shorts.threads_profile_via_timer) no horário do vertical, " +
  "até 3 h depois dele; se não sair, o timer abre um alarme para o editor. " +
  "Para publicar mesmo assim, rode NO 300 (de outra máquina vira um segundo escritor e o post pode sair duplicado) " +
  "só esse destino com --only threads_profile --threads-timer --publish --confirm-publish AAMMDD " +
  "(confira antes que o vídeo não está no perfil; o --threads-timer recusa qualquer outro destino)";

/**
 * #11964: por que um destino do timer do corte (`CORTE_TIMER_DESTINATIONS`) não
 * sai na rodada manual do corte com `publishing.shorts.corte_via_timer` ligado,
 * a partir de 10 min antes do horário até 3 h depois: é a janela em que o timer
 * do 300 publica. As duas rodadas publicando o mesmo destino ao mesmo tempo
 * duplicam o post (a conferência da conta só vê o post que já está no ar).
 */
export function corteTimerDelegatedDetail(slug: string): string {
  return (
    `sai pelo timer do 300 (${CORTE_TIMER_TASK}, de hora em hora, publishing.shorts.corte_via_timer), que é o dono deste destino do horário do corte até 3 h depois e alarma se falhar; ` +
    `esta rodada não o publica para não sair em dobro com o timer (#11964). O timer só publica com o "pode publicar" (--publish --confirm-publish do corte). ` +
    `Para publicar já, rode NO 300 o próprio timer: npx tsx scripts/shorts-corte-timer.ts --corte ${slug}`
  );
}

/**
 * #11265: motivo do pulo de X/Threads quando o R2 NÃO está configurado (só é
 * chamado com `r2.ready === false`). Escrito quando o R2 não seria habilitado
 * (decisão do editor, 27/10/2026); ele foi habilitado no mesmo dia (#10772),
 * então hoje `r2.ready === false` significa máquina sem os secrets
 * `R2_*`/`SHORTS_R2_*`. Com o backend do timer o aviso não lista os secrets;
 * com `worker-r2` (que depende dele) lista o que falta. Desde o #11478 o
 * destino fica PENDENTE (não terminal) e o aviso diz isso (#11498): mandar o
 * editor postar à mão o que outra máquina vai publicar duplica o post.
 */
export function publicVideoUnavailableReason(backend: InstagramBackend, r2Missing: readonly string[]): string {
  const cause = publicVideoUnavailableCause(backend, r2Missing);
  return backend === "timer-300" ? `${cause} — fica pendente; publica numa máquina com os secrets do R2 (ou à mão, registrando com --mark)` : cause;
}

/**
 * Pure: só a causa, sem o "fica pendente" de X/Threads. É o que o Instagram do
 * timer cita (#11355): ali quem responde é o alarme, com o que fazer no corpo.
 */
export function publicVideoUnavailableCause(backend: InstagramBackend, r2Missing: readonly string[]): string {
  return backend === "timer-300"
    ? "sem URL pública do vertical: R2 não configurado nesta máquina (faltam os secrets R2_*/SHORTS_R2_*; o bucket existe desde 27/10/2026, #10772/#11265)"
    : `falta ${r2Missing.join(", ")}`;
}

/** Destinos que só o skill faz (Chrome; o X e o TikTok pela Buffer MCP, #10772/#11515). */
export const GUIDED_DESTINATIONS = new Set(["youtube_shorts", "facebook_profile", "linkedin_page_repost", "x", "tiktok"]);

/** #11515: destinos que saem pela Buffer (`--mark {destino}=buffer:{id}`). */
export const BUFFER_DESTINATIONS = new Set(["x", "tiktok"]);

/**
 * Destinos que `--mark` aceita: os guiados + o `instagram`, que vira passo
 * guiado quando o vertical passa do teto de duração da API (#10893) — o editor
 * posta no app e registra, e a próxima rodada não tenta o rupload de novo — e
 * os dois perfis pessoais de API (`linkedin_profile`, `threads_profile`,
 * #11122), pra registrar a URL depois de conferir um `send_unknown`.
 */
export const MARKABLE_DESTINATIONS = new Set([...GUIDED_DESTINATIONS, "instagram", "linkedin_profile", THREADS_PROFILE_DESTINATION]);

export type ShortsPlanItem =
  /** `title`: título da mídia (vídeo do LinkedIn pessoal, #10772). */
  | { destination: string; mode: "api"; action: "publish"; caption: string; scheduledAt: string | null; title?: string }
  /** `title` (#12654): o mesmo título de mídia que o `publish` levaria, para o plano aprovado já trazê-lo. */
  | { destination: string; mode: "api"; action: "pending_schedule"; caption: string; scheduledAt: string; detail: string; title?: string }
  /** #10823: Reels do Instagram com horário futuro, entregue à fila do Worker. */
  /** `idempotencyKey` (#10906): o POST /queue repetido cai na mesma entry do Worker. */
  | { destination: string; mode: "api"; action: "enqueue"; caption: string; scheduledAt: string; igAccount: WorkerInstagramAccount; idempotencyKey: string }
  | { destination: string; mode: "api" | "guided"; action: "skip_done" }
  /** `skip_late` (#10772 F4): o horário do destino passou além do teto de atraso — vira passo manual. */
  /** `skip_delegated` (#10982): o destino sai por outro caminho (o `linkedin_profile` pelo timer do 300). */
  /**
   * `cause: "public_video"` (#11240): o pulo veio do R2 fora do ar (X/Threads
   * recebem o vídeo por URL pública), não de credencial do destino. Só o pulo
   * por credencial conta como terminal pra limpeza do vertical.
   */
  /**
   * `retryAt` (#12761): só no `linkedin_page_repost` em `skip_invalid` porque o
   * vídeo do perfil ainda vai sair por um dono automático — o horário em que a
   * re-execução repostará (grade da página, ≥30 min depois do perfil).
   */
  | { destination: string; mode: "api" | "guided"; action: "skip_missing_credentials" | "skip_invalid" | "skip_late" | "skip_delegated"; detail: string; cause?: "public_video"; retryAt?: string }
  /** `at`: horário planejado do passo guiado (repost da página, #10772; Instagram manual acima do teto, slot da grade, #10933). Ausente = `shortTime`. */
  /**
   * `upload` (#10915): o arquivo a subir no passo guiado — no Instagram acima
   * do teto, a versão comprimida pro `file_upload` do Chrome (ou o original,
   * se a compressão falhou), com `fitsChromeUpload` dizendo se ele cabe nos
   * 10 MB do `file_upload`. Só existe depois do `--publish`.
   */
  | { destination: string; mode: "guided"; action: "guided"; caption?: string; detail: string; at?: string; upload?: ChromeUploadPlanFile }
  /**
   * #10772: X via Buffer (MCP, só a skill chama). `scheduledAt` null = postar
   * já. A URL pública do vídeo só existe no `--publish` (sobe pro R2): vem em
   * `results[].buffer`.
   */
  | {
      destination: string;
      mode: "guided";
      action: "buffer";
      caption: string;
      scheduledAt: string | null;
      detail: string;
      /** #11515: canal da Buffer quando o destino não é o X (o do X vem de `publishing.social.twitter`). */
      channelId?: string;
      /** #11515: `metadata.tiktok` do `create_post` (título e a declaração de conteúdo de IA). */
      tiktok?: TikTokBufferMetadata;
    };

/** #11515: `metadata.tiktok` da Buffer. `isAiGenerated: false`: o vídeo é o Pixel gravado (decisão do editor, 28/10/2026). */
export interface TikTokBufferMetadata {
  title: string;
  isAiGenerated: boolean;
}

export interface ShortsPlan {
  aammdd: string;
  editionUrl: string;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  cover: { path: string | null; destinations: Record<string, string> };
  longVideo: string;
  youtube: YouTubeShortMetadata;
  /** Horário do vertical (#10831): HH:MM BRT, ISO no dia da edição, de onde veio. Base dos destinos guiados. */
  shortTime: ShortTime & { at: string };
  /**
   * #12250: horário de cada destino do plano (id → HH:MM BRT, ISO e origem).
   * Difere de `shortTime` só no destino com horário próprio em
   * `by_destination` (hoje o `youtube_shorts`, 06:30).
   */
  destinationTimes: Record<string, ShortTime & { at: string }>;
  /** Horário de cada destino de API desta rodada contra a grade já agendada (#10819). */
  slots: ShortSlot[];
  items: ShortsPlanItem[];
  /**
   * #11550: quem executa cada destino que não sai nesta rodada (ou sai por
   * passo da skill). Decisão do editor de 28/10/2026: "sempre é você que
   * precisa publicar" — nenhum destino volta para ele como passo manual.
   */
  owners: ShortsDestinationOwner[];
  /**
   * #12735: caminho de cada destino até o horizontal — o link na legenda
   * (`05-video-url.txt`), o link da bio (`diar.ia.br/video` com UTM da rede),
   * o vídeo relacionado do Short ou o repost. `link: null` = sem link nesta
   * rodada (`note` diz por quê). Ausente no corte avulso (não tem horizontal).
   */
  horizontalLinks?: Record<string, ShortHorizontalLinkPlan>;
  premises: string[];
  warnings: string[];
}

/** #12735: o link do horizontal usado por um destino do vertical. */
export interface ShortHorizontalLinkPlan {
  route: ShortHorizontalRoute;
  link: string | null;
  note: string;
  /** #13117: resposta ao post do Threads, corpo continua sem URL. #13709: leva o link por edição. */
  replyText?: string;
  /** #13709: 1º comentário do Reels no Instagram, com o link por edição. */
  commentText?: string;
}

/**
 * Pure (#12735): o caminho até o horizontal de cada destino do plano.
 * `horizontalUrl` = o `05-video-url.txt` da edição (`null` = ainda sem link,
 * ou edição sem vídeo: `noVideo`). #13709: `aammdd` monta o link por edição
 * (`diar.ia.br/video/{AAMMDD}`) do Instagram (1º comentário) e do Threads
 * (resposta); o TikTok fica sem link.
 */
export function planShortHorizontalLinks(destinations: readonly string[], horizontalUrl: string | null, noVideo: boolean, aammdd: string): Record<string, ShortHorizontalLinkPlan> {
  const out: Record<string, ShortHorizontalLinkPlan> = {};
  for (const id of destinations) {
    const route = shortHorizontalRoute(id);
    if (route === "caption") {
      out[id] = horizontalUrl
        ? { route, link: horizontalUrl, note: "na legenda (05-video-url.txt)" }
        : { route, link: null, note: noVideo ? "edição marcada sem vídeo: legenda sem link" : `${D1_VIDEO_URL_FILE} ausente: legenda sem link (rode depois do horizontal)` };
    } else if (route === "comment" || route === "reply") {
      // #13709: link por edição; o Worker do apex resolve o horizontal DESTA edição no clique.
      const link = editionVideoLink(aammdd, id === "threads_profile" ? "threads" : "instagram");
      out[id] = noVideo
        ? { route, link: null, note: "edição marcada sem vídeo: sem link por edição" }
        : {
            route,
            link,
            note: route === "comment"
              ? "link por edição no 1º comentário do Reels (a legenda não tem link clicável)"
              : "link por edição numa resposta ao próprio post (o corpo segue sem URL)",
          };
    } else if (route === "none") {
      out[id] = { route, link: null, note: "TikTok sem link (#13709): a legenda não tem link clicável e a bio não leva ao horizontal" };
    } else if (route === "related_video") {
      out[id] = { route, link: null, note: "vídeo relacionado do Short (#10811); link na descrição de Short não é clicável (#10831)" };
    } else {
      out[id] = { route, link: horizontalUrl, note: "repost do vídeo do perfil: herda o texto do linkedin_profile" };
    }
  }
  return out;
}

/**
 * Pure (#12786): a rodada `--publish` grava o `diar.ia.br/video` no KV? Só a
 * rodada principal da edição (a do `/diaria-publica`). O corte avulso não tem
 * horizontal, e as rodadas dos timers do 300 (`--linkedin-timer`,
 * `--instagram-timer`, `--threads-timer`) publicam um destino só, várias vezes
 * por dia: ler o KV em cada uma era trabalho repetido sem efeito, e um 05
 * trocado à mão entre duas execuções faria um timer, e não a rodada da edição,
 * mudar o link da bio.
 */
export function shouldUpdateLatestVideoOnPublish(input: { corte: boolean; writer: ShortsRegistryWriter }): boolean {
  return !input.corte && input.writer === "main";
}

/**
 * Pure (#12786): aviso quando um destino que leva o link do horizontal na
 * legenda vai sair (ou ser agendado) sem ele, porque o `05-video-url.txt`
 * ainda não existe. `null` = nada a avisar (todos com link, edição sem vídeo,
 * ou nenhum desses destinos sai nesta rodada). O texto diz como corrigir os
 * agendados depois do horizontal: o `--update-scheduled` reescreve a legenda
 * do Facebook e do X com o link (`planScheduledUpdates`).
 */
export function missingHorizontalLinkWarning(
  aammdd: string,
  horizontalLinks: Record<string, ShortHorizontalLinkPlan> | undefined,
  items: readonly ShortsPlanItem[],
  noVideo: boolean,
): string | null {
  if (!horizontalLinks || noVideo) return null;
  const outgoing = new Set(["publish", "pending_schedule", "enqueue", "buffer"]);
  const missing = items
    .filter((i) => outgoing.has(i.action))
    .map((i) => i.destination)
    .filter((d) => horizontalLinks[d]?.route === "caption" && !horizontalLinks[d]?.link);
  if (!missing.length) return null;
  return (
    `${missing.join(", ")} sai(em) sem o link do horizontal na legenda: ${D1_VIDEO_URL_FILE} ainda não existe (#12786). ` +
    `O caminho normal é publicar o horizontal antes. Se já agendou, depois do horizontal rode ` +
    `publish-shorts.ts ${aammdd} --update-scheduled --publish --confirm-publish ${aammdd} (troca a legenda do Facebook e do X agendados); ` +
    `o que já foi ao ar fica sem o link.`
  );
}

/**
 * #11550: o dono automático de um destino.
 *   - `timer-300`: uma task do 300 publica (`task`), sem ação da skill;
 *   - `agent-scheduled-task`: a skill cria uma task agendada one-shot que roda
 *     `command` em `at` (a API do destino não agenda e não há timer ligado);
 *   - `agent`: o agente executa nesta mesma rodada (`command`, ou o passo
 *     guiado/Buffer descrito no item).
 * Nunca `editor`: o relato da skill não devolve destino ao editor.
 */
export interface ShortsDestinationOwner {
  destination: string;
  action: ShortsPlanItem["action"];
  by: "timer-300" | "agent-scheduled-task" | "agent";
  task?: string;
  at?: string;
  command?: string;
  note: string;
}

/** Task do 300 que é dona de cada destino delegado (`scripts/lib/scheduled-tasks.ts`). */
export const SHORTS_TIMER_TASKS: Readonly<Record<string, string>> = {
  linkedin_profile: "Diaria-Shorts-LinkedIn-Profile",
  instagram: "Diaria-Shorts-Instagram",
  [THREADS_PROFILE_DESTINATION]: "Diaria-Shorts-Threads-Profile",
};

/** Flag de timer que faz a rodada ser a dona do destino (sem ela o destino delegado cai em `skip_delegated`). */
const TIMER_FLAG_OF: Partial<Record<ShortsRegistryWriter, { destination: string; flag: string }>> = {
  "linkedin-timer": { destination: "linkedin_profile", flag: "--linkedin-timer" },
  "threads-timer": { destination: THREADS_PROFILE_DESTINATION, flag: "--threads-timer" },
  "instagram-timer": { destination: "instagram", flag: "--instagram-timer" },
};

/**
 * Pure (#11679 item 3): argumentos que publicam um destino em `skip_late` já.
 * Na rodada do timer dono do destino, `--only X --publish --now` sem a flag do
 * timer cai em `skip_delegated` e não publica — a flag vai junto.
 */
export function lateNowArgs(destination: string, writer?: ShortsRegistryWriter): string {
  const timer = writer ? TIMER_FLAG_OF[writer] : undefined;
  return `--only ${destination} --publish${timer?.destination === destination ? ` ${timer.flag}` : ""} --now`;
}

/** Antecedência mínima para valer a pena agendar em vez de executar já (mesmo limiar de `resolveReelsSchedule`). */
export const OWNER_SCHEDULE_MIN_LEAD_MS = 10 * 60_000;

/**
 * Pure (#11550): dono de cada destino que não terminou nesta rodada.
 * `pending_schedule` sem timer vira task agendada pela skill; `skip_late` e os
 * passos guiados/Buffer ficam com o agente; `skip_delegated`, com o timer.
 * Destinos que saem nesta rodada (`publish`/`enqueue`), já registrados
 * (`skip_done`) ou pulados por credencial/conteúdo não entram.
 */
export function assignShortsDestinationOwners(
  items: readonly ShortsPlanItem[],
  ctx: {
    aammdd: string;
    now: Date;
    instagramViaTimer: boolean;
    writer?: ShortsRegistryWriter;
    /** #11795: comando base do corte avulso (`--corte SLUG`); os passos guiados re-executam por ele, sem a skill da edição. */
    baseCommand?: string;
    /** #11795: corte avulso com `publishing.shorts.corte_via_timer` — o timer do 300 é o dono dos destinos que a API não agenda. */
    corteTimer?: boolean;
    /** #11911: `--edition-dir` fora da pasta canônica — vai em todo comando de re-execução da edição. */
    editionDirOverride?: string;
  },
): ShortsDestinationOwner[] {
  // #11911: a pasta fora da canônica só roda com o escape — a re-execução leva os dois.
  // #11944: aspas simples de shell (com JSON.stringify, `$` e crase do caminho seriam expandidos).
  const dirArg = ctx.editionDirOverride !== undefined ? ` --edition-dir ${shellQuote(ctx.editionDirOverride)} --${ALLOW_UNWATCHED_DIR_FLAG}` : "";
  const base = ctx.baseCommand ?? `npx tsx scripts/publish-shorts.ts ${ctx.aammdd}${dirArg}`;
  const owners: ShortsDestinationOwner[] = [];
  for (const item of items) {
    const { destination, action } = item;
    if (action === "skip_delegated" && ctx.corteTimer && CORTE_TIMER_DESTINATIONS.includes(destination)) {
      // #11964: no corte, o dono é o timer do corte (não os timers da edição).
      owners.push({
        destination,
        action,
        by: "timer-300",
        task: CORTE_TIMER_TASK,
        note: `o timer do 300 (${CORTE_TIMER_TASK}, de hora em hora) publica na próxima execução, até 3 h depois do horário do corte, e alarma se falhar; só com o "pode publicar" do --publish --confirm-publish (#11912, #11964)`,
      });
    } else if (action === "skip_delegated" && ctx.corteTimer && destination === PAGE_REPOST_DESTINATION) {
      // #13733: o repost acompanha o vídeo do perfil no timer do corte (fila do Worker com a URN gravada).
      owners.push({
        destination,
        action,
        by: "timer-300",
        task: CORTE_TIMER_TASK,
        note: `o timer do 300 (${CORTE_TIMER_TASK}) publica o vídeo do perfil e, na mesma execução, põe o repost da página na fila do Worker com a URN recém-gravada; alarma o editor se não conseguir (#13733)`,
      });
    } else if (action === "skip_delegated") {
      const task = SHORTS_TIMER_TASKS[destination];
      owners.push({ destination, action, by: "timer-300", ...(task ? { task } : {}), note: `o timer do 300${task ? ` (${task})` : ""} publica no horário do vertical e alarma se não sair` });
    } else if (action === "pending_schedule") {
      if (ctx.corteTimer && CORTE_TIMER_DESTINATIONS.includes(destination)) {
        owners.push({
          destination,
          action,
          by: "timer-300",
          task: CORTE_TIMER_TASK,
          at: item.scheduledAt,
          note: `o timer do 300 (${CORTE_TIMER_TASK}, de hora em hora) publica na 1ª execução depois de ${item.scheduledAt}, até 3 h, e alarma o editor se o destino falhar; só depois do --publish --confirm-publish do corte (o "pode publicar", #11912), nunca a partir do dry-run`,
        });
      } else if (destination === "instagram" && ctx.instagramViaTimer) {
        owners.push({ destination, action, by: "timer-300", task: SHORTS_TIMER_TASKS.instagram, at: item.scheduledAt, note: "rodada do timer do 300: ele mesmo publica depois do horário" });
      } else {
        owners.push({
          destination,
          action,
          by: "agent-scheduled-task",
          at: item.scheduledAt,
          command: `${base} --only ${destination} --publish ${publishConfirmSuffix(ctx.aammdd)}`,
          note:
            `a API não agenda: a skill cria uma task agendada one-shot para ${item.scheduledAt} com este comando` +
            (SHORTS_TIMER_TASKS[destination] ? ` (dono permanente: ligar o timer ${SHORTS_TIMER_TASKS[destination]} no 300)` : ""),
        });
      }
    } else if (action === "skip_late") {
      owners.push({
        destination,
        action,
        by: "agent",
        command: `${base} ${lateNowArgs(destination, ctx.writer)} ${publishConfirmSuffix(ctx.aammdd)}`,
        note: "horário passou do teto: o agente publica nesta rodada com --now (ou registra com --mark se já saiu); nunca volta ao editor",
      });
    } else if (action === "guided") {
      const at = item.at;
      const later = at !== undefined && Date.parse(at) - ctx.now.getTime() > OWNER_SCHEDULE_MIN_LEAD_MS;
      if (ctx.baseCommand) {
        // #11795: o corte não tem skill de re-execução (a `/diaria-publica` só conhece edição) e o
        // comando do corte só imprime o plano de um passo guiado: o agente desta rodada é o dono real.
        owners.push({
          destination,
          action,
          by: "agent",
          ...(at !== undefined ? { at } : {}),
          note:
            `passo guiado (Chrome) do corte, executado pelo agente nesta rodada` +
            (later ? `: agendar na própria plataforma para ${at}, ou publicar e registrar com --mark` : "") +
            ` (re-executar ${ctx.baseCommand} só reimprime o plano)`,
        });
        continue;
      }
      owners.push(
        later
          ? {
              destination,
              action,
              by: "agent-scheduled-task",
              at,
              command: ctx.baseCommand ?? `/diaria-publica ${ctx.aammdd} --so vertical`,
              note: `passo guiado da skill (Chrome) às ${at}: a skill agenda a própria re-execução para esse horário`,
            }
          : { destination, action, by: "agent", note: "passo guiado da skill (Chrome), executado pelo agente nesta rodada" },
      );
    } else if (action === "buffer") {
      owners.push({ destination, action, by: "agent", note: "o agente agenda pela Buffer MCP (create_post) nesta rodada" });
    } else if (item.action === "skip_invalid" && destination === "linkedin_page_repost" && item.retryAt !== undefined) {
      // #12761: o repost espera o perfil, que sai por outro dono (timer do 300 ou --now do agente).
      // A re-execução leva o linkedin_profile junto: se ele ainda não saiu, o repost segue bloqueado
      // e ganha dono de novo; se saiu, o --publish reposta pela fila do Worker (#11121).
      const at = item.retryAt;
      const command = `${base} --only linkedin_profile,linkedin_page_repost --publish ${publishConfirmSuffix(ctx.aammdd)}`;
      const later = Date.parse(at) - ctx.now.getTime() > OWNER_SCHEDULE_MIN_LEAD_MS;
      owners.push(
        later
          ? {
              destination,
              action,
              by: "agent-scheduled-task",
              at,
              command,
              note: `repost depende do vídeo do perfil, que sai por outro dono: a skill cria uma task agendada one-shot para ${at} (depois do perfil) com este comando`,
            }
          : { destination, action, by: "agent", at, command, note: "repost depende do vídeo do perfil: o agente re-executa este comando nesta rodada, depois que o perfil sair" },
      );
    }
  }
  return owners;
}

interface ShortsPlanCommonInput {
  coverPath?: string | null;
  coverUploadReady?: boolean;
  /** #11547: `thumbnailOffset` (ms) do X/Buffer, derivado do timecode do Still; null = a Buffer escolhe. */
  coverBufferOffsetMs?: number | null;
  aammdd: string;
  reviewedMd: string;
  now: Date;
  config: unknown;
  pages: ResolvedFacebookPage[];
  instagramReady: boolean;
  /** Por que o Instagram não está pronto (vira o aviso do plano). */
  instagramNotReadyReason?: string;
  /**
   * Plano B na conta sem teto (#11355) ou com o vertical dentro do teto (#11774): trata o Instagram como passo guiado com
   * este motivo, sem olhar a duração. Só o `prepare-instagram-guided.ts` passa,
   * e ele nunca publica; a rodada que publica segue pela API.
   */
  instagramGuidedFallback?: string;
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
   * #11122: credencial do Threads pessoal (`readThreadsPersonalCreds`).
   * Ausente = não conferida → o destino é pulado com aviso.
   */
  threadsPersonal?: { ready: true } | { ready: false; reason: string };
  /**
   * #10772: dá pra servir o vertical por URL pública (R2)? O X (Buffer) só
   * recebe vídeo por URL. Ausente = não → X pulado com aviso.
   */
  publicVideo?: { ready: true } | { ready: false; reason: string; cause?: string };
  /**
   * #11070: credencial do canal (`YOUTUBE_*`, `missingYouTubeCredentials`).
   * Pronta → o Short sobe pela Data API; ausente ou não pronta → passo guiado.
   */
  youtubeApi?: { ready: true } | { ready: false; reason: string };
  /**
   * Quem é esta rodada (#11368: um campo só, nunca "os dois timers"). Ausente =
   * `main`. `linkedin-timer` (#10982, `--linkedin-timer`): com
   * `linkedin_profile_via_timer` ligado, só ela publica o `linkedin_profile`.
   * `instagram-timer` (#11265, `--instagram-timer`): com `instagram_backend:
   * "timer-300"`, só ela publica o `instagram`. `threads-timer` (#11410,
   * `--threads-timer`): com `threads_profile_via_timer`, só ela publica o
   * `threads_profile`.
   */
  writer?: ShortsRegistryWriter;
  video: { path: string; exists: boolean; sizeBytes: number | null };
  /**
   * #10893: duração do vertical (`mp4DurationSeconds`). Ausente = não medida;
   * null = medida mas ilegível. Nos dois casos o Instagram segue pela API
   * (com aviso no null, se o vídeo existe).
   */
  videoDurationSeconds?: number | null;
  /**
   * #12191: o horizontal da edição, para a descrição do Short citá-lo por
   * título (`readHorizontalVideoForShort`). Ausente = sem registro e sem
   * marcador de "sem vídeo": cita o título derivado do D1. Ignorado no corte.
   */
  horizontalVideo?: {
    recordTitle: string | null;
    noVideo: boolean;
    url?: string | null;
    ctaVertical?: boolean;
    /** #13280: `porVideo.vertical1.pertenceAoHorizontal` do roteiro; ausente = critério do título (#13209). */
    pertenceAoHorizontal?: boolean;
    roteiroWarning?: string;
  };
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
  /**
   * #11986: heartbeat do timer do corte (`readCorteTimerHeartbeat`). Presente e
   * velho com destinos entregues ao timer = aviso em `warnings` (o timer pode
   * estar parado e nada publicar esses destinos). Ausente (testes, filho do
   * timer) = sem conferência.
   */
  corteTimerHeartbeat?: CorteTimerHeartbeat;
}

/** #11944: corte discrimina a origem; pasta e aviso da edição são inseparáveis. */
export type ShortsPlanInput = ShortsPlanCommonInput & (
  | {
      /** Corte avulso: título, gancho e horário próprios, fora da edição. */
      corte: {
        slug: string; hhmm: string; title: string; hook: string;
        /** #11964: só o filho autorizado do timer publica na janela dele. */
        timerRun?: boolean;
      };
      corteOutside?: { dir: string; warning: string };
      editionDirOverride?: never;
      unwatchedEditionWarning?: never;
    }
  | ({ corte?: undefined; corteOutside?: never } & (
      | { editionDirOverride?: undefined; unwatchedEditionWarning?: never }
      | { editionDirOverride: string; unwatchedEditionWarning: string }
    ))
);

/**
 * Puro (#11911): `--edition-dir` aponta para fora da pasta canônica da edição?
 * Devolve o caminho a passar ao plano (`editionDirOverride`), ou `undefined`.
 */
export function nonCanonicalEditionDir(
  dir: string,
  canonicalDir: string,
  realpath: (p: string) => string = safeRealpath,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  // Compara pelo caminho real: `data/` é symlink pro OneDrive, e o mesmo diretório por outro caminho não é "fora".
  // #11944: no Windows sem diferenciar maiúsculas (o NTFS não diferencia).
  return samePathOnPlatform(realpath(resolve(dir)), realpath(resolve(canonicalDir)), platform) ? undefined : resolve(dir);
}

/** #11911: pasta canônica da edição, absoluta pela raiz do repo (não pelo cwd). */
export function canonicalShortsEditionDir(aammdd: string, root: string = ROOT): string {
  return resolve(root, editionDirFor(aammdd));
}

function safeRealpath(p: string): string {
  return realpathLenient(p);
}

/**
 * Puro (#11911): no modo edição, a pasta fora de `data/editions/{AAMM}/{AAMMDD}`
 * (`override`, de `nonCanonicalEditionDir`) é invisível aos timers do 300
 * (Instagram, LinkedIn e Threads pessoais) — recusa, a menos do escape
 * `--allow-unwatched-dir`, que devolve o aviso.
 */
export function checkEditionDir(input: { aammdd: string; override: string | undefined; allowUnwatched: boolean; canonicalDir: string }):
  | { ok: true; outside: false }
  | { ok: true; outside: true; warning: string }
  | { ok: false; error: string } {
  if (input.override === undefined) return { ok: true, outside: false };
  if (!input.allowUnwatched) {
    return {
      ok: false,
      error:
        `--edition-dir ${input.override} fica fora da pasta canônica da edição ${input.aammdd} (${input.canonicalDir}): os timers do 300 (Instagram, LinkedIn e Threads pessoais) não enxergam esta pasta, então nenhum destino que faltar gera alarme. ` +
        `Rode sem --edition-dir (usa a pasta canônica) ou, se for um corte fora de edição, use --corte SLUG (registro em data/cortes/SLUG/). ` +
        `Para rodar mesmo assim, sem alarme, passe --${ALLOW_UNWATCHED_DIR_FLAG} (#11911)`,
    };
  }
  return {
    ok: true,
    outside: true,
    warning:
      `--edition-dir ${input.override} fora da pasta canônica da edição ${input.aammdd} (${input.canonicalDir}) por --${ALLOW_UNWATCHED_DIR_FLAG}: nenhum alarme de destino faltante cobre esta pasta ` +
      `(os timers do 300 de Instagram, LinkedIn e Threads pessoais não a enxergam); confira cada destino à mão (#11911)`,
  };
}

/**
 * Puro (#11911): contexto dos donos recalculados depois da publicação (#11550).
 * Espelha o do plano: pasta fora da canônica (edição ou corte) nunca delega a
 * timer e leva a pasta e o escape nos comandos de re-execução.
 */
export function ownersContextAfterPublish(input: {
  aammdd: string;
  now: Date;
  instagramBackend: InstagramBackend;
  corteViaTimer: boolean;
  writer?: ShortsRegistryWriter;
  corteSlug?: string;
  corteOutsideDir?: string;
  editionDirOverride?: string;
}): Parameters<typeof assignShortsDestinationOwners>[1] {
  const corte = input.corteSlug !== undefined;
  return {
    aammdd: input.aammdd,
    now: input.now,
    instagramViaTimer: input.instagramBackend === "timer-300" && !corte && input.editionDirOverride === undefined,
    ...(input.writer !== undefined ? { writer: input.writer } : {}),
    ...(corte
      ? { baseCommand: corteBaseCommand(input.corteSlug!, input.corteOutsideDir), corteTimer: input.corteViaTimer && input.corteOutsideDir === undefined }
      : input.editionDirOverride !== undefined
        ? { editionDirOverride: input.editionDirOverride }
        : {}),
  };
}

/** Puro (#11986): aviso da rodada que entrega destinos a um timer do corte sem execução recente. */
export function corteTimerStaleWarning(delegated: readonly string[], hb: CorteTimerHeartbeat, now: Date): string {
  return (
    `timer do corte (${CORTE_TIMER_TASK}) sem execução recente — ${describeCorteTimerHeartbeat(hb, now)}: ${delegated.join(", ")} ficam com ele e não saem se ele estiver parado (desarmado ou 300 fora do ar). ` +
    "Confira a task no 300 antes de contar com o timer; a vigia dos cortes no 300 alarma por e-mail se o horário passar com ele parado (#11986)"
  );
}

/**
 * #13117: chamada falada do roteiro; leitura sem efeitos externos. Os blocos
 * legados `cta_ig`/`cta_out`/`cta_yt` também viram `cta_vertical` na vertical
 * (`blocoNaVertical`). Sem o arquivo = sem aviso (edição sem roteiro pela
 * skill, mesmo padrão de `readRoteiroHorizontal`); ilegível ou inválido avisa.
 */
export function readVerticalCta(editionDir: string): { ctaVertical?: boolean; pertenceAoHorizontal?: boolean; roteiroWarning?: string } {
  const path = join(editionDir, ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw?.falas)) throw new Error("falas ausentes");
    // #13280: a marcação do roteiro de que o vertical 1 pertence ao horizontal. Só boolean conta; outro tipo é ignorado (vale o título, #13209).
    const marca = raw?.porVideo?.vertical1?.pertenceAoHorizontal;
    return {
      ctaVertical: raw.falas.some(
        (f: { bloco?: unknown; texto?: unknown }) =>
          typeof f?.bloco === "string" && blocoNaVertical(f.bloco as BlockKey) === "cta_vertical" && typeof f.texto === "string" && f.texto.trim() !== "",
      ),
      ...(typeof marca === "boolean" ? { pertenceAoHorizontal: marca } : {}),
    };
  } catch {
    return { roteiroWarning: "roteiro-falas.json ilegível ou inválido: não foi possível conferir cta_vertical; comportamento anterior preservado (#13117)" };
  }
}

/**
 * #13210 item 1: o aviso de `roteiro-falas.json` ilegível nas rotas de troca
 * de texto (`--update-scheduled`, `--update-published`). O plano de
 * publicação já o põe em `plan.warnings`; sem isto, no update a linha
 * "Vídeo completo: link na bio" sumia sem aviso. Corte (`null`) não avisa:
 * não tem horizontal nem roteiro da edição.
 */
export function horizontalRoteiroWarnings(horizontal: { roteiroWarning?: string } | null): string[] {
  return horizontal?.roteiroWarning ? [horizontal.roteiroWarning] : [];
}

/**
 * #13209: a linha da bio nas rotas de troca de texto (`--update-scheduled`,
 * `--update-published`), com a mesma regra do plano: fala `cta_vertical`,
 * horizontal publicado e a marcação do roteiro (#13280) ou, sem ela, o mesmo
 * título do horizontal publicado.
 */
export function verticalBioCtaFromHorizontal(
  horizontal: { recordTitle: string | null; noVideo: boolean; ctaVertical?: boolean; pertenceAoHorizontal?: boolean },
  d1Title: string,
): boolean {
  return resolveVerticalBioCta({
    ctaFala: horizontal.ctaVertical === true,
    d1Title,
    recordTitle: horizontal.recordTitle,
    noVideo: horizontal.noVideo,
    pertenceAoHorizontal: horizontal.pertenceAoHorizontal,
  }).ctaVertical;
}

/**
 * #12191: o horizontal da edição para a citação na descrição do Short. Lê o
 * título do registro do upload (`_internal/05-youtube-published.json`) e o
 * marcador de edição sem vídeo. Fail-soft: registro ausente ou ilegível vira
 * `recordTitle: null` (a citação cai no título derivado do D1).
 */
export function readHorizontalVideoForShort(editionDir: string): {
  recordTitle: string | null;
  noVideo: boolean;
  url: string | null;
  ctaVertical?: boolean;
  pertenceAoHorizontal?: boolean;
  roteiroWarning?: string;
} {
  const roteiro = readVerticalCta(editionDir);
  const noVideo = isNoVideoEdition(editionDir);
  const url = noVideo ? null : readHorizontalUrlForShort(editionDir);
  const recordPath = join(editionDir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(recordPath)) return { recordTitle: null, noVideo, url, ...roteiro };
  try {
    const raw = JSON.parse(readFileSync(recordPath, "utf8")) as { title?: unknown } | null;
    const title = raw && typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null;
    return { recordTitle: title, noVideo, url, ...roteiro };
  } catch {
    console.error(`[aviso] ${recordPath} ilegível — o Short cita o título do horizontal derivado do D1 (#12191)`);
    return { recordTitle: null, noVideo, url, ...roteiro };
  }
}

/**
 * #12735: o link do horizontal da edição (`_internal/05-video-url.txt`) para a
 * legenda do vertical. Fail-soft: ausente → `null`; conteúdo que não é vídeo
 * do YouTube → aviso e `null` (a legenda sai sem link, nunca com URL errada).
 */
export function readHorizontalUrlForShort(editionDir: string): string | null {
  try {
    return readEditionHorizontalUrl(editionDir);
  } catch (e) {
    console.error(`[aviso] ${join(editionDir, D1_VIDEO_URL_FILE)}: ${(e as Error).message} — o vertical sai sem o link do horizontal (#12735)`);
    return null;
  }
}

export type InstagramQueueReadiness = { ready: true; account: WorkerInstagramAccount } | { ready: false; reason: string };
