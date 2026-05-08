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
 *     [--schedule]          # se presente, calcula scheduled_at e usa queue p/ posts futuros
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
} from "./lib/social-published-store.ts";
import type { PostEntry } from "./lib/social-published-store.ts";

interface MakeWebhookPayload {
  text: string;
  image_url: string | null;
  scheduled_at: string | null;
  destaque: string;
}

interface MakeWebhookResponse {
  request_id?: string;
  accepted?: boolean;
  [k: string]: unknown;
}

interface WorkerQueueResponse {
  queued: boolean;
  key: string;
  scheduled_at: string;
  destaque: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schedule") {
      args.schedule = true;
    } else if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      // #725 bug #4: não consumir flag boolean seguinte como valor de outro arg
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

/**
 * Extrai o texto de um post LinkedIn de uma seção `## dN` dentro de `# LinkedIn`.
 * Normaliza CRLF → LF (arquivo pode vir do Drive com Windows line endings).
 */
export function extractPostText(socialMd: string, destaque: string): string {
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

  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
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
        return JSON.parse(text) as WorkerQueueResponse;
      } catch {
        throw new Error(`Worker returned non-JSON response: ${text.slice(0, 200)}`);
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

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw) {
    console.error(
      "Erro: --edition-dir obrigatório.\n" +
        "Uso: npx tsx scripts/publish-linkedin.ts --edition-dir data/editions/260504 [--schedule]",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  const doSchedule = !!args.schedule;
  if (args["skip-existing"]) {
    console.warn("AVISO: --skip-existing não tem efeito (flag legada). Use --no-skip-existing pra desligar o skip.");
  }
  const skipExisting = args["no-skip-existing"] !== true; // default true (#725 bug #2)
  const dayOffsetOverride = args["day-offset"]
    ? parseInt(args["day-offset"] as string, 10)
    : undefined;

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

  // #999 fail-fast: se 06-public-images.json não existe ou tem destaque
  // sem URL, abortar quando --schedule passado. Make scenario LinkedIn
  // exige Image URL — sem ela, post falha 5× e vai pra DLQ silenciosamente.
  // Caso real edição 260508: image_url=null causou 5 retries → 3 posts perdidos
  // até editor manual intervir. Sem --schedule (route=make_now), continua
  // permitindo post sem imagem como safety net.
  if (doSchedule) {
    const imgCachePath = resolve(editionDir, "06-public-images.json");
    let allDestaquesHaveImage = false;
    if (existsSync(imgCachePath)) {
      try {
        const imgCache = JSON.parse(readFileSync(imgCachePath, "utf8")) as {
          images?: Record<string, { url?: string }>;
        };
        allDestaquesHaveImage = destaques.every((d) => {
          const url = imgCache.images?.[d]?.url ?? null;
          return typeof url === "string" && url.length > 0;
        });
      } catch {
        allDestaquesHaveImage = false;
      }
    }
    if (!allDestaquesHaveImage) {
      console.error(
        [
          "ERRO: --schedule passado mas 06-public-images.json não tem URL pra todos os destaques.",
          `  Path: ${imgCachePath}`,
          "  Make scenario LinkedIn (Create Company Image Post) exige Image URL — sem ela,",
          "  webhook retorna BundleValidationError e post entra em retry loop até DLQ.",
          "",
          "Resolução: rodar antes do dispatch:",
          "  npx tsx scripts/upload-images-public.ts --edition-dir " + editionDir + " --mode social",
          "",
          "Ou rodar SEM --schedule (route=make_now) pra postar sem imagem.",
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  const results: PostEntry[] = [];

  for (const d of destaques) {
    // #918: re-ler estado em cada iteração (publish-facebook pode estar
    // gravando em paralelo). appendSocialPosts faz upsert por platform+destaque,
    // então failed entries são naturalmente substituídas no próximo append.
    const currentState = readSocialPublished(publishedPath);

    // Resume-aware: pular posts já com status draft/scheduled
    if (skipExisting) {
      const existing = currentState.posts.find(
        (p) =>
          p.platform === "linkedin" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled"),
      );
      if (existing) {
        console.log(`SKIP linkedin/${d} — already ${existing.status}`);
        results.push(existing);
        continue;
      }
    }

    // Extrair texto do post
    let text: string;
    try {
      text = extractPostText(socialMd, d);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`ERROR extracting text for linkedin/${d}: ${msg}`);
      const entry: PostEntry = {
        platform: "linkedin",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: msg,
      };
      appendSocialPosts(publishedPath, [entry]);
      results.push(entry);
      continue;
    }

    // #725 bug #9: carregar URL pública da imagem do cache gerado por
    // upload-images-public.ts (rodado em Etapa 4a.0 antes do dispatch).
    // Cache: {edition_dir}/06-public-images.json, chave "d1"/"d2"/"d3".
    // Graceful fallback: null se cache ausente ou Drive não configurado —
    // comportamento anterior (post sem imagem) como safety net.
    let imageUrl: string | null = null;
    {
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
    }

    // Calcular scheduled_at
    let scheduledAt: string | null = null;
    if (doSchedule) {
      try {
        scheduledAt = computeScheduledAt({
          config: config as Parameters<typeof computeScheduledAt>[0]["config"],
          editionDate,
          destaque: d as "d1" | "d2" | "d3",
          platform: "linkedin",
          dayOffsetOverride,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`SKIP linkedin/${d}: schedule_error: ${msg}`);
        const entry: PostEntry = {
          platform: "linkedin",
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason: `schedule_error: ${msg}`,
        };
        appendSocialPosts(publishedPath, [entry]);
        results.push(entry);
        continue;
      }
    }

    // Montar payload
    const payload: MakeWebhookPayload = {
      text,
      image_url: imageUrl,
      scheduled_at: scheduledAt,
      destaque: d,
    };

    // Decidir route: Worker queue (se scheduled_at futuro + worker configurado) ou Make webhook direto
    const isFutureSchedule =
      scheduledAt !== null && Date.parse(scheduledAt) > Date.now();
    const route: "worker_queue" | "make_now" =
      useWorkerForScheduled && isFutureSchedule ? "worker_queue" : "make_now";

    // #886 observabilidade: log estruturado da decisão de route antes do fire,
    // pra trilha de auditoria em incidentes ("por que d2 saiu antes do horário?").
    logEvent({
      edition: editionDate,
      stage: 4,
      agent: "publish-linkedin",
      level: "info",
      message: `linkedin/${d} dispatched via ${route}`,
      details: { route, scheduled_at: scheduledAt, destaque: d },
    });

    // Try/catch aninhados — semantics:
    //   inner try (route === "worker_queue"): captura falha do Worker e tenta
    //     fallback Make. Se Make sucesso → entry com fallback_used=true,
    //     status="draft", route="worker_queue" (intent original). Se Make
    //     TAMBÉM falhar, propaga pro outer catch.
    //   outer catch lida com:
    //     (a) extractPostText/computeScheduledAt errors (pré-fire) — esses já
    //         tem `continue` antes daqui, mas a defesa em profundidade fica;
    //         entry → status: "failed", sem fallback_used.
    //     (b) Worker fail + Make fail (fallback exhausted) — entry →
    //         status: "failed" COM fallback_used: true preservado via reason.
    //     (c) Make fail no caminho fire-now (sem worker_queue) — entry →
    //         status: "failed", sem fallback_used.
    try {
      let entry: PostEntry;
      if (route === "worker_queue") {
        console.log(`Queuing linkedin/${d} via Cloudflare Worker (fire at ${scheduledAt})...`);
        try {
          const response = await postToWorkerQueue(workerUrl, workerToken, payload);
          entry = {
            platform: "linkedin",
            destaque: d,
            url: null,
            status: "scheduled",
            scheduled_at: scheduledAt,
            route,
            worker_queue_key: response.key,
          };
        } catch (workerError: unknown) {
          // #887: fallback gracioso pra Make direto se Worker falhar todos os retries.
          // Make.com posta IMEDIATAMENTE (ignora scheduled_at) — post real é melhor
          // que post falhado. Editor revê resultado no gate + run-log.
          const wmsg =
            workerError instanceof Error ? workerError.message : String(workerError);
          console.warn(
            `[publish-linkedin] Worker falhou (${wmsg}), fallback pra Make direto (post imediato, ignora scheduled_at)`,
          );
          const response = await postToMakeWebhook(webhookUrl, payload);
          entry = {
            platform: "linkedin",
            destaque: d,
            url: null,
            // Make POSTOU IMEDIATAMENTE — status sempre "draft" (post live, sem
            // agendamento futuro), nunca "scheduled". scheduled_at preservado
            // pra auditoria mas representa o que NÃO aconteceu. fallback_used +
            // fallback_reason carregam o sinal de que era pra ser scheduled.
            // route registrado é o originalmente intentado (worker_queue), não
            // o efetivamente usado (make) — pra rastrear intent.
            status: "draft",
            scheduled_at: scheduledAt,
            route,
            make_request_id: response.request_id,
            fallback_used: true,
            fallback_reason: sanitizeFallbackReason(wmsg),
          };
        }
      } else {
        console.log(`Publishing linkedin/${d} via Make.com (fire-now)...`);
        const response = await postToMakeWebhook(webhookUrl, payload);
        // #997: route=make_now sempre posta IMEDIATAMENTE (Make.com ignora
        // scheduled_at do payload). Status sempre "draft", nunca "scheduled" —
        // gate humano não pode achar que tá agendado quando o post já saiu.
        // scheduled_at preservado pra auditoria; route="make_now" disambigua.
        entry = {
          platform: "linkedin",
          destaque: d,
          url: null, // LinkedIn post URL só fica disponível após publicação efetiva
          status: "draft",
          scheduled_at: scheduledAt,
          route,
          make_request_id: response.request_id,
        };
      }
      appendSocialPosts(publishedPath, [entry]);
      results.push(entry);
      const fallbackTag = entry.fallback_used ? " (fallback worker→make)" : "";
      console.log(
        `OK linkedin/${d} — ${entry.status} via ${route}${fallbackTag}${scheduledAt ? ` at ${scheduledAt}` : ""}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`FAILED linkedin/${d}: ${msg}`);
      // route registrado é o originalmente intentado, não tentativas subsequentes
      // (sem fallback worker→make ainda — #892).
      const entry: PostEntry = {
        platform: "linkedin",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: scheduledAt,
        route,
        reason: msg,
      };
      appendSocialPosts(publishedPath, [entry]);
      results.push(entry);
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
