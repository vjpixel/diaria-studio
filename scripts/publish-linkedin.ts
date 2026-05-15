/**
 * publish-linkedin.ts (#506)
 *
 * Posta no LinkedIn company page (Diar.ia). 2 caminhos de fire:
 *   - "fire-now": POSTa direto no webhook Make.com (Scenario A "Integration LinkedIn")
 *     que executa o post imediatamente via módulo LinkedIn.
 *   - "queue": POSTa pro Cloudflare Worker `diaria-linkedin-cron` que enfileira em KV
 *     e fira o webhook Make automaticamente quando `scheduled_at` chega.
 *     Usado quando `--schedule` é passado E `scheduled_at` é futuro.
 *
 * Pré-requisitos:
 *   - MAKE_LINKEDIN_WEBHOOK_URL no env OU `publishing.social.linkedin.make_webhook_url` no config
 *   - (opcional) DIARIA_LINKEDIN_CRON_URL no env OU `publishing.social.linkedin.cloudflare_worker_url`
 *   - (opcional) DIARIA_LINKEDIN_CRON_TOKEN no env (header X-Diaria-Token pro Worker)
 *   Sem o Worker configurado, fallback é fire-now (mesmo se scheduled_at futuro) — mas
 *   nesse caso o Make.com posta imediatamente, ignorando o scheduled_at.
 *
 * Fallback Worker → Make (#887):
 *   Se Worker estiver configurado mas falhar todos os retries (503, KV down, deploy
 *   quebrado, etc.), o script cai gracefully em `postToMakeWebhook` (post imediato,
 *   ignora `scheduled_at`). Entry recebe `fallback_used = true` + `fallback_reason`
 *   para auditoria. Razão: post real é melhor que post falhado; editor revê no gate.
 *
 * Uso:
 *   npx tsx scripts/publish-linkedin.ts \
 *     --edition-dir data/editions/260504 \
 *     [--fire-now]          # #1101: opt-in pra post imediato (default = agendar via Worker queue)
 *     [--schedule]          # no-op (default já é agendar). Mantido pra compat.
 *     [--skip-existing]     # pula posts já em 06-social-published.json (default: true)
 *     [--only d1,d2,d3]     # subset de posts (default: todos)
 *     [--day-offset N]      # override de day_offset do config
 *
 * Output: appends em {edition-dir}/_internal/06-social-published.json
 * (mesmo arquivo do publish-facebook.ts, mesmo formato, plataforma "linkedin")
 *
 * Resume-aware: re-rodar pula posts já com status "scheduled" ou "draft".
 * Posts com status "failed" são retentados.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // #923 — carregar .env.local antes de qualquer process.env access

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScheduledAt } from "./compute-social-schedule.ts";
import { CONFIG } from "./lib/config.ts";
import { logEvent } from "./lib/run-log.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Tipos ─────────────────────────────────────────────────────────────

// #650 Tier C: PostEntry/SocialPublished vêm de lib/social-published-store.ts.
// `make_request_id` entra via escape hatch `[key: string]: unknown`.
// #918: appendSocialPosts/readSocialPublished são atomic + locked, prevenindo
// race condition com publish-facebook.ts em paralelo (incidente 2026-05-07
// onde FB d2/d3 sumiram do JSON quando LinkedIn sobrescreveu).
import {
  appendSocialPosts,
  readSocialPublished,
  resolveSubtype,
} from "./lib/social-published-store.ts";
import type { PostEntry, PostSubtype } from "./lib/social-published-store.ts";

// #595 — webhook_target + action types (espelham linkedin-payload.ts)
type WebhookTarget = "diaria" | "pixel";
type QueueAction = "post" | "comment";

// #1032: types movidos pra scripts/lib/schemas/linkedin-payload.ts
import {
  type MakeWebhookPayload,
  type MakeWebhookResponse,
  type WorkerQueueResponse,
  parseMakeWebhookPayload,
  parseWorkerQueueResponse,
} from "./lib/schemas/linkedin-payload.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schedule") {
      args.schedule = true;
    } else if (argv[i] === "--fire-now") {
      // #1101 — opt-in pra post imediato (sem agendamento). Default é agendar.
      args["fire-now"] = true;
    } else if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i] === "--test-mode") {
      // #1056 — tagar entries com is_test:true pra delete-test-schedules safety
      args["test-mode"] = true;
    } else if (argv[i] === "--no-comments") {
      // #1075 — skipar comment_diaria + comment_pixel (Make não suporta comments).
      // #1310 — agora é no-op (comments já são skip default).
      args["no-comments"] = true;
    } else if (argv[i] === "--with-comments") {
      // #1310 — opt-in raro pra forçar enqueue de comments (caso Make adicione
      // suporte futuro). Default é skipar.
      args["with-comments"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      // #725 bug #4: não consumir flag boolean seguinte como valor de outro arg
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Isola o bloco completo `## d{N}` dentro de `# LinkedIn` (incluindo eventuais
 * subseções `### comment_diaria` e `### comment_pixel` — #595).
 * Normaliza CRLF → LF (arquivo pode vir do Drive com Windows line endings).
 */
function extractDestaqueBlock(socialMd: string, destaque: string): string {
  // Normalizar CRLF → LF
  socialMd = socialMd.replace(/\r\n/g, "\n");

  // Isolar seção # LinkedIn
  const platRe = /(?:^|\n)# LinkedIn\n([\s\S]*?)(?=\n# |$)/i;
  const platMatch = socialMd.match(platRe);
  if (!platMatch) throw new Error("Seção 'LinkedIn' não encontrada em 03-social.md");

  // Extrair subseção ## dN
  // #725 bug #3: `\d+\b` em vez de `\d` — evita `## d10` bater como `## d1`+`0`
  const dRe = new RegExp(
    `(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`,
    "i",
  );
  const dMatch = platMatch[1].match(dRe);
  if (!dMatch) throw new Error(`Destaque '${destaque}' não encontrado em LinkedIn`);

  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Extrai o texto do **post principal** (sem `### comment_*` subsections — #595).
 * Backward-compat: se o destaque não tem subseções, retorna o bloco inteiro.
 */
export function extractPostText(socialMd: string, destaque: string): string {
  const block = extractDestaqueBlock(socialMd, destaque);
  // Cortar no primeiro `### comment_diaria` ou `### comment_pixel` se houver
  const commentRe = /\n### comment_(diaria|pixel)\b/;
  const cut = block.search(commentRe);
  const mainOnly = cut >= 0 ? block.slice(0, cut) : block;
  return mainOnly.trim();
}

/**
 * Extrai o texto do `### comment_diaria` de um destaque (#595).
 * Substitui `{edition_url}` pelo URL da edição se passado.
 *
 * Retorna `null` se a subseção não existe (backward-compat com 03-social.md
 * gerados antes do schema #595 — main only).
 */
export function extractCommentDiaria(
  socialMd: string,
  destaque: string,
  editionUrl: string | null = null,
): string | null {
  const block = extractDestaqueBlock(socialMd, destaque);
  // Match `### comment_diaria\n...` até `### comment_pixel` ou fim
  const re = /\n### comment_diaria\b\s*\n([\s\S]*?)(?=\n### comment_(pixel|diaria)\b|$)/;
  const m = block.match(re);
  if (!m) return null;
  let text = m[1].trim();
  if (editionUrl) {
    text = text.replaceAll("{edition_url}", editionUrl);
  }
  return text;
}

/**
 * Extrai o texto do `### comment_pixel` de um destaque (#595).
 * Retorna `null` se a subseção não existe.
 */
export function extractCommentPixel(socialMd: string, destaque: string): string | null {
  const block = extractDestaqueBlock(socialMd, destaque);
  const re = /\n### comment_pixel\b\s*\n([\s\S]*?)(?=\n### comment_(diaria|pixel)\b|$)/;
  const m = block.match(re);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Sanitiza fallback_reason antes de gravar no entry. Worker pode retornar
 * HTML 500 longo com stack trace + paths internos; mesmo com `wmsg` truncado
 * em 300 chars (per `postToWorkerQueue` retorno error message), pode vazar
 * info irrelevante / sensível. Estratégia:
 *   - Se a mensagem contém um HTTP status (`HTTP NNN`), extrai o status code
 *     + a primeira linha (sem o status), max 100 chars.
 *   - Senão, usa só a primeira linha truncada em 100 chars.
 * Exposed para tests.
 */
export function sanitizeFallbackReason(raw: string): string {
  const httpMatch = raw.match(/HTTP \d{3}/);
  const firstLine = raw.split("\n")[0].slice(0, 150);
  return httpMatch
    ? `${httpMatch[0]}: ${firstLine.replace(httpMatch[0], "").trim().slice(0, 100)}`
    : firstLine.slice(0, 100);
}

/**
 * Envia payload ao webhook Make.com com retry (até `maxAttempts` tentativas).
 * Retorna a resposta parseada ou lança em falha total.
 */
export async function postToMakeWebhook(
  webhookUrl: string,
  payload: MakeWebhookPayload,
  maxAttempts = 2,
): Promise<MakeWebhookResponse> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Make webhook HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      // Make.com pode retornar 200 com body vazio ou JSON
      const text = await res.text();
      if (!text.trim()) return { accepted: true };
      try {
        return JSON.parse(text) as MakeWebhookResponse;
      } catch {
        // Resposta não-JSON mas HTTP 200 → aceitar como sucesso
        return { accepted: true };
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`[publish-linkedin] attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastError ?? new Error("make_webhook_failed");
}

/**
 * Enfileira o post no Cloudflare Worker `diaria-linkedin-cron` (KV-backed).
 * Worker fira o webhook Make automaticamente quando `scheduled_at` chega.
 *
 * Retorna a resposta do Worker (com `key` da fila) ou lança em falha.
 */
export async function postToWorkerQueue(
  workerUrl: string,
  token: string,
  payload: MakeWebhookPayload,
  maxAttempts = 2,
): Promise<WorkerQueueResponse> {
  // Worker espera /queue endpoint
  const queueUrl = workerUrl.replace(/\/+$/, "") + "/queue";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(queueUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Diaria-Token": token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Worker queue HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const text = await res.text();
      try {
        // #1032: schema-validated parse (queued: true required, etc)
        return parseWorkerQueueResponse(JSON.parse(text));
      } catch (parseErr) {
        throw new Error(
          `Worker response inválido (schema ou JSON): ${text.slice(0, 200)} — ${(parseErr as Error).message}`,
        );
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`[publish-linkedin] worker attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastError ?? new Error("worker_queue_failed");
}

// ── Dispatch helper (#595) ────────────────────────────────────────────

/**
 * Input pra um item de fila — main post OU comment (Diar.ia / Pixel).
 * Comments têm `subtype: "comment_diaria" | "comment_pixel"`, `webhookTarget`
 * pode ser "pixel", e `action: "comment"`. Main usa defaults `"main" / "diaria" / "post"`.
 */
export interface DispatchInput {
  destaque: string;
  subtype: PostSubtype;
  text: string;
  imageUrl: string | null;
  scheduledAt: string | null;
  webhookTarget: WebhookTarget;
  action: QueueAction;
  parentDestaque?: string;
}

export interface DispatchContext {
  publishedPath: string;
  webhookUrl: string;
  workerUrl: string;
  workerToken: string;
  useWorkerForScheduled: boolean;
  editionDate: string;
  /** #1056 — quando true, todas as entries gravadas em 06-social-published.json
   * recebem `is_test: true`. Usado pelo `delete-test-schedules.ts --require-is-test`
   * pra cleanup seguro só de artefatos de teste, sem deletar produção. */
  isTest?: boolean;
}

/**
 * Despacha um item LinkedIn (main, comment_diaria ou comment_pixel) — extrai
 * a lógica que era inline no loop de destaques (#595, refactor pra suportar 9
 * items por edição em vez de 3).
 *
 * Decide route (worker_queue se scheduled futuro + worker configurado, senão
 * make_now), monta payload, dispara, e grava entry em 06-social-published.json.
 * Em failure, grava entry com status="failed" + reason.
 *
 * Exported pra testes (#595 review) — caller principal é main() inline.
 */
export async function dispatchEntry(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<PostEntry> {
  const { destaque: d, subtype, text, imageUrl, scheduledAt } = input;
  const tag = `linkedin/${d}/${subtype}`;

  // Schema-validated payload (#1032)
  const payload: MakeWebhookPayload = parseMakeWebhookPayload({
    text,
    image_url: imageUrl,
    scheduled_at: scheduledAt,
    destaque: d,
    webhook_target: input.webhookTarget,
    action: input.action,
    ...(input.parentDestaque !== undefined && { parent_destaque: input.parentDestaque }),
  });

  // Route decision: comments precisam de worker queue (timing relativo ao main).
  // Main pode usar make_now se scheduled é passado.
  const isFutureSchedule = scheduledAt !== null && Date.parse(scheduledAt) > Date.now();
  const route: "worker_queue" | "make_now" =
    ctx.useWorkerForScheduled && isFutureSchedule ? "worker_queue" : "make_now";

  logEvent({
    edition: ctx.editionDate,
    stage: 4,
    agent: "publish-linkedin",
    level: "info",
    message: `${tag} dispatched via ${route}`,
    details: { route, scheduled_at: scheduledAt, destaque: d, subtype, webhook_target: input.webhookTarget, action: input.action },
  });

  try {
    let entry: PostEntry;
    if (route === "worker_queue") {
      console.log(`Queuing ${tag} via Cloudflare Worker (fire at ${scheduledAt})...`);
      try {
        const response = await postToWorkerQueue(ctx.workerUrl, ctx.workerToken, payload);
        entry = {
          platform: "linkedin",
          destaque: d,
          subtype,
          url: null,
          status: "scheduled",
          scheduled_at: scheduledAt,
          route,
          worker_queue_key: response.key,
          webhook_target: input.webhookTarget,
          action: input.action,
        };
      } catch (workerError: unknown) {
        // #887 fallback: Worker falhou → tenta Make direto. Mas Pixel comments
        // SÓ tem URL no Worker (Diar.ia webhookUrl não é Pixel) — fallback
        // não-aplicável pra webhook_target=pixel; falha entry com reason claro.
        const wmsg = workerError instanceof Error ? workerError.message : String(workerError);
        if (input.webhookTarget === "pixel") {
          throw new Error(
            `${wmsg} (fallback worker→make não disponível pra webhook_target=pixel — Make scenario Pixel não tem URL local)`,
          );
        }
        console.warn(
          `[publish-linkedin] Worker falhou (${wmsg}), fallback pra Make direto (post imediato, ignora scheduled_at)`,
        );
        const response = await postToMakeWebhook(ctx.webhookUrl, payload);
        entry = {
          platform: "linkedin",
          destaque: d,
          subtype,
          url: null,
          status: "draft",
          scheduled_at: scheduledAt,
          route,
          make_request_id: response.request_id,
          fallback_used: true,
          fallback_reason: sanitizeFallbackReason(wmsg),
          webhook_target: input.webhookTarget,
          action: input.action,
        };
      }
    } else {
      // route === "make_now"
      // Pixel não tem fallback make_now (URL é só no Worker). Falha early.
      if (input.webhookTarget === "pixel") {
        throw new Error(
          `webhook_target=pixel exige Worker configurado — make_now não suportado (Pixel webhook URL fica só no Worker secret)`,
        );
      }
      console.log(`Publishing ${tag} via Make.com (fire-now)...`);
      const response = await postToMakeWebhook(ctx.webhookUrl, payload);
      entry = {
        platform: "linkedin",
        destaque: d,
        subtype,
        url: null,
        status: "draft",
        scheduled_at: scheduledAt,
        route,
        make_request_id: response.request_id,
        webhook_target: input.webhookTarget,
        action: input.action,
      };
    }
    if (ctx.isTest) entry.is_test = true; // #1056
    appendSocialPosts(ctx.publishedPath, [entry]);
    const fallbackTag = entry.fallback_used ? " (fallback worker→make)" : "";
    console.log(
      `OK ${tag} — ${entry.status} via ${route}${fallbackTag}${scheduledAt ? ` at ${scheduledAt}` : ""}`,
    );
    return entry;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`FAILED ${tag}: ${msg}`);
    const entry: PostEntry = {
      platform: "linkedin",
      destaque: d,
      subtype,
      url: null,
      status: "failed",
      scheduled_at: scheduledAt,
      route,
      reason: msg,
      webhook_target: input.webhookTarget,
      action: input.action,
    };
    if (ctx.isTest) entry.is_test = true; // #1056
    appendSocialPosts(ctx.publishedPath, [entry]);
    return entry;
  }
}

/**
 * Calcula scheduled_at de comment relativo ao main (#595).
 * - mainAt no futuro → comment fica em mainAt + offsetMin
 * - mainAt no passado (ou null/make_now) → comment fica em now + offsetMin
 *
 * Razão: se main fira agora (make_now ou já-passou), o comment ainda precisa
 * esperar o LinkedIn aceitar o post pra ele aparecer no "Get Latest" do Make.
 * 3min/8min de buffer de now é suficiente.
 */
export function computeCommentScheduledAt(
  mainAtIso: string | null,
  offsetMinutes: number,
  now: number = Date.now(),
): string {
  const mainMs = mainAtIso ? Date.parse(mainAtIso) : NaN;
  const baseMs = !isNaN(mainMs) && mainMs > now ? mainMs : now;
  return new Date(baseMs + offsetMinutes * 60_000).toISOString();
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw) {
    console.error(
      "Erro: --edition-dir obrigatório.\n" +
        "Uso: npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/260504 [--fire-now]",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  // #1101: default = agendar. `--schedule` continua aceito (no-op se default já é true).
  // Pra forçar post imediato, usar `--fire-now` (opt-in explícito).
  const fireNow = !!args["fire-now"];
  const doSchedule = !fireNow;
  const isTest = !!args["test-mode"]; // #1056 — tag is_test:true em entries
  // #1310 — comments skipped por DEFAULT. Make.com LinkedIn module não suporta
  // `Create Comment` (nem company nem personal). Enfileirar items com
  // action:"comment" gera "Missing value of required parameter 'url'" no Make,
  // 5 retries, DLQ, e spam de email pro editor. Posts comments manualmente
  // pelo Pixel (~T+3min e T+8min após main). Use `--with-comments` pra forçar
  // se Make adicionar suporte futuro. Legacy `--no-comments` ainda aceito por
  // back-compat (no-op — comments já são skip default).
  const noComments = !args["with-comments"]; // inverteu em #1310
  if (args["no-comments"]) {
    console.warn("AVISO: --no-comments é no-op em #1310+ (comments já são skip default). Use --with-comments pra forçar.");
  }
  if (args["skip-existing"]) {
    console.warn("AVISO: --skip-existing não tem efeito (flag legada). Use --no-skip-existing pra desligar o skip.");
  }
  const skipExisting = args["no-skip-existing"] !== true; // default true (#725 bug #2)
  const dayOffsetOverride = args["day-offset"]
    ? parseInt(args["day-offset"] as string, 10)
    : undefined;
  // #595 — URL pública da edição Beehiiv pra substituir `{edition_url}` em
  // comment_diaria. Precedência: --edition-url flag > _internal/05-edition-url.txt
  // > fallback `https://diar.ia.br` (raiz) com warn.
  const editionUrlFlag = args["edition-url"] as string | undefined;

  // Subset de destaques (--only d1,d2 → ["d1","d2"])
  const onlyArg = args["only"] as string | undefined;
  const destaques: string[] = onlyArg
    ? onlyArg
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^d[123]$/.test(s))
    : ["d1", "d2", "d3"];

  if (destaques.length === 0) {
    console.error("Erro: --only deve conter d1, d2 e/ou d3 (ex: --only d1,d2).");
    process.exit(1);
  }

  // Resolver webhook URL: env tem precedência
  const config = JSON.parse(
    readFileSync(resolve(ROOT, "platform.config.json"), "utf8"),
  ) as {
    publishing?: {
      social?: {
        linkedin?: {
          make_webhook_url?: string;
          cloudflare_worker_url?: string;
        };
        [k: string]: unknown;
      };
    };
    [k: string]: unknown;
  };

  const webhookUrl =
    process.env.MAKE_LINKEDIN_WEBHOOK_URL ??
    config.publishing?.social?.linkedin?.make_webhook_url ??
    "";

  if (!webhookUrl) {
    console.error(
      "Erro: webhook Make.com não configurado.\n" +
        "Opções:\n" +
        "  1. Variável de env: MAKE_LINKEDIN_WEBHOOK_URL=https://hook.eu2.make.com/...\n" +
        '  2. platform.config.json → publishing.social.linkedin.make_webhook_url: "..."',
    );
    process.exit(1);
  }

  // Worker URL + token: opcionais. Sem eles, fallback é fire-now via Make webhook
  // (mas posts agendados pra futuro vão postar IMEDIATAMENTE — Make.com não respeita
  // scheduled_at do payload). Configurar pra agendamento real.
  const workerUrl =
    process.env.DIARIA_LINKEDIN_CRON_URL ??
    config.publishing?.social?.linkedin?.cloudflare_worker_url ??
    "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  const useWorkerForScheduled = workerUrl !== "" && workerToken !== "";

  // #923 fail-fast: --schedule sem Worker = silent fire-now bug. Aborta.
  // Bug histórico (2026-05-07): .env.local não carregava → workerToken="" →
  // useWorkerForScheduled=false → fallback pra Make.com fire-now → 3 posts
  // postados imediatamente em vez de agendados. Pra evitar repetição, qualquer
  // --schedule sem Worker config aborta com mensagem clara.
  if (doSchedule && !useWorkerForScheduled) {
    const lines = [
      "ERRO: --schedule passado mas Cloudflare Worker não está configurado.",
      "  DIARIA_LINKEDIN_CRON_URL: " + (workerUrl ? "set" : "MISSING"),
      "  DIARIA_LINKEDIN_CRON_TOKEN: " +
        (workerToken
          ? "set (length=" + workerToken.length + ")"
          : "MISSING — provavelmente .env.local não carregada"),
      "",
      "Sem o Worker, --schedule cairia em fire-now via Make.com (publica",
      "IMEDIATAMENTE, ignora scheduled_at). Pra evitar publicação acidental,",
      "este script aborta.",
      "",
      "Resolução:",
      "  1. Confirmar que .env.local existe e contém DIARIA_LINKEDIN_CRON_TOKEN",
      "  2. Confirmar platform.config.json (ou env DIARIA_LINKEDIN_CRON_URL)",
      "     com cloudflare_worker_url",
      "  3. OU rodar SEM --schedule pra postar imediatamente conscientemente",
    ];
    console.error(lines.join("\n"));
    process.exit(2);
  }

  // Carregar 03-social.md
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error("Erro: 03-social.md não encontrado. Rode a Etapa 2 primeiro.");
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  // #595 — Resolver edition_url pra substituir {edition_url} em comment_diaria.
  // Ordem: --edition-url flag > _internal/05-edition-url.txt > fallback raiz.
  let editionUrl: string;
  if (editionUrlFlag) {
    editionUrl = editionUrlFlag;
    console.log(`#595: edition_url via flag → ${editionUrl}`);
  } else {
    const editionUrlFile = resolve(editionDir, "_internal", "05-edition-url.txt");
    if (existsSync(editionUrlFile)) {
      editionUrl = readFileSync(editionUrlFile, "utf8").trim();
      console.log(`#595: edition_url via 05-edition-url.txt → ${editionUrl}`);
    } else {
      editionUrl = "https://diar.ia.br";
      console.warn(
        `#595: edition_url não fornecido (sem --edition-url nem 05-edition-url.txt) — fallback ${editionUrl}. ` +
        `Comment_diaria vai apontar pra raiz da newsletter em vez do post específico.`,
      );
    }
  }

  // Extrair edition date (últimos 6 chars do caminho)
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;
  if (!/^\d{6}$/.test(editionDate)) {
    console.error(
      `Erro: não foi possível extrair AAMMDD do caminho '${editionDir}'.`,
    );
    process.exit(1);
  }

  // Carregar / inicializar estado publicado (mesmo arquivo do facebook)
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const internalPath = resolve(internalDir, "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    publishedPath = rootPath; // backward compat — gravará no root
  } else {
    publishedPath = internalPath; // nova edição
  }
  // #918: Estado lido fresh-on-read em cada iteração via readSocialPublished
  // (evita race com publish-facebook.ts paralelo). appendSocialPosts faz upsert
  // por platform+destaque sob .lock — não precisamos de buffer local.

  // #999/#1275 fail-fast: se 06-public-images.json não existe ou tem destaque
  // sem URL, abortar SEMPRE. Make scenario LinkedIn (tanto main quanto comments)
  // exige Image URL — sem ela, post falha 5× e vai pra DLQ silenciosamente.
  //
  // Histórico:
  // - #999 (260508): primeira incidência, fail-fast adicionado mas só ativo com --schedule
  // - #1275 (260513+260514): regressão — 12 comments foram pra DLQ. Cache tinha apenas
  //   {cover, eia_a, eia_b} (mode newsletter) sem {d1, d2, d3} (mode social). Provável
  //   causa: orchestrator pulou 4c-pre OU --fire-now bypass acidental. Fix: remover o
  //   `if (doSchedule)` guard — fail-fast roda SEMPRE, inclusive em --fire-now.
  //   Rationale: post sem imagem cria post LinkedIn quebrado (text-only mas Make scenario
  //   espera image post) → erro do Make → editor recebe spam de email. Safety net pior
  //   que abort claro.
  {
    const imgCachePath = resolve(editionDir, "06-public-images.json");
    const imgCacheState: {
      exists: boolean;
      keys: string[];
      missing: string[];
      destaques_with_url: string[];
    } = { exists: false, keys: [], missing: [...destaques], destaques_with_url: [] };

    if (existsSync(imgCachePath)) {
      imgCacheState.exists = true;
      try {
        const imgCache = JSON.parse(readFileSync(imgCachePath, "utf8")) as {
          images?: Record<string, { url?: string }>;
        };
        imgCacheState.keys = Object.keys(imgCache.images ?? {});
        imgCacheState.destaques_with_url = destaques.filter((d) => {
          const url = imgCache.images?.[d]?.url ?? null;
          return typeof url === "string" && url.length > 0;
        });
        imgCacheState.missing = destaques.filter(
          (d) => !imgCacheState.destaques_with_url.includes(d),
        );
      } catch {
        imgCacheState.missing = [...destaques];
      }
    }

    // Logar SEMPRE o state do cache (audit pra debug futuro de regressões #1275)
    logEvent({
      edition: editionDate,
      stage: 4,
      agent: "publish-linkedin",
      level: imgCacheState.missing.length === 0 ? "info" : "warn",
      message: `image_cache_state: ${imgCacheState.destaques_with_url.length}/${destaques.length} destaques com URL`,
      details: { ...imgCacheState, cache_path: imgCachePath },
    });

    if (imgCacheState.missing.length > 0) {
      console.error(
        [
          `ERRO (#1275 fail-fast): 06-public-images.json não tem URL pra destaque(s): ${imgCacheState.missing.join(", ")}`,
          `  Path: ${imgCachePath}`,
          `  Keys presentes: ${imgCacheState.keys.join(", ") || "<arquivo ausente>"}`,
          "  Make scenario LinkedIn (Create Company Image Post) exige Image URL — sem ela,",
          "  webhook retorna BundleValidationError e post entra em retry loop até DLQ.",
          "  Comments (comment_diaria + comment_pixel) também falham mesmo herdando URL do main.",
          "",
          "Resolução: rodar antes do dispatch:",
          "  npx tsx scripts/upload-images-public.ts --edition-dir " + editionDir + " --mode social",
          "",
          "  (--mode all também serve — uploada cover/eai_a/eia_b + d1/d2/d3 em uma chamada)",
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  const results: PostEntry[] = [];
  const ctx: DispatchContext = {
    publishedPath,
    webhookUrl,
    workerUrl,
    workerToken,
    useWorkerForScheduled,
    editionDate,
    isTest,
  };

  // #595 — pre-carregar imageUrl por destaque (mesmo source pra todos os
  // subtypes; comments não usam imagem mas o helper aceita null).
  const imageUrlByDestaque: Record<string, string | null> = {};
  for (const d of destaques) {
    let imageUrl: string | null = null;
    const imgCachePath = resolve(editionDir, "06-public-images.json");
    if (existsSync(imgCachePath)) {
      try {
        const imgCache = JSON.parse(readFileSync(imgCachePath, "utf8")) as {
          images?: Record<string, { url?: string }>;
        };
        const url = imgCache.images?.[d]?.url ?? null;
        if (url) {
          imageUrl = url;
          console.log(`linkedin/${d}: imagem Drive → ${url}`);
        } else {
          console.warn(`linkedin/${d}: chave '${d}' ausente em 06-public-images.json — post sem imagem`);
        }
      } catch (e) {
        console.warn(`linkedin/${d}: 06-public-images.json inválido — ${(e as Error).message}`);
      }
    } else {
      console.warn(`linkedin/${d}: 06-public-images.json não existe — rodar upload-images-public.ts antes. Post sem imagem.`);
    }
    imageUrlByDestaque[d] = imageUrl;
  }

  for (const d of destaques) {
    // #918: re-ler estado em cada iteração (publish-facebook pode estar
    // gravando em paralelo). appendSocialPosts faz upsert por
    // (platform, destaque, subtype) sob .lock — failed entries são
    // naturalmente substituídas no próximo append (#595 ajusta upsert).
    const currentState = readSocialPublished(publishedPath);

    // Helper: skip se já temos um entry final pra (linkedin, d, subtype).
    const alreadyDone = (subtype: PostSubtype): PostEntry | undefined =>
      currentState.posts.find(
        (p) =>
          p.platform === "linkedin" &&
          p.destaque === d &&
          resolveSubtype(p) === subtype &&
          (p.status === "draft" || p.status === "scheduled"),
      );

    // ── Calcular mainAt (1× por destaque, reusado pelos comments) ──
    let mainAt: string | null = null;
    if (doSchedule) {
      try {
        mainAt = computeScheduledAt({
          config: config as Parameters<typeof computeScheduledAt>[0]["config"],
          editionDate,
          destaque: d as "d1" | "d2" | "d3",
          platform: "linkedin",
          dayOffsetOverride,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`SKIP linkedin/${d}: schedule_error: ${msg}`);
        // Falha de schedule afeta os 3 subtypes — gravar 3 entries failed
        for (const sub of ["main", "comment_diaria", "comment_pixel"] as const) {
          const entry: PostEntry = {
            platform: "linkedin",
            destaque: d,
            subtype: sub,
            url: null,
            status: "failed",
            scheduled_at: null,
            reason: `schedule_error: ${msg}`,
          };
          if (isTest) entry.is_test = true; // #1056
          appendSocialPosts(publishedPath, [entry]);
          results.push(entry);
        }
        continue;
      }
    }

    // ── 1. MAIN ────────────────────────────────────────────────────
    {
      const existing = skipExisting ? alreadyDone("main") : undefined;
      if (existing) {
        console.log(`SKIP linkedin/${d}/main — already ${existing.status}`);
        results.push(existing);
      } else {
        let text: string;
        try {
          text = extractPostText(socialMd, d);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`ERROR extracting text for linkedin/${d}/main: ${msg}`);
          const entry: PostEntry = {
            platform: "linkedin",
            destaque: d,
            subtype: "main",
            url: null,
            status: "failed",
            scheduled_at: null,
            reason: msg,
          };
          if (isTest) entry.is_test = true; // #1056
          appendSocialPosts(publishedPath, [entry]);
          results.push(entry);
          continue; // sem main, comments não fazem sentido
        }

        results.push(await dispatchEntry({
          destaque: d,
          subtype: "main",
          text,
          imageUrl: imageUrlByDestaque[d],
          scheduledAt: mainAt,
          webhookTarget: "diaria",
          action: "post",
        }, ctx));
      }
    }

    // ── 2-3. COMMENTS (T+3min / T+8min) — só com --schedule (#595 review)
    // Sem --schedule (fire-now mode), comments seriam route=make_now e
    // comment_pixel jogaria erro (Pixel exige Worker). Para preservar backward-
    // compat com `publish-linkedin` ad-hoc fire-now (debug, recovery, retry
    // isolado), pulamos comments quando !doSchedule. Pra editor que quer 9
    // items (3 main + 6 comments), basta passar --schedule.
    if (!doSchedule) {
      console.log(
        `linkedin/${d}: comments pulados (fire-now mode sem --schedule). ` +
          `Pra agendar 9 items por edição (main + comment_diaria + comment_pixel), passe --schedule.`,
      );
      continue;
    }

    // #1075 — Make não suporta CreateCompanyComment nem CreateComment via API
    // pessoal. Editor pode pular comments via --no-comments até Make adicionar
    // suporte ou pivotarmos pra outra plataforma.
    if (noComments) {
      console.log(`linkedin/${d}: comments pulados (--no-comments, #1075)`);
      continue;
    }

    // ── 2. COMMENT_DIARIA (T+3min) ─────────────────────────────────
    {
      const cdText = extractCommentDiaria(socialMd, d, editionUrl);
      if (cdText === null) {
        // Schema antigo (sem subseção comment_diaria) — backward-compat: skip.
        console.log(`linkedin/${d}/comment_diaria: subseção ausente em 03-social.md — schema pré-#595, skip`);
      } else {
        const existing = skipExisting ? alreadyDone("comment_diaria") : undefined;
        if (existing) {
          console.log(`SKIP linkedin/${d}/comment_diaria — already ${existing.status}`);
          results.push(existing);
        } else {
          const cdAt = computeCommentScheduledAt(mainAt, 3);
          results.push(await dispatchEntry({
            destaque: d,
            subtype: "comment_diaria",
            text: cdText,
            imageUrl: null, // comments não levam imagem
            scheduledAt: cdAt,
            webhookTarget: "diaria",
            action: "comment",
            parentDestaque: d,
          }, ctx));
        }
      }
    }

    // ── 3. COMMENT_PIXEL (T+8min) ──────────────────────────────────
    {
      const cpText = extractCommentPixel(socialMd, d);
      if (cpText === null) {
        console.log(`linkedin/${d}/comment_pixel: subseção ausente em 03-social.md — schema pré-#595, skip`);
      } else {
        const existing = skipExisting ? alreadyDone("comment_pixel") : undefined;
        if (existing) {
          console.log(`SKIP linkedin/${d}/comment_pixel — already ${existing.status}`);
          results.push(existing);
        } else {
          const cpAt = computeCommentScheduledAt(mainAt, 8);
          results.push(await dispatchEntry({
            destaque: d,
            subtype: "comment_pixel",
            text: cpText,
            imageUrl: null,
            scheduledAt: cpAt,
            webhookTarget: "pixel",
            action: "comment",
            parentDestaque: d,
          }, ctx));
        }
      }
    }
  }

  // Sumário final
  const summary = {
    total: results.length,
    draft: results.filter((r) => r.status === "draft").length,
    scheduled: results.filter((r) => r.status === "scheduled").length,
    failed: results.filter((r) => r.status === "failed").length,
  };

  console.log(JSON.stringify({ out_path: publishedPath, summary, posts: results }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
