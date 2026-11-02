/**
 * clarice-mcp-chunks.ts (#11812) — Clarice por blocos no caminho MCP.
 *
 * Problema: na Etapa 2d da `/diaria-mensal`, `mcp__clarice__correct_text` com o
 * draft inteiro estourou o teto de 30s do cliente MCP, repetidas vezes
 * (01/11/2026); blocos menores passaram. O REST (`clarice-correct.ts`) já
 * chunka sozinho, mas o MCP é chamado pelo LLM, que precisa de um jeito
 * determinístico de dividir o texto e de juntar as sugestões de volta.
 *
 * Dois modos:
 *
 *   split — divide o texto em blocos (`splitIntoChunks`, fronteira `---` >
 *   parágrafo > linha) de no máximo `--max-chars` (default
 *   `CLARICE_MCP_CHUNK_MAX_CHARS`). Grava `chunk-NN.md` + `manifest.json` em
 *   `--out-dir` e imprime no stdout a lista de blocos a enviar. Bloco sem
 *   conteúdo (só `---`/branco) sai com `send: false`: não chamar o MCP.
 *
 *     npx tsx scripts/clarice-mcp-chunks.ts split \
 *       --in data/monthly/$CYCLE/draft.md \
 *       --out-dir data/monthly/$CYCLE/_internal/clarice-chunks
 *
 *   O agente então chama `mcp__clarice__correct_text` UM bloco por vez (serial,
 *   #4952) com o conteúdo de cada `chunk-NN.md` e grava a resposta (array de
 *   `{from, to, ...}`) em `chunk-NN.suggestions.json`. Bloco cuja chamada
 *   falhou fica sem o arquivo: o merge segue com os outros.
 *
 *   merge — confere que o texto não mudou desde o split (sha256), aplica as
 *   sugestões de cada bloco no PRÓPRIO bloco (`mergeChunkSuggestions`: âncora
 *   única por bloco, filtro de ruído do #11798) e re-concatena.
 *
 *     npx tsx scripts/clarice-mcp-chunks.ts merge \
 *       --in data/monthly/$CYCLE/draft.md \
 *       --out-dir data/monthly/$CYCLE/_internal/clarice-chunks \
 *       --out data/monthly/$CYCLE/draft.md \
 *       --suggestions-out data/monthly/$CYCLE/_internal/02-clarice-suggestions.json \
 *       --report data/monthly/$CYCLE/_internal/02-clarice-report.json
 *
 *   Não re-aplicar `--suggestions-out` ao texto inteiro com `clarice-apply.ts`:
 *   uma âncora única dentro do bloco pode aparecer 2+ vezes no texto todo e
 *   seria pulada como ambígua (mesma ressalva de `clarice-correct.ts`).
 *
 * Exit codes:
 *   0 — ok (bloco sem resposta não é erro: sai em `missing_chunks` no relatório)
 *   1 — args inválidos
 *   2 — I/O ou JSON inválido (manifest, `--in`, arquivo de sugestões malformado)
 *   3 — `--in` mudou depois do split (sha256 diferente): refazer o split
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  CLARICE_MCP_CHUNK_MAX_CHARS,
  isSubstantiveParagraph,
  mergeChunkSuggestions,
  splitIntoChunks,
  type ApplyResult,
  type ClariceChunkSuggestion,
} from "./lib/clarice-chunk.ts";
import { parseClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";

export interface ChunkManifestEntry {
  index: number;
  startOffset: number;
  chars: number;
  /** Nome do arquivo do bloco dentro de `--out-dir`. */
  file: string;
  /** Onde o agente grava a resposta do MCP para este bloco. */
  suggestionsFile: string;
  /** `false` = bloco sem conteúdo (só branco ou `---`): não chamar o MCP. */
  send: boolean;
}

export interface ChunkManifest {
  sha256: string;
  maxChars: number;
  chunks: ChunkManifestEntry[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Divide `text` e devolve o manifest + o conteúdo de cada bloco (sem I/O). */
export function buildChunkManifest(
  text: string,
  maxChars = CLARICE_MCP_CHUNK_MAX_CHARS,
): { manifest: ChunkManifest; contents: string[] } {
  const chunks = splitIntoChunks(text, maxChars);
  const width = Math.max(2, String(chunks.length).length);
  const entries = chunks.map((c, i) => {
    const n = String(i + 1).padStart(width, "0");
    return {
      index: i,
      startOffset: c.startOffset,
      chars: c.text.length,
      file: `chunk-${n}.md`,
      suggestionsFile: `chunk-${n}.suggestions.json`,
      send: isSubstantiveParagraph(c.text),
    };
  });
  return {
    manifest: { sha256: sha256(text), maxChars, chunks: entries },
    contents: chunks.map((c) => c.text),
  };
}

export class ChunkMergeError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export interface ChunkMergeResult extends ApplyResult {
  /** Índices (1-based, como no nome do arquivo) de blocos enviáveis sem resposta. */
  missingChunks: number[];
}

/**
 * Junta as respostas do MCP (sem I/O). `rawSuggestions[i]` é o JSON já
 * parseado do bloco `i`, ou `undefined` se o arquivo não existe.
 *
 * Re-divide `text` com o mesmo `maxChars` do manifest e confere sha256 e
 * fronteiras: o apply é chunk-local, então o bloco precisa ser o mesmo que o
 * MCP viu.
 */
export function mergeChunkResponses(
  text: string,
  manifest: ChunkManifest,
  rawSuggestions: Array<unknown | undefined>,
  log: (msg: string) => void = (msg) => console.warn(msg),
): ChunkMergeResult {
  if (sha256(text) !== manifest.sha256) {
    throw new ChunkMergeError(
      "texto mudou depois do split (sha256 diferente) — refazer o split e as chamadas ao MCP",
      3,
    );
  }
  const chunks = splitIntoChunks(text, manifest.maxChars);
  if (
    chunks.length !== manifest.chunks.length ||
    chunks.some((c, i) => c.startOffset !== manifest.chunks[i].startOffset)
  ) {
    throw new ChunkMergeError("fronteiras dos blocos não batem com o manifest — refazer o split", 3);
  }

  const missingChunks: number[] = [];
  const pairs: Array<{ chunk: (typeof chunks)[number]; suggestions: ClariceChunkSuggestion[] }> = [];
  for (const [i, chunk] of chunks.entries()) {
    const entry = manifest.chunks[i];
    const raw = rawSuggestions[i];
    if (raw === undefined) {
      if (entry.send) missingChunks.push(i + 1);
      pairs.push({ chunk, suggestions: [] });
      continue;
    }
    let suggestions: ClariceChunkSuggestion[];
    try {
      suggestions = parseClariceSuggestions(raw);
    } catch (e) {
      throw new ChunkMergeError(
        `${entry.suggestionsFile}: formato inválido (esperado array de {from, to}): ${(e as Error).message}`,
        2,
      );
    }
    pairs.push({ chunk, suggestions });
  }

  const merged = mergeChunkSuggestions(pairs, log);
  return { ...merged, missingChunks };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runSplit(values: Record<string, string>): number {
  const inPath = values.in;
  const outDir = values["out-dir"];
  if (!inPath || !outDir) {
    console.error("Uso: clarice-mcp-chunks.ts split --in <md> --out-dir <dir> [--max-chars N]");
    return 1;
  }
  const maxChars = values["max-chars"] ? Number(values["max-chars"]) : CLARICE_MCP_CHUNK_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 200) {
    console.error(`[clarice-mcp-chunks] --max-chars inválido: ${values["max-chars"]} (inteiro >= 200)`);
    return 1;
  }
  let text: string;
  try {
    text = readFileSync(inPath, "utf8");
  } catch (e) {
    console.error(`[clarice-mcp-chunks] erro lendo --in: ${(e as Error).message}`);
    return 2;
  }
  const { manifest, contents } = buildChunkManifest(text, maxChars);
  mkdirSync(outDir, { recursive: true });
  for (const [i, entry] of manifest.chunks.entries()) {
    writeFileSync(join(outDir, entry.file), contents[i], "utf8");
    // Resposta de uma rodada anterior não pode ser lida como desta: o merge
    // trataria um arquivo velho como a resposta do bloco novo.
    const stale = join(outDir, entry.suggestionsFile);
    if (existsSync(stale)) unlinkSync(stale);
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const toSend = manifest.chunks.filter((c) => c.send);
  console.log(
    JSON.stringify(
      {
        chunks: manifest.chunks.length,
        send: toSend.map((c) => ({ file: join(outDir, c.file), suggestionsFile: join(outDir, c.suggestionsFile), chars: c.chars })),
      },
      null,
      2,
    ),
  );
  return 0;
}

function runMerge(values: Record<string, string>): number {
  const inPath = values.in;
  const outDir = values["out-dir"];
  const outPath = values.out;
  if (!inPath || !outDir || !outPath) {
    console.error(
      "Uso: clarice-mcp-chunks.ts merge --in <md> --out-dir <dir> --out <md> [--suggestions-out <json>] [--report <json>]",
    );
    return 1;
  }
  let text: string;
  let manifest: ChunkManifest;
  try {
    text = readFileSync(inPath, "utf8");
    manifest = readJson(join(outDir, "manifest.json")) as ChunkManifest;
  } catch (e) {
    console.error(`[clarice-mcp-chunks] erro lendo --in/manifest: ${(e as Error).message}`);
    return 2;
  }
  const raw: Array<unknown | undefined> = [];
  for (const entry of manifest.chunks ?? []) {
    const p = join(outDir, entry.suggestionsFile);
    if (!existsSync(p) || readFileSync(p, "utf8").trim() === "") {
      raw.push(undefined);
      continue;
    }
    try {
      raw.push(readJson(p));
    } catch (e) {
      console.error(`[clarice-mcp-chunks] ${entry.suggestionsFile}: JSON inválido: ${(e as Error).message}`);
      return 2;
    }
  }

  let result: ChunkMergeResult;
  try {
    result = mergeChunkResponses(text, manifest, raw);
  } catch (e) {
    if (e instanceof ChunkMergeError) {
      console.error(`[clarice-mcp-chunks] ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }

  writeFileSync(outPath, result.text, "utf8");
  if (values["suggestions-out"]) {
    const all = raw.flatMap((r) => (r === undefined ? [] : parseClariceSuggestions(r)));
    writeFileSync(values["suggestions-out"], JSON.stringify(all, null, 2), "utf8");
  }
  const report = {
    chunks: manifest.chunks.length,
    missing_chunks: result.missingChunks,
    applied: result.applied.length,
    skipped: result.skipped.length,
    applied_details: result.applied,
    skipped_details: result.skipped,
  };
  const reportJson = JSON.stringify(report, null, 2);
  if (values.report) writeFileSync(values.report, reportJson, "utf8");
  else console.error(reportJson);
  if (result.missingChunks.length > 0) {
    console.warn(
      `[clarice-mcp-chunks] aviso: ${result.missingChunks.length} bloco(s) sem resposta do MCP (${result.missingChunks.join(", ")}) — texto deles ficou sem correção`,
    );
  }
  return 0;
}

export function main(argv: string[]): number {
  const [mode, ...rest] = argv;
  const { values } = parseArgs(rest);
  if (mode === "split") return runSplit(values);
  if (mode === "merge") return runMerge(values);
  console.error("Uso: clarice-mcp-chunks.ts <split|merge> ... (ver cabeçalho do arquivo)");
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
