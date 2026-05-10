/**
 * delete-test-schedules.ts (#1058)
 *
 * Deleta todos os posts agendados de uma edição de teste — Facebook (Graph API
 * DELETE) + LinkedIn (Worker `DELETE /queue/:key`). Atualiza
 * 06-social-published.json marcando cada entry como `status: deleted`.
 *
 * Uso:
 *   npx tsx scripts/delete-test-schedules.ts --edition-dir data/editions/260510/
 *   npx tsx scripts/delete-test-schedules.ts --edition-dir ... --platform facebook
 *   npx tsx scripts/delete-test-schedules.ts --edition-dir ... --platform linkedin
 *   npx tsx scripts/delete-test-schedules.ts --edition-dir ... --dry-run
 *
 * Pré-requisitos:
 *   - data/.fb-credentials.json com page_access_token + api_version (FB)
 *   - DIARIA_LINKEDIN_CRON_URL + DIARIA_LINKEDIN_CRON_TOKEN no env (LinkedIn)
 *
 * Background: /diaria-test --with-publish cria posts agendados pra +10 dias
 * que precisam ser deletados antes da data agendada. Antes deste script o
 * cleanup era manual (Node ad-hoc + 9× wrangler kv key delete).
 *
 * Origem: run /diaria-test 260510 (2026-05-10) — 12 posts cleanup manual.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSocialPublished,
  appendSocialPosts,
  type PostEntry,
} from "./lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface FbCredentials {
  page_id?: string;
  page_access_token?: string;
  api_version?: string;
}

interface DeleteResult {
  platform: "facebook" | "linkedin";
  destaque: string;
  subtype?: string;
  identifier: string; // fb_post_id ou worker_queue_key
  status: "deleted" | "skipped" | "failed" | "dry_run";
  reason?: string;
  http_status?: number;
}

function loadFbCredentials(): FbCredentials | null {
  const path = resolve(ROOT, "data/.fb-credentials.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FbCredentials;
  } catch {
    return null;
  }
}

function resolveLinkedinWorkerUrl(): string {
  const fromEnv = process.env.DIARIA_LINKEDIN_CRON_URL;
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(
      readFileSync(resolve(ROOT, "platform.config.json"), "utf8"),
    ) as { publishing?: { social?: { linkedin?: { cloudflare_worker_url?: string } } } };
    return config.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
  } catch {
    return "";
  }
}

export async function deleteFbPost(
  fbPostId: string,
  pageToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; httpStatus: number; body?: string }> {
  const url = `https://graph.facebook.com/${apiVersion}/${fbPostId}?access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetchImpl(url, { method: "DELETE" });
  const body = await res.text();
  return { ok: res.ok, httpStatus: res.status, body: body.slice(0, 300) };
}

export async function deleteLinkedinKey(
  workerUrl: string,
  token: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; httpStatus: number; body?: string }> {
  // /queue/:key requer URL-encoding do key (contém `:` e timestamps)
  const url = workerUrl.replace(/\/+$/, "") + "/queue/" + encodeURIComponent(key);
  const res = await fetchImpl(url, {
    method: "DELETE",
    headers: { "X-Diaria-Token": token },
  });
  const body = await res.text();
  return { ok: res.ok, httpStatus: res.status, body: body.slice(0, 300) };
}

function parseArgs(argv: string[]): {
  editionDir: string | null;
  platform: "all" | "facebook" | "linkedin";
  dryRun: boolean;
} {
  let editionDir: string | null = null;
  let platform: "all" | "facebook" | "linkedin" = "all";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--edition-dir" && i + 1 < argv.length) {
      editionDir = argv[++i];
    } else if (arg === "--platform" && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === "facebook" || v === "linkedin") platform = v;
      else throw new Error(`--platform deve ser facebook ou linkedin (got '${v}')`);
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  return { editionDir, platform, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.editionDir) {
    console.error(
      "Uso: delete-test-schedules.ts --edition-dir <path> [--platform facebook|linkedin] [--dry-run]",
    );
    process.exit(2);
  }

  const editionDir = resolve(ROOT, args.editionDir);
  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  const publishedPath = existsSync(internalPath)
    ? internalPath
    : existsSync(rootPath)
      ? rootPath
      : null;
  if (!publishedPath) {
    console.error(`[delete-test-schedules] arquivo não encontrado:\n  ${internalPath}\n  ${rootPath}`);
    process.exit(2);
  }

  const published = readSocialPublished(publishedPath);
  const targets = published.posts.filter((p) => {
    if (p.status === "deleted") return false;
    if (args.platform === "all") return true;
    return p.platform === args.platform;
  });

  if (targets.length === 0) {
    console.log(JSON.stringify({ deleted: [], skipped: [], message: "nenhum post pra deletar" }, null, 2));
    return;
  }

  console.error(`[delete-test-schedules] ${targets.length} posts pra deletar (dry_run=${args.dryRun})`);

  const results: DeleteResult[] = [];
  const fbCreds = loadFbCredentials();
  const liWorkerUrl = resolveLinkedinWorkerUrl();
  const liToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";

  for (const post of targets) {
    const subtype = (post.subtype as string | undefined) ?? "main";
    if (post.platform === "facebook") {
      const fbPostId = (post.fb_post_id as string | undefined) ?? "";
      if (!fbPostId) {
        results.push({
          platform: "facebook", destaque: post.destaque, subtype,
          identifier: "(no fb_post_id)", status: "skipped", reason: "no_fb_post_id",
        });
        continue;
      }
      if (args.dryRun) {
        results.push({
          platform: "facebook", destaque: post.destaque, subtype,
          identifier: fbPostId, status: "dry_run",
        });
        continue;
      }
      if (!fbCreds?.page_access_token) {
        results.push({
          platform: "facebook", destaque: post.destaque, subtype,
          identifier: fbPostId, status: "failed", reason: "missing_fb_credentials",
        });
        continue;
      }
      try {
        const r = await deleteFbPost(
          fbPostId,
          fbCreds.page_access_token,
          fbCreds.api_version ?? "v25.0",
        );
        results.push({
          platform: "facebook", destaque: post.destaque, subtype,
          identifier: fbPostId, status: r.ok ? "deleted" : "failed",
          http_status: r.httpStatus, reason: r.ok ? undefined : r.body,
        });
      } catch (e) {
        results.push({
          platform: "facebook", destaque: post.destaque, subtype,
          identifier: fbPostId, status: "failed", reason: (e as Error).message,
        });
      }
      continue;
    }
    if (post.platform === "linkedin") {
      const queueKey = (post.worker_queue_key as string | undefined) ?? "";
      if (!queueKey) {
        results.push({
          platform: "linkedin", destaque: post.destaque, subtype,
          identifier: "(no worker_queue_key)", status: "skipped", reason: "no_worker_queue_key",
        });
        continue;
      }
      if (args.dryRun) {
        results.push({
          platform: "linkedin", destaque: post.destaque, subtype,
          identifier: queueKey, status: "dry_run",
        });
        continue;
      }
      if (!liWorkerUrl || !liToken) {
        results.push({
          platform: "linkedin", destaque: post.destaque, subtype,
          identifier: queueKey, status: "failed", reason: "missing_worker_creds",
        });
        continue;
      }
      try {
        const r = await deleteLinkedinKey(liWorkerUrl, liToken, queueKey);
        results.push({
          platform: "linkedin", destaque: post.destaque, subtype,
          identifier: queueKey, status: r.ok ? "deleted" : "failed",
          http_status: r.httpStatus, reason: r.ok ? undefined : r.body,
        });
      } catch (e) {
        results.push({
          platform: "linkedin", destaque: post.destaque, subtype,
          identifier: queueKey, status: "failed", reason: (e as Error).message,
        });
      }
    }
  }

  // Atualizar 06-social-published.json com deleted_at em entries deletadas
  if (!args.dryRun) {
    const now = new Date().toISOString();
    const deletedKeys = new Set(
      results.filter((r) => r.status === "deleted").map((r) => r.platform + "|" + r.destaque + "|" + (r.subtype ?? "main")),
    );
    const updated: PostEntry[] = [];
    for (const p of published.posts) {
      const subtype = (p.subtype as string | undefined) ?? "main";
      const key = p.platform + "|" + p.destaque + "|" + subtype;
      if (deletedKeys.has(key)) {
        updated.push({ ...p, status: "deleted" as const, deleted_at: now, deleted_reason: "test_mode_cleanup" });
      } else {
        updated.push(p);
      }
    }
    writeFileSync(publishedPath, JSON.stringify({ posts: updated }, null, 2) + "\n", "utf8");
  }

  // Sumário
  const summary = {
    total: results.length,
    deleted: results.filter((r) => r.status === "deleted").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    dry_run: results.filter((r) => r.status === "dry_run").length,
  };
  console.log(JSON.stringify({ summary, results }, null, 2));

  if (summary.failed > 0) process.exit(1);
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
