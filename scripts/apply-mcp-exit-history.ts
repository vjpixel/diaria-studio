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

/** Extrai `{subscriptions[], pagination}` de qualquer shape de input
 *  suportado. Tolerante: campos ausentes viram `[]`/`{}`. */
export function extractExitHistoryPayload(raw: unknown): {
  rows: BeehiivExitHistoryRawRecord[];
  pagination: Partial<ExitHistoryPageMeta>;
} {
  if (Array.isArray(raw)) return { rows: raw as BeehiivExitHistoryRawRecord[], pagination: {} };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const rows = Array.isArray(obj.subscriptions)
      ? (obj.subscriptions as BeehiivExitHistoryRawRecord[])
      : Array.isArray(obj.data)
        ? (obj.data as BeehiivExitHistoryRawRecord[])
        : [];
    const paginationRaw = obj.pagination && typeof obj.pagination === "object" ? (obj.pagination as Record<string, unknown>) : {};
    const pagination: Partial<ExitHistoryPageMeta> = {
      page: typeof paginationRaw.page === "number" ? paginationRaw.page : undefined,
      per_page: typeof paginationRaw.per_page === "number" ? paginationRaw.per_page : undefined,
      total: typeof paginationRaw.total === "number" ? paginationRaw.total : undefined,
      total_pages: typeof paginationRaw.total_pages === "number" ? paginationRaw.total_pages : undefined,
    };
    return { rows, pagination };
  }
  return { rows: [], pagination: {} };
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
  if (typeof pagination.page === "number") {
    manifest = applyExitHistoryPageToManifest(manifest, { page: pagination.page, ...pagination }, now);
  } else {
    // Sem `pagination.page` no payload — não dá pra avançar o checkpoint
    // com segurança (não sabemos QUAL página isto era). O JSONL já foi
    // mesclado (dado nunca é perdido), só o manifest fica como estava.
    console.error(
      "⚠️  payload sem pagination.page — dado aplicado ao JSONL, mas o checkpoint de paginação não avançou.",
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
