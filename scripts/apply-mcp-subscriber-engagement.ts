/**
 * apply-mcp-subscriber-engagement.ts (#6465, fatia 1 do epic #6464)
 *
 * Aplica per-subscriber engagement data buscada via MCP
 * `list_post_subscriber_engagement` (e, se o invocador também paginar
 * `list_post_click_subscribers`, essa identidade por clique) num JSONL
 * append-only por post: `data/beehiiv-backup/subscriber-engagement/{post_id}.jsonl`.
 *
 * Por que existe: o cruzamento assinante × edição (quem abriu/clicou em QUAL
 * post, quando) só existe via essas 2 tools MCP — a API REST pública do
 * Beehiiv não expõe isso (mesmo gap documentado em `MCP_ONLY_GAPS` de
 * `scripts/backup-beehiiv.ts`). MCPs só são chamáveis de dentro de uma
 * sessão Claude (top-level ou subagent com a tool no escopo) — nunca de
 * scripts TS standalone. O agent `beehiiv-engagement-backup` (molde:
 * `.claude/agents/beehiiv-clicks-enricher.md`) faz o fetch paginado e pipa
 * o resultado acumulado pra este script, que persiste em disco.
 *
 * Formato do JSONL: 1 linha = 1 registro CRU retornado pela MCP (sem
 * reshape de campos — ao contrário de `apply-mcp-clicks.ts`, que remapeia
 * pro shape legado de `build-link-ctr.ts`, aqui a prioridade é preservar
 * fidelidade do dado antes que o acesso à API acabe; qualquer modelagem
 * fica pro epic #6464, fora de escopo desta fatia).
 *
 * Uso (do agent `beehiiv-engagement-backup`):
 *   echo '{"engagement":[...]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts \
 *     --post-id post_<uuid> [--title "..."] \
 *     [--pages-fetched 3 --total-pages 3] [--allow-empty-replace] \
 *     [--out-dir data/beehiiv-backup/subscriber-engagement]
 *
 *   # Append vs replace: default é REPLACE (reescreve o `.jsonl` inteiro a
 *   # partir do array completo). Use --append (#6733) pra aplicar página a
 *   # página IMEDIATAMENTE após cada fetch MCP, sem exigir acumular/
 *   # retranscrever manualmente múltiplas páginas antes de aplicar nenhuma —
 *   # esse acúmulo manual já perdeu 1 registro de 100 numa transcrição real:
 *   echo '{"engagement":[page1]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts --post-id X --pages-fetched 1 --total-pages 3
 *   echo '{"engagement":[page2]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts --post-id X --pages-fetched 2 --total-pages 3 --append
 *   echo '{"engagement":[page3]}' | npx tsx scripts/apply-mcp-subscriber-engagement.ts --post-id X --pages-fetched 3 --total-pages 3 --append
 *
 * Stdin JSON (tolerante — mesmo padrão de `apply-mcp-clicks.ts`):
 *   { "engagement": [...] }   — wrapper shape (resposta direta da MCP)
 *   { "data": [...] }         — alternativo
 *   [...]                     — array nu
 *
 * Modo padrão é REPLACE (reescreve o `.jsonl` inteiro a partir do array
 * completo que o invocador passou). `--append` (#6733) mescla o payload
 * novo com o que já está em disco, deduplicando por `subscriber_id`
 * (registro incoming vence em caso de conflito — mesma convenção do dedup
 * por `url` de `apply-mcp-clicks.ts`); registro sem `subscriber_id` nunca é
 * deduplicado contra outro (cada um é tratado como único, via chave
 * sintética) — degrada pra "nunca perde dado", nunca pra "colapsa dado
 * potencialmente distinto". `--append` existe porque, diferente de
 * `list_post_clicks` (que o enricher já pagina e junta em `allClicks` antes
 * de aplicar), a paginação de `list_post_subscriber_engagement` tende a ter
 * mais páginas — forçar o agent a acumular/retranscrever manualmente todas
 * antes do primeiro apply é o que causou a perda de registro que motivou
 * este flag.
 *
 * GUARD (mesmo padrão de #4836 em `apply-mcp-clicks.ts`): em modo REPLACE
 * (sem `--append`), nunca apaga um JSONL não-vazio com um payload vazio sem
 * `--allow-empty-replace` explícito — um MCP que responde vazio por
 * rate-limit/timeout/paginação malformada não pode silenciosamente destruir
 * engagement já confirmado. Em modo `--append`, o guard não se aplica —
 * aplicar uma página vazia nunca apaga o que já está em disco (é sempre uma
 * união, nunca uma substituição), então não há dado pra perder.
 *
 * Efeito colateral (sempre, mesmo em erro): grava/atualiza
 * `{out-dir}/manifest.json` via `scripts/lib/beehiiv-engagement-manifest.ts`
 * — status `ok` (todas as páginas confirmadas), `partial` (paginação
 * truncada — `pages_fetched < total_pages`), ou `error` (falha antes de
 * escrever). Isso é o que torna a extração retomável entre invocações do
 * agent: `list-posts-for-engagement-backup.ts` só reoferece posts que não
 * estão `ok`.
 *
 * Output (stdout): JSON `{ post_id, before_count, after_count, status }`.
 * Stderr: warnings.
 *
 * Exit codes: 0=sucesso, 1=erro IO/parse, 2=args inválidos, 3=guard —
 * replace apagaria JSONL não-vazio sem `--allow-empty-replace`.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  buildInitialManifest,
  upsertEntry,
  type EngagementManifest,
  type EngagementManifestEntry,
} from "./lib/beehiiv-engagement-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");

/** Flag de override do guard de replace-vazio — mesma convenção de `apply-mcp-clicks.ts`. */
export const ALLOW_EMPTY_REPLACE_FLAG = "--allow-empty-replace";

/** Erro do guard REPLACE-vazio — distinto de erro de IO/parse pra permitir exit code próprio (3). */
export class EmptyReplaceGuardError extends Error {
  constructor(postId: string, lostCount: number) {
    super(
      `guard: REPLACE apagaria ${lostCount} registro(s) existente(s) de ${postId} ` +
        `(JSONL não-vazio → payload vazio). Se isso é esperado (ex: MCP confirmou ` +
        `0 assinantes engajados de verdade pro post), rode de novo com ${ALLOW_EMPTY_REPLACE_FLAG}.`,
    );
    this.name = "EmptyReplaceGuardError";
  }
}

/** Extrai array de registros de qualquer formato suportado de input (mesma tolerância de `apply-mcp-clicks.ts`). */
export function extractEngagementArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.engagement)) return obj.engagement;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

/** Lê o nº de linhas não-vazias de um JSONL existente — 0 se o arquivo não existe. */
export function countExistingLines(path: string): number {
  if (!existsSync(path)) return 0;
  const content = readFileSync(path, "utf8");
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

/** Lê e faz parse das linhas não-vazias de um JSONL existente — [] se o arquivo não existe. */
export function readExistingRecords(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Mescla `existing` (já em disco) com `incoming` (payload desta chamada),
 * deduplicando por `subscriber_id` — incoming vence em caso de conflito
 * (mesma convenção do dedup por `url` em `apply-mcp-clicks.ts`). Registro
 * sem `subscriber_id` string nunca é deduplicado contra outro: cada um
 * recebe uma chave sintética própria (índice na lista concatenada), então
 * nunca colide com um registro de outra página que também careça do campo.
 */
export function mergeEngagementRecords(existing: unknown[], incoming: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  let syntheticIdx = 0;
  const put = (record: unknown) => {
    const subscriberId =
      record && typeof record === "object" && typeof (record as { subscriber_id?: unknown }).subscriber_id === "string"
        ? (record as { subscriber_id: string }).subscriber_id
        : undefined;
    const key = subscriberId ?? `__no_id_${syntheticIdx++}`;
    merged.set(key, record);
  };
  for (const r of existing) put(r);
  for (const r of incoming) put(r); // incoming wins se mesmo subscriber_id
  return [...merged.values()];
}

export interface ApplyEngagementOpts {
  postId: string;
  title?: string;
  pagesFetched?: number;
  totalPages?: number;
  allowEmptyReplace?: boolean;
  outDir?: string;
  /** Mescla com o JSONL existente (dedup por `subscriber_id`) em vez de sobrescrever (#6733). */
  append?: boolean;
}

export interface ApplyEngagementResult {
  post_id: string;
  before_count: number;
  after_count: number;
  status: "ok" | "partial";
}

/** Escreve `records` (JSON.stringify por linha) atomicamente via tmp+rename. */
function writeJsonlAtomic(path: string, records: unknown[]): void {
  const tmp = `${path}.tmp`;
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

function loadManifest(manifestPath: string): EngagementManifest {
  if (!existsSync(manifestPath)) return buildInitialManifest([], new Date().toISOString());
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as EngagementManifest;
  } catch {
    return buildInitialManifest([], new Date().toISOString());
  }
}

function saveManifestAtomic(manifestPath: string, manifest: EngagementManifest): void {
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

/**
 * Aplica o payload de engagement de 1 post. Lança em erro de IO/parse ou no
 * guard de replace-vazio; caller (main) traduz pra exit code apropriado.
 */
export function applyEngagement(stdinJson: string, opts: ApplyEngagementOpts): ApplyEngagementResult {
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const jsonlPath = resolve(outDir, `${opts.postId}.jsonl`);
  const manifestPath = resolve(outDir, "manifest.json");

  const beforeCount = countExistingLines(jsonlPath);
  const raw = JSON.parse(stdinJson) as unknown;
  const incoming = extractEngagementArray(raw);

  let records: unknown[];
  if (opts.append) {
    // Append (#6733): mescla com o que já está em disco — nunca apaga nada,
    // então o guard de replace-vazio abaixo não se aplica a este ramo.
    const existing = readExistingRecords(jsonlPath);
    records = mergeEngagementRecords(existing, incoming);
  } else {
    if (beforeCount > 0 && incoming.length === 0 && !opts.allowEmptyReplace) {
      // Guard dispara ANTES de tocar manifest ou disco — mesma ordem de
      // `apply-mcp-clicks.ts` (nunca grava estado parcial num caminho de erro).
      throw new EmptyReplaceGuardError(opts.postId, beforeCount);
    }
    records = incoming;
  }

  writeJsonlAtomic(jsonlPath, records);

  const pagesFetched = opts.pagesFetched;
  const totalPages = opts.totalPages;
  const status: "ok" | "partial" =
    pagesFetched != null && totalPages != null && pagesFetched < totalPages ? "partial" : "ok";

  const manifest = loadManifest(manifestPath);
  const entry: EngagementManifestEntry = {
    post_id: opts.postId,
    title: opts.title,
    status,
    count: records.length,
    pages_fetched: pagesFetched,
    total_pages: totalPages,
    fetched_at: new Date().toISOString(),
  };
  saveManifestAtomic(manifestPath, upsertEntry(manifest, entry));

  return { post_id: opts.postId, before_count: beforeCount, after_count: records.length, status };
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

function parseIntArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || !argv[idx + 1]) return undefined;
  const n = parseInt(argv[idx + 1], 10);
  return Number.isInteger(n) ? n : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const postIdIdx = argv.indexOf("--post-id");
  if (postIdIdx === -1 || !argv[postIdIdx + 1]) {
    console.error(
      "uso: apply-mcp-subscriber-engagement.ts --post-id post_<uuid> [--title T] " +
        "[--pages-fetched N --total-pages M] [--append] [--allow-empty-replace] [--out-dir DIR]  (JSON via stdin)",
    );
    process.exit(2);
  }
  const titleIdx = argv.indexOf("--title");
  const outDirIdx = argv.indexOf("--out-dir");

  const opts: ApplyEngagementOpts = {
    postId: argv[postIdIdx + 1],
    title: titleIdx !== -1 ? argv[titleIdx + 1] : undefined,
    pagesFetched: parseIntArg(argv, "--pages-fetched"),
    totalPages: parseIntArg(argv, "--total-pages"),
    allowEmptyReplace: argv.includes(ALLOW_EMPTY_REPLACE_FLAG),
    outDir: outDirIdx !== -1 ? resolve(argv[outDirIdx + 1]) : undefined,
    append: argv.includes("--append"),
  };

  const stdinJson = await readStdin();
  if (!stdinJson.trim()) {
    console.error("stdin vazio — espera JSON da MCP list_post_subscriber_engagement");
    process.exit(2);
  }

  try {
    const result = applyEngagement(stdinJson, opts);
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
