/**
 * publish-linkedin.ts (#506)
 *
 * Posta no LinkedIn company page (Diar.ia) via webhook Make.com.
 * Make.com recebe o payload e executa o post via módulo LinkedIn.
 *
 * Pré-requisito: MAKE_LINKEDIN_WEBHOOK_URL no env OU campo
 * `publishing.social.linkedin.make_webhook_url` em platform.config.json.
 * A variável de env tem precedência sobre o config.
 *
 * Uso:
 *   npx tsx scripts/publish-linkedin.ts \
 *     --edition-dir data/editions/260504 \
 *     [--schedule]          # se presente, calcula scheduled_at e envia no payload
 *     [--skip-existing]     # pula posts já em 06-social-published.json (default: true)
 *     [--only d1,d2,d3]     # subset de posts (default: todos)
 *     [--day-offset N]      # override de day_offset do config
 *
 * Payload enviado ao Make.com (por post):
 *   { text, image_url, scheduled_at, destaque }
 *
 * Make.com valida e posta/agenda no LinkedIn company page.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Tipos ─────────────────────────────────────────────────────────────

interface PostEntry {
  platform: string;
  destaque: string;
  url: string | null;
  status: "draft" | "scheduled" | "failed";
  scheduled_at: string | null;
  reason?: string;
  make_request_id?: string;
}

interface SocialPublished {
  posts: PostEntry[];
}

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

// ── Helpers ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schedule") {
      args.schedule = true;
    } else if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
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
  const dRe = new RegExp(
    `(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d|\\n# |$)`,
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
        signal: AbortSignal.timeout(15_000),
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
  const skipExisting = args["skip-existing"] !== false; // default true
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
        linkedin?: { make_webhook_url?: string };
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

    // image_url é null — Make.com workflow decide a estratégia (upload direto, R2, etc).
    // Quando hosting público estiver disponível, passar a URL aqui.
    const imageUrl: string | null = null;

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

    // Enviar ao Make.com com retry
    try {
      console.log(`Publishing linkedin/${d} via Make.com...`);
      const response = await postToMakeWebhook(webhookUrl, payload);
      const entry: PostEntry = {
        platform: "linkedin",
        destaque: d,
        url: null, // LinkedIn post URL só fica disponível após publicação efetiva
        status: scheduledAt ? "scheduled" : "draft",
        scheduled_at: scheduledAt,
        make_request_id: response.request_id,
      };
      published.posts.push(entry);
      savePublished(publishedPath, published);
      results.push(entry);
      console.log(
        `OK linkedin/${d} — ${entry.status}${scheduledAt ? ` at ${scheduledAt}` : ""}`,
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
