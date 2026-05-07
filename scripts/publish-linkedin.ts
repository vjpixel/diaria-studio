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

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScheduledAt } from "./compute-social-schedule.ts";
import { CONFIG } from "./lib/config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Tipos ─────────────────────────────────────────────────────────────

// #650 Tier C: PostEntry/SocialPublished vêm de lib/social-published-store.ts.
// `make_request_id` entra via escape hatch `[key: string]: unknown`.
import type { PostEntry, SocialPublished } from "./lib/social-published-store.ts";

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

function loadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as SocialPublished;
  }
  return { posts: [] };
}

function savePublished(path: string, data: SocialPublished): void {
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmpPath, path);
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
  const published = loadPublished(publishedPath);

  const results: PostEntry[] = [];

  for (const d of destaques) {
    // Resume-aware: pular posts já com status draft/scheduled
    if (skipExisting) {
      const existing = published.posts.find(
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
      // Remover entradas failed para retry
      published.posts = published.posts.filter(
        (p) =>
          !(p.platform === "linkedin" && p.destaque === d && p.status === "failed"),
      );
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
      published.posts.push(entry);
      savePublished(publishedPath, published);
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
        published.posts.push(entry);
        savePublished(publishedPath, published);
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
    const route =
      useWorkerForScheduled && isFutureSchedule ? "worker_queue" : "make_now";

    try {
      let entry: PostEntry;
      if (route === "worker_queue") {
        console.log(`Queuing linkedin/${d} via Cloudflare Worker (fire at ${scheduledAt})...`);
        const response = await postToWorkerQueue(workerUrl, workerToken, payload);
        entry = {
          platform: "linkedin",
          destaque: d,
          url: null,
          status: "scheduled",
          scheduled_at: scheduledAt,
          worker_queue_key: response.key,
        };
      } else {
        console.log(`Publishing linkedin/${d} via Make.com (fire-now)...`);
        const response = await postToMakeWebhook(webhookUrl, payload);
        entry = {
          platform: "linkedin",
          destaque: d,
          url: null, // LinkedIn post URL só fica disponível após publicação efetiva
          status: scheduledAt ? "scheduled" : "draft",
          scheduled_at: scheduledAt,
          make_request_id: response.request_id,
        };
      }
      published.posts.push(entry);
      savePublished(publishedPath, published);
      results.push(entry);
      console.log(
        `OK linkedin/${d} — ${entry.status} via ${route}${scheduledAt ? ` at ${scheduledAt}` : ""}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`FAILED linkedin/${d}: ${msg}`);
      const entry: PostEntry = {
        platform: "linkedin",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: scheduledAt,
        reason: msg,
      };
      published.posts.push(entry);
      savePublished(publishedPath, published);
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
