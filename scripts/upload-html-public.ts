/**
 * upload-html-public.ts (#1178)
 *
 * Faz PUT de `_internal/newsletter-final.html` pro Worker Cloudflare,
 * onde fica acessível via GET por uma URL única por edição. Substitui o
 * fluxo chunk-html-base64 + javascript_tool push (consome ~80K tokens
 * por edição — Stage 4 newsletter playbook).
 *
 * Fluxo novo:
 *   1. Worker grava HTML em KV (key=html:{edition}, TTL 12h)
 *   2. Stage 4 playbook usa `fetch('/html/{edition}')` direto do browser
 *   3. Insert via `editor.commands.insertContent({type:'text', text: html})`
 *   → ~5K tokens total (vs ~80K antes)
 *
 * URL retornada (campo `url` no stdout) também serve pra editor revisar o
 * HTML online antes do paste — botões A/B do poll funcionam, imagens
 * carregam. Não substitui test email do Beehiiv (CSS final não está lá).
 *
 * Uso:
 *   npx tsx scripts/upload-html-public.ts --edition 260514
 *   npx tsx scripts/upload-html-public.ts --edition 260514 --dry-run
 *
 * Env:
 *   ADMIN_SECRET ou POLL_ADMIN_SECRET — HMAC pra autenticar o PUT
 *   POLL_WORKER_URL (default: https://diar-ia-poll.diaria.workers.dev)
 *
 * Output stdout (JSON):
 *   {
 *     "edition": "260514",
 *     "url": "https://diar-ia-poll.diaria.workers.dev/html/260514",
 *     "bytes": 28341,
 *     "ttl_seconds": 604800
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
}

export async function uploadHtml(args: {
  edition: string;
  htmlPath: string;
  secret: string;
  workerUrl?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<UploadHtmlResult> {
  const workerUrl = (args.workerUrl ?? POLL_WORKER_URL).replace(/\/+$/, "");
  const url = `${workerUrl}/html/${encodeURIComponent(args.edition)}`;
  const html = readFileSync(args.htmlPath, "utf8");

  if (args.dryRun) {
    return {
      edition: args.edition,
      url,
      bytes: Buffer.byteLength(html, "utf8"),
      dry_run: true,
    };
  }

  const sig = htmlPutSig(args.secret, args.edition);
  const fetchFn = args.fetchImpl ?? fetch;
  const res = await fetchFn(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${sig}`,
      "Content-Type": "text/html; charset=utf-8",
    },
    body: html,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`Worker PUT ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { bytes: number; ttl_seconds: number };
  return {
    edition: args.edition,
    url,
    bytes: data.bytes,
    ttl_seconds: data.ttl_seconds,
  };
}

async function main(): Promise<void> {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  const dryRun = flags.has("dry-run");
  const htmlPathOverride = values["html"];

  if (!edition) {
    console.error("Uso: upload-html-public.ts --edition AAMMDD [--dry-run] [--html <path>]");
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
