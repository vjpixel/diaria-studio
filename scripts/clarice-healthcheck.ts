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
 *   npx tsx scripts/clarice-healthcheck.ts [--timeout-ms N] [--mcp] [--via-headers-helper]
 *
 * --mcp: em vez do REST cortex, sonda o MCP `clarice` de verdade
 * (`checkClariceMcpHealth` abaixo, #5114) — ver docstring da função pro
 * porquê disso não ser redundante com o probe REST default.
 *
 * --via-headers-helper (#11312, implica --mcp): a key do probe MCP sai do
 * `headersHelper` do `.mcp.json` (`scripts/mcp/clarice-headers.mjs`), como o
 * Claude Code faz, em vez de `CLARICE_API_KEY` lida por este script. O Stage 0
 * roda nesse modo (`stage-0-run.ts`, sinal `clariceMcp` do preflight-state).
 *
 * Stdout: JSON { ok: boolean, latency_ms?: number, error?: string }
 *   (com --via-headers-helper, também `key_source` e, às vezes, `note`)
 * Exit codes:
 *   0 — saudável (ok: true)
 *   1 — arg inválido
 *   2 — degraded (ok: false, exibe `error`)
 *
 * Não escolhi exit 1 pra erro de conectividade: 1 é "arg inválido" em vários
 * scripts do repo e poderia ser confundido com falha de uso.
 */

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";

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
    // #9911: cancela corpo não lido (ex.: stream SSE do initialize). Sem o
    // process.exit, um socket aberto deixaria o processo pendurado. Abortar
    // depois de o corpo útil já ter sido lido não tem efeito.
    controller.abort();
  }
}

// ─── MCP `clarice` (#5114) ─────────────────────────────────────────────
//
// Achado #5114: o healthcheck REST acima só prova que `cortex.clarice.ai`
// está de pé com ESTA key -- não prova nada sobre o MCP (`mcp.clarice.ai`,
// endpoint DIFERENTE, auth resolvida num processo DIFERENTE -- o `.mcp.json`
// monta o header no Claude Code, via `headersHelper` desde o #11251, não neste
// script).
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
    // #9911: cancela corpo não lido (ex.: stream SSE do initialize). Sem o
    // process.exit, um socket aberto deixaria o processo pendurado. Abortar
    // depois de o corpo útil já ter sido lido não tem efeito.
    controller.abort();
  }
}

// ─── Key pelo MESMO caminho do Claude Code (#11312) ────────────────────
//
// O probe MCP acima usa a key que ESTE processo lê (`CLARICE_API_KEY` do
// ambiente + `.env` via dotenv). O Claude Code monta o header do MCP de outro
// jeito (`.mcp.json`, #11251): roda o `headersHelper`
// (`node scripts/mcp/clarice-headers.mjs`) e, se ele não devolver o header,
// cai no estático `${CLARICE_API_KEY}`. Um helper quebrado passaria batido num
// probe que só usa a key do script. Com `--via-headers-helper`, o probe roda o
// MESMO helper e usa a saída dele.
//
// Limites (documentados, não resolvíveis daqui): (1) trust da pasta — sem
// trust aceito o Claude Code nem roda o helper, e um script não tem como saber
// isso; (2) o estático é expandido do ambiente do processo do Claude Code, não
// deste script (que já carregou o `.env`), então o fallback abaixo é uma
// aproximação otimista do header estático.

/** Caminho do helper relativo à raiz do projeto — o mesmo de `.mcp.json`. */
export const CLARICE_HEADERS_HELPER = "scripts/mcp/clarice-headers.mjs";
const CLARICE_MCP_HEADER_NAME = "X-Clarice-Api-Key";
/** Timeout do Claude Code para um `headersHelper` (doc oficial de MCP). */
const HEADERS_HELPER_TIMEOUT_MS = 10_000;
/** O Claude Code tira do ambiente de um helper de repositório as vars com
 * cara de credencial (ver docstring de `clarice-headers.mjs`). Reproduzido
 * aqui para o helper ler o `.env` como leria sob o Claude Code. */
const CREDENTIAL_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

export interface HelperRun {
  /** `null` = o processo não saiu com código (timeout/sinal/spawn falhou). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Mensagem de erro do spawn (ex.: ENOENT, ETIMEDOUT), quando houver. */
  spawnError?: string;
}

export type ProbeKeySource = "headers-helper" | "static-env";

export type ProbeKeyResolution =
  | { ok: true; apiKey: string; source: ProbeKeySource; note?: string }
  | { ok: false; error: string };

/**
 * Decide qual key o probe MCP usa a partir da saída do `headersHelper`, na
 * mesma ordem do Claude Code: header dinâmico do helper primeiro; helper sem
 * header (`{}`, a saída dele quando não acha key) → estático do ambiente.
 * Helper que falha (exit != 0, timeout, stdout que não é objeto JSON) é
 * reportado como falha — é exatamente o caso "helper quebrado" que o probe
 * com a key do script não enxergava (#11312). Pura, nunca lança.
 */
export function resolveProbeKeyFromHelper(run: HelperRun, envKey: string | undefined): ProbeKeyResolution {
  if (run.spawnError || run.code !== 0) {
    const why = run.spawnError ?? `exit ${run.code ?? "sem código (timeout/sinal)"}`;
    const stderr = run.stderr.trim().slice(0, 200);
    return { ok: false, error: `headersHelper ${CLARICE_HEADERS_HELPER} falhou: ${why}${stderr ? ` — ${stderr}` : ""}` };
  }
  let headers: unknown;
  try {
    headers = JSON.parse(run.stdout.trim());
  } catch {
    return { ok: false, error: `headersHelper ${CLARICE_HEADERS_HELPER} imprimiu algo que não é JSON: ${run.stdout.trim().slice(0, 200)}` };
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return { ok: false, error: `headersHelper ${CLARICE_HEADERS_HELPER} não imprimiu um objeto JSON de headers` };
  }
  const dynamic = (headers as Record<string, unknown>)[CLARICE_MCP_HEADER_NAME];
  if (typeof dynamic === "string" && dynamic.trim()) {
    return { ok: true, apiKey: dynamic.trim(), source: "headers-helper" };
  }
  const staticKey = envKey?.trim();
  if (!staticKey) {
    return {
      ok: false,
      error:
        `headersHelper sem ${CLARICE_MCP_HEADER_NAME} e CLARICE_API_KEY ausente no ambiente — ` +
        `o MCP iria com header vazio (401, sintoma do #11251)`,
    };
  }
  return {
    ok: true,
    apiKey: staticKey,
    source: "static-env",
    note: "headersHelper não devolveu header; probe usou a key do ambiente (aproxima o header estático do .mcp.json)",
  };
}

/** Roda o `headersHelper` como o Claude Code roda: cwd na raiz do projeto,
 * timeout de 10s, ambiente sem vars com cara de credencial. Nunca lança. */
export function runClariceHeadersHelper(projectRoot: string, env: NodeJS.ProcessEnv = process.env): HelperRun {
  const helperEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!CREDENTIAL_ENV_NAME.test(k)) helperEnv[k] = v;
  }
  const res = spawnSync(process.execPath, [CLARICE_HEADERS_HELPER], {
    cwd: projectRoot,
    env: helperEnv,
    encoding: "utf8",
    timeout: HEADERS_HELPER_TIMEOUT_MS,
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    ...(res.error ? { spawnError: res.error.message } : {}),
  };
}

export interface HealthcheckArgs {
  timeoutMs?: number;
  mcp?: boolean;
  /** #11312: probe MCP com a key resolvida pelo `headersHelper` (implica `--mcp`). */
  viaHeadersHelper?: boolean;
}

export function parseHealthcheckArgs(argv: string[]): HealthcheckArgs {
  const out: HealthcheckArgs = {};
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
    if (argv[i] === "--via-headers-helper") {
      out.viaHeadersHelper = true;
      out.mcp = true;
    }
  }
  return out;
}

async function main(): Promise<number> {
  let args: HealthcheckArgs;
  try {
    args = parseHealthcheckArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  if (args.viaHeadersHelper) {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const resolution = resolveProbeKeyFromHelper(runClariceHeadersHelper(projectRoot), process.env.CLARICE_API_KEY);
    if (!resolution.ok) {
      console.log(JSON.stringify({ ok: false, error: resolution.error }));
      return 2;
    }
    const result = await checkClariceMcpHealth({ apiKey: resolution.apiKey, timeoutMs: args.timeoutMs });
    console.log(
      JSON.stringify({ ...result, key_source: resolution.source, ...(resolution.note ? { note: resolution.note } : {}) }),
    );
    return result.ok ? 0 : 2;
  }
  const apiKey = process.env.CLARICE_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ ok: false, error: "CLARICE_API_KEY ausente" }));
    return 2;
  }
  const result = args.mcp
    ? await checkClariceMcpHealth({ apiKey, timeoutMs: args.timeoutMs })
    : await checkClariceHealth({ apiKey, timeoutMs: args.timeoutMs });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 2;
}

if (isMainModule(import.meta.url)) {
  // #9911: runCli grava process.exitCode; exceção inesperada sai 1, como a
  // rejeição não tratada do `await main()` antigo.
  await runCli(main);
}
