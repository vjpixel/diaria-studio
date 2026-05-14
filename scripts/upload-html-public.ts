/**
 * upload-html-public.ts (#1178, #1239)
 *
 * Faz PUT de `_internal/newsletter-final.html` pro Worker Cloudflare,
 * onde fica acessível via GET por uma URL única por edição. Substitui o
 * fluxo chunk-html-base64 + javascript_tool push (consome ~80K tokens
 * por edição — Stage 4 newsletter playbook).
 *
 * Fluxo novo:
 *   1. Worker grava HTML em KV (key=html:{edition}, TTL 12h)
 *   2. Stage 4 playbook usa `fetch('/{edition}')` direto do browser
 *   3. Insert via `editor.commands.insertContent({type:'text', text: html})`
 *   → ~5K tokens total (vs ~80K antes)
 *
 * URL retornada (campo `url` no stdout) também serve pra editor revisar o
 * HTML online antes do paste — botões A/B do poll funcionam, imagens
 * carregam. Não substitui test email do Beehiiv (CSS final não está lá).
 *
 * #1239 — Migração de Worker:
 *   - Tenta primeiro `draft.diaria.workers.dev/{edition}` (Worker dedicado)
 *   - Fallback automático pra `diar-ia-poll.diaria.workers.dev/html/{edition}`
 *     (Worker legado) quando o novo não está disponível
 *   - Após Worker novo deployado + grace period, remover fallback
 *
 * Uso:
 *   npx tsx scripts/upload-html-public.ts --edition 260514
 *   npx tsx scripts/upload-html-public.ts --edition 260514 --dry-run
 *   npx tsx scripts/upload-html-public.ts --edition 260514 --legacy-only
 *
 * Env:
 *   ADMIN_SECRET ou POLL_ADMIN_SECRET — HMAC pra autenticar o PUT
 *   DRAFT_WORKER_URL (default: https://draft.diaria.workers.dev) — alvo primário
 *   POLL_WORKER_URL (default: https://diar-ia-poll.diaria.workers.dev) — fallback
 *
 * Output stdout (JSON):
 *   {
 *     "edition": "260514",
 *     "url": "https://draft.diaria.workers.dev/260514",
 *     "bytes": 28341,
 *     "ttl_seconds": 43200,
 *     "target": "draft" | "poll-legacy"
 *   }
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT_WORKER_URL =
  process.env.DRAFT_WORKER_URL ?? "https://draft.diaria.workers.dev";
const POLL_WORKER_URL =
  process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

/** HMAC(ADMIN_SECRET, "html:{key}") — Worker valida com hmacVerify mesmo input. */
export function htmlPutSig(secret: string, key: string): string {
  return createHmac("sha256", secret).update(`html:${key}`).digest("hex");
}

export interface UploadHtmlResult {
  edition: string;
  url: string;
  bytes: number;
  ttl_seconds?: number;
  dry_run?: boolean;
  /** Worker que efetivamente recebeu o PUT (#1239 — observabilidade da migração). */
  target?: "draft" | "poll-legacy";
}

/**
 * Constrói a URL completa pra um worker dado. Mantida exportada
 * pra testes unitários.
 */
export function buildWorkerUrl(workerBaseUrl: string, edition: string, kind: "draft" | "poll-legacy"): string {
  const base = workerBaseUrl.replace(/\/+$/, "");
  const editionEnc = encodeURIComponent(edition);
  return kind === "draft" ? `${base}/${editionEnc}` : `${base}/html/${editionEnc}`;
}

async function tryPut(args: {
  url: string;
  html: string;
  sig: string;
  fetchImpl: typeof fetch;
}): Promise<{ ok: boolean; status: number; data?: { bytes: number; ttl_seconds: number }; errBody?: string }> {
  const res = await args.fetchImpl(args.url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${args.sig}`,
      "Content-Type": "text/html; charset=utf-8",
    },
    body: args.html,
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    return { ok: false, status: res.status, errBody: body };
  }
  const data = (await res.json()) as { bytes: number; ttl_seconds: number };
  return { ok: true, status: res.status, data };
}

export async function uploadHtml(args: {
  edition: string;
  htmlPath: string;
  secret: string;
  draftWorkerUrl?: string;
  pollWorkerUrl?: string;
  dryRun?: boolean;
  legacyOnly?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<UploadHtmlResult> {
  const draftBase = (args.draftWorkerUrl ?? DRAFT_WORKER_URL).replace(/\/+$/, "");
  const pollBase = (args.pollWorkerUrl ?? POLL_WORKER_URL).replace(/\/+$/, "");
  const draftUrl = buildWorkerUrl(draftBase, args.edition, "draft");
  const pollUrl = buildWorkerUrl(pollBase, args.edition, "poll-legacy");
  const html = readFileSync(args.htmlPath, "utf8");

  if (args.dryRun) {
    return {
      edition: args.edition,
      url: args.legacyOnly ? pollUrl : draftUrl,
      bytes: Buffer.byteLength(html, "utf8"),
      dry_run: true,
      target: args.legacyOnly ? "poll-legacy" : "draft",
    };
  }

  const sig = htmlPutSig(args.secret, args.edition);
  const fetchFn = args.fetchImpl ?? fetch;

  // #1239: tenta draft Worker primeiro, fallback pra poll legacy se falhar.
  if (!args.legacyOnly) {
    const draftAttempt = await tryPut({ url: draftUrl, html, sig, fetchImpl: fetchFn });
    if (draftAttempt.ok && draftAttempt.data) {
      return {
        edition: args.edition,
        url: draftUrl,
        bytes: draftAttempt.data.bytes,
        ttl_seconds: draftAttempt.data.ttl_seconds,
        target: "draft",
      };
    }
    // 404/connection refused = Worker não existe ainda. Cai pro legacy.
    // 4xx/5xx outros podem ser auth/payload — também tentar legacy (mesma assinatura).
    console.error(
      `[upload-html-public] draft Worker falhou (${draftAttempt.status}): ${draftAttempt.errBody?.slice(0, 200)}. Fallback pra poll legacy.`,
    );
  }

  const pollAttempt = await tryPut({ url: pollUrl, html, sig, fetchImpl: fetchFn });
  if (!pollAttempt.ok) {
    throw new Error(`Worker PUT falhou em ambos: draft + poll-legacy (status ${pollAttempt.status}): ${pollAttempt.errBody}`);
  }
  return {
    edition: args.edition,
    url: pollUrl,
    bytes: pollAttempt.data!.bytes,
    ttl_seconds: pollAttempt.data!.ttl_seconds,
    target: "poll-legacy",
  };
}

async function main(): Promise<void> {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  const dryRun = flags.has("dry-run");
  const legacyOnly = flags.has("legacy-only");
  const htmlPathOverride = values["html"];

  if (!edition) {
    console.error(
      "Uso: upload-html-public.ts --edition AAMMDD [--dry-run] [--html <path>] [--legacy-only]",
    );
    process.exit(2);
  }

  const secret =
    process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET ?? "";
  if (!secret && !dryRun) {
    console.error("[upload-html-public] ADMIN_SECRET ausente no env — abortando");
    process.exit(1);
  }

  const htmlPath = htmlPathOverride
    ? resolve(ROOT, htmlPathOverride)
    : resolve(ROOT, "data", "editions", edition, "_internal", "newsletter-final.html");

  if (!existsSync(htmlPath)) {
    console.error(`[upload-html-public] HTML não encontrado: ${htmlPath}`);
    process.exit(1);
  }

  const result = await uploadHtml({
    edition,
    htmlPath,
    secret,
    dryRun,
    legacyOnly,
  });
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[upload-html-public] ${(e as Error).message}`);
    process.exit(1);
  });
}
