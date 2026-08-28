/**
 * apply-mcp-kit-clicks.ts (#6186)
 *
 * Aplica per-link click data buscada via MCP `get_link_clicks_for_a_broadcast`
 * (Kit) no cache local `data/kit-cache/posts/kit_{id8}.json`. Análogo ao
 * `apply-mcp-clicks.ts` (Beehiiv), mas mais simples: o shape do Kit já vem
 * com `unique_clicks` direto por URL (sem split email/web, sem campos
 * `_verified` separados), confirmado ao vivo em 260828 contra o broadcast
 * 25654292 (produção). Ver `.claude/agents/kit-clicks-enricher.md`.
 *
 * Por que existe: `mcp__kit__get_link_clicks_for_a_broadcast` é chamável do
 * top-level (diferente do endpoint removido da Beehiiv), mas o volume de
 * broadcasts do mês inteiro ainda justifica um cache local — o mesmo
 * `monthly-click-sections.ts` que já lê `data/beehiiv-cache/posts/` pra
 * editições Beehiiv passa a ler `data/kit-cache/posts/` pra editições Kit,
 * sem re-fetchar a MCP a cada rodada do digest mensal.
 *
 * Diferença estrutural do `apply-mcp-clicks.ts`: não há um `kit-sync.ts`
 * prévio que cria o arquivo de cache com metadata do post antes dos clicks
 * chegarem (a raw-posts/*.txt do fetch-monthly-posts.ts já cobre o texto).
 * Por isso este script CRIA o arquivo de cache se ainda não existir, em vez
 * de exigir cache-miss como erro.
 *
 * `id8`: mesmo prefixo usado no nome do arquivo raw-posts
 * (`post_{id8}_{AAMMDD}.txt`, ver `fetch-monthly-posts.ts`). Broadcast IDs do
 * Kit são inteiros sequenciais — hoje com 8 dígitos, então `id8` é o próprio
 * ID completo (sem truncamento com perda, diferente do prefixo de 8 hex de
 * um UUID Beehiiv). Se o ID do Kit crescer além de 8 dígitos no futuro, isso
 * é uma limitação pré-existente de `id8()` em `fetch-monthly-posts.ts`, fora
 * do escopo deste script.
 *
 * Uso (do orchestrator top-level, ou do agent `kit-clicks-enricher`):
 *   echo '{"clicks":[...]}' | npx tsx scripts/apply-mcp-kit-clicks.ts --id8 25654292
 *
 *   # Append vs replace: default é REPLACE. --append funde por url (incoming
 *   # vence em empate), mesmo padrão do apply-mcp-clicks.ts.
 *
 * Stdin JSON shape (tolerante — aceita o envelope inteiro da MCP ou só o array):
 *   { "broadcast": { "clicks": [...] } }   — envelope direto da MCP
 *   { "clicks": [...] }                     — sem envelope de broadcast
 *   [...]                                    — array nu
 *
 * GUARD (#4836, mesmo padrão do apply-mcp-clicks.ts): modo REPLACE (default)
 * recusa sobrescrever um `stats.clicks` NÃO-VAZIO com array vazio, a menos
 * que `--allow-empty-replace` seja passado explicitamente.
 *
 * Output (stdout): JSON `{ id8, before_count, after_count, mapped, enrichment_state }`.
 * Stderr: warnings.
 *
 * Exit codes: 0=sucesso, 1=erro IO/parse, 2=args inválidos, 3=guard —
 * replace apagaria stats.clicks não-vazio sem --allow-empty-replace.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import type { EnrichmentState } from "./lib/shared/enrichment-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/kit-cache/posts");

/** MCP `get_link_clicks_for_a_broadcast` retorna este shape por click record
 * (confirmado ao vivo, 260828, broadcast 25654292 real). */
export interface McpKitClick {
  id?: number;
  url: string;
  unique_clicks?: number;
  click_to_delivery_rate?: number;
  click_to_open_rate?: number;
}

/** Shape persistido no cache — mesmos campos, `unique_clicks` sempre presente
 * (default 0) pra `monthly-click-sections.ts` não precisar tratar ausência. */
export interface LegacyKitClick {
  url: string;
  unique_clicks: number;
  click_to_delivery_rate?: number;
  click_to_open_rate?: number;
}

/** Mapeia 1 click record da shape MCP pra legacy. Pure function. */
export function mapKitClick(c: McpKitClick): LegacyKitClick {
  return {
    url: c.url,
    unique_clicks: c.unique_clicks ?? 0,
    click_to_delivery_rate: c.click_to_delivery_rate,
    click_to_open_rate: c.click_to_open_rate,
  };
}

/** Extrai array de clicks de qualquer formato suportado de input. */
export function extractKitClicksArray(raw: unknown): McpKitClick[] {
  if (Array.isArray(raw)) return raw as McpKitClick[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.broadcast && typeof obj.broadcast === "object") {
      const b = obj.broadcast as Record<string, unknown>;
      if (Array.isArray(b.clicks)) return b.clicks as McpKitClick[];
    }
    if (Array.isArray(obj.clicks)) return obj.clicks as McpKitClick[];
    if (Array.isArray(obj.data)) return obj.data as McpKitClick[];
  }
  return [];
}

/** Um raw shape "legitimamente vazio" — array nu vazio, ou um dos 3
 * envelopes reconhecidos com `clicks: []` explícito. Usado só pra decidir
 * se vale avisar em stderr quando `extractKitClicksArray` devolveu []
 * (ver #6642 review, silent-failure-hunter) — distingue "MCP confirmou 0
 * cliques" de "shape não reconhecido, [] por omissão". */
export function isRecognizedEmptyKitShape(raw: unknown): boolean {
  if (Array.isArray(raw)) return true; // array nu, vazio ou não — sempre reconhecido
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.broadcast && typeof obj.broadcast === "object") {
      const b = obj.broadcast as Record<string, unknown>;
      if (Array.isArray(b.clicks)) return true;
    }
    if (Array.isArray(obj.clicks)) return true;
    if (Array.isArray(obj.data)) return true;
  }
  return false;
}

/** Flag de override do guard de replace-vazio. Fonte única — CLI e testes referenciam esta constante. */
export const ALLOW_EMPTY_REPLACE_FLAG = "--allow-empty-replace";

/** Erro do guard REPLACE-vazio (#4836) — distinto de erro de IO/parse pra permitir exit code próprio. */
export class EmptyReplaceGuardError extends Error {
  constructor(id8: string, lostCount: number) {
    super(
      `guard: REPLACE apagaria ${lostCount} click(s) existente(s) de kit_${id8} ` +
        `(stats.clicks não-vazio → payload vazio). Se isso é esperado (ex: MCP confirmou ` +
        `0 cliques reais pro broadcast), rode de novo com ${ALLOW_EMPTY_REPLACE_FLAG}.`,
    );
    this.name = "EmptyReplaceGuardError";
  }
}

export interface ApplyKitOpts {
  id8: string;
  append: boolean;
  /** Override do guard REPLACE-vazio — default false, recusa por padrão. */
  allowEmptyReplace?: boolean;
  /** Override de path para testes. */
  postsDir?: string;
}

export interface ApplyKitResult {
  id8: string;
  before_count: number;
  after_count: number;
  mapped: number;
  appended: boolean;
  /** #4836 (portado do lado Beehiiv) — distingue `enriched_zero` (tentativa
   * real confirmou 0 cliques) de `never_enriched` (nunca tentou), pra
   * consumidores futuros de médias/CTR sobre o cache Kit não confundirem
   * ausência de tentativa com resultado zero genuíno. */
  enrichment_state: EnrichmentState;
}

/** `id8` vira segmento de nome de arquivo sem sanitização — validar que é
 * só dígitos (formato real dos broadcast IDs do Kit, ver docstring do
 * módulo) evita que um valor tipo `../../etc` escreva fora de `postsDir`
 * (#6642 review — o script cria o arquivo do zero, diferente do
 * apply-mcp-clicks.ts, que exige cache pré-existente; sem essa validação a
 * superfície de risco de um id8 malformado é maior aqui). */
export function isValidId8(id8: string): boolean {
  return /^\d+$/.test(id8);
}

export function applyKitClicks(stdinJson: string, opts: ApplyKitOpts): ApplyKitResult {
  if (!isValidId8(opts.id8)) {
    throw new Error(`--id8 inválido (esperado só dígitos, formato do broadcast ID do Kit): ${JSON.stringify(opts.id8)}`);
  }
  const postsDir = opts.postsDir ?? POSTS_DIR;
  const cachePath = resolve(postsDir, `kit_${opts.id8}.json`);

  // Diferente do apply-mcp-clicks.ts: não há sync prévio que crie o cache
  // com metadata — cache ausente é o caso NORMAL na 1ª invocação pra um
  // broadcast, não um erro.
  const cache: { stats?: { clicks?: unknown[]; [k: string]: unknown }; [k: string]: unknown } =
    existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

  const raw = JSON.parse(stdinJson) as unknown;
  const incoming = extractKitClicksArray(raw);
  // #6642 review (silent-failure-hunter): extractKitClicksArray retorna []
  // pra QUALQUER shape não reconhecido, indistinguível de "MCP confirmou 0
  // cliques reais" — sem log, um erro de shape (campo renomeado, resposta
  // parcial da API disfarçada de objeto) fica permanentemente registrado
  // como "0 cliques verificados". Aviso barato em stderr quando o array
  // veio vazio E o raw não era um envelope reconhecidamente-vazio (ex.:
  // `{"clicks":[]}` é legítimo; `{"error":"..."}` ou `{}` não é).
  if (incoming.length === 0 && !isRecognizedEmptyKitShape(raw)) {
    console.error(
      `[apply-mcp-kit-clicks] aviso: shape não reconhecido pra kit_${opts.id8}, tratando como 0 clicks: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  const mapped = incoming.map(mapKitClick);

  const existing = (cache.stats?.clicks ?? []) as LegacyKitClick[];
  const beforeCount = existing.length;

  let finalClicks: LegacyKitClick[];
  if (opts.append) {
    const seen = new Map<string, LegacyKitClick>();
    for (const c of existing) seen.set(c.url, c);
    for (const c of mapped) seen.set(c.url, c); // incoming vence em empate
    finalClicks = [...seen.values()];
  } else {
    if (beforeCount > 0 && mapped.length === 0 && !opts.allowEmptyReplace) {
      throw new EmptyReplaceGuardError(opts.id8, beforeCount);
    }
    finalClicks = mapped;
  }

  // #4836 (mesmo raciocínio do apply-mcp-clicks.ts): toda invocação é uma
  // tentativa REAL via MCP — o campo é sempre recalculado a partir do array
  // final, nunca herdado do que já estava no cache.
  const enrichmentState: EnrichmentState = finalClicks.length > 0 ? "enriched_n" : "enriched_zero";
  cache.id8 = opts.id8;
  cache.stats = { ...(cache.stats ?? {}), clicks: finalClicks, enrichment_state: enrichmentState };

  mkdirSync(postsDir, { recursive: true });
  const tmp = `${cachePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, cachePath);

  return {
    id8: opts.id8,
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
  const id8Idx = argv.indexOf("--id8");
  if (id8Idx === -1 || !argv[id8Idx + 1]) {
    console.error("uso: apply-mcp-kit-clicks.ts --id8 <broadcast_id8> [--append]  (JSON via stdin)");
    process.exit(2);
  }
  const opts: ApplyKitOpts = {
    id8: argv[id8Idx + 1],
    append: argv.includes("--append"),
    allowEmptyReplace: argv.includes(ALLOW_EMPTY_REPLACE_FLAG),
  };

  const stdinJson = await readStdin();
  if (!stdinJson.trim()) {
    console.error("stdin vazio — espera JSON da MCP get_link_clicks_for_a_broadcast");
    process.exit(2);
  }

  try {
    const result = applyKitClicks(stdinJson, opts);
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
