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
 * GUARD (#4836): modo REPLACE (default, sem `--append`) recusa sobrescrever
 * um `stats.clicks` NÃO-VAZIO com um array vazio, a menos que
 * `--allow-empty-replace` seja passado explicitamente. Incidente que motivou:
 * em 2026-08-05, entre 18:19:29 e 18:19:53, 22 posts tiveram `stats.clicks`
 * apagado (`[]`) por uma invocação REPLACE deste script enquanto
 * `stats.email.unique_verified_clicks` seguia entre 6 e 28 — 109 cliques
 * perdidos, sem sinal de erro (write atômico via tmp+rename "funcionou",
 * só que com o array errado). Um MCP `list_post_clicks` que responde vazio
 * (rede, rate limit, resposta malformada da paginação) é justamente esse
 * caso: sucesso aparente, payload vazio, e sem o guard o REPLACE apaga dado
 * bom silenciosamente. Post genuinamente sem cliques nunca teve linhas pra
 * começo de conversa (`existing.length === 0`) — não aciona o guard.
 *
 * `enrichment_state` (#4836 item 3): toda chamada bem-sucedida também grava
 * `stats.enrichment_state` — `enriched_n` se `finalClicks.length > 0`,
 * `enriched_zero` caso contrário. Distingue "tentei e confirmei zero" (dado
 * confiável) de "nunca tentei" (`never_enriched`, default de
 * `beehiiv-sync.ts` pra post sem cache anterior) — ver
 * `scripts/lib/shared/enrichment-state.ts`.
 *
 * Output (stdout): JSON `{ post_id, before_count, after_count, mapped, enrichment_state }`.
 * Stderr: warnings.
 *
 * Exit codes: 0=sucesso, 1=erro IO/parse, 2=args inválidos, 3=guard —
 * replace apagaria stats.clicks não-vazio sem --allow-empty-replace.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import type { EnrichmentState } from "./lib/shared/enrichment-state.ts";

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

/** Flag de override do guard de replace-vazio. Fonte única — CLI e testes referenciam esta constante. */
export const ALLOW_EMPTY_REPLACE_FLAG = "--allow-empty-replace";

/** Erro do guard REPLACE-vazio (#4836) — distinto de erro de IO/parse pra permitir exit code próprio. */
export class EmptyReplaceGuardError extends Error {
  constructor(postId: string, lostCount: number) {
    super(
      `guard: REPLACE apagaria ${lostCount} click(s) existente(s) de ${postId} ` +
        `(stats.clicks não-vazio → payload vazio). Se isso é esperado (ex: MCP confirmou ` +
        `0 cliques reais pro post), rode de novo com ${ALLOW_EMPTY_REPLACE_FLAG}.`,
    );
    this.name = "EmptyReplaceGuardError";
  }
}

export interface ApplyOpts {
  postId: string;
  append: boolean;
  /** Override do guard REPLACE-vazio (#4836) — default false, recusa por padrão. */
  allowEmptyReplace?: boolean;
  /** Override paths para testes. */
  postsDir?: string;
}

export interface ApplyResult {
  post_id: string;
  before_count: number;
  after_count: number;
  mapped: number;
  appended: boolean;
  /** #4836 item 3 — estado gravado em `stats.enrichment_state` após este apply. */
  enrichment_state: EnrichmentState;
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
    // Guard (#4836): REPLACE nunca apaga um array não-vazio silenciosamente.
    if (beforeCount > 0 && mapped.length === 0 && !opts.allowEmptyReplace) {
      throw new EmptyReplaceGuardError(opts.postId, beforeCount);
    }
    finalClicks = mapped;
  }

  // #4836 item 3: toda invocação deste script é uma tentativa REAL de
  // enrichment via MCP — o campo é sempre recalculado a partir do array
  // final, nunca herdado do que já estava no cache (diferente de
  // `beehiiv-sync.ts`, que só PRESERVA o estado anterior porque não busca
  // clicks). `enriched_zero` é tão válido quanto `enriched_n`: os dois
  // representam um resultado CONFIRMADO, distinto de `never_enriched`.
  const enrichmentState: EnrichmentState = finalClicks.length > 0 ? "enriched_n" : "enriched_zero";
  cache.stats = { ...(cache.stats ?? {}), clicks: finalClicks, enrichment_state: enrichmentState };

  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, cachePath);

  return {
    post_id: opts.postId,
    before_count: beforeCount,
    after_count: finalClicks.length,
    mapped: mapped.length,
    appended: opts.append,
    enrichment_state: enrichmentState,
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
    allowEmptyReplace: argv.includes(ALLOW_EMPTY_REPLACE_FLAG),
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
    process.exit(e instanceof EmptyReplaceGuardError ? 3 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
