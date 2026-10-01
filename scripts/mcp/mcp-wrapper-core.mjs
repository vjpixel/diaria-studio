/**
 * mcp-wrapper-core.mjs (#8994) — núcleo puro dos wrappers de MCP stdio
 * declarados em `.mcp.json` (`run-google-ads-mcp.mjs`, `run-doppler-mcp.mjs`).
 *
 * **Por que wrapper e não `${VAR}` direto no `.mcp.json`:** o harness do
 * Claude Code interpola `${VAR}` a partir do ambiente do PROCESSO dele, que
 * nunca carrega o `.env` do projeto. Credencial que só existe no `.env`
 * (caso de `GOOGLE_ADS_*` e `DOPPLER_MCP_TOKEN` no Neo, diagnosticado ao
 * vivo em 30/09/2026) chegava vazia ao servidor: o `doppler` fechava a
 * conexão (`CONNECTION_CLOSED`) e o `google-ads` subia sem credencial. O
 * wrapper lê o `.env` ele mesmo, com a mesma precedência de
 * `scripts/lib/env-loader.ts` (`loadProjectEnv`): var já presente no
 * ambiente vence, o `.env` só preenche o que falta.
 *
 * **Diferença deliberada em relação ao `loadProjectEnv`:** valor presente
 * mas VAZIO no ambiente conta como ausente. `${VAR}` não resolvido vira
 * string vazia no harness, e é exatamente esse vazio que o `.env` precisa
 * preencher aqui.
 *
 * **Menor privilégio:** o filho só recebe do `.env` as chaves que o servidor
 * de fato usa (`pickKeys`), nunca o `.env` inteiro — o processo do MCP não
 * tem por que enxergar a key da Brevo.
 *
 * **Invariante de stdio:** é MCP sobre stdio — NADA aqui escreve em stdout.
 * Toda mensagem de diagnóstico vai pra stderr; stdout é do servidor.
 *
 * Tudo aqui é puro (fs/env/plataforma injetáveis) e testado em
 * `test/mcp-wrapper-core.test.ts`. Os entrypoints só fazem a cola com o
 * processo real (`launch`).
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, win32 as pathWin32, posix as pathPosix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";

/** Root do projeto: 2 níveis acima de `scripts/mcp/` — independe do cwd com que o harness spawna. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Spec git do google-ads-mcp — o mesmo que `pipx install` recebe. */
export const GOOGLE_ADS_MCP_SPEC = "git+https://github.com/googleads/google-ads-mcp.git";
export const GOOGLE_ADS_MCP_BIN = "google-ads-mcp";

/** Chaves do `.env` repassadas ao servidor google-ads (ADC + config da conta). */
export const GOOGLE_ADS_ENV_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

export const DOPPLER_MCP_TOKEN_KEY = "DOPPLER_MCP_TOKEN";

/** Parse de `.env` (mesmo parser do `loadProjectEnv`). Arquivo ilegível → `{}`. */
export function readEnvFile(path, { exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  if (!exists(path)) return {};
  try {
    return dotenvParse(read(path));
  } catch {
    return {};
  }
}

/** Mantém só as chaves pedidas (menor privilégio). */
export function pickKeys(vars, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(vars, k)) out[k] = vars[k];
  return out;
}

/**
 * Merge sem sobrescrever: chave presente e NÃO vazia em `base` vence;
 * ausente ou vazia é preenchida por `fileVars`. Retorna objeto novo.
 */
export function mergeEnvNoOverride(base, fileVars) {
  const out = { ...base };
  for (const [k, v] of Object.entries(fileVars)) {
    if (out[k] === undefined || out[k] === "") out[k] = v;
  }
  return out;
}

/**
 * Procura um executável no PATH. No Windows testa as extensões de PATHEXT
 * (`google-ads-mcp.exe`, `npx.cmd`). Retorna o caminho absoluto ou `null`.
 */
export function findOnPath(name, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const pathVar = isWin ? (env.Path ?? env.PATH ?? env.path ?? "") : (env.PATH ?? "");
  const dirs = pathVar.split(isWin ? ";" : ":").filter(Boolean);
  // No Windows só nome COM extensão executável conta (o `npx` sem extensão é script sh).
  const exts = isWin
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir.replace(/^"|"$/g, ""), name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Decide como subir o google-ads-mcp: binário instalado (rápido) ou, se
 * ausente, `pipx run --spec ...` (re-resolve o spec git a cada start —
 * medido 11s com cache quente; frio pode estourar os 30s do harness).
 */
export function resolveGoogleAdsLaunch({ find = (n) => findOnPath(n) } = {}) {
  const bin = find(GOOGLE_ADS_MCP_BIN);
  if (bin) return { command: bin, args: [], warning: null };
  const pipx = find("pipx");
  if (!pipx) {
    return {
      error:
        `[run-google-ads-mcp] nem "${GOOGLE_ADS_MCP_BIN}" nem "pipx" estão no PATH. ` +
        `Instale com: pipx install ${GOOGLE_ADS_MCP_SPEC}`,
    };
  }
  return {
    command: pipx,
    args: ["run", "--spec", GOOGLE_ADS_MCP_SPEC, GOOGLE_ADS_MCP_BIN],
    warning:
      `[run-google-ads-mcp] "${GOOGLE_ADS_MCP_BIN}" não está instalado — caindo em "pipx run --spec", ` +
      `que re-resolve o repo git a cada start e pode estourar o timeout de 30s do harness. ` +
      `Recomendado: pipx install ${GOOGLE_ADS_MCP_SPEC}`,
  };
}

/**
 * Decide como subir o MCP do Doppler. Sem `DOPPLER_MCP_TOKEN` (ambiente ou
 * `.env`), devolve erro — subir o servidor com token vazio é o que fazia o
 * harness reportar só `CONNECTION_CLOSED`, sem dizer o porquê.
 * O token vira `DOPPLER_TOKEN` só no ambiente do filho; nunca cai para um
 * `DOPPLER_TOKEN` pré-existente (escopo mais amplo — ver docs/setup.md 5a).
 */
export function resolveDopplerLaunch(env, { find = (n) => findOnPath(n) } = {}) {
  const token = env[DOPPLER_MCP_TOKEN_KEY];
  if (!token) {
    return {
      error:
        `[run-doppler-mcp] ${DOPPLER_MCP_TOKEN_KEY} ausente — adicione ao .env do projeto ` +
        `(Service Token SOMENTE LEITURA dedicado, ver docs/setup.md passo 5a).`,
    };
  }
  const npx = find("npx");
  if (!npx) return { error: `[run-doppler-mcp] "npx" não está no PATH.` };
  return {
    command: npx,
    args: ["-y", "@dopplerhq/mcp-server", "--read-only"],
    childEnv: { DOPPLER_TOKEN: token },
  };
}

/**
 * Monta o spawn. `.cmd`/`.bat` no Windows não podem ser spawnados sem shell
 * (Node ≥20 recusa com EINVAL) — passa pelo `cmd.exe` com o caminho entre
 * aspas. Args aqui são sempre constantes nossas (sem entrada externa).
 */
export function buildSpawnSpec(command, args, { platform = process.platform, env = process.env } = {}) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const line = [`"${command}"`, ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(" ");
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command, args, options: {} };
}

/** Carrega do `.env` só `keys` e faz merge sem sobrescrever o ambiente. */
export function envWithProjectKeys(keys, { root = PROJECT_ROOT, env = process.env, readFile = readEnvFile } = {}) {
  return mergeEnvNoOverride(env, pickKeys(readFile(join(root, ".env")), keys));
}

/**
 * Cola com o processo real: spawn com stdio herdado, repassa sinais e o
 * código de saída. Só stderr para diagnóstico.
 */
export function launch(spec, env) {
  const child = spawn(spec.command, spec.args, { stdio: "inherit", env, ...spec.options });
  const forward = (sig) => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("error", (err) => {
    process.stderr.write(`[mcp-wrapper] falha ao iniciar ${spec.command}: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
  return child;
}
