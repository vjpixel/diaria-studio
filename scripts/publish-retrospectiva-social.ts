/**
 * scripts/publish-retrospectiva-social.ts (#9500, #9508)
 *
 * Posts PÚBLICOS de chamada da Retrospectiva do Mês em
 * `/diaria-mensal-apoiadores`: desde o #9508, **3 posts por rede, um por
 * história** (DESTAQUE 1/2/3 do `draft.md`), no formato dos destaques
 * diários. Adaptador fino sobre os MESMOS clientes dos publicadores da Etapa 5
 * da diária — nenhum publicador foi alterado nem reimplementado:
 *
 *   | canal             | formato                                  | via |
 *   |-------------------|------------------------------------------|-----|
 *   | `linkedin_pagina` | imagem (capa 4:5) + texto                | `dispatchEntry` (`publish-linkedin.ts`), Worker, `allowImmediateFallback: false` e SEM URL do Make (o `make_now` falha em vez de publicar na hora) |
 *   | `facebook`        | imagem (capa 4:5) + texto                | `publishFacebookCarouselByUrl` (`publish-facebook.ts`), agendamento nativo da Graph API, 1 foto |
 *   | `instagram`       | carrossel de 5 (capa + 3 parágrafos + CTA) | `postToWorkerQueue` com `image_urls` (#6005 Parte B) |
 *   | `threads`         | carrossel de 5                           | `postToWorkerQueue` com `image_urls` (#6095) |
 *   | `x`               | até 4 imagens (capa + 3 parágrafos, sem o CTA — #8202) | **não despacha**: devolve o payload da mutation `createPost` do Buffer, que só o top-level alcança (MCP); o registro vem depois via `append-twitter-published.ts` + `mark-retrospectiva-channel.ts --channel x:dN` |
 *
 * Por que não rodar os CLIs da diária: eles exigem diretório de edição e
 * INJETAM a linha de canal com a URL da edição (`injectChannelLine`) — aqui
 * isso publicaria a URL da retrospectiva paywalled, justamente o que o post
 * público não pode citar (#9474). Até o #9508 a página LinkedIn tinha 1 post
 * único, em script próprio — ver "Post ÚNICO legado" abaixo.
 *
 * ## Texto, imagens, agenda
 *
 * - Texto (`lib/mensal/retrospectiva-social.ts`): `divulgacao/d{N}.md` (3
 *   parágrafos — slides + corpo da legenda de LinkedIn/Facebook/Instagram, com
 *   a linha longa de CTA somada aqui) e `divulgacao/d{N}-curto.md` (Threads/X).
 *   Recusado ANTES de qualquer dispatch se algo falhar.
 * - Imagens (`lib/mensal/retrospectiva-cards.ts`): capa 4:5 + 4 slides
 *   gerados localmente em `divulgacao/` e subidos pro KV (só fora do
 *   `--dry-run`, só depois do pré-voo).
 * - Agenda (`resolveRetrospectivaPostScheduledAts`, decisão do editor): dia
 *   D+1 do envio do e-mail, nos slots da diária — história 1 às 10:00, 2 às
 *   12:30, 3 às 17:30 BRT — com as 5 redes NO MESMO horário. Por isso o dia
 *   não pode ter edição diária agendada: post vivo no store da diária desse
 *   dia (`editionDir(AAMMDD)/_internal/06-social-published.json`, ou seja `data/editions/{AAMM}/{AAMMDD}/`) barra o
 *   pré-voo; dia útil sem edição (ainda) vira aviso.
 *
 * ## Idempotência
 *
 * State por post (`divulgacao-published.json`, chave `{canal}:d{N}`): `done`
 * sem `--force` pula. 2º guard: store por história
 * `_internal/divulgacao-social-d{N}-published.json` (um por história porque o
 * store faz upsert por plataforma+destaque, e o Worker só aceita
 * `especial-{letras}` como destaque) — post vivo ali pula mesmo com o state
 * sem registro. `--force` sobre post vivo: LinkedIn/Instagram/Threads cancelam
 * a entry antiga na fila do Worker ANTES de reenviar; Facebook/X exigem que o
 * editor remova o anterior na rede e confirme com `--old-cancelled canal[:dN]`.
 *
 * ## Post ÚNICO legado da página LinkedIn (#9474)
 *
 * O ciclo 2609-10 já tem o post único da página agendado no Worker
 * (`_internal/divulgacao-linkedin-published.json`). Enquanto ele estiver
 * vivo e algum post da página estiver pedido, o pré-voo INTEIRO é recusado
 * (tudo-ou-nada: sairiam 4 na página). `--replace-linkedin-single` cancela a entry no Worker (DELETE
 * /queue/:key) antes de despachar os 3 novos, marca o store legado como
 * `deleted` e o canal `linkedin_pagina` (sem sufixo) como `pending`. Se a
 * entry já saiu da fila (provavelmente publicada), os 3 seguem mesmo assim e
 * o resultado avisa (`legacy_linkedin.action = "already-gone"`). O post único
 * do #9500 nas outras redes (`_internal/divulgacao-social-published.json`)
 * não tem cancelamento por script: vivo, também recusa o pré-voo.
 *
 * Antecedência: o pré-voo exige ≥10 min e a checagem se repete post a post
 * logo antes do dispatch (a geração/upload das imagens e o envio em série
 * levam minutos) — horário vencido vira `failed`, nunca post imediato.
 *
 * Uso:
 *   npx tsx scripts/publish-retrospectiva-social.ts --cycle 2609-10 \
 *     [--skip linkedin,facebook,instagram:d2,...] [--force canal[:dN][,...]] [--old-cancelled facebook:d1,x] \
 *     [--replace-linkedin-single] [--base-date AAAA-MM-DD] [--at ISO] [--dry-run]
 *
 * Exit: 0 = ok; 1 = post falhou, reconciliação não rodou, ou texto/agenda
 * recusados (nada despachado); 2 = uso.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { appendSocialPosts, readSocialPublished, type PostEntry, type SocialPublished } from "./lib/social-published-store.ts";
import { deleteFromWorkerQueue, postToWorkerQueue } from "./lib/worker-queue-client.ts";
import { publishFacebookCarouselByUrl, validateScheduledTime } from "./publish-facebook.ts";
import { dispatchEntry, type DispatchContext } from "./publish-linkedin.ts";
import { verifyWorkerDispatch, formatVerifySummary } from "./verify-social-worker-dispatch.ts";
import { WORKER_DESTAQUE_RE } from "./publish-artigo-especial-linkedin.ts";
import { TWITTER_IMAGE_LIMIT } from "./prep-twitter-posts.ts";
import { decideChannelAction, buildDoneChannelState, buildFailedChannelState, withChannelState } from "./lib/artigo-especial-state.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { uploadMonthlyImage } from "./lib/mensal/monthly-image-upload.ts";
import { extractDestaqueTitle } from "./lib/mensal/monthly-apoiadores-kit-render.ts";
import { resolveMonthlySendSchedule, type MonthlySendScheduleConfig } from "./lib/mensal/monthly-send-schedule.ts";
import {
  resolveRetrospectivaBaseDate,
  resolveRetrospectivaPostScheduledAts,
  resolveRetrospectivaScheduledAts,
  type RetrospectivaPostSchedule,
} from "./lib/mensal/retrospectiva-schedule.ts";
import {
  RETROSPECTIVA_HISTORIAS,
  RETROSPECTIVA_POST_CHANNELS,
  RETROSPECTIVA_POST_KEYS,
  contentMonthLabel,
  parseRetrospectivaSkip,
  retrospectivaPostKey,
  retrospectivaDivulgacaoStatePath,
  readRetrospectivaDivulgacaoState,
  writeRetrospectivaDivulgacaoState,
  type RetrospectivaHistoria,
  type RetrospectivaPostChannel,
  type RetrospectivaPostKey,
} from "./lib/mensal/retrospectiva-divulgacao.ts";
import {
  RETROSPECTIVA_SOCIAL_PLATFORM,
  isShortChannel,
  retrospectivaHistoriaBodyProblems,
  retrospectivaHistoriaFiles,
  retrospectivaPostText,
  retrospectivaPostTextFile,
  retrospectivaSocialPostProblems,
} from "./lib/mensal/retrospectiva-social.ts";
import {
  RETROSPECTIVA_CARD_SLOTS,
  renderRetrospectivaCards,
  retrospectivaCoverFontSize,
  retrospectivaCoverTitleFits,
  type RetrospectivaCardSet,
} from "./lib/mensal/retrospectiva-cards.ts";
import { logEvent } from "./lib/run-log.ts";
import { editionDir } from "./lib/edition-paths.ts";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * `destaque` no store e no Worker — `especial-{sufixo}` é o único namespace do
 * Worker publicado sem semântica alheia (`d[123]`, `weekly-*`, `eia-*` são da
 * diária, do semanal e do "É IA?"). Ampliar o regex exigiria deploy.
 */
export const RETROSPECTIVA_SOCIAL_DESTAQUE = "especial-retrospectiva";

/** Store do post ÚNICO da página LinkedIn (#9474) — legado, só lido/cancelado. */
export const LEGACY_LINKEDIN_PUBLISHED_FILENAME = "divulgacao-linkedin-published.json";

/** Store do post ÚNICO de Facebook/Instagram/Threads/X (#9500) — legado, só lido (post vivo ali barra o pré-voo). */
export const LEGACY_SOCIAL_PUBLISHED_FILENAME = "divulgacao-social-published.json";

/** Piso de antecedência: a Graph API do Facebook recusa agendamento a menos de 10 min. */
const MIN_LEAD_MS = 10 * 60 * 1000;

/** Redes que agendam pelo Worker (`/queue`) — cancelável por DELETE e reconciliável. */
const WORKER_CHANNELS = new Set<RetrospectivaPostChannel>(["linkedin_pagina", "instagram", "threads"]);

/** Store de dispatch de uma história. */
export function retrospectivaSocialPublishedPath(cycleDir: string, h: RetrospectivaHistoria): string {
  return resolve(cycleDir, "_internal", `divulgacao-social-${h}-published.json`);
}

export interface SocialDispatchInput {
  historia: RetrospectivaHistoria;
  text: string;
  /** Ordem do formato da rede (ver `imageUrlsFor`): 1 (capa), 5 (carrossel). */
  imageUrls: string[];
  scheduledAt: string;
}

export interface SocialDispatchers {
  /** Página LinkedIn — `dispatchEntry` grava o store sozinho; `publishedPath` = store da história. */
  linkedin: (i: SocialDispatchInput, publishedPath: string) => Promise<PostEntry>;
  facebook: (i: SocialDispatchInput) => Promise<PostEntry>;
  worker: (channel: "instagram" | "threads", i: SocialDispatchInput) => Promise<PostEntry>;
  /** Remove da fila do Worker um post anterior (`deleteFromWorkerQueue`). */
  cancelWorker: (key: string) => Promise<{ alreadyGone: boolean }>;
}

/** Payload da mutation `createPost` do Buffer pro top-level (o MCP não é alcançável de script). */
export interface XBufferPayload {
  historia: RetrospectivaHistoria;
  channelId: string;
  text: string;
  dueAt: string;
  /** Capa + 3 parágrafos (≤ `TWITTER_IMAGE_LIMIT`), nunca o slide de CTA. */
  images: Array<{ url: string; altText: string }>;
  /** `--dry-run`: as imagens existem localmente, mas as URLs só nascem no upload do envio. */
  imagePendingUpload: boolean;
  publishedPath: string;
  destaque: string;
}

/** Imagens de uma história: URLs públicas, ou paths locais no `--dry-run` (`pendingUpload`). */
export interface HistoriaImages {
  cards: RetrospectivaCardSet;
  pendingUpload: boolean;
}

type Base = { key: RetrospectivaPostKey; channel: RetrospectivaPostChannel; historia: RetrospectivaHistoria };
export type SocialPostResult =
  | (Base & { action: "skipped"; reason: string })
  | (Base & { action: "dry-run"; scheduledAt: string; images: string[]; text: string })
  | (Base & { action: "dispatched"; entry: PostEntry })
  | (Base & { action: "failed"; reason: string })
  | (Base & { channel: "x"; action: "x-payload"; payload: XBufferPayload });

export type LegacyLinkedinResult =
  | { action: "none" }
  | { action: "would-cancel" | "cancelled" | "already-gone"; key: string; scheduledAt: string | null }
  | { action: "failed"; key: string; reason: string };

export interface RunRetrospectivaSocialOptions {
  cycle: string;
  cycleDir: string;
  /** Posts pedidos (todos menos `--skip`). */
  posts: readonly RetrospectivaPostKey[];
  /** Textos de cada história (`d{N}.md` e `d{N}-curto.md`); ausente = recusado no pré-voo. */
  texts: Partial<Record<RetrospectivaHistoria, { corpo?: string; curto?: string }>>;
  /** Título da história (capa) — do `draft.md`. */
  titles: Partial<Record<RetrospectivaHistoria, string | null>>;
  /** Agenda — resolvida só se algum post tiver trabalho (com tudo `done`, uma `--base-date` antiga não deve abortar). */
  resolveScheduledAts: () => RetrospectivaPostSchedule;
  /** Gera (e fora do dry-run sobe) as imagens das histórias pedidas. Chamado só depois do pré-voo. */
  prepareImages: (historias: RetrospectivaHistoria[]) => Promise<Partial<Record<RetrospectivaHistoria, HistoriaImages>>>;
  force: ReadonlySet<RetrospectivaPostKey>;
  /** `--old-cancelled`: o editor já removeu na rede o post anterior (Facebook/X) — destrava o `--force` sobre post vivo. */
  oldCancelled?: ReadonlySet<RetrospectivaPostKey>;
  /** `--replace-linkedin-single`: cancela o post único legado da página antes dos 3 novos. */
  replaceLinkedinSingle?: boolean;
  dryRun: boolean;
  dispatchers: SocialDispatchers;
  /** Rede desligada por config (`publishing.social.{canal}.enabled: false`) → motivo. */
  disabled: Partial<Record<RetrospectivaPostChannel, string>>;
  /** Buffer `channelId` do X (`publishing.social.twitter.buffer_channel_id`). */
  xChannelId: string | null;
  /** Credencial/Worker ausente por rede → motivo (checado só fora do dry-run). */
  missingCredentials: Partial<Record<RetrospectivaPostChannel, string>>;
  verifyWorker?: (published: SocialPublished) => Promise<{ updated: SocialPublished; changes: number; inQueue?: number }>;
  now?: number;
  /** Relógio da re-checagem de antecedência por post (default: `now` fixo, senão `Date.now`). */
  clock?: () => number;
  /**
   * Edição diária do dia alvo (`AAMMDD`): a pasta existe? quantos posts
   * sociais agendados/publicados no store dela? Post vivo barra o pré-voo
   * (mesmos slots). Ausente = nenhuma checagem (só testes).
   */
  dailyEditionCheck?: (aammdd: string) => { dirExists: boolean; livePosts: number };
}

export interface RunRetrospectivaSocialResult {
  results: SocialPostResult[];
  legacyLinkedin: LegacyLinkedinResult;
  /** Avisos que não barram (ex: dia útil sem edição diária ainda — #9508). */
  warnings: string[];
  /** A reconciliação com o Worker não rodou ou não confirmou — os posts estão na fila, sem confirmação (caller sai != 0). */
  verifyError: string | null;
  /** Post despachado cujo state não foi gravado (o store segura a reexecução; caller sai != 0). */
  stateWriteErrors: string[];
}

/** Pura: separa a chave `{canal}:d{N}`. */
export function splitPostKey(key: RetrospectivaPostKey): { channel: RetrospectivaPostChannel; historia: RetrospectivaHistoria } {
  const [channel, historia] = key.split(":") as [RetrospectivaPostChannel, RetrospectivaHistoria];
  return { channel, historia };
}

/**
 * Pura: post vivo (agendado/publicado) de uma rede no store da história — 2º
 * guard de idempotência, igual ao do LinkedIn do #9474.
 */
export function findLiveSocialDispatch(published: SocialPublished, channel: RetrospectivaPostChannel): PostEntry | null {
  const platform = RETROSPECTIVA_SOCIAL_PLATFORM[channel];
  return (
    published.posts.find(
      (p) => p.platform === platform && p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE && (p.status === "scheduled" || p.status === "published"),
    ) ?? null
  );
}

/**
 * Pura (#9510): a entrada do store da DIÁRIA conta como post vivo (que ocupa o
 * slot)? Tudo que não é `failed`/`deleted`/`skipped` — o LinkedIn grava
 * `status: "draft"` em posts que de fato saem (fallback Make, `make_now`) —,
 * exceto dry-run (`reason` "dry-run…") e draft roteado a outro destino sem
 * `make_request_id` (não saiu).
 */
export function isLiveDailyPost(p: PostEntry): boolean {
  if (p.status === "failed" || p.status === "deleted" || p.status === "skipped") return false;
  if (typeof p.reason === "string" && p.reason.startsWith("dry-run")) return false;
  if (p.status === "draft") {
    const routedElsewhere = p.route !== undefined && p.route !== null && p.route !== "none";
    if (routedElsewhere && (p.make_request_id === undefined || p.make_request_id === null)) return false;
  }
  return true;
}

/** Pura: o post ÚNICO legado da página LinkedIn ainda agendado (cancelável) no store do #9474, ou `null`. */
export function findLegacyLinkedinSingle(published: SocialPublished): PostEntry | null {
  return (
    published.posts.find(
      (p) =>
        p.platform === "linkedin" &&
        p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE &&
        p.status === "scheduled" &&
        typeof p.worker_queue_key === "string",
    ) ?? null
  );
}

/** Pura: imagens de cada rede, a partir das 5 da história (mesmo recorte da diária). */
export function imageUrlsFor(channel: RetrospectivaPostChannel, cards: RetrospectivaCardSet): string[] {
  const carousel = RETROSPECTIVA_CARD_SLOTS.map((s) => cards[s]);
  if (channel === "instagram" || channel === "threads") return carousel;
  if (channel === "x") return carousel.slice(0, -1).slice(0, TWITTER_IMAGE_LIMIT); // #8202: sem o CTA
  return [cards.cover];
}

/**
 * Corpo testável. Decide post a post (state, config, store), valida TODOS os
 * posts ativos antes de despachar QUALQUER um (textos, título da capa,
 * agenda, credencial, post legado — lança e nada sai), gera/sobe as imagens,
 * cancela o post único legado da página se pedido, despacha
 * LinkedIn/Facebook/Instagram/Threads, devolve os payloads do X e reconcilia
 * os posts do Worker.
 */
export async function runRetrospectivaSocialDispatch(o: RunRetrospectivaSocialOptions): Promise<RunRetrospectivaSocialResult> {
  const statePath = retrospectivaDivulgacaoStatePath(o.cycleDir);
  let state = readRetrospectivaDivulgacaoState(statePath, o.cycle);
  const stores = new Map<RetrospectivaHistoria, SocialPublished>(
    RETROSPECTIVA_HISTORIAS.map((h) => [h, readSocialPublished(retrospectivaSocialPublishedPath(o.cycleDir, h))]),
  );
  const results: SocialPostResult[] = [];
  const active: RetrospectivaPostKey[] = [];
  const liveOnForce = new Map<RetrospectivaPostKey, PostEntry>();

  // Ordem cronológica: história 1 (todas as redes), depois 2, depois 3.
  const ordered = RETROSPECTIVA_HISTORIAS.flatMap((h) => RETROSPECTIVA_POST_CHANNELS.map((ch) => retrospectivaPostKey(ch, h))).filter((k) =>
    o.posts.includes(k),
  );
  for (const key of ordered) {
    const { channel, historia } = splitPostKey(key);
    const base = { key, channel, historia };
    const decision = decideChannelAction(state, key, o.force.has(key));
    if (decision.action === "skip") {
      results.push({ ...base, action: "skipped", reason: decision.reason });
      continue;
    }
    if (o.disabled[channel]) {
      results.push({ ...base, action: "skipped", reason: `desligado no platform.config.json: ${o.disabled[channel]}` });
      continue;
    }
    const live = findLiveSocialDispatch(stores.get(historia)!, channel);
    if (live && !o.force.has(key)) {
      results.push({
        ...base,
        action: "skipped",
        reason:
          `o store ${retrospectivaSocialPublishedPath(o.cycleDir, historia)} já tem o post (status ${live.status}, ${live.scheduled_at ?? "?"}) — ` +
          `o state não registrou (escrita anterior falhou?). Confira na rede; --force ${key} despacha de novo.`,
      });
      continue;
    }
    if (live) liveOnForce.set(key, live);
    active.push(key);
  }

  const legacyPath = resolve(o.cycleDir, "_internal", LEGACY_LINKEDIN_PUBLISHED_FILENAME);
  const legacy = findLegacyLinkedinSingle(readSocialPublished(legacyPath));
  const linkedinActive = active.some((k) => splitPostKey(k).channel === "linkedin_pagina");
  let legacyResult: LegacyLinkedinResult = { action: "none" };
  if (active.length === 0) return { results, legacyLinkedin: legacyResult, verifyError: null, stateWriteErrors: [], warnings: [] };

  const schedule = o.resolveScheduledAts();
  const clock = o.clock ?? (() => o.now ?? Date.now());
  const now = clock();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Pré-voo de TODOS os posts ativos — qualquer problema aborta antes do 1º
  // dispatch e antes do upload das imagens.
  const historiasAtivas = RETROSPECTIVA_HISTORIAS.filter((h) => active.some((k) => splitPostKey(k).historia === h));
  for (const h of historiasAtivas) {
    const files = retrospectivaHistoriaFiles(h);
    const t = o.texts[h] ?? {};
    if (t.corpo === undefined) {
      errors.push(`${h}: divulgacao/${files.corpo} ausente — o Passo 1 da skill precisa rodar antes`);
    } else {
      const problems = retrospectivaHistoriaBodyProblems(t.corpo);
      if (problems.length > 0) errors.push(`${h} (${files.corpo}): ${problems.join("; ")}`);
    }
    const title = o.titles[h];
    if (!title) errors.push(`${h}: título da história não encontrado no draft.md (DESTAQUE ${h.slice(1)})`);
    else if (!retrospectivaCoverTitleFits(title)) errors.push(`${h}: título "${title}" não cabe na capa a 62px — reescreva-o no draft (#8589)`);
  }
  for (const key of active) {
    const { channel, historia } = splitPostKey(key);
    const t = o.texts[historia] ?? {};
    if (isShortChannel(channel)) {
      if (t.curto === undefined) errors.push(`${key}: divulgacao/${retrospectivaHistoriaFiles(historia).curto} ausente`);
      else {
        const problems = retrospectivaSocialPostProblems(channel, t.curto);
        if (problems.length > 0) errors.push(`${key}: ${problems.join("; ")}`);
      }
    } else if (t.corpo !== undefined) {
      const problems = retrospectivaSocialPostProblems(channel, retrospectivaPostText(channel, t)!);
      if (problems.length > 0) errors.push(`${key}: ${problems.join("; ")}`);
    }
    const at = schedule[historia][channel];
    if (!(Date.parse(at) > now + MIN_LEAD_MS)) errors.push(`${key}: ${at} não está a ≥10 min no futuro — o post sairia fora da agenda`);
    if (channel === "x" && !o.xChannelId) errors.push(`${key}: publishing.social.twitter.buffer_channel_id ausente no platform.config.json`);
    if (!o.dryRun && o.missingCredentials[channel]) errors.push(`${key}: ${o.missingCredentials[channel]}`);
    // --force sobre post vivo: as redes do Worker cancelam a entry antiga antes
    // de reenviar; Facebook/X não têm cancelamento por script — o editor
    // remove na rede e confirma com --old-cancelled (senão sairiam dois).
    const live = liveOnForce.get(key);
    if (live && !WORKER_CHANNELS.has(channel) && !o.oldCancelled?.has(key)) {
      errors.push(
        `${key}: --force sobre post vivo (${String(live.fb_post_id ?? live.buffer_post_id ?? live.url ?? "?")}, ${live.scheduled_at ?? "?"}) — ` +
          `remova-o na rede e rode de novo com --old-cancelled ${key}`,
      );
    }
    if (live && WORKER_CHANNELS.has(channel) && typeof live.worker_queue_key !== "string") {
      errors.push(`${key}: --force sobre post vivo sem worker_queue_key no store — não há como cancelá-lo na fila; confira no Worker`);
    }
  }
  if (linkedinActive && legacy && !o.replaceLinkedinSingle) {
    errors.push(
      `linkedin: o post ÚNICO da página (#9474) segue agendado no Worker (${String(legacy.worker_queue_key)}, ${legacy.scheduled_at ?? "?"}) — ` +
        "os 3 posts por história somariam 4 (o pré-voo é tudo-ou-nada: nada sai). Passe --replace-linkedin-single pra cancelá-lo e substituí-lo, ou --skip linkedin.",
    );
  }
  // Post ÚNICO do #9500 (Facebook/Instagram/Threads/X): sem cancelamento por
  // script — se algum estiver vivo, os 3 por história somariam 4 naquela rede.
  const legacySocial = readSocialPublished(resolve(o.cycleDir, "_internal", LEGACY_SOCIAL_PUBLISHED_FILENAME));
  for (const ch of RETROSPECTIVA_POST_CHANNELS) {
    if (ch === "linkedin_pagina" || !active.some((k) => splitPostKey(k).channel === ch)) continue;
    const live = findLiveSocialDispatch(legacySocial, ch);
    if (live) {
      errors.push(
        `${ch}: o post ÚNICO do #9500 está vivo (${LEGACY_SOCIAL_PUBLISHED_FILENAME}, status ${live.status}, ${live.scheduled_at ?? "?"}) — ` +
          `remova-o na rede, marque-o "deleted" no store, ou --skip ${ch === "x" ? "x" : ch}`,
      );
    }
  }
  // Os posts saem nos MESMOS slots da diária (decisão do editor, #9508): o dia
  // não pode ter edição diária agendada — os dois disputariam o mesmo feed no
  // mesmo minuto. Sábado/domingo não têm edição.
  const day = schedule.d1.linkedin_pagina.slice(0, 10);
  const aammdd = `${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}`;
  const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
  const slotsLabel = RETROSPECTIVA_HISTORIAS.map((h) => schedule[h].linkedin_pagina.slice(11, 16)).join("/");
  const daily = o.dailyEditionCheck?.(aammdd) ?? { dirExists: false, livePosts: 0 };
  if (daily.livePosts > 0) {
    errors.push(
      `dia ${day}: a edição diária ${aammdd} tem ${daily.livePosts} post(s) social(is) agendado(s)/publicado(s) nos mesmos slots ` +
        `(${slotsLabel}) — escolha outro dia (--base-date ou --at; sábado/domingo não têm edição)`,
    );
  } else if (daily.dirExists) {
    warnings.push(`dia ${day}: ${editionDir(aammdd)} existe (edição em curso) — se a diária publicar, sai nos mesmos slots da Retrospectiva`);
  } else if (!weekend) {
    warnings.push(`dia ${day} é dia útil: uma edição diária ainda pode ser produzida pra ele e sairia nos mesmos slots`);
  }
  if (!WORKER_DESTAQUE_RE.test(RETROSPECTIVA_SOCIAL_DESTAQUE)) {
    errors.push(`destaque "${RETROSPECTIVA_SOCIAL_DESTAQUE}" incompatível com o Worker (${WORKER_DESTAQUE_RE})`);
  }
  if (errors.length > 0) {
    throw new Error(`posts da Retrospectiva recusados ANTES de qualquer dispatch:\n  - ${errors.join("\n  - ")}`);
  }

  let images: Partial<Record<RetrospectivaHistoria, HistoriaImages>>;
  try {
    images = await o.prepareImages(historiasAtivas);
  } catch (e) {
    throw new Error(`geração/upload das imagens falhou — nada despachado: ${(e as Error).message}`);
  }
  const missingImages = historiasAtivas.filter((h) => !images[h]);
  if (missingImages.length > 0) throw new Error(`imagens ausentes para ${missingImages.join(", ")} — nada despachado`);
  // Paths locais (dry-run) nunca podem chegar a um dispatcher real como URL.
  const notUploaded = historiasAtivas.filter((h) => images[h]!.pendingUpload);
  if (!o.dryRun && notUploaded.length > 0) {
    throw new Error(`imagens de ${notUploaded.join(", ")} não subiram pro KV (pendingUpload fora do dry-run) — nada despachado`);
  }

  const xPayload = (h: RetrospectivaHistoria): XBufferPayload => {
    const img = images[h]!;
    const label = `da história ${h.slice(1)} da Retrospectiva de ${contentMonthLabel(o.cycle)} da diar.ia.br`;
    return {
      historia: h,
      channelId: o.xChannelId!,
      text: retrospectivaPostText("x", o.texts[h]!)!, // o mesmo texto (CRLF normalizado) que o pré-voo mediu
      dueAt: schedule[h].x,
      images: img.pendingUpload
        ? []
        : imageUrlsFor("x", img.cards).map((url, i) => ({ url, altText: i === 0 ? `Capa ${label}` : `Slide ${i} ${label}` })),
      imagePendingUpload: img.pendingUpload,
      publishedPath: retrospectivaSocialPublishedPath(o.cycleDir, h),
      destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
    };
  };

  if (o.dryRun) {
    if (linkedinActive && legacy) {
      legacyResult = { action: "would-cancel", key: String(legacy.worker_queue_key), scheduledAt: legacy.scheduled_at };
    }
    for (const key of active) {
      const { channel, historia } = splitPostKey(key);
      const base = { key, channel, historia };
      if (channel === "x") results.push({ ...base, channel: "x", action: "x-payload", payload: xPayload(historia) });
      else
        results.push({
          ...base,
          action: "dry-run",
          scheduledAt: schedule[historia][channel],
          images: imageUrlsFor(channel, images[historia]!.cards),
          text: retrospectivaPostText(channel, o.texts[historia]!)!,
        });
    }
    return { results, legacyLinkedin: legacyResult, verifyError: null, stateWriteErrors: [], warnings };
  }

  const stateWriteErrors: string[] = [];
  const record = (key: RetrospectivaPostKey, ok: boolean, reason: string | null, entry: PostEntry | null) => {
    const at = new Date().toISOString();
    try {
      state = withChannelState(state, key, ok ? buildDoneChannelState(at, entry?.url ?? null) : buildFailedChannelState(at, reason ?? "dispatch falhou"));
      writeRetrospectivaDivulgacaoState(statePath, state);
    } catch (e) {
      // O post pode JÁ estar agendado — o store (gravado antes) segura uma 2ª
      // execução; segue pros outros posts.
      const id = entry ? String(entry.fb_post_id ?? entry.worker_queue_key ?? "?") : "-";
      const msg = `${key}: state NÃO gravado (${(e as Error).message})${ok ? ` — o post JÁ ESTÁ agendado (${id}); NÃO rode de novo sem conferir` : ""}.`;
      console.error(msg);
      stateWriteErrors.push(msg);
    }
  };

  // Post único legado da página: cancelado ANTES dos 3 novos. Falha no
  // cancelamento = os 3 da página não saem (sairiam 4); "já saiu da fila" =
  // provavelmente publicado, os 3 seguem (pedido do editor) e o resultado avisa.
  let linkedinBlocked: string | null = null;
  if (linkedinActive && legacy && o.replaceLinkedinSingle) {
    const key = String(legacy.worker_queue_key);
    let alreadyGone: boolean | null = null;
    try {
      alreadyGone = (await o.dispatchers.cancelWorker(key)).alreadyGone;
    } catch (e) {
      linkedinBlocked = `cancelamento do post único legado da página (${key}) falhou: ${(e as Error).message} — os 3 da página não foram enviados (sairiam 4)`;
      legacyResult = { action: "failed", key, reason: linkedinBlocked };
    }
    if (alreadyGone !== null) {
      legacyResult = { action: alreadyGone ? "already-gone" : "cancelled", key, scheduledAt: legacy.scheduled_at };
      // O DELETE JÁ aconteceu: falha ao REGISTRAR não segura os 3 novos (o
      // store legado deixaria de bater com o Worker, mas o post sumiu de lá).
      const at = new Date().toISOString();
      try {
        appendSocialPosts(legacyPath, [
          alreadyGone
            ? { ...legacy, status: "published", reason: `#9508: saiu da fila antes do cancelamento (${at}) — provavelmente publicado` }
            : { ...legacy, status: "deleted", cancelled_at: at, reason: "#9508: substituído pelos 3 posts por história (--replace-linkedin-single)" },
        ]);
        if (!alreadyGone) {
          state = withChannelState(state, "linkedin_pagina", {
            status: "pending",
            attemptedAt: at,
            url: null,
            reason: `cancelado no Worker (${key}) — substituído pelos 3 posts por história (#9508)`,
          });
          writeRetrospectivaDivulgacaoState(statePath, state);
        }
      } catch (e) {
        const msg = `post único legado da página: registro NÃO gravado (${(e as Error).message}) — no Worker ele já está ${alreadyGone ? "fora da fila" : "cancelado"} (${key}).`;
        console.error(msg);
        stateWriteErrors.push(msg);
      }
    }
  }

  for (const h of historiasAtivas) mkdirSync(dirname(retrospectivaSocialPublishedPath(o.cycleDir, h)), { recursive: true });
  const workerDispatched = new Set<RetrospectivaHistoria>();
  for (const key of active) {
    const { channel, historia } = splitPostKey(key);
    const base = { key, channel, historia };
    const publishedPath = retrospectivaSocialPublishedPath(o.cycleDir, historia);
    if (channel === "x") {
      results.push({ ...base, channel: "x", action: "x-payload", payload: xPayload(historia) });
      continue;
    }
    if (channel === "linkedin_pagina" && linkedinBlocked) {
      record(key, false, linkedinBlocked, null);
      results.push({ ...base, action: "failed", reason: linkedinBlocked });
      continue;
    }
    // O pré-voo mediu a antecedência ANTES de gerar/subir 15 imagens e de
    // despachar em série: re-checa por post. Um horário que passou no meio do
    // caminho viraria post IMEDIATO (o `dispatchEntry` roteia horário passado
    // pro `make_now`; a fila do Worker dispara entry vencida na hora).
    if (!(Date.parse(schedule[historia][channel]) > clock() + MIN_LEAD_MS)) {
      const reason = `${schedule[historia][channel]} ficou a <10 min durante a execução — não despachado (sairia na hora); rode de novo com --at`;
      record(key, false, reason, null);
      results.push({ ...base, action: "failed", reason });
      continue;
    }
    const live = liveOnForce.get(key);
    if (live && WORKER_CHANNELS.has(channel)) {
      // Cancela ANTES de reenviar: se o reenvio falhar, não sobra post antigo
      // vivo com o store dizendo `failed` (o que liberaria um 3º envio).
      let reason: string | null = null;
      try {
        const c = await o.dispatchers.cancelWorker(live.worker_queue_key as string);
        if (c.alreadyGone) reason = `post anterior (${String(live.worker_queue_key)}) já saiu da fila — provavelmente JÁ publicado; não reenviado`;
      } catch (e) {
        reason = `cancelamento do post anterior (${String(live.worker_queue_key)}) falhou: ${(e as Error).message} — não reenviado`;
      }
      if (reason) {
        results.push({ ...base, action: "failed", reason });
        continue;
      }
    }
    const input: SocialDispatchInput = {
      historia,
      text: retrospectivaPostText(channel, o.texts[historia]!)!,
      imageUrls: imageUrlsFor(channel, images[historia]!.cards),
      scheduledAt: schedule[historia][channel],
    };
    let entry: PostEntry;
    try {
      entry =
        channel === "linkedin_pagina"
          ? await o.dispatchers.linkedin(input, publishedPath)
          : channel === "facebook"
            ? await o.dispatchers.facebook(input)
            : await o.dispatchers.worker(channel, input);
    } catch (e) {
      entry = {
        platform: RETROSPECTIVA_SOCIAL_PLATFORM[channel],
        destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: (e as Error).message,
      };
    }
    entry = { ...entry, historia };
    try {
      appendSocialPosts(publishedPath, [entry]);
    } catch (e) {
      // O post pode JÁ estar aceito pela rede: abortar aqui perderia o
      // registro e liberaria um 2º envio na reexecução. Segue pro state (que
      // então segura a reexecução) e pros outros posts.
      const msg =
        `${key}: store NÃO gravado (${(e as Error).message})` +
        (entry.status !== "failed" ? ` — o post JÁ ESTÁ agendado (${String(entry.fb_post_id ?? entry.worker_queue_key ?? "?")}); NÃO rode de novo sem conferir` : "") +
        ".";
      console.error(msg);
      stateWriteErrors.push(msg);
    }
    if (entry.status === "failed") {
      const reason = entry.reason ?? "dispatch falhou";
      record(key, false, reason, null);
      results.push({ ...base, action: "failed", reason });
      continue;
    }
    record(key, true, null, entry);
    results.push({ ...base, action: "dispatched", entry });
    if (WORKER_CHANNELS.has(channel) && entry.status === "scheduled") workerDispatched.add(historia);
  }

  const verifyErrors: string[] = [];
  if (o.verifyWorker) {
    for (const h of workerDispatched) {
      const publishedPath = retrospectivaSocialPublishedPath(o.cycleDir, h);
      try {
        const before = readSocialPublished(publishedPath);
        const r = await o.verifyWorker(before);
        console.log(`[verify] ${h}: reconciliação Worker: ${formatVerifySummary(r)}`);
        const workerPlatforms = new Set([...WORKER_CHANNELS].map((ch) => RETROSPECTIVA_SOCIAL_PLATFORM[ch]));
        // Post de amanhã que some da fila E do DLQ vira "published" na
        // reconciliação — leitura de lag do KV, não entrega (#573). Não grava.
        const precoce = r.updated.posts.filter(
          (p) =>
            workerPlatforms.has(p.platform) &&
            p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE &&
            p.status === "published" &&
            typeof p.scheduled_at === "string" &&
            Date.parse(p.scheduled_at) > clock(),
        );
        if (precoce.length > 0) {
          throw new Error(
            `reconciliação marcou como publicado post ainda no futuro (${precoce.map((p) => p.platform).join(", ")}) — ` +
              "provável lag do KV; store NÃO atualizado, confira a fila do Worker",
          );
        }
        // `inQueue` conta TODA entry agendada do store que o Worker lista —
        // inclusive as de execuções anteriores. Compara com todas as agendadas
        // do store (não só as desta execução), senão uma antiga confirmada
        // mascararia uma nova que não chegou à fila.
        const expected = before.posts.filter(
          (p) => workerPlatforms.has(p.platform) && p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE && p.status === "scheduled",
        ).length;
        if (typeof r.inQueue === "number" && r.inQueue < expected) {
          verifyErrors.push(`${h}: só ${r.inQueue} de ${expected} post(s) do Worker confirmados na fila — confira antes de considerar agendado`);
        }
        if (r.changes > 0) {
          writeFileSync(publishedPath, JSON.stringify(r.updated, null, 2) + "\n", "utf8");
          for (const ch of WORKER_CHANNELS) {
            const dead = r.updated.posts.find(
              (p) => p.platform === RETROSPECTIVA_SOCIAL_PLATFORM[ch] && p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE && p.status === "failed",
            );
            const key = retrospectivaPostKey(ch, h);
            const i = results.findIndex((x) => x.key === key && x.action === "dispatched");
            if (dead && i >= 0) {
              const reason = typeof dead.failure_reason === "string" ? dead.failure_reason : "reconciliação pós-dispatch: Worker reportou falha (DLQ).";
              record(key, false, reason, null);
              results[i] = { key, channel: ch, historia: h, action: "failed", reason };
            }
          }
        }
      } catch (e) {
        // Aceito e gravado; o que falhou foi CONFIRMAR na fila — não vira
        // `failed` (retentar duplicaria), mas o caller sai != 0.
        verifyErrors.push(`${h}: ${(e as Error).message}`);
        console.warn(`[verify] ${h} falhou — os posts estão na fila, mas não foram confirmados no Worker: ${(e as Error).message}`);
      }
    }
  }
  return { results, legacyLinkedin: legacyResult, verifyError: verifyErrors.length > 0 ? verifyErrors.join(" | ") : null, stateWriteErrors, warnings };
}

/** Pura: `--force`/`--old-cancelled` → chaves de post (mesmos tokens do `--skip`; tokens de outros canais são ignorados aqui). */
export function parseSocialForce(forceArg: string | undefined, flag = "--force"): Set<RetrospectivaPostKey> {
  let all: Set<string>;
  try {
    all = parseRetrospectivaSkip(forceArg);
  } catch (e) {
    throw new Error((e as Error).message.replace(/^--skip/, flag));
  }
  return new Set(RETROSPECTIVA_POST_KEYS.filter((k) => all.has(k)));
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const { values, flags } = parseArgs(argv);
  const dryRun = flags.has("dry-run");
  const cycleDir = monthlyDir(cycle);

  let skip: Set<string>;
  let force: Set<RetrospectivaPostKey>;
  let oldCancelled: Set<RetrospectivaPostKey>;
  try {
    skip = parseRetrospectivaSkip(values["skip"]);
    // `--force` sem lista NÃO é global (ver SKILL): exige os canais.
    if (flags.has("force")) throw new Error("--force exige a lista de canais (ex: --force instagram ou instagram:d2) — nunca global.");
    force = parseSocialForce(values["force"]);
    oldCancelled = parseSocialForce(values["old-cancelled"], "--old-cancelled");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const posts = RETROSPECTIVA_POST_KEYS.filter((k) => !skip.has(k));

  const texts: Partial<Record<RetrospectivaHistoria, { corpo?: string; curto?: string }>> = {};
  for (const h of RETROSPECTIVA_HISTORIAS) {
    const read = (f: string) => {
      const p = resolve(cycleDir, "divulgacao", f);
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    };
    const f = retrospectivaHistoriaFiles(h);
    texts[h] = { corpo: read(f.corpo), curto: read(f.curto) };
  }
  const draftPath = resolve(cycleDir, "draft.md");
  const draft = existsSync(draftPath) ? readFileSync(draftPath, "utf8") : "";
  const titles = Object.fromEntries(RETROSPECTIVA_HISTORIAS.map((h, i) => [h, extractDestaqueTitle(draft, i + 1)])) as Record<
    RetrospectivaHistoria,
    string | null
  >;

  type SocialCfg = { enabled?: boolean; disabled_reason?: string; buffer_channel_id?: string; cloudflare_worker_url?: string };
  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as Parameters<
    typeof resolveRetrospectivaPostScheduledAts
  >[0] & {
    publishing?: { social?: Record<string, SocialCfg> };
    monthly_send_schedule?: MonthlySendScheduleConfig;
  };
  const social = (config.publishing?.social ?? {}) as Record<string, SocialCfg | undefined>;
  const disabled: Partial<Record<RetrospectivaPostChannel, string>> = {};
  for (const ch of RETROSPECTIVA_POST_CHANNELS) {
    const c = social[ch === "x" ? "twitter" : ch === "linkedin_pagina" ? "linkedin" : ch];
    if (c?.enabled === false) disabled[ch] = c.disabled_reason || "enabled=false"; // `||`: motivo "" não pode reabilitar a rede
  }

  const { baseDate, fromRule } = resolveRetrospectivaBaseDate(cycle, {
    baseDate: values["base-date"],
    at: values["at"],
    rule: resolveMonthlySendSchedule(config.monthly_send_schedule),
  });
  let schedule: RetrospectivaPostSchedule | null = null;
  const resolveScheduledAts = (): RetrospectivaPostSchedule => {
    const s = resolveRetrospectivaPostScheduledAts(config, { at: values["at"], baseDate });
    schedule = s;
    let perfil: string;
    try {
      perfil = resolveRetrospectivaScheduledAts(config, { at: values["at"], baseDate }).perfil;
    } catch (e) {
      perfil = `(não resolvido: ${(e as Error).message})`;
    }
    console.log(
      `Agenda (#9508) — dia ${s.d1.linkedin_pagina.slice(0, 10)}, 5 redes no mesmo horário, slots da diária` +
        (values["at"]
          ? " — dia tirado do --at"
          : baseDate
            ? ` — D+1 do envio em ${baseDate}${fromRule ? " (regra do 1º sábado, #9473)" : ""}`
            : " — D+1 de HOJE (regra do 1º sábado indisponível p/ este ciclo; passe --base-date com a data do envio do e-mail)") +
        `:\n${RETROSPECTIVA_HISTORIAS.map((h) => `  ${h}: ${s[h].linkedin_pagina} (LinkedIn, Facebook, Instagram, Threads, X)`).join("\n")}` +
        `\n  linkedin_perfil (manual, 1 post só) = ${perfil}`,
    );
    return s;
  };

  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? social.instagram?.cloudflare_worker_url ?? social.linkedin?.cloudflare_worker_url ?? "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  let fbCreds: { page_id?: string; page_access_token?: string; api_version?: string } = {};
  const fbCredsPath = resolve(ROOT, "data/.fb-credentials.json");
  if (existsSync(fbCredsPath)) {
    try {
      fbCreds = JSON.parse(readFileSync(fbCredsPath, "utf8"));
    } catch (e) {
      console.warn(`AVISO: ${fbCredsPath} existe mas não é JSON válido (${(e as Error).message}) — usando só as env vars.`);
    }
  }
  const fbPageId = process.env.FACEBOOK_PAGE_ID || fbCreds.page_id || "";
  const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || fbCreds.page_access_token || "";
  const fbApiVersion = process.env.FACEBOOK_API_VERSION || fbCreds.api_version || "v25.0";

  const missingCredentials: Partial<Record<RetrospectivaPostChannel, string>> = {};
  if (!fbPageId || !fbToken) missingCredentials.facebook = "FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN ausentes";
  if (!workerUrl || !workerToken) {
    // Sem o Worker não há agendamento (Instagram/Threads não agendam pela API;
    // a página LinkedIn cairia no `make_now` — publicaria AGORA).
    missingCredentials.linkedin_pagina = missingCredentials.instagram = missingCredentials.threads =
      "Worker não configurado (DIARIA_LINKEDIN_CRON_URL/_TOKEN)";
  }

  const prepareImages = async (historias: RetrospectivaHistoria[]): Promise<Partial<Record<RetrospectivaHistoria, HistoriaImages>>> => {
    // Sem Georgia a arte sai com fallback de fonte, fora da marca, em silêncio (#4090).
    await assertBrandSerifAvailable("publish-retrospectiva-social");
    const fontSize = retrospectivaCoverFontSize(RETROSPECTIVA_HISTORIAS.map((h) => titles[h] ?? ""));
    const kicker = `Retrospectiva de ${contentMonthLabel(cycle)}`;
    const out: Partial<Record<RetrospectivaHistoria, HistoriaImages>> = {};
    for (const h of historias) {
      const local = await renderRetrospectivaCards({ cycleDir, historia: h, title: titles[h]!, corpo: texts[h]!.corpo!, kicker, fontSize });
      if (dryRun) {
        out[h] = { cards: local, pendingUpload: true };
        continue;
      }
      const urls = await Promise.all(RETROSPECTIVA_CARD_SLOTS.map((s) => uploadMonthlyImage(local[s], cycle, ROOT)));
      out[h] = { cards: Object.fromEntries(RETROSPECTIVA_CARD_SLOTS.map((s, i) => [s, urls[i]])) as RetrospectivaCardSet, pendingUpload: false };
    }
    return out;
  };

  const r = await runRetrospectivaSocialDispatch({
    cycle,
    cycleDir,
    posts,
    texts,
    titles,
    resolveScheduledAts,
    prepareImages,
    force,
    oldCancelled,
    replaceLinkedinSingle: flags.has("replace-linkedin-single"),
    dryRun,
    disabled,
    xChannelId: social.twitter?.buffer_channel_id ?? null,
    missingCredentials,
    dispatchers: {
      linkedin: (i, publishedPath) => {
        const ctx: DispatchContext = {
          publishedPath,
          // Vazio DE PROPÓSITO: o `dispatchEntry` roteia horário vencido pro
          // `make_now` (post imediato) e `allowImmediateFallback: false` só
          // cobre falha do Worker. Sem URL do Make, esse caminho falha em vez
          // de publicar — post da Retrospectiva nunca sai fora da agenda.
          webhookUrl: "",
          apiKey: process.env.MAKE_WEBHOOK_API_KEY || undefined,
          workerUrl,
          workerToken,
          useWorkerForScheduled: true,
          editionDate: `retrospectiva-${cycle}`,
          rootDir: ROOT,
        };
        return dispatchEntry(
          {
            destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
            subtype: "main",
            text: i.text,
            imageUrl: i.imageUrls[0] ?? null,
            scheduledAt: i.scheduledAt,
            webhookTarget: "diaria",
            action: "post",
            allowImmediateFallback: false,
          },
          ctx,
        );
      },
      facebook: async (i) => {
        validateScheduledTime(i.scheduledAt);
        const res = await publishFacebookCarouselByUrl(fbPageId, fbToken, fbApiVersion, i.imageUrls, i.text, i.scheduledAt);
        const postId = res.post_id || res.id;
        return {
          platform: "facebook",
          destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
          url: `https://www.facebook.com/${fbPageId}/posts/${postId}`,
          status: "scheduled",
          scheduled_at: i.scheduledAt,
          fb_post_id: postId,
        };
      },
      worker: async (channel, i) => {
        const res = await postToWorkerQueue(
          workerUrl,
          workerToken,
          {
            text: i.text,
            // Instagram exige `image_url` mesmo no carrossel (mesmo payload de `publish-instagram.ts`); Threads vai só com `image_urls`.
            image_url: channel === "instagram" ? i.imageUrls[0] : null,
            image_urls: i.imageUrls,
            scheduled_at: i.scheduledAt,
            destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
            channel,
          },
          2,
          "publish-retrospectiva-social",
        );
        return {
          platform: channel,
          destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
          url: null,
          status: "scheduled",
          scheduled_at: i.scheduledAt,
          worker_queue_key: res.key,
        };
      },
      cancelWorker: (key) => deleteFromWorkerQueue(workerUrl, workerToken, key, "publish-retrospectiva-social"),
    },
    verifyWorker: (p) => verifyWorkerDispatch(p, workerUrl, workerToken),
    dailyEditionCheck: (aammdd) => {
      const dir = resolve(ROOT, editionDir(aammdd));
      const store = resolve(dir, "_internal", "06-social-published.json");
      let livePosts = 0;
      if (existsSync(store)) {
        // Store ilegível conta como conflito: na dúvida, não agendar em cima da diária.
        try {
          livePosts = readSocialPublished(store).posts.filter(isLiveDailyPost).length;
        } catch {
          livePosts = 1;
        }
      }
      return { dirExists: existsSync(dir), livePosts };
    },
  });

  for (const w of r.warnings) {
    console.error(`AVISO: ${w}`);
    logEvent({ edition: cycle, stage: null, agent: "publish-retrospectiva-social", level: "warn", message: w }, ROOT);
  }
  const sched = schedule as RetrospectivaPostSchedule | null;
  if (values["at"] && sched) {
    const slots = RETROSPECTIVA_HISTORIAS.map((h) => sched[h].linkedin_pagina);
    if (!slots.some((x) => Date.parse(x) === Date.parse(values["at"]!))) {
      const msg = `--at só escolhe o DIA (${sched.d1.linkedin_pagina.slice(0, 10)}); o horário "${values["at"]}" é descartado — os posts saem nos slots ${slots.join(", ")}`;
      console.error(`AVISO: ${msg}`);
      logEvent({ edition: cycle, stage: null, agent: "publish-retrospectiva-social", level: "warn", message: msg }, ROOT);
    }
  }
  for (const x of r.results) {
    if (x.action !== "dispatched" && x.action !== "failed") continue;
    logEvent(
      {
        edition: cycle,
        stage: null,
        agent: "publish-retrospectiva-social",
        level: x.action === "failed" || r.verifyError ? "warn" : "info",
        message: `${x.key} ${x.action} para ${(schedule as RetrospectivaPostSchedule | null)?.[x.historia][x.channel] ?? "?"}`,
        details: x.action === "failed" ? { reason: x.reason } : { url: x.entry.url, worker_queue_key: x.entry.worker_queue_key ?? null },
      },
      ROOT,
    );
  }
  if (r.legacyLinkedin.action !== "none") {
    logEvent(
      {
        edition: cycle,
        stage: null,
        agent: "publish-retrospectiva-social",
        level: r.legacyLinkedin.action === "cancelled" || r.legacyLinkedin.action === "would-cancel" ? "info" : "warn",
        message: `post único legado da página LinkedIn: ${r.legacyLinkedin.action}`,
        details: r.legacyLinkedin,
      },
      ROOT,
    );
  }
  console.log(
    JSON.stringify(
      {
        cycle,
        dry_run: dryRun,
        legacy_linkedin: r.legacyLinkedin,
        warnings: r.warnings,
        results: r.results,
        verify_error: r.verifyError,
        state_write_errors: r.stateWriteErrors,
      },
      null,
      2,
    ),
  );
  if (r.legacyLinkedin.action === "already-gone") {
    console.error(
      "AVISO: o post único legado da página LinkedIn já tinha saído da fila (provavelmente publicado) — os 3 por história foram enviados mesmo assim.",
    );
  }
  if (r.results.some((x) => x.action === "failed") || r.verifyError || r.stateWriteErrors.length > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`publish-retrospectiva-social: ${(e as Error).message}`);
    process.exit(1);
  });
}
