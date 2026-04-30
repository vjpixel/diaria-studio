/**
 * fetch-monthly-posts.ts (#403)
 *
 * Substitui o subagente `collect-monthly-runner` por script determinístico
 * que usa a API REST do Beehiiv diretamente. Elimina dependência de MCP em
 * subagente (MCPs nativos do Claude.ai não são repassados a subagentes).
 *
 * Busca todos os posts publicados no mês YYMM e grava o markdown bruto em
 * `data/monthly/{YYMM}/raw-posts/post_{id8}_{AAMMDD}.txt`.
 *
 * Uso:
 *   npx tsx scripts/fetch-monthly-posts.ts 2604
 *
 * Variáveis de ambiente (dotenv carregado automaticamente):
 *   BEEHIIV_API_KEY — obrigatório
 *
 * Output (stdout): JSON { yymm, posts_found, downloaded, skipped_existing,
 *                         posts_with_html_fallback, out_dir, warnings }
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEEHIIV_API = "https://api.beehiiv.com/v2";

interface BeehiivPost {
  id: string;
  title?: string;
  web_url?: string;
  publish_date: number; // Unix timestamp (seconds) — Beehiiv usa "publish_date", não "published_at"
}

interface BeehiivListResponse {
  data: BeehiivPost[];
  total_results?: number;
  total_pages?: number;
  page?: number;
}

interface BeehiivPostDetail {
  content?: {
    free?: {
      web?: string;   // HTML versão web
      email?: string; // HTML versão email (REST API não tem markdown)
    };
  };
}

interface BeehiivPostResponse {
  data: BeehiivPostDetail;
}

async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function yyymmToWindow(yymm: string): { start: Date; end: Date } {
  const year = 2000 + parseInt(yymm.slice(0, 2), 10);
  const month = parseInt(yymm.slice(2, 4), 10);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)), // exclusive
  };
}

function toAammdd(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return (
    String(d.getUTCFullYear()).slice(2) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

function id8(postId: string): string {
  return postId.replace(/^post_/, "").slice(0, 8);
}

async function fetchPostsForMonth(
  pubId: string,
  apiKey: string,
  win: { start: Date; end: Date },
): Promise<BeehiivPost[]> {
  const collected: BeehiivPost[] = [];
  let page = 1;

  while (true) {
    // Sem filtro de status: Beehiiv usa "confirmed" para posts publicados,
    // não "published" como seria de esperar. Filtrar client-side pela janela
    // de datas é suficiente para excluir rascunhos (publish_date = 0 ou nulo).
    const params = new URLSearchParams({
      per_page: "50",
      order_by: "newest_first",
      page: String(page),
    });
    const data = await apiFetch<BeehiivListResponse>(
      `/publications/${pubId}/posts?${params}`,
      apiKey,
    );
    const posts = data.data ?? [];
    if (posts.length === 0) break;

    let anyInWindow = false;
    let allBefore = true;

    for (const p of posts) {
      const ms = p.publish_date * 1000;
      if (ms >= win.start.getTime() && ms < win.end.getTime()) {
        collected.push(p);
        anyInWindow = true;
        allBefore = false;
      } else if (ms >= win.end.getTime()) {
        allBefore = false;
      }
    }

    if (!anyInWindow && allBefore) break; // all posts are before our window
    if (data.total_pages && page >= data.total_pages) break;
    page++;
  }

  return collected;
}

async function fetchContent(
  postId: string,
  pubId: string,
  apiKey: string,
): Promise<{ markdown?: string; html?: string }> {
  const params = new URLSearchParams();
  params.append("expand[]", "free_web_content");
  params.append("expand[]", "free_email_content");
  const res = await apiFetch<BeehiivPostResponse>(
    `/publications/${pubId}/posts/${postId}?${params}`,
    apiKey,
  );
  // REST API retorna apenas HTML — sem endpoint markdown na Beehiiv API v2.
  // free.email (HTML email) é preferido por ser mais próximo do formato
  // que o MCP retorna; free.web como fallback.
  const html = res.data?.content?.free?.email || res.data?.content?.free?.web || undefined;
  return { markdown: undefined, html };
}

async function main() {
  const yymm = process.argv[2];
  if (!yymm || !/^\d{4}$/.test(yymm)) {
    console.error("Uso: npx tsx scripts/fetch-monthly-posts.ts YYMM");
    console.error("  Ex: npx tsx scripts/fetch-monthly-posts.ts 2604");
    process.exit(2);
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    console.error("BEEHIIV_API_KEY não definida. Configure no .env.");
    process.exit(1);
  }

  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const pubId: string = process.env.BEEHIIV_PUBLICATION_ID ?? cfg.beehiiv?.publicationId;
  if (!pubId) {
    console.error("publicationId não encontrado em platform.config.json ou BEEHIIV_PUBLICATION_ID.");
    process.exit(1);
  }

  const win = yyymmToWindow(yymm);
  const outDir = resolve(ROOT, `data/monthly/${yymm}/raw-posts`);
  mkdirSync(outDir, { recursive: true });

  process.stderr.write(
    `[fetch-monthly-posts] ${yymm}: ${win.start.toISOString().slice(0, 10)} → ${win.end.toISOString().slice(0, 10)}\n`,
  );

  const posts = await fetchPostsForMonth(pubId, apiKey, win);
  process.stderr.write(`[fetch-monthly-posts] ${posts.length} posts no mês\n`);

  const warnings: string[] = [];
  let downloaded = 0;
  let skipped = 0;
  let htmlFallback = 0;

  for (const post of posts) {
    const filename = `post_${id8(post.id)}_${toAammdd(post.publish_date)}.txt`;
    const filepath = resolve(outDir, filename);

    if (existsSync(filepath)) {
      skipped++;
      continue;
    }

    process.stderr.write(`  ↓ ${filename}\n`);
    const content = await fetchContent(post.id, pubId, apiKey);

    let text: string;
    if (content.markdown) {
      text = content.markdown;
    } else if (content.html) {
      text = content.html;
      htmlFallback++;
      warnings.push(`${filename}: markdown ausente — gravado HTML (parser pode falhar)`);
    } else {
      warnings.push(`${filename}: sem conteúdo — pulado`);
      continue;
    }

    writeFileSync(filepath, text, "utf8");
    downloaded++;
  }

  if (posts.length === 0) {
    warnings.push("Nenhum post encontrado no mês — verificar publicationId e BEEHIIV_API_KEY.");
  }

  console.log(
    JSON.stringify({
      yymm,
      posts_found: posts.length,
      downloaded,
      skipped_existing: skipped,
      posts_with_html_fallback: htmlFallback,
      out_dir: `data/monthly/${yymm}/raw-posts/`,
      warnings,
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
