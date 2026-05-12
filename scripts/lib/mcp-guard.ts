/**
 * mcp-guard.ts (#1132 — wave 2 estabilidade, P1)
 *
 * Helper standardizado pra wrapping de operações que dependem de MCPs ou
 * APIs externas (Beehiiv, Brevo, Cloudflare Worker, Drive, Gmail, etc).
 *
 * Aplica regra invariável CLAUDE.md `MCP indisponível = fail-fast, nunca
 * stall` (#738). Antes desta abstração, cada script tinha seu próprio
 * pattern de error handling — algum stallava, outro silenciava warn,
 * outro crashava com stack trace sem contexto.
 *
 * Comportamento:
 * 1. Tenta a operação com timeout configurável
 * 2. Em falha (timeout ou exception), retry com backoff
 * 3. Após esgotamento, emite **halt banner** via `render-halt-banner.ts`
 *    e re-lança (caller decide se exit ou propagar)
 *
 * Não fala com MCP diretamente — só wraps. Caller passa o thunk.
 *
 * Uso típico:
 * ```ts
 * import { withMcpGuard } from "./lib/mcp-guard.ts";
 *
 * const response = await withMcpGuard(
 *   async () => fetch(`${WORKER_URL}/img/key`, { method: "PUT", body: buf }),
 *   { mcpName: "cloudflare-worker", stage: "Stage 4 — upload images" },
 * );
 * ```
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface McpGuardOptions {
  /** Nome do MCP/API (usado no halt banner). Ex: `beehiiv`, `cloudflare-worker`, `drive`, `gmail`. */
  mcpName: string;
  /** Stage do pipeline (usado no halt banner). Ex: `Stage 4 — Publish`. */
  stage: string;
  /**
   * Timeout por tentativa em ms. Default 30000 (30s). Operações longas
   * (upload de imagem, fetch RSS) podem precisar mais.
   */
  timeoutMs?: number;
  /**
   * Número de retries após primeira falha (não conta a tentativa inicial).
   * Default 1 (= 2 tentativas totais). Setar 0 pra disable retry.
   */
  retries?: number;
  /**
   * Delay entre tentativas em ms. Default 2000.
   */
  retryDelayMs?: number;
  /**
   * Se `true` (default), emite halt banner após esgotar retries.
   * Setar `false` pra apenas re-lançar o erro sem ruído (caller controla output).
   */
  haltOnFailure?: boolean;
  /**
   * Função `console.error`-like pra logging por tentativa. Default usa
   * `process.stderr.write` direto. Útil pra mock em tests.
   */
  log?: (msg: string) => void;
}

/** Erro específico do guard — caller pode distinguir de erros raw da operação. */
export class McpGuardError extends Error {
  constructor(
    message: string,
    public readonly mcpName: string,
    public readonly stage: string,
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(message);
    this.name = "McpGuardError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Roda `operation` com timeout. Retorna o valor ou rejeita com erro.
 *
 * Pure helper exportado pra teste isolado.
 */
export function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    operation().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Sleep helper exportado pra teste. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Emite o halt banner via `render-halt-banner.ts`. Pure side effect.
 *
 * Não exit — apenas escreve no stdout/stderr. Caller decide se continua
 * propagando o erro ou aborta.
 */
export function emitHaltBanner(
  mcpName: string,
  stage: string,
  reason: string,
): void {
  const scriptPath = resolve(ROOT, "scripts/render-halt-banner.ts");
  spawnSync(
    "npx",
    [
      "tsx",
      scriptPath,
      "--stage",
      stage,
      "--reason",
      `${mcpName} — ${reason}`,
      "--action",
      `Verifique conectividade do ${mcpName} e responda 'retry' pra re-tentar, ou 'abort' pra abortar`,
    ],
    { stdio: "inherit" },
  );
}

/**
 * Wraps uma operação async com timeout + retry + halt banner em falha
 * persistente. Re-lança `McpGuardError` após esgotar retries.
 *
 * @param operation Thunk que retorna a Promise da operação.
 * @param opts Configuração do guard.
 * @returns Valor retornado pela operação em caso de sucesso.
 * @throws `McpGuardError` se todas as tentativas falharem.
 */
export async function withMcpGuard<T>(
  operation: () => Promise<T>,
  opts: McpGuardOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const haltOnFailure = opts.haltOnFailure ?? true;
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg));

  const maxAttempts = retries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(operation, timeoutMs);
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      log(
        `[mcp-guard] ${opts.mcpName} attempt ${attempt}/${maxAttempts} failed: ${errMsg}\n`,
      );
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }
  }

  // Esgotamos retries
  const lastErrMsg = lastError instanceof Error ? lastError.message : String(lastError);
  if (haltOnFailure) {
    emitHaltBanner(opts.mcpName, opts.stage, lastErrMsg);
  }
  throw new McpGuardError(
    `${opts.mcpName} falhou após ${maxAttempts} tentativas: ${lastErrMsg}`,
    opts.mcpName,
    opts.stage,
    maxAttempts,
    lastError,
  );
}
