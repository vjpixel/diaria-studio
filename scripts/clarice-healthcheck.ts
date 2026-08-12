/**
 * clarice-healthcheck.ts (#1329) — ping REST Clarice cortex API pra
 * detectar conectividade antes do Stage 2.
 *
 * Roda no Stage 0 (preflight). Não falha o pipeline — só sinaliza
 * (degraded / down) e loga warn. O caminho normal de Stage 2 continua
 * sendo MCP, mas o orchestrator agora **sabe** se o REST tá disponível
 * pra cair no fallback (`clarice-correct.ts`) sem halt.
 *
 * Uso (CLI):
 *   npx tsx scripts/clarice-healthcheck.ts [--timeout-ms N] [--mcp]
 *
 * --mcp: em vez do REST cortex, sonda o MCP `clarice` de verdade
 * (`checkClariceMcpHealth` abaixo, #5114) — ver docstring da função pro
 * porquê disso não ser redundante com o probe REST default.
 *
 * Stdout: JSON { ok: boolean, latency_ms?: number, error?: string }
 * Exit codes:
 *   0 — saudável (ok: true)
 *   1 — arg inválido
 *   2 — degraded (ok: false, exibe `error`)
 *
 * Não escolhi exit 1 pra erro de conectividade: 1 é "arg inválido" em vários
 * scripts do repo e poderia ser confundido com falha de uso.
 */

import "dotenv/config";
import { isMainModule } from "./lib/cli-args.ts";

const CLARICE_ENDPOINT = "https://cortex.clarice.ai/api-correction";
const PROBE_TEXT = "ola";
/**
 * O cortex responde entre ~2,8s e ~16,3s mesmo pro probe de 3 chars (medido
 * 2026-07-15). O default anterior de 5s abortava de forma INTERMITENTE — Stage 0
 * marcava CLARICE_REST=false com o REST saudável, e Stage 2 pulava direto pro
 * halt banner sem tentar o fallback (orchestrator-stage-2.md §266). O modo de
 * falha ser intermitente é o que escondeu o bug: falha constante seria óbvia,
 * flake ocasional lê como "desconexão misteriosa". Alinhado com o default sem
 * --retry de clarice-correct.ts.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Latência real observada no probe de 3 chars (2026-07-15). O default precisa folgar sobre isso. */
export const OBSERVED_PROBE_LATENCY_MS = 16_300;

export interface HealthResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface HealthOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkClariceHealth(
  opts: HealthOptions,
): Promise<HealthResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    const res = await fetchFn(CLARICE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-API-Key": opts.apiKey,
      },
      body: JSON.stringify({ paragraphs: [{ description: PROBE_TEXT, offset: 0 }] }),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      return { ok: false, latency_ms, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true, latency_ms };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    return { ok: false, latency_ms, error: (e as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── MCP `clarice` (#5114) ─────────────────────────────────────────────
//
// Achado #5114: o healthcheck REST acima só prova que `cortex.clarice.ai`
// está de pé com ESTA key -- não prova nada sobre o MCP (`mcp.clarice.ai`,
// endpoint DIFERENTE, auth resolvida num processo DIFERENTE -- o `.mcp.json`
// interpola `${CLARICE_API_KEY}` no launch do Claude Code, não neste script).
// `studio-integrations.ts` já documentava essa lacuna como "aproxima, não
// prova" desde #3848 -- este bloco fecha ela com um probe real.
//
// Verificado AO VIVO (12/08/2026, curl contra `https://mcp.clarice.ai/mcp`
// com uma key inválida) o formato exato da falha: o transporte MCP
// (streamable HTTP) responde SEMPRE HTTP 200 em `initialize` -- essa etapa
// não checa a key, só abre uma sessão (`Mcp-Session-Id` no header de
// resposta). A key só é validada quando uma TOOL é de fato chamada
// (`tools/call`), porque a Clarice repassa a chamada pro cortex real por
// trás -- e mesmo aí o transporte MCP continua devolvendo HTTP 200; o erro
// vem DENTRO do envelope JSON-RPC, como `result.isError: true` +
// `result.content[0].text` (ex.: "Erro: a API da Clarice retornou HTTP 401.
// Tente novamente."). Um probe que checasse só o HTTP status do transporte
// (como um `fetch` ingênuo faria) reportaria sempre `ok: true`, mesmo com
// 401 real -- daí os 2 round-trips abaixo serem necessários, não um capricho.
const CLARICE_MCP_ENDPOINT = "https://mcp.clarice.ai/mcp";
const MCP_PROBE_TOOL = "correct_text";
const MCP_PROBE_TEXT = "ola";

interface McpJsonRpcResponse {
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: { message?: string; code?: number };
}

/** O transporte streamable-HTTP do MCP devolve `Content-Type: text/event-stream`
 * mesmo pra uma resposta ÚNICA (não um stream de verdade nesta troca request/
 * response, sem subscription) -- o corpo vem no formato SSE
 * (`event: message\ndata: {...json rpc...}\n\n`). Extrai o JSON da(s) linha(s)
 * `data:` -- se houver mais de uma (não observado, mas o formato permite),
 * usa a ÚLTIMA (mais recente). Fallback: se nenhuma linha `data:` existir,
 * tenta o corpo inteiro como JSON puro (o spec MCP streamable-HTTP permite o
 * servidor responder `application/json` direto em vez de SSE pra uma troca
 * sem subscription — não observado ao vivo contra este servidor, mas cobrir
 * os dois formatos é mais barato que arriscar um falso "resposta ilegível"
 * se o comportamento mudar). `null` só se AMBOS falharem -- nunca lança. */
export function parseMcpSseResponse(body: string): McpJsonRpcResponse | null {
  const dataLines = [...body.matchAll(/^data: (.+)$/gm)].map((m) => m[1]);
  if (dataLines.length > 0) {
    try {
      return JSON.parse(dataLines[dataLines.length - 1]) as McpJsonRpcResponse;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(body.trim()) as McpJsonRpcResponse;
  } catch {
    return null;
  }
}

/**
 * Sonda o MCP `clarice` de verdade: abre uma sessão (`initialize`) e chama a
 * tool `correct_text` com um texto trivial, exatamente como o Stage 2 da
 * diária chamaria via `mcp__clarice__correct_text`. `ok: false` cobre TODOS
 * os jeitos de falhar: HTTP não-200 em qualquer etapa, sessão sem
 * `mcp-session-id`, corpo SSE ilegível, erro JSON-RPC de transporte
 * (`error` no envelope), OU o caso mais comum na prática --
 * `result.isError: true` (auth rejeitada pelo cortex por trás, mesmo
 * sintoma do #5114 original).
 */
export async function checkClariceMcpHealth(opts: HealthOptions): Promise<HealthResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  const baseHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Clarice-Api-Key": opts.apiKey,
  };

  try {
    const initRes = await fetchFn(CLARICE_MCP_ENDPOINT, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "diaria-clarice-healthcheck", version: "1.0.0" },
        },
      }),
      signal: controller.signal,
    });
    if (!initRes.ok) {
      const body = await initRes.text().catch(() => "<unreadable>");
      return { ok: false, latency_ms: Date.now() - t0, error: `HTTP ${initRes.status} (initialize): ${body.slice(0, 200)}` };
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) {
      return { ok: false, latency_ms: Date.now() - t0, error: "sessão MCP não retornou header mcp-session-id" };
    }

    const callRes = await fetchFn(CLARICE_MCP_ENDPOINT, {
      method: "POST",
      headers: { ...baseHeaders, "Mcp-Session-Id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: MCP_PROBE_TOOL, arguments: { text: MCP_PROBE_TEXT } },
      }),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - t0;
    if (!callRes.ok) {
      const body = await callRes.text().catch(() => "<unreadable>");
      return { ok: false, latency_ms, error: `HTTP ${callRes.status} (tools/call): ${body.slice(0, 200)}` };
    }
    const bodyText = await callRes.text();
    const parsed = parseMcpSseResponse(bodyText);
    if (!parsed) {
      return { ok: false, latency_ms, error: `resposta MCP ilegível: ${bodyText.slice(0, 200)}` };
    }
    if (parsed.error) {
      return { ok: false, latency_ms, error: `MCP error: ${parsed.error.message ?? JSON.stringify(parsed.error)}` };
    }
    if (parsed.result?.isError) {
      const text = parsed.result.content?.find((c) => c.type === "text")?.text ?? "erro desconhecido (isError sem content)";
      return { ok: false, latency_ms, error: text };
    }
    return { ok: true, latency_ms };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: (e as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseHealthcheckArgs(argv: string[]): { timeoutMs?: number; mcp?: boolean } {
  const out: { timeoutMs?: number; mcp?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    // Mesmo guard de clarice-correct.ts: só consome o próximo token como valor
    // se ele não for outra --flag.
    const value = argv[i + 1]?.startsWith("--") ? undefined : argv[i + 1];
    if (argv[i] === "--timeout-ms" && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--timeout-ms deve ser um número positivo (recebido: ${value})`);
      }
      out.timeoutMs = n;
      i++;
    }
    if (argv[i] === "--mcp") {
      out.mcp = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  let args: { timeoutMs?: number; mcp?: boolean };
  try {
    args = parseHealthcheckArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const apiKey = process.env.CLARICE_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ ok: false, error: "CLARICE_API_KEY ausente" }));
    process.exit(2);
  }
  const result = args.mcp
    ? await checkClariceMcpHealth({ apiKey, timeoutMs: args.timeoutMs })
    : await checkClariceHealth({ apiKey, timeoutMs: args.timeoutMs });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 2);
}

if (isMainModule(import.meta.url)) {
  await main();
}
