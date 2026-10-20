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
import { resolve, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
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
  const out = redactSecrets(`${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim());
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

// ── #10602: `login status` não renova o token — sonda de refresh real ──────────
//
// `codex login status` só lê `~/.codex/auth.json` e responde "Logged in using
// ChatGPT" mesmo com o refresh token revogado/expirado. A falha real
// (`Failed to refresh token: ... Please log out and sign in again`) só aparece
// quando o Codex precisa RENOVAR o access token — no meio do Stage 1/3. O
// access token da conta ChatGPT dura ~10 dias e o Codex o renova sozinho
// quando `last_refresh` passa de ~8 dias; antes disso o token em disco serve
// e não há o que testar. Por isso a sonda é em 2 passos:
//   1. lê `auth.json` (só `exp` do access token e `last_refresh` — NUNCA
//      devolve, loga ou guarda o token em si);
//   2. se o token está perto de exigir refresh (ou o arquivo não dá pra ler),
//      roda um `codex exec` mínimo, que dispara o refresh de fato — se o
//      refresh funciona, o token sai RENOVADO; se não, o lock vira `expired`.

/** Janela de antecedência: abaixo disso de validade, a sonda roda o refresh. */
export const CODEX_REFRESH_MARGIN_MS = 3 * 24 * 3600 * 1000;
/** `last_refresh` mais velho que isto → o Codex vai tentar renovar no próximo uso. */
export const CODEX_LAST_REFRESH_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Timeout do `codex exec` da sonda (chamada de modelo curta, mas ainda é rede). */
export const CODEX_REFRESH_PROBE_TIMEOUT_MS = 90_000;

/** Estado do `auth.json` sem nenhum segredo: só datas derivadas. */
export type CodexAuthFreshness =
  | { kind: "fresh"; detail: string }
  | { kind: "needs-refresh"; detail: string }
  | { kind: "unknown"; detail: string };

/** Mascara qualquer coisa com cara de token antes de ir pra `detail`/log. */
export function redactSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<jwt-redigido>")
    .replace(/\b(sk|rt|sess)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<token-redigido>");
}

/** `exp` (ms) do payload de um JWT, sem validar assinatura. `null` se ilegível. */
function jwtExpMs(jwt: unknown): number | null {
  if (typeof jwt !== "string") return null;
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * #10602: classifica o conteúdo do `auth.json` (já parseado). Pura.
 * Só olha `tokens.access_token` (exp) e `last_refresh`; o retorno nunca carrega
 * token nenhum.
 */
export function assessCodexAuthFreshness(auth: unknown, now: number = Date.now()): CodexAuthFreshness {
  if (!auth || typeof auth !== "object") return { kind: "unknown", detail: "auth.json sem objeto JSON" };
  const a = auth as { tokens?: { access_token?: unknown }; last_refresh?: unknown };
  const expMs = jwtExpMs(a.tokens?.access_token);
  if (expMs === null) return { kind: "unknown", detail: "auth.json sem access_token legível (exp)" };
  const days = (ms: number) => (ms / 86_400_000).toFixed(1);
  const lastRefreshMs = typeof a.last_refresh === "string" ? Date.parse(a.last_refresh) : NaN;
  if (expMs - now < CODEX_REFRESH_MARGIN_MS) {
    return {
      kind: "needs-refresh",
      detail: expMs <= now
        ? `access token expirou há ${days(now - expMs)} dia(s)`
        : `access token expira em ${days(expMs - now)} dia(s)`,
    };
  }
  if (Number.isFinite(lastRefreshMs) && now - lastRefreshMs > CODEX_LAST_REFRESH_MAX_AGE_MS) {
    return { kind: "needs-refresh", detail: `último refresh há ${days(now - lastRefreshMs)} dia(s)` };
  }
  return { kind: "fresh", detail: `access token válido por mais ${days(expMs - now)} dia(s)` };
}

/** Path do `auth.json` do Codex (`$CODEX_HOME/auth.json`, default `~/.codex`). */
export function codexAuthPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

/** Leitor real do `auth.json` (#10602). Nunca lança; nunca devolve o token. */
export function readCodexAuthFreshness(path: string = codexAuthPath(), now: number = Date.now()): CodexAuthFreshness {
  if (!existsSync(path)) return { kind: "unknown", detail: "auth.json do Codex não encontrado" };
  try {
    return assessCodexAuthFreshness(JSON.parse(readFileSync(path, "utf8")), now);
  } catch (e) {
    return { kind: "unknown", detail: `auth.json ilegível: ${(e as Error).name}` };
  }
}

/** Prompt mínimo da sonda — só precisa de UMA chamada autenticada. */
const CODEX_PROBE_PROMPT = 'Reply with just "ok". Do not run any command.';

/**
 * Runner real da sonda de refresh (#10602): `codex exec` mínimo, sandbox
 * read-only, login forçado pela assinatura ChatGPT (mesmo `-c` do
 * `codex-image.js`), cwd num tmpdir pra não tocar o checkout.
 */
export function runCodexRefreshProbe(): CodexStatusResult {
  const env = { ...process.env };
  for (const k of CODEX_STRIPPED_ENV_VARS) delete env[k];
  // `model_reasoning_effort="low"` (#10612 review P3): a sonda só precisa de UMA
  // chamada autenticada — effort alto do config.toml gastaria cota e arriscaria
  // estourar o timeout (vira `unchecked`). O modelo NÃO é fixado: forçar `-m`
  // poderia escolher um modelo indisponível pra conta e falhar por outro motivo.
  const args = [
    "exec", "--skip-git-repo-check", "--sandbox", "read-only",
    "-c", 'forced_login_method="chatgpt"', "-c", 'model_reasoning_effort="low"', "-",
  ];
  const opts = {
    encoding: "utf8" as const, timeout: CODEX_REFRESH_PROBE_TIMEOUT_MS, env, cwd: tmpdir(),
    input: CODEX_PROBE_PROMPT, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };
  let r = spawnSync("codex", args, opts);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
    r = spawnSync("codex.cmd", args, { ...opts, shell: true });
  }
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? { code: (r.error as NodeJS.ErrnoException).code, message: r.error.message } : undefined,
  };
}

/** Assinaturas de falha de AUTENTICAÇÃO no output do `codex exec` (#10602, texto medido no 300). */
const CODEX_AUTH_FAILURE_RE = /refresh token|could not be refreshed|sign in again|log ?in again|unauthori[sz]ed|\b401\b|token_expired|invalid_grant/i;
/**
 * Subconjunto INEQUÍVOCO, usado também com exit 0 (#10612 review P2): sem o
 * `401` solto, que com exit 0 pode ser só uma contagem (`tokens used: 401`).
 */
const CODEX_AUTH_FAILURE_STRONG_RE = /refresh token|could not be refreshed|sign in again|log ?in again|unauthori[sz]ed|token_expired|invalid_grant/i;

/**
 * #10602: classifica o resultado da sonda `codex exec`. Pura.
 * - output com assinatura INEQUÍVOCA de auth → `expired`, MESMO com exit 0
 *   (#10612 review P2: uma versão do `codex exec` que imprima "Failed to
 *   refresh token" e encerre o turno com 0 não pode deixar o lock `ok`);
 * - exit 0 → `ok` (o refresh, se era necessário, aconteceu);
 * - exit != 0 com assinatura de auth (incluindo `401` solto) → `expired`
 *   (o caso do issue: status ok + refresh falha);
 * - qualquer outra falha (timeout, rede, limite de uso) → `unchecked`: não
 *   prova que a credencial morreu, então não bloqueia — mas fica visível.
 */
export function classifyCodexRefreshProbe(r: CodexStatusResult, why: string): LockCheckResult {
  const dependency = "Codex CLI (login ChatGPT — image_generator=codex, Stages 1, 3)";
  const out = redactSecrets(`${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim());
  const exitOk = !r.error && r.status === 0;
  const authFailed = exitOk ? CODEX_AUTH_FAILURE_STRONG_RE.test(out) : CODEX_AUTH_FAILURE_RE.test(out);
  if (exitOk && !authFailed) {
    return { dependency, state: "ok", blocks_stages: [], reauth_action: "", detail: `refresh testado via \`codex exec\` (${why}) — ok` };
  }
  if (authFailed) {
    return {
      dependency, state: "expired", blocks_stages: [1, 3],
      reauth_action: "Rodar `codex logout && codex login --device-auth` (conta ChatGPT) nesta máquina — `login status` diz 'Logged in' mas o refresh do token falha",
      detail: `\`codex login status\` ok, mas o refresh falhou (${why}): ${out.slice(-240)}`,
    };
  }
  const reason = r.error?.code === "ETIMEDOUT"
    ? `\`codex exec\` não respondeu em ${CODEX_REFRESH_PROBE_TIMEOUT_MS / 1000}s`
    : `\`codex exec\` saiu com ${r.error ? r.error.message : `exit ${r.status}`}: ${out.slice(-200)}`;
  return {
    dependency, state: "unchecked", blocks_stages: [], reauth_action: "",
    detail: `sonda de refresh inconclusiva (${why}) — ${reason}; se o Stage 1/3 falhar com "Failed to refresh token", rodar \`codex login --device-auth\``,
  };
}

export interface ApiKeyLockOptions {
  /** Injetável em teste — default `platform.config.json` da raiz. */
  configPath?: string;
  /** Injetável em teste — default roda `codex login status` de verdade. */
  runCodexStatus?: () => CodexStatusResult;
  /** #10602: injetável em teste — default lê `~/.codex/auth.json` (sem expor token). */
  readCodexAuth?: () => CodexAuthFreshness;
  /** #10602: injetável em teste — default roda o `codex exec` mínimo de verdade. */
  runCodexProbe?: () => CodexStatusResult;
}

/**
 * Lê `platform.config.json` e verifica a credencial de acordo com `image_generator`.
 * Keys: só presença no env, sem rede. `codex` (#9093): roda `codex login status`
 * com timeout curto — login expirado aparecia só no meio do Stage 1/3. Desde o
 * #10602, com o status ok e o token perto de precisar de refresh, roda também
 * a sonda `codex exec` (o status não detecta refresh token morto). Com
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
    let codex = classifyCodexStatus((opts.runCodexStatus ?? runCodexLoginStatus)());
    if (codex.state === "ok") {
      // #10602: "Logged in" não prova que o refresh funciona — testar quando
      // o token está perto de precisar de refresh (ou o auth.json é opaco).
      const fresh = (opts.readCodexAuth ?? readCodexAuthFreshness)();
      codex = fresh.kind === "fresh"
        ? { ...codex, detail: `${codex.detail} — ${fresh.detail}` }
        : classifyCodexRefreshProbe((opts.runCodexProbe ?? runCodexRefreshProbe)(), fresh.detail);
    }
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
