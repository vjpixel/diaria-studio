/**
 * apply-mcp-exit-history.ts (#7248)
 *
 * Aplica 1 página crua de `list_subscriptions` (MCP Beehiiv, filtrada por
 * `status: "inactive"`) num backup append-only:
 * `data/beehiiv-backup/exit-history/subscribers.jsonl` (registros JÁ
 * filtrados/normalizados — ver `parseExitHistoryPage` em
 * `scripts/lib/beehiiv-exit-history.ts`) + `manifest.json` (checkpoint de
 * paginação).
 *
 * Por que existe: `unsubscribed_on` (o timestamp REAL de saída) só existe
 * via MCP, chamável só de dentro de uma sessão Claude — nunca de scripts TS
 * standalone (mesma restrição de `apply-mcp-subscriber-engagement.ts`). O
 * agent `beehiiv-exit-history-drain` faz o fetch paginado e pipa cada
 * página pra este script, que persiste em disco.
 *
 * Diferente de `apply-mcp-subscriber-engagement.ts` (1 arquivo por post,
 * modo REPLACE-ou-append), este recurso é ÚNICO — sempre em modo mescla
 * (nunca REPLACE): cada página é uma fatia disjunta do MESMO filtro
 * (`status=inactive`), então não existe cenário de "página vazia apaga
 * histórico confirmado" — sem guard de replace-vazio, sem `--append` como
 * flag (é sempre o comportamento).
 *
 * Uso (do agent `beehiiv-exit-history-drain`):
 *   echo '<resposta CRUA da MCP list_subscriptions>' | \
 *     npx tsx scripts/apply-mcp-exit-history.ts [--out-dir data/beehiiv-backup/exit-history]
 *
 * Stdin JSON tolerante — aceita a resposta crua da MCP inteira
 * (`{pagination: {...}, subscriptions: [...]}`) ou variantes
 * (`{data: [...]}`, array nu). `pagination` é opcional — sem ela, o
 * manifest só sabe que "mais uma página foi aplicada", sem saber quantas
 * faltam (não impede a aplicação, só deixa `complete` como estava).
 *
 * Output (stdout): JSON com progresso + `next_page` (o que a próxima
 * chamada da MCP deve pedir).
 * Stderr: warnings.
 * Exit codes: 0=sucesso, 1=erro IO/parse, 2=args inválidos.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  parseExitHistoryPage,
  mergeExitHistoryRecords,
  buildInitialExitHistoryManifest,
  applyExitHistoryPageToManifest,
  nextExitHistoryPage,
  type BeehiivExitHistoryRawRecord,
  type BeehiivExitHistoryRecord,
  type ExitHistoryManifest,
  type ExitHistoryPageMeta,
} from "./lib/beehiiv-exit-history.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/exit-history");

/**
 * #7426 fleet review finding 1 (silent-failure-hunter, alta confiança):
 * antes desta classe, QUALQUER objeto sem `subscriptions`/`data` como array
 * colapsava silenciosamente pra `{rows: [], pagination: {}}` — incluindo um
 * corpo de erro da MCP (rate-limit 429, etc) encaminhado por engano pelo
 * agent via stdin. Isso mergiava 0 registros e saía com exit 0,
 * indistinguível de uma página genuinamente vazia — viola #738 (MCP
 * indisponível é fail-fast, nunca stall/esconder) e #573 (validar
 * deterministicamente, nunca confiar na narração do agente).
 */
export class UnrecognizedExitHistoryPayloadError extends Error {
  constructor(raw: unknown) {
    super(
      `payload não reconhecível como página de list_subscriptions — sem "subscriptions"/"data" como array nem "pagination" reconhecível ` +
        `(pode ser um corpo de erro da MCP, ex: rate-limit, encaminhado por engano). Shape recebido: ${previewPayloadShape(raw)}`,
    );
    this.name = "UnrecognizedExitHistoryPayloadError";
  }
}

/** Preview truncado (sem vazar dado sensível em excesso) do payload pro stderr. */
function previewPayloadShape(raw: unknown): string {
  try {
    const json = JSON.stringify(raw);
    if (json === undefined) return String(raw);
    return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  } catch {
    return String(raw);
  }
}

/** Extrai `{subscriptions[], pagination}` de qualquer shape de input
 *  suportado (`{subscriptions: [...]}`, `{data: [...]}`, array nu, ou
 *  `{pagination: {...}}` sem linhas — página genuinamente vazia). Payloads
 *  que não batem NENHUMA dessas formas (ex: corpo de erro da MCP) lançam
 *  `UnrecognizedExitHistoryPayloadError` — falha DURA, nunca "0 linhas,
 *  exit 0" silencioso (#7426 finding 1). */
export function extractExitHistoryPayload(raw: unknown): {
  rows: BeehiivExitHistoryRawRecord[];
  pagination: Partial<ExitHistoryPageMeta>;
} {
  if (Array.isArray(raw)) return { rows: raw as BeehiivExitHistoryRawRecord[], pagination: {} };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const hasSubscriptions = Array.isArray(obj.subscriptions);
    const hasData = Array.isArray(obj.data);
    const hasPaginationObj = obj.pagination !== undefined && obj.pagination !== null && typeof obj.pagination === "object";
    if (!hasSubscriptions && !hasData && !hasPaginationObj) {
      throw new UnrecognizedExitHistoryPayloadError(raw);
    }
    const rows = hasSubscriptions
      ? (obj.subscriptions as BeehiivExitHistoryRawRecord[])
      : hasData
        ? (obj.data as BeehiivExitHistoryRawRecord[])
        : [];
    const paginationRaw = hasPaginationObj ? (obj.pagination as Record<string, unknown>) : {};
    const pagination: Partial<ExitHistoryPageMeta> = {
      page: typeof paginationRaw.page === "number" ? paginationRaw.page : undefined,
      per_page: typeof paginationRaw.per_page === "number" ? paginationRaw.per_page : undefined,
      total: typeof paginationRaw.total === "number" ? paginationRaw.total : undefined,
      total_pages: typeof paginationRaw.total_pages === "number" ? paginationRaw.total_pages : undefined,
    };
    return { rows, pagination };
  }
  throw new UnrecognizedExitHistoryPayloadError(raw);
}

function readExistingRecords(path: string): BeehiivExitHistoryRecord[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const out: BeehiivExitHistoryRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as BeehiivExitHistoryRecord);
    } catch {
      // linha corrompida — ignorada, dado real perdido só nesta linha, nunca no arquivo inteiro.
    }
  }
  return out;
}

function writeJsonlAtomic(path: string, records: readonly BeehiivExitHistoryRecord[]): void {
  const tmp = `${path}.tmp`;
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

function loadManifest(path: string, now: string): ExitHistoryManifest {
  if (!existsSync(path)) return buildInitialExitHistoryManifest(now);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ExitHistoryManifest;
  } catch {
    return buildInitialExitHistoryManifest(now);
  }
}

function saveManifestAtomic(path: string, manifest: ExitHistoryManifest): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, path);
}

/**
 * #7426 fleet review finding 2 (silent-failure-hunter, média confiança): o
 * warning genérico de "checkpoint não avançou" conflacionava dois casos
 * diferentes — a MCP genuinamente omitiu `pagination` numa página válida
 * (quirk documentado, #7197) vs. o payload não tinha nada a ver com uma
 * página (hoje bloqueado ANTES de chegar aqui pelo finding 1, mas o campo
 * fica estruturado pra quem debugar depois não precisar reler prosa).
 * `"page-recorded"` é o caminho feliz — `pagination.page` presente, o
 * manifest avançou. `"missing-pagination-quirk"` é o único jeito de chegar
 * aqui sem avançar o checkpoint (payload passou pela validação de shape do
 * finding 1, então TEM subscriptions[]/data[]/pagination reconhecível —
 * só faltou `pagination.page` especificamente).
 */
export type ExitHistoryPaginationOutcome = "page-recorded" | "missing-pagination-quirk";

export interface ApplyExitHistoryResult {
  before_count: number;
  after_count: number;
  new_or_updated: number;
  page: number | null;
  pages_fetched: number;
  total_pages: number | null;
  total: number | null;
  complete: boolean;
  next_page: number;
  pagination_outcome: ExitHistoryPaginationOutcome;
}

export function applyExitHistoryPage(stdinJson: string, outDir: string = DEFAULT_OUT_DIR): ApplyExitHistoryResult {
  mkdirSync(outDir, { recursive: true });
  const jsonlPath = resolve(outDir, "subscribers.jsonl");
  const manifestPath = resolve(outDir, "manifest.json");
  const now = new Date().toISOString();

  const raw = JSON.parse(stdinJson) as unknown;
  const { rows, pagination } = extractExitHistoryPayload(raw);
  const parsed = parseExitHistoryPage(rows);

  const existing = readExistingRecords(jsonlPath);
  const beforeCount = existing.length;
  const merged = mergeExitHistoryRecords(existing, parsed);
  writeJsonlAtomic(jsonlPath, merged);

  let manifest = loadManifest(manifestPath, now);
  let paginationOutcome: ExitHistoryPaginationOutcome;
  if (typeof pagination.page === "number") {
    manifest = applyExitHistoryPageToManifest(manifest, { page: pagination.page, ...pagination }, now);
    paginationOutcome = "page-recorded";
  } else {
    // Sem `pagination.page` no payload — não dá pra avançar o checkpoint
    // com segurança (não sabemos QUAL página isto era). O JSONL já foi
    // mesclado (dado nunca é perdido), só o manifest fica como estava.
    // Chega até aqui SÓ quando o payload já passou pela validação de shape
    // (finding 1) — ou seja, é o quirk documentado #7197 (MCP omite
    // `pagination` numa página real), não um payload de erro disfarçado.
    paginationOutcome = "missing-pagination-quirk";
    console.error(
      "⚠️  pagination_outcome=missing-pagination-quirk — payload sem pagination.page (quirk #7197), " +
        "dado aplicado ao JSONL, mas o checkpoint de paginação não avançou.",
    );
  }
  saveManifestAtomic(manifestPath, manifest);

  return {
    before_count: beforeCount,
    after_count: merged.length,
    new_or_updated: parsed.length,
    page: typeof pagination.page === "number" ? pagination.page : null,
    pages_fetched: manifest.pages_fetched,
    total_pages: manifest.total_pages,
    total: manifest.total,
    complete: manifest.complete,
    next_page: nextExitHistoryPage(manifest),
    pagination_outcome: paginationOutcome,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveP(data));
    process.stdin.on("error", rejectP);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDirIdx = argv.indexOf("--out-dir");
  const outDir = outDirIdx !== -1 && argv[outDirIdx + 1] ? resolve(argv[outDirIdx + 1]) : DEFAULT_OUT_DIR;

  const stdinJson = await readStdin();
  if (!stdinJson.trim()) {
    console.error("stdin vazio — espera a resposta crua da MCP list_subscriptions");
    process.exit(2);
  }

  try {
    const result = applyExitHistoryPage(stdinJson, outDir);
    console.log(JSON.stringify(result));
  } catch (e) {
    // #7426 finding 5: stack trace (não só a mensagem) — barato, ajuda debug futuro.
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  });
}
