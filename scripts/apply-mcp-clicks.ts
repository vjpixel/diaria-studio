/**
 * apply-mcp-clicks.ts (#1357 followup)
 *
 * Aplica per-link click data buscada via MCP `list_post_clicks` no cache local
 * de um post Beehiiv (`data/beehiiv-cache/posts/{post_id}.json`). Mapeia o
 * shape moderno da MCP pro shape que `build-link-ctr.ts` espera.
 *
 * Por que existe: o endpoint REST `/posts/{id}/clicks` foi removido da API
 * pública do Beehiiv. A única forma de obter per-link clicks hoje é via
 * MCP — que só é chamável do top-level Claude (não de scripts ou subagents).
 * Por isso o orchestrator top-level coleta clicks via MCP e pipa pra este
 * script, que persiste no cache.
 *
 * Field mapping (MCP shape → build-link-ctr legacy shape):
 *   email.total_clicked            → email.verified_clicks
 *   email.total_unique_clicked     → email.unique_clicks
 *   email.total_clicked_verified   → email.verified_clicks (sobrepõe quando existe)
 *   email.total_unique_clicked_verified → email.unique_verified_clicks
 *   email.click_rate / click_rate_verified passados adiante sem mapping
 *   url, url_hash, web ficam intactos
 *
 * Uso (do orchestrator top-level):
 *   echo '{"clicks":[...]}' | npx tsx scripts/apply-mcp-clicks.ts \
 *     --post-id post_<uuid>
 *
 *   # Append vs replace: default é REPLACE (limpa stats.clicks e escreve o
 *   # array novo). Use --append quando paginar e enviar pedaços:
 *   echo '{"clicks":[page1]}' | npx tsx scripts/apply-mcp-clicks.ts --post-id X
 *   echo '{"clicks":[page2]}' | npx tsx scripts/apply-mcp-clicks.ts --post-id X --append
 *
 * Stdin JSON shape (tolerante — aceita tanto o response inteiro da MCP quanto
 * só o array de clicks):
 *   { "clicks": [...] }     — wrapper shape (resposta direta da MCP)
 *   { "data": [...] }       — alternativo
 *   [...]                   — array nu
 *
 * Output (stdout): JSON `{ post_id, before_count, after_count, mapped }`.
 * Stderr: warnings.
 *
 * Exit codes: 0=sucesso, 1=erro IO/parse, 2=args inválidos.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");

/** MCP retorna este shape pra cada click record. */
export interface McpClick {
  url: string;
  url_hash?: string;
  email?: {
    total_clicked?: number;
    total_unique_clicked?: number;
    click_rate?: number;
    total_clicked_verified?: number;
    total_unique_clicked_verified?: number;
    click_rate_verified?: number;
  };
  web?: {
    total_clicked?: number;
    total_unique_clicked?: number;
  };
}

/** Shape que `build-link-ctr.ts` lê (campos legacy). */
export interface LegacyClick {
  url: string;
  url_hash?: string;
  email: {
    verified_clicks: number;
    unique_verified_clicks: number;
    unique_clicks: number;
    click_rate?: number;
    click_rate_verified?: number;
  };
  web?: {
    total_clicked?: number;
    total_unique_clicked?: number;
  };
}

/**
 * Mapeia 1 click record da shape MCP pra legacy. Pure function.
 *
 * Estratégia: prefere campos `_verified` quando existem (mais confiáveis —
 * filtram bots), cai pros campos não-verificados como fallback. `unique_clicks`
 * mapeia do `total_unique_clicked` (sem qualifier verified, é o agregado).
 */
export function mapClick(c: McpClick): LegacyClick {
  const email = c.email ?? {};
  return {
    url: c.url,
    url_hash: c.url_hash,
    email: {
      verified_clicks: email.total_clicked_verified ?? email.total_clicked ?? 0,
      unique_verified_clicks: email.total_unique_clicked_verified ?? email.total_unique_clicked ?? 0,
      unique_clicks: email.total_unique_clicked ?? 0,
      click_rate: email.click_rate,
      click_rate_verified: email.click_rate_verified,
    },
    web: c.web,
  };
}

/** Extrai array de clicks de qualquer formato suportado de input. */
export function extractClicksArray(raw: unknown): McpClick[] {
  if (Array.isArray(raw)) return raw as McpClick[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.clicks)) return obj.clicks as McpClick[];
    if (Array.isArray(obj.data)) return obj.data as McpClick[];
  }
  return [];
}

export interface ApplyOpts {
  postId: string;
  append: boolean;
  /** Override paths para testes. */
  postsDir?: string;
}

export interface ApplyResult {
  post_id: string;
  before_count: number;
  after_count: number;
  mapped: number;
  appended: boolean;
}

export function applyClicks(stdinJson: string, opts: ApplyOpts): ApplyResult {
  const postsDir = opts.postsDir ?? POSTS_DIR;
  const cachePath = resolve(postsDir, `${opts.postId}.json`);
  if (!existsSync(cachePath)) {
    throw new Error(`cache miss for ${opts.postId} — run beehiiv-sync.ts first to populate post metadata`);
  }

  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
    stats?: { clicks?: unknown[]; [k: string]: unknown };
    [k: string]: unknown;
  };

  const raw = JSON.parse(stdinJson) as unknown;
  const incoming = extractClicksArray(raw);
  const mapped = incoming.map(mapClick);

  const existing = (cache.stats?.clicks ?? []) as LegacyClick[];
  const beforeCount = existing.length;

  let finalClicks: LegacyClick[];
  if (opts.append) {
    // Append + dedup por url
    const seen = new Map<string, LegacyClick>();
    for (const c of existing) seen.set(c.url, c);
    for (const c of mapped) seen.set(c.url, c); // incoming wins se mesma url
    finalClicks = [...seen.values()];
  } else {
    finalClicks = mapped;
  }

  cache.stats = { ...(cache.stats ?? {}), clicks: finalClicks };

  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, cachePath);

  return {
    post_id: opts.postId,
    before_count: beforeCount,
    after_count: finalClicks.length,
    mapped: mapped.length,
    appended: opts.append,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolveP(data));
    process.stdin.on("error", rejectP);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const postIdIdx = argv.indexOf("--post-id");
  if (postIdIdx === -1 || !argv[postIdIdx + 1]) {
    console.error("uso: apply-mcp-clicks.ts --post-id post_<uuid> [--append]  (JSON via stdin)");
    process.exit(2);
  }
  const opts: ApplyOpts = {
    postId: argv[postIdIdx + 1],
    append: argv.includes("--append"),
  };

  const stdinJson = await readStdin();
  if (!stdinJson.trim()) {
    console.error("stdin vazio — espera JSON da MCP list_post_clicks");
    process.exit(2);
  }

  try {
    const result = applyClicks(stdinJson, opts);
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
