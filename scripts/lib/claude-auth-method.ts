/**
 * scripts/lib/claude-auth-method.ts (#11887)
 *
 * Preflight de MÉTODO DE AUTENTICAÇÃO do CLI `claude` para os runners
 * headless (`run-nightly-chain.ts`, `run-scheduled-edicao.ts`).
 *
 * A regra #5608 do CLAUDE.md proíbe qualquer sessão de Claude Code do projeto
 * de autenticar pela API pay-per-token (custo + conectores claude.ai
 * desligados). `claudeCliEnv` já tira as vars de API do ambiente do filho, mas
 * isso não cobre a credencial GRAVADA: em 02/11/2026 o CLI interativo do `300`
 * mostrou "API Usage Billing" sem nenhuma var `ANTHROPIC_*` no ambiente
 * (#11887). Este módulo pergunta ao próprio CLI (`claude auth status`, sem
 * custo de tokens) com o MESMO ambiente que o filho vai receber, e o runner
 * não sobe a sessão se a resposta não for a assinatura.
 *
 * **Valores de `authMethod`** — lidos do bundle do CLI 2.1.310 em 02/11/2026
 * (função que monta o JSON de `auth status`): `claude.ai`, `oauth_token`,
 * `api_key`, `api_key_helper`, `third_party`, `none`. Junto vem
 * `apiKeySource` quando existe uma fonte de key: `ANTHROPIC_API_KEY` (var de
 * ambiente aprovada), `/login managed key` (`primaryApiKey` gravado em
 * `~/.claude.json` por um `/login` com conta do Console) ou `apiKeyHelper`.
 * No mesmo bundle, uma fonte de key presente REBAIXA o token claude.ai para
 * `none` (`tokenSource` vira `none` quando `apiKey` existe), ou seja: basta
 * uma key gravada para o CLI preferi-la mesmo com `.credentials.json` válido.
 * É a leitura mais provável do #11887 (credencial `.credentials.json`
 * presente, cabeçalho "API Usage Billing"), registrada como hipótese em
 * `docs/overnight-nightly-chain.md`.
 *
 * **Política:**
 *   - `claude.ai` → `subscription`.
 *   - `oauth_token` → `subscription` só quando a fonte é `CLAUDE_CODE_OAUTH_TOKEN`
 *     (token de assinatura do `claude setup-token`) e não há
 *     `ANTHROPIC_AUTH_TOKEN` no ambiente — o mesmo rótulo cobre o par
 *     `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` de gateway (#6714).
 *   - `apiProvider` diferente de `firstParty` (Bedrock, Vertex, gateway) ou
 *     qualquer outro `authMethod`, inclusive um rótulo novo → `not-subscription`.
 *     Estrito de propósito: um rótulo renomeado numa versão futura do CLI
 *     para a cadeia com um alarme legível, e o conserto é acrescentar o rótulo
 *     aqui; aceitar o desconhecido deixaria passar justamente o caso da issue.
 *   - `loggedIn: false` / `authMethod: none` → `logged-out`.
 *   - binário ausente, timeout, saída que não é JSON, JSON sem `authMethod`
 *     → `unknown` (o runner só avisa: o preflight não pode virar causa de
 *     parada quando ele mesmo não concluiu).
 *
 * **Sem segredo no log.** Do JSON de `auth status` só saem `loggedIn`,
 * `authMethod`, `apiProvider`, `apiKeySource` (rótulo, não a key) e
 * `subscriptionType`; e-mail/org nunca. A coleta de evidência
 * (`collectClaudeAuthEvidence`) lê só NOMES de vars e PRESENÇA de chaves nos
 * arquivos de config, nunca valores.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Exit dos runners quando o CLI não está na assinatura claude.ai. Fora de `successExitCodes`: a unit sai `failed`. */
export const EXIT_AUTH_NOT_SUBSCRIPTION = 7;

/** Único `authMethod` aceito sem condição (capturado ao vivo em 20/10/2026, #10597, e de novo em 02/11/2026). */
export const SUBSCRIPTION_AUTH_METHOD = "claude.ai";

/**
 * Vars cuja PRESENÇA (nunca o valor) entra na evidência: as de
 * `CLAUDE_CLI_STRIPPED_ENV_VARS` que mexem em auth + as que o bundle do CLI
 * consulta para escolher a fonte de credencial.
 */
export const AUTH_ENV_VAR_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CONFIG_DIR",
] as const;

export type ClaudeAuthStatus = "subscription" | "not-subscription" | "logged-out" | "unknown";

/** Campos não sensíveis do `auth status`. */
export interface ClaudeAuthFields {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  apiKeySource?: string;
  subscriptionType?: string | null;
}

export interface ClaudeAuthResult {
  status: ClaudeAuthStatus;
  fields: ClaudeAuthFields;
  /** Linha pronta pro log do runner. */
  message: string;
}

/** true = o runner NÃO sobe a sessão. */
export function authBlocksRun(r: ClaudeAuthResult): boolean {
  return r.status === "not-subscription" || r.status === "logged-out";
}

function pickFields(parsed: Record<string, unknown>): ClaudeAuthFields {
  const f: ClaudeAuthFields = {};
  if (typeof parsed.loggedIn === "boolean") f.loggedIn = parsed.loggedIn;
  if (typeof parsed.authMethod === "string") f.authMethod = parsed.authMethod;
  if (typeof parsed.apiProvider === "string") f.apiProvider = parsed.apiProvider;
  if (typeof parsed.apiKeySource === "string") f.apiKeySource = parsed.apiKeySource;
  if (typeof parsed.subscriptionType === "string" || parsed.subscriptionType === null) {
    f.subscriptionType = parsed.subscriptionType as string | null;
  }
  return f;
}

function describe(f: ClaudeAuthFields): string {
  const parts = [`authMethod=${f.authMethod ?? "?"}`, `apiProvider=${f.apiProvider ?? "?"}`];
  if (f.apiKeySource) parts.push(`apiKeySource=${f.apiKeySource}`);
  if (f.subscriptionType) parts.push(`subscriptionType=${f.subscriptionType}`);
  return parts.join(" ");
}

const FIX_HINT =
  "nunca configure key nem crédito (#5608): remova a fonte de auth da API (var no ambiente/settings `env`, " +
  "`apiKeyHelper`, `primaryApiKey` em ~/.claude.json) e rode `claude /login` com a assinatura";

/**
 * Classifica a saída de `claude auth status` (JSON). Pura.
 *
 * `envNames`: nomes de var presentes no ambiente da sondagem — desempata o
 * `oauth_token` (ver docstring do módulo).
 */
export function classifyClaudeAuthStatus(raw: string, envNames: ReadonlySet<string> = new Set()): ClaudeAuthResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unknown", fields: {}, message: "auth do CLI NÃO VERIFICÁVEL — `claude auth status` não devolveu JSON (#11887)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unknown", fields: {}, message: "auth do CLI NÃO VERIFICÁVEL — `claude auth status` devolveu JSON que não é objeto (#11887)" };
  }
  const f = pickFields(parsed as Record<string, unknown>);
  if (f.loggedIn === false || f.authMethod === "none") {
    return {
      status: "logged-out",
      fields: f,
      message: `auth do CLI: SEM SESSÃO (${describe(f)}) — rode \`claude /login\` com a assinatura (#11887)`,
    };
  }
  if (f.authMethod === undefined) {
    return { status: "unknown", fields: f, message: `auth do CLI NÃO VERIFICÁVEL — JSON sem authMethod (${describe(f)}) (#11887)` };
  }
  if (f.apiProvider !== undefined && f.apiProvider !== "firstParty") {
    return {
      status: "not-subscription",
      fields: f,
      message: `auth do CLI NÃO É A ASSINATURA (${describe(f)}): provider de terceiro — ${FIX_HINT} (#11887)`,
    };
  }
  if (f.authMethod === SUBSCRIPTION_AUTH_METHOD) {
    return { status: "subscription", fields: f, message: `auth do CLI: assinatura claude.ai (${describe(f)})` };
  }
  if (
    f.authMethod === "oauth_token" &&
    !envNames.has("ANTHROPIC_AUTH_TOKEN") &&
    (envNames.has("CLAUDE_CODE_OAUTH_TOKEN") || envNames.has("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"))
  ) {
    return {
      status: "subscription",
      fields: f,
      message: `auth do CLI: token de assinatura via CLAUDE_CODE_OAUTH_TOKEN (${describe(f)})`,
    };
  }
  return {
    status: "not-subscription",
    fields: f,
    message: `auth do CLI NÃO É A ASSINATURA (${describe(f)}) — ${FIX_HINT} (#11887)`,
  };
}

/** Nomes (só nomes) das vars de auth presentes e não vazias em `env`. */
export function presentAuthEnvNames(env: NodeJS.ProcessEnv): string[] {
  return AUTH_ENV_VAR_NAMES.filter((k) => typeof env[k] === "string" && env[k] !== "");
}

export interface CheckClaudeAuthOptions {
  execFn?: typeof execFileSync;
  timeoutMs?: number;
}

/**
 * Roda `claude auth status --json` com `env` (o ambiente que o filho vai
 * receber) e classifica. Nunca lança.
 *
 * O CLI sai != 0 sem sessão; se o stdout do erro trouxer JSON, ele é
 * classificado normalmente; se não, código numérico != 0 vira `logged-out`
 * (mesma leitura do #10597). ENOENT/timeout → `unknown`.
 */
export function checkClaudeAuthMethod(
  claudeBin: string,
  env: NodeJS.ProcessEnv,
  opts: CheckClaudeAuthOptions = {},
): ClaudeAuthResult {
  const execFn = opts.execFn ?? execFileSync;
  const envNames = new Set(presentAuthEnvNames(env));
  let raw: string;
  try {
    raw = String(
      execFn(claudeBin, ["auth", "status", "--json"], {
        encoding: "utf8",
        env,
        timeout: opts.timeoutMs ?? 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    const err = e as { status?: number | null; code?: string; message?: string; stdout?: unknown };
    const out = err.stdout == null ? "" : String(err.stdout);
    if (out.trim().startsWith("{")) {
      const r = classifyClaudeAuthStatus(out, envNames);
      if (r.status !== "unknown") return r;
    }
    if (typeof err.status === "number" && err.status !== 0) {
      return {
        status: "logged-out",
        fields: {},
        message: `auth do CLI: SEM SESSÃO (\`claude auth status\` saiu ${err.status}) — rode \`claude /login\` com a assinatura (#11887)`,
      };
    }
    return {
      status: "unknown",
      fields: {},
      message: `auth do CLI NÃO VERIFICÁVEL — \`claude auth status\` não concluiu (${err.code ?? err.message ?? "erro desconhecido"}) (#11887)`,
    };
  }
  return classifyClaudeAuthStatus(raw, envNames);
}

/** Evidência não sensível de ONDE pode estar a fonte de auth da API. */
export interface ClaudeAuthEvidence {
  /** Vars de auth presentes no ambiente sondado (só nomes). */
  envVars: string[];
  /** `primaryApiKey` presente no `.claude.json` global (key gravada por `/login` com conta do Console). */
  globalConfigPrimaryApiKey: boolean | null;
  /** Quantas keys de `ANTHROPIC_API_KEY` já foram APROVADAS no prompt do CLI (`customApiKeyResponses.approved`). */
  globalConfigApprovedEnvKeys: number | null;
  /** Arquivos de settings com `apiKeyHelper` ou com var de auth no bloco `env` (caminho → o que tem). */
  settings: Array<{ path: string; apiKeyHelper: boolean; envVars: string[] }>;
  /** `.credentials.json` existe (só existência; o conteúdo é token). */
  credentialsFile: boolean;
}

export interface CollectEvidenceOptions {
  env: NodeJS.ProcessEnv;
  repoRootAbs: string;
  home?: string;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}

function safeJson(read: (p: string) => string, path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(read(path)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Lê PRESENÇA de fontes de auth nos lugares que o CLI consulta. Nunca devolve
 * valor de key/token. Arquivo ausente ou ilegível simplesmente não entra.
 */
export function collectClaudeAuthEvidence(opts: CollectEvidenceOptions): ClaudeAuthEvidence {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const configDir = opts.env.CLAUDE_CONFIG_DIR;
  const claudeDir = configDir ?? join(home, ".claude");
  const globalConfigPath = configDir ? join(configDir, ".claude.json") : join(home, ".claude.json");

  const global = exists(globalConfigPath) ? safeJson(read, globalConfigPath) : null;
  let approved: number | null = null;
  if (global) {
    const resp = global.customApiKeyResponses as { approved?: unknown } | undefined;
    approved = Array.isArray(resp?.approved) ? resp.approved.length : 0;
  }

  const settingsPaths = [
    join(claudeDir, "settings.json"),
    join(claudeDir, "settings.local.json"),
    join(opts.repoRootAbs, ".claude", "settings.json"),
    join(opts.repoRootAbs, ".claude", "settings.local.json"),
    "/etc/claude-code/managed-settings.json",
  ];
  const settings: ClaudeAuthEvidence["settings"] = [];
  for (const p of settingsPaths) {
    if (!exists(p)) continue;
    const s = safeJson(read, p);
    if (!s) continue;
    const envBlock = s.env && typeof s.env === "object" ? (s.env as Record<string, unknown>) : {};
    const envVars = AUTH_ENV_VAR_NAMES.filter((k) => k in envBlock);
    const apiKeyHelper = typeof s.apiKeyHelper === "string" && s.apiKeyHelper !== "";
    if (apiKeyHelper || envVars.length > 0) settings.push({ path: p, apiKeyHelper, envVars });
  }

  return {
    envVars: presentAuthEnvNames(opts.env),
    globalConfigPrimaryApiKey: global ? typeof global.primaryApiKey === "string" && global.primaryApiKey !== "" : null,
    globalConfigApprovedEnvKeys: approved,
    settings,
    credentialsFile: exists(join(claudeDir, ".credentials.json")),
  };
}

/** Uma linha de evidência pro log (sem valores). */
export function formatClaudeAuthEvidence(e: ClaudeAuthEvidence): string {
  const s = e.settings.length
    ? e.settings.map((x) => `${x.path}[${[x.apiKeyHelper ? "apiKeyHelper" : "", ...x.envVars].filter(Boolean).join(",")}]`).join(" ")
    : "nenhum";
  return (
    `evidência de auth: env=[${e.envVars.join(",") || "nenhuma"}] ` +
    `primaryApiKey=${e.globalConfigPrimaryApiKey ?? "?"} ` +
    `keysAprovadas=${e.globalConfigApprovedEnvKeys ?? "?"} ` +
    `settings=${s} credentialsFile=${e.credentialsFile}`
  );
}
