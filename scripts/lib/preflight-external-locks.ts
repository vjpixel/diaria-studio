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
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTokenHealth } from "../google-auth.ts";
import { checkCloudflareToken } from "../check-cloudflare-token.ts";
import { loadProjectEnv } from "./env-loader.ts";
import { hasFlag, isMainModule } from "./cli-args.ts";

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

/** Resultado mínimo de `codex login status` (shape de `spawnSync`). */
export interface CodexStatusResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: { code?: string; message: string };
}

/** Timeout curto: o preflight não pode herdar os 300s do `codex.timeout_seconds`. */
export const CODEX_STATUS_TIMEOUT_MS = 15_000;

/** Vars que fariam o Codex cair em API pay-per-token — espelha
 * `STRIPPED_ENV_VARS` de `scripts/codex-image.js` (#9088). */
const CODEX_STRIPPED_ENV_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"];

/** Runner real de `codex login status` (#9093). Windows com instalação npm
 * expõe só `codex.cmd` — mesmo fallback de `codex-image.js`. */
export function runCodexLoginStatus(): CodexStatusResult {
  const env = { ...process.env };
  for (const k of CODEX_STRIPPED_ENV_VARS) delete env[k];
  const opts = { encoding: "utf8" as const, timeout: CODEX_STATUS_TIMEOUT_MS, env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  let r = spawnSync("codex", ["login", "status"], opts);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
    r = spawnSync("codex.cmd", ["login", "status"], { ...opts, shell: true });
  }
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? { code: (r.error as NodeJS.ErrnoException).code, message: r.error.message } : undefined,
  };
}

/**
 * #9093: classifica o `codex login status` num `LockCheckResult`. Pura.
 * - binário ausente (ENOENT) → `missing`;
 * - timeout / exit ≠ 0 → `expired` (ação `codex login`);
 * - logado por API key (não pela assinatura ChatGPT) → `expired` — o
 *   `codex-image.js` força `forced_login_method="chatgpt"` e recusaria.
 */
export function classifyCodexStatus(r: CodexStatusResult): LockCheckResult {
  const dependency = "Codex CLI (login ChatGPT — image_generator=codex, Stages 1, 3)";
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  if (r.error?.code === "ENOENT") {
    return {
      dependency, state: "missing", blocks_stages: [1, 3],
      reauth_action: "Instalar o Codex CLI e rodar `codex login` (ver docs/codex-image-setup.md)",
      detail: "binário `codex` não encontrado no PATH",
    };
  }
  if (r.error || r.status !== 0) {
    const why = r.error?.code === "ETIMEDOUT"
      ? `\`codex login status\` não respondeu em ${CODEX_STATUS_TIMEOUT_MS / 1000}s`
      : `\`codex login status\` saiu com ${r.error ? r.error.message : `exit ${r.status}`}: ${out.slice(-200)}`;
    return { dependency, state: "expired", blocks_stages: [1, 3], reauth_action: "Rodar `codex login` (conta ChatGPT) nesta máquina", detail: why };
  }
  if (/api key/i.test(out) && !/chatgpt/i.test(out)) {
    return {
      dependency, state: "expired", blocks_stages: [1, 3],
      reauth_action: "Rodar `codex logout && codex login` com a conta ChatGPT (API key é pay-per-token e é recusada)",
      detail: `logado por API key: ${out.slice(-200)}`,
    };
  }
  return { dependency, state: "ok", blocks_stages: [], reauth_action: "", detail: out.slice(-200) || "logado" };
}

export interface ApiKeyLockOptions {
  /** Injetável em teste — default `platform.config.json` da raiz. */
  configPath?: string;
  /** Injetável em teste — default roda `codex login status` de verdade. */
  runCodexStatus?: () => CodexStatusResult;
}

/**
 * Lê `platform.config.json` e verifica a credencial de acordo com `image_generator`.
 * Keys: só presença no env, sem rede. `codex` (#9093): roda `codex login status`
 * com timeout curto — login expirado aparecia só no meio do Stage 1/3. Com
 * `codex.fallback`, reporta também a key do fallback; ela só bloqueia stages
 * quando o próprio Codex está quebrado (senão o fallback nem é usado).
 */
export function checkApiKeyLocks(opts: ApiKeyLockOptions = {}): LockCheckResult[] {
  const results: LockCheckResult[] = [];

  const configPath = opts.configPath ?? resolve(ROOT, "platform.config.json");
  let imageGenerator = "gemini";
  let codexFallback: string | undefined;
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        image_generator?: string;
        codex?: { fallback?: string };
      };
      imageGenerator = (cfg.image_generator ?? "gemini").toLowerCase();
      codexFallback = cfg.codex?.fallback?.toLowerCase();
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

  const keyResult = (gen: string, blocking: boolean, label = ""): LockCheckResult | null => {
    const keyDef = keyMap[gen];
    if (!keyDef) return null;
    const present = !!process.env[keyDef.env]?.trim();
    return {
      dependency: `${keyDef.env} (${keyDef.description}${label})`,
      state: present ? "ok" : "missing",
      blocks_stages: present || !blocking ? [] : keyDef.stages,
      reauth_action: present ? "" : `Configurar ${keyDef.env} em .env ou exportar no shell antes de rodar`,
      detail: present ? `${keyDef.env} presente` : `${keyDef.env} ausente`,
    };
  };

  if (imageGenerator === "codex") {
    const codex = classifyCodexStatus((opts.runCodexStatus ?? runCodexLoginStatus)());
    results.push(codex);
    if (codexFallback) {
      const fb = keyResult(codexFallback, codex.state !== "ok", " — fallback do Codex");
      if (fb) results.push(fb);
    }
    return results;
  }

  const r = keyResult(imageGenerator, true);
  if (r) results.push(r);
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
  /** #9093: injetável em teste (config fixo + runner fake do `codex login status`). */
  apiKeyLockOptions?: ApiKeyLockOptions;
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

  results.push(...checkApiKeyLocks(opts?.apiKeyLockOptions));
  results.push(...checkMcpConnectors());

  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

/**
 * #9316: uma trava só é BLOQUEANTE quando o estado não é ok/unchecked E ela de
 * fato bloqueia algum stage. Uma entrada `missing` com `blocks_stages: []` é
 * informativa — caso real: a key do fallback do Codex ausente com o Codex OK
 * (o fallback nem é usado). Antes o CLI filtrava só por `state` e saía com
 * exit 1 nesse caso, renderizando o banner "trava(s) externa(s)" no Stage 0
 * de toda edição sem nada bloqueado.
 */
export function isBlockingLock(r: LockCheckResult): boolean {
  return r.state !== "ok" && r.state !== "unchecked" && r.blocks_stages.length > 0;
}

/** #9316: exit code do CLI — 1 se houver ao menos 1 trava bloqueante, senão 0. Pura. */
export function exitCodeForLocks(results: LockCheckResult[]): 0 | 1 {
  return results.some(isBlockingLock) ? 1 : 0;
}

export function formatRow(r: LockCheckResult): string {
  if (r.state === "ok" || r.state === "unchecked") {
    const icon = r.state === "ok" ? "✅" : "ℹ️ ";
    return `  ${icon} ${r.dependency} — ${r.state}`;
  }
  const action = `\n     Ação: ${r.reauth_action}`;
  if (!isBlockingLock(r)) {
    // #9316: não-ok mas sem stage bloqueado → aviso informativo, nunca "❌ bloqueia".
    return `  ⚠️  ${r.dependency} — ${r.state} (informativo, não bloqueia nenhum stage)${action}`;
  }
  return `  ❌ ${r.dependency} — ${r.state}  → bloqueia stages: ${r.blocks_stages.join(", ")}${action}`;
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

  const blocking = results.filter(isBlockingLock);

  process.stdout.write("\n=== Preflight de Travas Externas (#2358) ===\n\n");
  for (const r of results) {
    process.stdout.write(formatRow(r) + "\n");
  }
  process.stdout.write("\n");

  const code = exitCodeForLocks(results);
  if (code !== 0) {
    process.stderr.write(
      `[preflight-external-locks] ${blocking.length} trava(s) bloqueante(s) detectada(s).\n`,
    );
  }
  return code;
}

// CLI guard — não dispara main() quando importado em testes (#cli-guard)
if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
