/**
 * scripts/publish-retrospectiva-social.ts (#9500)
 *
 * Canais `facebook`, `instagram`, `threads` e `x` de
 * `/diaria-mensal-apoiadores`: agenda os posts PÚBLICOS de chamada da
 * Retrospectiva do Mês fora do LinkedIn. Adaptador fino sobre os MESMOS
 * clientes dos publicadores da Etapa 5 da diária — nenhum publicador foi
 * alterado nem reimplementado:
 *
 *   | canal       | via                                                         |
 *   |-------------|-------------------------------------------------------------|
 *   | `facebook`  | `publishFacebookCarouselByUrl` (`publish-facebook.ts`), agendamento nativo da Graph API (`scheduled_publish_time`), 1 foto |
 *   | `instagram` | `postToWorkerQueue` (`lib/worker-queue-client.ts`), `channel: "instagram"` — a API do Instagram não agenda (#3817) |
 *   | `threads`   | `postToWorkerQueue`, `channel: "threads"`                     |
 *   | `x`         | **não despacha**: imprime o payload da mutation `createPost` do Buffer, que só o top-level alcança (MCP); o registro vem depois via `append-twitter-published.ts` + `mark-retrospectiva-channel.ts --channel x` |
 *
 * Por que não rodar os CLIs da diária (como a `/diaria-anual` faz com
 * `prep-annual-social.ts`): eles exigem diretório com 2–3 destaques e
 * INJETAM a linha de canal com a URL da edição (`injectChannelLine`) — aqui
 * isso publicaria a URL da retrospectiva paywalled, justamente o que o post
 * público não pode citar (#9474).
 *
 * ## Texto, imagem, agenda
 *
 * - Texto: `divulgacao/{canal}.md` (Passo 1 da skill), recusado ANTES de
 *   qualquer dispatch se `retrospectivaSocialPostProblems` acusar algo (CTA,
 *   URL paywalled, teto de caracteres, markdown).
 * - Imagem: a capa ESTÁTICA do D1 em 1:1 (`04-d1-1x1.jpg` do ciclo, subida
 *   pro KV na hora com a mesma convenção de key das imagens da mensal —
 *   `img-{ciclo}-04-d1-1x1.jpg`) — nunca o carrossel de 5 slides da diária.
 *   1:1 porque o Instagram recusa proporção acima de 1,91:1, e a imagem do D1
 *   em `_internal/public-images.json` é 2:1. Facebook, Threads e X usam a
 *   mesma; sem o 1:1, caem pro 2:1 do D1 (o Instagram não: recusa).
 *   `--image-url` sobrepõe tudo.
 * - Agenda: D+1 a partir da página LinkedIn (09:00 BRT), escalonada 10 min
 *   por canal — `resolveRetrospectivaSocialScheduledAts`, que recusa colisão
 *   com a diária (10:00 d1 | 12:30 d2 | 17:30 d3).
 *
 * ## Idempotência
 *
 * State por canal (`divulgacao-published.json`): `done` sem `--force` pula.
 * 2º guard: `_internal/divulgacao-social-published.json` (mesmo store dos
 * publicadores, `appendSocialPosts`) — post vivo ali pula mesmo com o state
 * sem registro. Instagram/Threads reconciliados contra o Worker
 * (`verifyWorkerDispatch`; DLQ → `failed`).
 *
 * Uso:
 *   npx tsx scripts/publish-retrospectiva-social.ts --cycle 2609-10 \
 *     [--skip facebook,instagram,threads,x] [--force canal[,canal]] \
 *     [--base-date AAAA-MM-DD] [--at ISO] [--image-url URL] [--dry-run]
 *
 * Exit: 0 = ok; 1 = canal falhou, reconciliação não rodou, ou texto/agenda
 * recusados (nada despachado); 2 = uso.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { appendSocialPosts, readSocialPublished, type PostEntry, type SocialPublished } from "./lib/social-published-store.ts";
import { postToWorkerQueue } from "./lib/worker-queue-client.ts";
import { publishFacebookCarouselByUrl, validateScheduledTime } from "./publish-facebook.ts";
import { verifyWorkerDispatch, formatVerifySummary } from "./verify-social-worker-dispatch.ts";
import { readD1ImageUrl, RETROSPECTIVA_LINKEDIN_DESTAQUE } from "./publish-retrospectiva-linkedin.ts";
import { decideChannelAction, buildDoneChannelState, buildFailedChannelState, withChannelState } from "./lib/artigo-especial-state.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { uploadMonthlyImage } from "./lib/mensal/monthly-image-upload.ts";
import { resolveMonthlySendSchedule, type MonthlySendScheduleConfig } from "./lib/mensal/monthly-send-schedule.ts";
import {
  resolveRetrospectivaBaseDate,
  resolveRetrospectivaSocialScheduledAts,
} from "./lib/mensal/retrospectiva-schedule.ts";
import {
  contentMonthLabel,
  parseRetrospectivaSkip,
  retrospectivaDivulgacaoStatePath,
  readRetrospectivaDivulgacaoState,
  writeRetrospectivaDivulgacaoState,
} from "./lib/mensal/retrospectiva-divulgacao.ts";
import {
  RETROSPECTIVA_SOCIAL_CHANNELS,
  RETROSPECTIVA_SOCIAL_PLATFORM,
  RETROSPECTIVA_SOCIAL_TEXT_FILES,
  retrospectivaSocialPostProblems,
  type RetrospectivaSocialChannel,
} from "./lib/mensal/retrospectiva-social.ts";
import { logEvent } from "./lib/run-log.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** `destaque` no store e no Worker — o mesmo do LinkedIn (`especial-{sufixo}`, único namespace do Worker sem semântica alheia). */
export const RETROSPECTIVA_SOCIAL_DESTAQUE = RETROSPECTIVA_LINKEDIN_DESTAQUE;

/** Arquivo local do D1 1:1 da mensal (gerado junto com o 2:1 na Etapa 3 do `/diaria-mensal`). */
export const D1_SQUARE_FILENAME = "04-d1-1x1.jpg";

/** Piso de antecedência: a Graph API do Facebook recusa agendamento a menos de 10 min. */
const MIN_LEAD_MS = 10 * 60 * 1000;

export interface SocialDispatchInput {
  text: string;
  imageUrl: string | null;
  scheduledAt: string;
}

export interface SocialDispatchers {
  facebook: (i: SocialDispatchInput) => Promise<PostEntry>;
  worker: (channel: "instagram" | "threads", i: SocialDispatchInput) => Promise<PostEntry>;
}

/** Payload da mutation `createPost` do Buffer pro top-level (o MCP não é alcançável de script). */
export interface XBufferPayload {
  channelId: string;
  text: string;
  dueAt: string;
  images: Array<{ url: string; altText: string }>;
  publishedPath: string;
  destaque: string;
}

export type SocialChannelResult =
  | { channel: RetrospectivaSocialChannel; action: "skipped"; reason: string }
  | { channel: RetrospectivaSocialChannel; action: "dry-run"; scheduledAt: string; imageUrl: string | null; text: string }
  | { channel: RetrospectivaSocialChannel; action: "dispatched"; entry: PostEntry }
  | { channel: RetrospectivaSocialChannel; action: "failed"; reason: string }
  | { channel: "x"; action: "x-payload"; payload: XBufferPayload };

export interface RunRetrospectivaSocialOptions {
  cycle: string;
  cycleDir: string;
  /** Canais pedidos (todos os 4 menos `--skip`). */
  channels: readonly RetrospectivaSocialChannel[];
  /** Texto de cada canal (`divulgacao/{canal}.md`); ausente = recusado no pré-voo. */
  texts: Partial<Record<RetrospectivaSocialChannel, string>>;
  scheduledAts: Record<RetrospectivaSocialChannel, string>;
  /** `--image-url` explícito (sobrepõe as duas abaixo). */
  imageOverride: string | null;
  /** 2:1 do D1 (`_internal/public-images.json`) — fallback fora do Instagram. */
  d1ImageUrl: string | null;
  /** Resolve o 1:1 do D1 (upload pro KV). Chamado só se algum canal ativo precisar. */
  resolveSquareImage: () => Promise<string | null>;
  force: ReadonlySet<RetrospectivaSocialChannel>;
  dryRun: boolean;
  publishedPath: string;
  dispatchers: SocialDispatchers;
  /** Canal desligado por config (`publishing.social.{canal}.enabled: false`) → motivo. */
  disabled: Partial<Record<RetrospectivaSocialChannel, string>>;
  /** Buffer `channelId` do X (`publishing.social.twitter.buffer_channel_id`). */
  xChannelId: string | null;
  /** Credencial/Worker ausente por canal → motivo (checado só fora do dry-run). */
  missingCredentials: Partial<Record<RetrospectivaSocialChannel, string>>;
  verifyWorker?: (published: SocialPublished) => Promise<{ updated: SocialPublished; changes: number; inQueue?: number }>;
  now?: number;
}

export interface RunRetrospectivaSocialResult {
  results: SocialChannelResult[];
  /** A reconciliação com o Worker não rodou — os posts estão na fila, sem confirmação (caller sai != 0). */
  verifyError: string | null;
}

/**
 * Pura: post vivo (agendado/publicado) de um canal no store de dispatch — 2º
 * guard de idempotência, igual ao `findLiveDispatch` do LinkedIn.
 */
export function findLiveSocialDispatch(published: SocialPublished, channel: RetrospectivaSocialChannel): PostEntry | null {
  const platform = RETROSPECTIVA_SOCIAL_PLATFORM[channel];
  return (
    published.posts.find(
      (p) => p.platform === platform && p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE && (p.status === "scheduled" || p.status === "published"),
    ) ?? null
  );
}

/**
 * Corpo testável. Decide canal a canal (state, config, store), valida TODOS
 * os canais ativos antes de despachar QUALQUER um (texto, imagem, agenda,
 * credencial — lança e nada sai), despacha Facebook/Instagram/Threads, devolve
 * o payload do X e reconcilia Instagram/Threads contra o Worker.
 */
export async function runRetrospectivaSocialDispatch(o: RunRetrospectivaSocialOptions): Promise<RunRetrospectivaSocialResult> {
  const statePath = retrospectivaDivulgacaoStatePath(o.cycleDir);
  let state = readRetrospectivaDivulgacaoState(statePath, o.cycle);
  const published = readSocialPublished(o.publishedPath);
  const results: SocialChannelResult[] = [];
  const active: RetrospectivaSocialChannel[] = [];

  for (const ch of o.channels) {
    const decision = decideChannelAction(state, ch, o.force.has(ch));
    if (decision.action === "skip") {
      results.push({ channel: ch, action: "skipped", reason: decision.reason });
      continue;
    }
    if (o.disabled[ch]) {
      results.push({ channel: ch, action: "skipped", reason: `desligado no platform.config.json: ${o.disabled[ch]}` });
      continue;
    }
    const live = findLiveSocialDispatch(published, ch);
    if (live && !o.force.has(ch)) {
      results.push({
        channel: ch,
        action: "skipped",
        reason:
          `o store ${o.publishedPath} já tem o post (status ${live.status}, ${live.scheduled_at ?? "?"}) — o state por canal ` +
          `não registrou (escrita anterior falhou?). Confira na rede; --force ${ch} despacha de novo.`,
      });
      continue;
    }
    if (live) {
      console.warn(`[${ch}] --force: o post anterior (${String(live.fb_post_id ?? live.worker_queue_key ?? live.buffer_post_id ?? "?")}) NÃO é cancelado — remova-o à mão se não for pra sair duplicado.`);
    }
    active.push(ch);
  }

  // Imagem: o 1:1 só é resolvido (upload) se algum canal ativo for usá-lo.
  const square = o.imageOverride ?? (active.length > 0 ? await o.resolveSquareImage() : null);
  const imageFor = (ch: RetrospectivaSocialChannel): string | null =>
    o.imageOverride ?? (ch === "instagram" ? square : (square ?? o.d1ImageUrl));

  // Pré-voo de TODOS os canais ativos — qualquer problema aborta antes do 1º dispatch.
  const now = o.now ?? Date.now();
  const errors: string[] = [];
  for (const ch of active) {
    const text = o.texts[ch];
    if (text === undefined) {
      errors.push(`${ch}: divulgacao/${RETROSPECTIVA_SOCIAL_TEXT_FILES[ch]} ausente — o Passo 1 da skill precisa rodar antes`);
      continue;
    }
    const problems = retrospectivaSocialPostProblems(ch, text);
    if (problems.length > 0) errors.push(`${ch}: ${problems.join("; ")}`);
    if ((ch === "instagram" || ch === "facebook") && !imageFor(ch)) {
      errors.push(
        ch === "instagram"
          ? `instagram: sem imagem 1:1 (${D1_SQUARE_FILENAME} ausente e sem --image-url) — o Instagram recusa o 2:1 do D1`
          : `facebook: sem imagem (nem ${D1_SQUARE_FILENAME}, nem images.d1, nem --image-url)`,
      );
    }
    if (!(Date.parse(o.scheduledAts[ch]) > now + MIN_LEAD_MS)) {
      errors.push(`${ch}: ${o.scheduledAts[ch]} não está a ≥10 min no futuro — o post sairia fora da agenda`);
    }
    if (ch === "x" && !o.xChannelId) errors.push("x: publishing.social.twitter.buffer_channel_id ausente no platform.config.json");
    if (!o.dryRun && o.missingCredentials[ch]) errors.push(`${ch}: ${o.missingCredentials[ch]}`);
  }
  if (errors.length > 0) {
    throw new Error(`posts sociais recusados ANTES de qualquer dispatch:\n  - ${errors.join("\n  - ")}`);
  }

  const xPayload = (): XBufferPayload => ({
    channelId: o.xChannelId!,
    text: o.texts.x!.trim(),
    dueAt: o.scheduledAts.x,
    images: imageFor("x") ? [{ url: imageFor("x")!, altText: `Imagem do destaque principal da Retrospectiva de ${contentMonthLabel(o.cycle)} da diar.ia.br` }] : [],
    publishedPath: o.publishedPath,
    destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
  });

  if (o.dryRun) {
    for (const ch of active) {
      if (ch === "x") results.push({ channel: "x", action: "x-payload", payload: xPayload() });
      else results.push({ channel: ch, action: "dry-run", scheduledAt: o.scheduledAts[ch], imageUrl: imageFor(ch), text: o.texts[ch]!.trim() });
    }
    return { results, verifyError: null };
  }

  const record = (ch: RetrospectivaSocialChannel, ok: boolean, reason: string | null, url: string | null) => {
    const at = new Date().toISOString();
    state = withChannelState(state, ch, ok ? buildDoneChannelState(at, url) : buildFailedChannelState(at, reason ?? "dispatch falhou"));
    writeRetrospectivaDivulgacaoState(statePath, state);
  };

  mkdirSync(dirname(o.publishedPath), { recursive: true });
  let workerDispatched = false;
  for (const ch of active) {
    if (ch === "x") {
      results.push({ channel: "x", action: "x-payload", payload: xPayload() });
      continue;
    }
    const input: SocialDispatchInput = { text: o.texts[ch]!.trim(), imageUrl: imageFor(ch), scheduledAt: o.scheduledAts[ch] };
    let entry: PostEntry;
    try {
      entry = ch === "facebook" ? await o.dispatchers.facebook(input) : await o.dispatchers.worker(ch, input);
    } catch (e) {
      entry = {
        platform: RETROSPECTIVA_SOCIAL_PLATFORM[ch],
        destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: (e as Error).message,
      };
    }
    appendSocialPosts(o.publishedPath, [entry]);
    if (entry.status === "failed") {
      const reason = entry.reason ?? "dispatch falhou";
      record(ch, false, reason, null);
      results.push({ channel: ch, action: "failed", reason });
      continue;
    }
    record(ch, true, null, entry.url);
    results.push({ channel: ch, action: "dispatched", entry });
    if (ch !== "facebook" && entry.status === "scheduled") workerDispatched = true;
  }

  let verifyError: string | null = null;
  if (workerDispatched && o.verifyWorker) {
    try {
      const r = await o.verifyWorker(readSocialPublished(o.publishedPath));
      console.log(`[verify] reconciliação Worker: ${formatVerifySummary(r)}`);
      if (r.changes > 0) {
        writeFileSync(o.publishedPath, JSON.stringify(r.updated, null, 2) + "\n", "utf8");
        for (const ch of ["instagram", "threads"] as const) {
          const dead = r.updated.posts.find(
            (p) => p.platform === ch && p.destaque === RETROSPECTIVA_SOCIAL_DESTAQUE && p.status === "failed",
          );
          const i = results.findIndex((x) => x.channel === ch && x.action === "dispatched");
          if (dead && i >= 0) {
            const reason = typeof dead.failure_reason === "string" ? dead.failure_reason : "reconciliação pós-dispatch: Worker reportou falha (DLQ).";
            record(ch, false, reason, null);
            results[i] = { channel: ch, action: "failed", reason };
          }
        }
      }
    } catch (e) {
      // Aceito e gravado; o que falhou foi CONFIRMAR na fila — não vira
      // `failed` (retentar duplicaria), mas o caller sai != 0.
      verifyError = (e as Error).message;
      console.warn(`[verify] falhou — os posts estão na fila, mas não foram confirmados no Worker: ${verifyError}`);
    }
  }
  return { results, verifyError };
}

/** Pura: `--force canal[,canal]` → canais sociais (mesmos tokens do `--skip`; tokens de outros canais são ignorados aqui). */
export function parseSocialForce(forceArg: string | undefined): Set<RetrospectivaSocialChannel> {
  let all: Set<string>;
  try {
    all = parseRetrospectivaSkip(forceArg);
  } catch (e) {
    throw new Error((e as Error).message.replace(/^--skip/, "--force"));
  }
  return new Set(RETROSPECTIVA_SOCIAL_CHANNELS.filter((ch) => all.has(ch)));
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const { values, flags } = parseArgs(argv);
  const dryRun = flags.has("dry-run");
  const cycleDir = monthlyDir(cycle);

  let skip: Set<string>;
  let force: Set<RetrospectivaSocialChannel>;
  try {
    skip = parseRetrospectivaSkip(values["skip"]);
    // `--force` sem lista NÃO é global (ver SKILL): exige os canais.
    if (flags.has("force")) throw new Error("--force exige a lista de canais (ex: --force instagram) — nunca global.");
    force = parseSocialForce(values["force"]);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const channels = RETROSPECTIVA_SOCIAL_CHANNELS.filter((ch) => !skip.has(ch));

  const texts: Partial<Record<RetrospectivaSocialChannel, string>> = {};
  for (const ch of channels) {
    const p = resolve(cycleDir, "divulgacao", RETROSPECTIVA_SOCIAL_TEXT_FILES[ch]);
    if (existsSync(p)) texts[ch] = readFileSync(p, "utf8");
  }

  type SocialCfg = { enabled?: boolean; disabled_reason?: string; buffer_channel_id?: string; cloudflare_worker_url?: string };
  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as Parameters<
    typeof resolveRetrospectivaSocialScheduledAts
  >[0] & {
    publishing?: { social?: Record<string, SocialCfg> };
    monthly_send_schedule?: MonthlySendScheduleConfig;
  };
  const social = (config.publishing?.social ?? {}) as Record<string, SocialCfg | undefined>;
  const disabled: Partial<Record<RetrospectivaSocialChannel, string>> = {};
  for (const ch of RETROSPECTIVA_SOCIAL_CHANNELS) {
    const c = social[ch === "x" ? "twitter" : ch];
    if (c?.enabled === false) disabled[ch] = c.disabled_reason ?? "enabled=false";
  }

  const { baseDate, fromRule } = resolveRetrospectivaBaseDate(cycle, {
    baseDate: values["base-date"],
    at: values["at"],
    rule: resolveMonthlySendSchedule(config.monthly_send_schedule),
  });
  const scheduledAts = resolveRetrospectivaSocialScheduledAts(config, { at: values["at"], baseDate });
  console.log(
    `Agenda (#9500): ${RETROSPECTIVA_SOCIAL_CHANNELS.map((ch) => `${ch}=${scheduledAts[ch]}`).join(" | ")}` +
      (values["at"]
        ? " — a partir de --at"
        : baseDate
          ? ` — âncora: envio em ${baseDate}${fromRule ? " (regra do 1º sábado, #9473)" : ""}`
          : " — âncora: HOJE (regra do 1º sábado indisponível p/ este ciclo; passe --base-date com a data do envio do e-mail)"),
  );

  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? social.instagram?.cloudflare_worker_url ?? social.linkedin?.cloudflare_worker_url ?? "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  let fbCreds: { page_id?: string; page_access_token?: string; api_version?: string } = {};
  try {
    fbCreds = JSON.parse(readFileSync(resolve(ROOT, "data/.fb-credentials.json"), "utf8"));
  } catch {
    /* sem arquivo legado: só env */
  }
  const fbPageId = process.env.FACEBOOK_PAGE_ID || fbCreds.page_id || "";
  const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || fbCreds.page_access_token || "";
  const fbApiVersion = process.env.FACEBOOK_API_VERSION || fbCreds.api_version || "v25.0";

  const missingCredentials: Partial<Record<RetrospectivaSocialChannel, string>> = {};
  if (!fbPageId || !fbToken) missingCredentials.facebook = "FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN ausentes";
  if (!workerUrl || !workerToken) {
    // Sem o Worker não há agendamento no Instagram/Threads (a API não agenda) — nunca publica na hora.
    missingCredentials.instagram = missingCredentials.threads = "Worker não configurado (DIARIA_LINKEDIN_CRON_URL/_TOKEN)";
  }

  const squarePath = resolve(cycleDir, D1_SQUARE_FILENAME);
  const resolveSquareImage = async (): Promise<string | null> => {
    if (!existsSync(squarePath)) return null;
    if (dryRun) return `(upload de ${D1_SQUARE_FILENAME} no envio)`;
    return uploadMonthlyImage(squarePath, cycle, ROOT);
  };

  const publishedPath = resolve(cycleDir, "_internal", "divulgacao-social-published.json");
  const r = await runRetrospectivaSocialDispatch({
    cycle,
    cycleDir,
    channels,
    texts,
    scheduledAts,
    imageOverride: values["image-url"] ?? null,
    d1ImageUrl: readD1ImageUrl(cycleDir),
    resolveSquareImage,
    force,
    dryRun,
    publishedPath,
    disabled,
    xChannelId: social.twitter?.buffer_channel_id ?? null,
    missingCredentials,
    dispatchers: {
      facebook: async (i) => {
        validateScheduledTime(i.scheduledAt);
        const res = await publishFacebookCarouselByUrl(fbPageId, fbToken, fbApiVersion, [i.imageUrl!], i.text, i.scheduledAt);
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
          { text: i.text, image_url: i.imageUrl, scheduled_at: i.scheduledAt, destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, channel },
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
    },
    verifyWorker: (p) => verifyWorkerDispatch(p, workerUrl, workerToken),
  });

  for (const x of r.results) {
    if (x.action !== "dispatched" && x.action !== "failed") continue;
    logEvent(
      {
        edition: cycle,
        stage: null,
        agent: "publish-retrospectiva-social",
        level: x.action === "failed" || r.verifyError ? "warn" : "info",
        message: `${x.channel} ${x.action} para ${scheduledAts[x.channel]}`,
        details: x.action === "failed" ? { reason: x.reason } : { url: x.entry.url, worker_queue_key: x.entry.worker_queue_key ?? null },
      },
      ROOT,
    );
  }
  console.log(JSON.stringify({ cycle, dry_run: dryRun, published_path: publishedPath, results: r.results, verify_error: r.verifyError }, null, 2));
  if (r.results.some((x) => x.action === "failed") || r.verifyError) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`publish-retrospectiva-social: ${(e as Error).message}`);
    process.exit(1);
  });
}
