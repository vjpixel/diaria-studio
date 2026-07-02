/**
 * preflight-external-locks.ts (#2358)
 *
 * Verificação determinística de travas externas de autenticação ANTES de
 * iniciar o trabalho da edição. Travas que vencem silenciosamente não são
 * detectadas pela checagem de MCP em runtime (#738) — este módulo cobre o
 * que é verificável de forma determinística a partir do Node.
 *
 * Dependências verificadas:
 *
 *   1. OAuth Google Drive (`data/.credentials.json`)
 *      Reutiliza `checkTokenHealth` de google-auth.ts (mesmo token cobre
 *      Drive + Gmail + upload de imagens sociais). Estado: ok | expired | missing.
 *
 *   2. Wrangler/Cloudflare (`CLOUDFLARE_API_TOKEN`)
 *      Reutiliza `checkCloudflareToken` de check-cloudflare-token.ts
 *      (REST API, sem execução de CLI). Estado: ok | expired | missing.
 *
 *   3. API keys de plataforma (GEMINI_API_KEY, etc.)
 *      Verifica presença no env (sem gastar cota). Estado: ok | missing.
 *
 *   4. Conectores MCP (Gmail, Beehiiv via claude.ai)
 *      Não verificáveis deterministicamente a partir do Node — reportados
 *      como "unchecked" (verificados em runtime pelo orchestrator via #738).
 *
 * Saída: `LockCheckResult[]` — array de resultados por dependência.
 * Exit codes (CLI):
 *   0 — todas as travas ok ou unchecked (warn-only para unchecked)
 *   1 — pelo menos 1 trava bloqueante (blocks_stages não-vazio + state != ok)
 *   2 — erro inesperado ao rodar o preflight (não bloqueia — warn)
 *
 * Uso CLI:
 *   npx tsx scripts/lib/preflight-external-locks.ts [--skip-oauth]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTokenHealth } from "../google-auth.ts";
import { checkCloudflareToken } from "../check-cloudflare-token.ts";
import { loadProjectEnv } from "./env-loader.ts";
import { hasFlag } from "./cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export type LockState = "ok" | "expired" | "missing" | "unchecked";

export interface LockCheckResult {
  /** Nome legível da dependência */
  dependency: string;
  /** Estado detectado */
  state: LockState;
  /** Stages downstream que falham quando esta trava está quebrada */
  blocks_stages: number[];
  /** Ação de re-autenticação (string vazia quando state === "ok" | "unchecked") */
  reauth_action: string;
  /** Detalhes adicionais para log (opcional) */
  detail?: string;
}

// ── Checagem 1: OAuth Google ───────────────────────────────────────────────────

/**
 * Verifica o token OAuth Google. Reutiliza `checkTokenHealth` de google-auth.ts
 * para cobrir o mesmo token que cobre Drive + Gmail + imagens sociais.
 *
 * @param fetchImpl      Injetável para testes (mock fetch).
 * @param _now           Reservado para testes futuros (timestamp ms epoch).
 * @param tokenHealthFn  Injetável para testes — substitui checkTokenHealth por mock.
 *                       Útil para exercer o ramo "expired" sem precisar de
 *                       data/.credentials.json no disco (#633).
 * @param credentialsPath Injetável para testes — substitui o path de
 *                       `data/.credentials.json` real. Default preserva o
 *                       comportamento de produção (#2846: torna o teste
 *                       "OAuth ausente" hermético em máquinas com a junction
 *                       `data/` do OneDrive, onde o arquivo real existe).
 */
export async function checkOAuthLock(
  fetchImpl: typeof fetch = fetch,
  _now?: number,
  tokenHealthFn?: (f: typeof fetch) => ReturnType<typeof checkTokenHealth>,
  credentialsPath: string = resolve(ROOT, "data", ".credentials.json"),
): Promise<LockCheckResult> {
  // Quando o tokenHealthFn é injetado (testes), pular o existsSync — o mock
  // simula o comportamento pós-credentials, incluindo expirado.
  if (tokenHealthFn === undefined && !existsSync(credentialsPath)) {
    return {
      dependency: "OAuth Google (Drive + Gmail + imagens)",
      state: "missing",
      blocks_stages: [0, 1, 3, 4, 5],
      reauth_action:
        "npx tsx scripts/oauth-setup.ts  (re-autentica em ~1min; rode /diaria-inbox depois)",
      detail: `data/.credentials.json ausente — nenhuma credencial OAuth encontrada`,
    };
  }

  const healthFn = tokenHealthFn ?? checkTokenHealth;
  let health: Awaited<ReturnType<typeof checkTokenHealth>>;
  try {
    health = await healthFn(fetchImpl);
  } catch (e) {
    // Exceção inesperada ao chamar checkTokenHealth (ex: saveCredentials falhou,
    // AbortSignal propagado como throw) — não assumir ok; reportar como unchecked
    // com warn para não mascarar credentials quebrados nem bloquear por transitório.
    return {
      dependency: "OAuth Google (Drive + Gmail + imagens)",
      state: "unchecked",
      blocks_stages: [],
      reauth_action: "",
      detail: `checkTokenHealth lançou exceção inesperada: ${(e as Error).message} — verificar manualmente`,
    };
  }

  if (health.status === "valid" || health.status === "expiring_soon") {
    // expiring_soon ainda funciona — não bloqueia, mas detalha
    return {
      dependency: "OAuth Google (Drive + Gmail + imagens)",
      state: "ok",
      blocks_stages: [],
      reauth_action: "",
      detail: health.detail,
    };
  }

  // Erro de rede transitório (ex: timeout no endpoint Google, 5xx) — não bloqueia.
  // Consistente com checkCloudflareToken que também trata "error" como não-bloqueante.
  if (health.status === "error") {
    return {
      dependency: "OAuth Google (Drive + Gmail + imagens)",
      state: "unchecked",
      blocks_stages: [],
      reauth_action: "",
      detail: `erro de rede ao verificar OAuth (transitório) — ${health.detail}`,
    };
  }

  // no_credentials ou invalid_grant → bloqueante
  return {
    dependency: "OAuth Google (Drive + Gmail + imagens)",
    state: health.status === "no_credentials" ? "missing" : "expired",
    blocks_stages: [0, 1, 3, 4, 5],
    reauth_action:
      "npx tsx scripts/oauth-setup.ts  (re-autentica em ~1min; rode /diaria-inbox depois)",
    detail: health.detail,
  };
}

// ── Checagem 2: Wrangler/Cloudflare ───────────────────────────────────────────

/**
 * Verifica o token Cloudflare via REST API (sem execução de CLI).
 *
 * @param fetchImpl  Injetável para testes (mock fetch).
 * @param apiToken   Token a verificar. Se omitido, lê de CLOUDFLARE_API_TOKEN.
 */
export async function checkWranglerLock(
  fetchImpl: typeof fetch = fetch,
  apiToken?: string,
): Promise<LockCheckResult> {
  const tokenToCheck = apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";

  const health = await checkCloudflareToken(tokenToCheck, fetchImpl);

  if (health.status === "active") {
    return {
      dependency: "Wrangler/Cloudflare (Worker + KV)",
      state: "ok",
      blocks_stages: [],
      reauth_action: "",
      detail: `token ativo (prefix: ${health.token_prefix ?? "?"})`,
    };
  }

  if (health.status === "error") {
    // Erro de rede transitório — não bloqueia (exit 0, soft warning)
    return {
      dependency: "Wrangler/Cloudflare (Worker + KV)",
      state: "ok",
      blocks_stages: [],
      reauth_action: "",
      detail: `erro de rede ao verificar (transitório) — ${health.error ?? ""}`,
    };
  }

  return {
    dependency: "Wrangler/Cloudflare (Worker + KV)",
    state: health.status === "missing" ? "missing" : "expired",
    blocks_stages: [0],
    reauth_action:
      "Renovar CLOUDFLARE_API_TOKEN no .env (dashboard CF) ou rodar: wrangler login",
    detail: health.error,
  };
}

// ── Checagem 3: API keys de plataforma ────────────────────────────────────────

/**
 * Lê `platform.config.json` e verifica a key de acordo com `image_generator`.
 * Não faz nenhuma chamada de rede — só valida presença no env.
 */
export function checkApiKeyLocks(): LockCheckResult[] {
  const results: LockCheckResult[] = [];

  const configPath = resolve(ROOT, "platform.config.json");
  let imageGenerator = "gemini";
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        image_generator?: string;
      };
      imageGenerator = (cfg.image_generator ?? "gemini").toLowerCase();
    } catch {
      // config malformado — não bloqueia verificação de key
    }
  }

  const keyMap: Record<
    string,
    { env: string; description: string; stages: number[] }
  > = {
    gemini: {
      env: "GEMINI_API_KEY",
      description: "Gemini API (eia-compose Stage 1 + image-generate Stage 3)",
      stages: [1, 3],
    },
    cloudflare: {
      env: "CLOUDFLARE_WORKERS_TOKEN",
      description: "Cloudflare Workers AI (Stages 1, 3)",
      stages: [1, 3],
    },
    openai: {
      env: "OPENAI_API_KEY",
      description: "OpenAI DALL-E (Stages 1, 3)",
      stages: [1, 3],
    },
  };

  const keyDef = keyMap[imageGenerator];
  if (keyDef) {
    const value = process.env[keyDef.env];
    results.push({
      dependency: `${keyDef.env} (${keyDef.description})`,
      state: value && value.trim().length > 0 ? "ok" : "missing",
      blocks_stages: value && value.trim().length > 0 ? [] : keyDef.stages,
      reauth_action:
        value && value.trim().length > 0
          ? ""
          : `Configurar ${keyDef.env} em .env ou exportar no shell antes de rodar`,
      detail:
        value && value.trim().length > 0
          ? `${keyDef.env} presente`
          : `${keyDef.env} ausente`,
    });
  }

  return results;
}

// ── Checagem 4: Conectores MCP (não verificáveis via TS) ─────────────────────

/**
 * Reporta conectores MCP como "unchecked" — são verificados em runtime
 * pelo orchestrator via #738. Incluído aqui para o resumo ser completo.
 */
export function checkMcpConnectors(): LockCheckResult[] {
  return [
    {
      dependency: "MCP Gmail (claude.ai)",
      state: "unchecked",
      blocks_stages: [0, 1, 6],
      reauth_action: "Verificado em runtime pelo orchestrator (#738)",
      detail: "não verificável deterministicamente a partir do Node",
    },
    {
      dependency: "MCP Beehiiv (claude.ai)",
      state: "unchecked",
      blocks_stages: [0, 5, 6],
      reauth_action: "Verificado em runtime pelo orchestrator (#738)",
      detail: "não verificável deterministicamente a partir do Node",
    },
  ];
}

// ── Função principal exportável ────────────────────────────────────────────────

/**
 * Executa todas as checagens de travas externas e retorna array de resultados.
 *
 * Parâmetros injetáveis permitem testes determinísticos sem I/O real.
 *
 * @param opts.fetchImpl   Mock de fetch (default: global fetch)
 * @param opts.apiToken    Token Cloudflare explícito (default: env var)
 * @param opts.skipOauth   Pular checagem de OAuth (para testes sem data/)
 */
export async function preflightExternalLocks(opts?: {
  fetchImpl?: typeof fetch;
  apiToken?: string;
  skipOauth?: boolean;
}): Promise<LockCheckResult[]> {
  loadProjectEnv();

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const apiToken = opts?.apiToken;
  const skipOauth = opts?.skipOauth ?? false;

  const checks: Promise<LockCheckResult | LockCheckResult[]>[] = [];

  if (!skipOauth) {
    checks.push(checkOAuthLock(fetchImpl));
  }
  checks.push(checkWranglerLock(fetchImpl, apiToken));

  // API key checks são síncronas
  const resolved = await Promise.all(checks);
  const results: LockCheckResult[] = resolved.flat();

  results.push(...checkApiKeyLocks());
  results.push(...checkMcpConnectors());

  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function formatRow(r: LockCheckResult): string {
  const icon =
    r.state === "ok"
      ? "✅"
      : r.state === "unchecked"
        ? "ℹ️ "
        : "❌";
  const stages =
    r.state === "ok" || r.state === "unchecked"
      ? ""
      : `  → bloqueia stages: ${r.blocks_stages.join(", ")}`;
  const action = r.state === "ok" || r.state === "unchecked" ? "" : `\n     Ação: ${r.reauth_action}`;
  return `  ${icon} ${r.dependency} — ${r.state}${stages}${action}`;
}

async function main(): Promise<number> {
  const skipOauth = hasFlag(process.argv.slice(2), "skip-oauth");

  let results: LockCheckResult[];
  try {
    results = await preflightExternalLocks({ skipOauth });
  } catch (e) {
    process.stderr.write(
      `[preflight-external-locks] erro inesperado: ${(e as Error).message}\n`,
    );
    return 2;
  }

  const blocking = results.filter(
    (r) => r.state !== "ok" && r.state !== "unchecked",
  );

  process.stdout.write("\n=== Preflight de Travas Externas (#2358) ===\n\n");
  for (const r of results) {
    process.stdout.write(formatRow(r) + "\n");
  }
  process.stdout.write("\n");

  if (blocking.length > 0) {
    process.stderr.write(
      `[preflight-external-locks] ${blocking.length} trava(s) bloqueante(s) detectada(s).\n`,
    );
    return 1;
  }

  return 0;
}

// CLI guard — não dispara main() quando importado em testes (#cli-guard)
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/lib\/preflight-external-locks\.ts$/.test(_argv1)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
