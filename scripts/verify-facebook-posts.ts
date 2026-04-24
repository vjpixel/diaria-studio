/**
 * verify-facebook-posts.ts
 *
 * Verifica posts agendados do Facebook contra a Graph API e atualiza
 * `06-social-published.json` com o status real (published / failed).
 *
 * Rationale (#47): `publish-facebook.ts` agenda via `scheduled_publish_time`
 * e grava `status: "scheduled"`. Sem verificação, esse status fica para
 * sempre — mesmo que o post tenha saído (status real: published) ou falhado
 * silenciosamente (ex: token expirado, página sem permissão).
 *
 * Uso:
 *   npx tsx scripts/verify-facebook-posts.ts --edition-dir data/editions/260423/
 *   npm run verify-facebook-posts -- --edition-dir data/editions/260423/
 *
 * Requer: `data/.fb-credentials.json` com `page_access_token` + `api_version`.
 *
 * Output: atualiza in-place o `06-social-published.json` da edição.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface PostEntry {
  platform: string;
  destaque: string;
  url: string | null;
  status: "draft" | "scheduled" | "failed" | "published";
  scheduled_at: string | null;
  published_at?: string;
  reason?: string;
  failure_reason?: string;
  fb_post_id?: string;
}

export interface SocialPublished {
  posts: PostEntry[];
}

export interface GraphPostResponse {
  is_published?: boolean;
  created_time?: string;
  permalink_url?: string;
  scheduled_publish_time?: number;
  error?: { message: string; code?: number };
}

export type FetchPostFn = (
  postId: string,
  pageToken: string,
  apiVersion: string,
) => Promise<GraphPostResponse>;

/**
 * Fetch default — chama Graph API real. Pode ser substituído em testes.
 */
export async function defaultFetchPost(
  postId: string,
  pageToken: string,
  apiVersion: string,
): Promise<GraphPostResponse> {
  const fields = "is_published,created_time,permalink_url,scheduled_publish_time";
  // Token via Authorization header (não query string) pra evitar leak em logs
  // de proxies/CDNs intermediários — security review da sessão 2026-04-24.
  const url = `https://graph.facebook.com/${apiVersion}/${postId}?fields=${fields}`;
  const res = await fetch(url, {
    headers: { Authorization: `OAuth ${pageToken}` },
  });
  const data = (await res.json()) as GraphPostResponse;
  return data;
}

/**
 * Reconciliação pura: dado o estado atual da entry e o retorno da Graph API,
 * retorna a entry atualizada. Testável sem network.
 */
export function reconcilePost(
  entry: PostEntry,
  graph: GraphPostResponse,
  now: Date,
): PostEntry {
  if (graph.error) {
    return {
      ...entry,
      status: "failed",
      failure_reason: graph.error.message,
    };
  }

  const scheduledUnix = graph.scheduled_publish_time;
  const nowUnix = Math.floor(now.getTime() / 1000);

  if (typeof scheduledUnix === "number" && scheduledUnix > nowUnix) {
    // Ainda no futuro — mantém scheduled
    return entry;
  }

  if (graph.is_published === true) {
    return {
      ...entry,
      status: "published",
      url: graph.permalink_url ?? entry.url,
      published_at: graph.created_time ?? undefined,
    };
  }

  // scheduled_publish_time passou e is_published !== true → falha silenciosa
  return {
    ...entry,
    status: "failed",
    failure_reason: `scheduled_publish_time passou mas is_published=${graph.is_published ?? "null"}`,
  };
}

export async function verifyPublished(
  published: SocialPublished,
  pageToken: string,
  apiVersion: string,
  fetchPost: FetchPostFn = defaultFetchPost,
  now: Date = new Date(),
): Promise<{ updated: SocialPublished; changes: number }> {
  const updatedPosts: PostEntry[] = [];
  let changes = 0;

  for (const entry of published.posts) {
    if (entry.platform !== "facebook" || entry.status !== "scheduled" || !entry.fb_post_id) {
      updatedPosts.push(entry);
      continue;
    }
    try {
      const graph = await fetchPost(entry.fb_post_id, pageToken, apiVersion);
      const next = reconcilePost(entry, graph, now);
      if (next.status !== entry.status) changes++;
      updatedPosts.push(next);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      updatedPosts.push({ ...entry, status: "failed", failure_reason: `graph_api_error: ${message}` });
      changes++;
    }
  }

  return { updated: { ...published, posts: updatedPosts }, changes };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  if (!editionDir) {
    console.error("Uso: verify-facebook-posts.ts --edition-dir <path>");
    process.exit(1);
  }

  const publishedPath = resolve(ROOT, editionDir, "06-social-published.json");
  if (!existsSync(publishedPath)) {
    console.error(`Arquivo não encontrado: ${publishedPath}`);
    process.exit(1);
  }

  const credsPath = resolve(ROOT, "data/.fb-credentials.json");
  if (!existsSync(credsPath)) {
    console.error(`Credenciais não encontradas: ${credsPath}`);
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(credsPath, "utf8")) as {
    page_access_token: string;
    api_version: string;
  };
  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as SocialPublished;

  const { updated, changes } = await verifyPublished(
    published,
    creds.page_access_token,
    creds.api_version,
  );

  if (changes > 0) {
    writeFileSync(publishedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    console.log(`✓ ${changes} post(s) atualizados em ${publishedPath}`);
  } else {
    console.log("Nenhuma mudança de status detectada.");
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
