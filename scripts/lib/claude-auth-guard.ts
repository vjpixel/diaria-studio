/**
 * scripts/lib/claude-auth-guard.ts (#11887)
 *
 * Preflight de AUTENTICAÇÃO para os runners headless que despacham `claude`
 * (`run-nightly-chain.ts`, `run-scheduled-edicao.ts`): a sessão agendada só
 * sobe se `claude auth status` disser `authMethod === "claude.ai"` (#5608).
 *
 * Por que além de `CLAUDE_CLI_STRIPPED_ENV_VARS`: aquele filtro cobre auth
 * por VARIÁVEL de ambiente. No 300 (02/11/2026) a sessão apareceu como "API
 * Usage Billing" sem nenhuma `ANTHROPIC_*` no ambiente — a credencial
 * guardada pelo próprio CLI estava em modo API. Filtrar env não pega isso;
 * só perguntar ao CLI qual método ele vai usar pega.
 *
 * Contratos:
 *  - **Falha fechado.** Binário que não roda, timeout, saída que não é JSON,
 *    `authMethod` ausente ou diferente de `claude.ai` → não confiado. Nunca
 *    fail-soft: o cenário que importa é justamente o CLI estar num estado
 *    inesperado.
 *  - **Não expõe segredo nem identidade.** A saída de `claude auth status`
 *    traz e-mail, orgId e nome da organização. Este módulo extrai SÓ o campo
 *    `authMethod` (e `apiProvider`, valor de enum) e nunca devolve nem loga o
 *    resto, nem o stdout/stderr cru. Também não lê arquivos de credencial.
 *  - Roda com o MESMO env que o dispatch usa (o chamador passa o env já
 *    filtrado por `claudeCliEnv`), então o veredito vale pra sessão real.
 *
 * Puro exceto pelo spawn, que é injetável (`exec`).
 */
import { execFileSync } from "node:child_process";

/** Exit dos runners quando a auth não é claude.ai. Fora de `successExitCodes`: a unit sai `failed`. */
export const EXIT_CLAUDE_AUTH_NOT_SUBSCRIPTION = 7;

/** Único método aceito: assinatura claude.ai. */
export const REQUIRED_AUTH_METHOD = "claude.ai";

/** Teto do `claude auth status` — é uma leitura local; travar aqui não pode segurar a rodada. */
export const AUTH_STATUS_TIMEOUT_MS = 30_000;

export type ClaudeAuthStatus =
  /** `authMethod === "claude.ai"`. */
  | "subscription"
  /** O CLI respondeu com outro método (api, console, token de gateway...). */
  | "wrong-method"
  /** Não foi possível determinar (falha de spawn, timeout, saída inválida). Tratado como falha. */
  | "unverifiable";

export interface ClaudeAuthResult {
  status: ClaudeAuthStatus;
  /** Só o valor de enum `authMethod` quando conhecido; nunca outros campos. */
  authMethod?: string;
  /** Linha pronta pro log do runner. Sem e-mail, org, token ou saída crua. */
  message: string;
}

export interface ClaudeAuthOptions {
  /** Env do filho — o mesmo do dispatch (já passado por `claudeCliEnv`). */
  env?: NodeJS.ProcessEnv;
  exec?: typeof execFileSync;
  timeoutMs?: number;
}

/** Sanitiza um valor de enum antes de ecoar: só `[A-Za-z0-9._-]`, até 40 chars. */
function safeEnum(value: unknown): string {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 40);
}

export function checkClaudeAuth(claudeBin: string, opts: ClaudeAuthOptions = {}): ClaudeAuthResult {
  const exec = opts.exec ?? execFileSync;
  const unverifiable = (why: string): ClaudeAuthResult => ({
    status: "unverifiable",
    message:
      `auth do claude: NÃO VERIFICÁVEL — ${why}. Tratado como não-assinatura (#11887, #5608): ` +
      "a rodada não sobe. Conferir `claude auth status` no host e, se preciso, `/login` com a assinatura.",
  });

  let stdout: string;
  try {
    stdout = String(
      exec(claudeBin, ["auth", "status"], {
        encoding: "utf8",
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (e) {
    // Só o código/errno — a mensagem do erro pode carregar stdout/stderr.
    const code = (e as NodeJS.ErrnoException).code;
    const status = (e as { status?: number | null }).status;
    return unverifiable(`\`claude auth status\` falhou (${code ?? (status != null ? `exit ${status}` : "erro de spawn")})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unverifiable("a saída de `claude auth status` não é JSON");
  }
  const method = (parsed as { authMethod?: unknown } | null)?.authMethod;
  if (typeof method !== "string" || method === "") {
    return unverifiable("a saída de `claude auth status` não traz `authMethod`");
  }
  if (method !== REQUIRED_AUTH_METHOD) {
    return {
      status: "wrong-method",
      authMethod: safeEnum(method),
      message:
        `auth do claude: authMethod=${safeEnum(method)}, esperado ${REQUIRED_AUTH_METHOD} — sessão agendada NÃO sobe ` +
        "(pay-per-token e conectores claude.ai desligados, #5608/#11887). Rodar `/login` com a assinatura no host.",
    };
  }
  return { status: "subscription", authMethod: REQUIRED_AUTH_METHOD, message: `auth do claude: ok (authMethod=${REQUIRED_AUTH_METHOD})` };
}
