/**
 * clarice-correct.ts (#1329) — fallback REST direto pro Clarice cortex API.
 *
 * Existe pra quando o MCP `mcp__clarice__correct_text` está offline e a
 * pipeline precisa continuar sem halt. Caminho normal continua sendo MCP
 * (top-level Claude faz a chamada inline em Stage 2 §3b). Este script vira
 * fallback automático quando o MCP retorna erro/disconnect.
 *
 * Pareado com `scripts/clarice-healthcheck.ts` que roda no Stage 0 pra
 * forewarn antes de chegar no Stage 2.
 *
 * Endpoint: POST https://cortex.clarice.ai/api-correction
 * Header:  X-API-Key: $CLARICE_API_KEY
 * Body:    { paragraphs: [{ description: <text>, offset: 0 }] }
 *
 * Uso (CLI):
 *   npx tsx scripts/clarice-correct.ts \
 *     --in data/editions/{AAMMDD}/_internal/02-humanized.md \
 *     --out data/editions/{AAMMDD}/_internal/02-clarice-suggestions.json
 *
 * Saída: `--out` recebe JSON array de `{ from, to, rule?, explanation? }` —
 * mesmo shape que `mcp__clarice__correct_text` retorna, então o
 * `clarice-apply.ts` consome sem mudança.
 *
 * Exit codes:
 *   0 — sucesso
 *   1 — args inválidos
 *   2 — env CLARICE_API_KEY ausente
 *   3 — HTTP non-2xx da API Clarice
 *   4 — I/O (read --in ou write --out)
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

import type { ClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";
import { parseClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";

const CLARICE_ENDPOINT = "https://cortex.clarice.ai/api-correction";

export interface CorrectOptions {
  apiKey: string;
  text: string;
  /** Opcional — injeta fetch pra testes. Default = global fetch. */
  fetchImpl?: typeof fetch;
  /** Timeout em ms — default 30s. */
  timeoutMs?: number;
}

/**
 * Chama REST API Clarice. Retorna lista de sugestões já parseada/validada
 * via Zod schema (`ClariceSuggestionsSchema`).
 *
 * Throws:
 *   - Error("HTTP {status}: {body}") em non-2xx
 *   - Error("invalid response shape: ...") se o JSON não bate com schema
 */
export async function correctTextViaREST(
  opts: CorrectOptions,
): Promise<ClariceSuggestions> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(CLARICE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-API-Key": opts.apiKey,
      },
      body: JSON.stringify({
        paragraphs: [{ description: opts.text, offset: 0 }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable>");
    throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }

  const raw = await res.json() as unknown;
  return extractSuggestions(raw);
}

/**
 * O endpoint pode envelopar a resposta de jeitos diferentes (paragraphs[].suggestions[],
 * results[], top-level array). Tenta achatar pra um array uniforme que valida
 * via ClariceSuggestionsSchema.
 *
 * Exporta pra teste — caller normal usa `correctTextViaREST`.
 */
export function extractSuggestions(raw: unknown): ClariceSuggestions {
  const flat = flatten(raw);
  return parseClariceSuggestions(flat);
}

function flatten(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.suggestions)) return obj.suggestions;
    if (Array.isArray(obj.paragraphs)) {
      return (obj.paragraphs as Array<Record<string, unknown>>).flatMap((p) =>
        Array.isArray(p?.suggestions) ? p.suggestions as unknown[] : [],
      );
    }
    if (Array.isArray(obj.results)) return obj.results;
  }
  return [];
}

interface CliArgs {
  inPath: string;
  outPath: string;
}

function parseCliArgs(argv: string[]): CliArgs | null {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--in" && value) { out.inPath = value; i++; }
    else if (flag === "--out" && value) { out.outPath = value; i++; }
  }
  if (!out.inPath || !out.outPath) return null;
  return out as CliArgs;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: clarice-correct.ts --in <text-file> --out <suggestions-json>");
    process.exit(1);
  }
  const apiKey = process.env.CLARICE_API_KEY;
  if (!apiKey) {
    console.error("CLARICE_API_KEY ausente no env");
    process.exit(2);
  }

  let text: string;
  try {
    text = readFileSync(args.inPath, "utf8");
  } catch (e) {
    console.error(`erro lendo --in: ${(e as Error).message}`);
    process.exit(4);
  }

  let suggestions: ClariceSuggestions;
  try {
    suggestions = await correctTextViaREST({ apiKey, text });
  } catch (e) {
    console.error(`erro chamando Clarice REST: ${(e as Error).message}`);
    process.exit(3);
  }

  try {
    writeFileSync(args.outPath, JSON.stringify(suggestions, null, 2), "utf8");
  } catch (e) {
    console.error(`erro escrevendo --out: ${(e as Error).message}`);
    process.exit(4);
  }

  console.log(JSON.stringify({ suggestions_count: suggestions.length, out: args.outPath }));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  await main();
}
