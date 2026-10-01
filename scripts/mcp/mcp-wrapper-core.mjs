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
 * mas VAZIO no ambiente conta como ausente (ver `mergeEnvNoOverride`).
 *
 * **Menor privilégio:** do `.env` só entram as chaves listadas pelo wrapper
 * (`pickKeys`), nunca o `.env` inteiro; o ambiente do harness é herdado
 * como está.
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

/** `.env` existe mas não pôde ser lido/parseado — os entrypoints saem com 1. */
export class EnvFileReadError extends Error {}

/**
 * Parse de `.env` (mesmo parser do `loadProjectEnv`). Ausente → `{}` (caso
 * legítimo: clone sem `.env`). Existente mas ilegível → `EnvFileReadError`
 * — engolir isso faria o servidor subir sem credencial, o sintoma do #8994.
 */
export function readEnvFile(path, { exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  if (!exists(path)) return {};
  try {
    return dotenvParse(read(path));
  } catch (err) {
    throw new EnvFileReadError(`[mcp-wrapper] falha ao ler ${path}: ${err?.message ?? String(err)}`);
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
 * Vazio conta como ausente porque uma var exportada vazia (ex.: `set X=` no
 * perfil, ou resíduo de `${VAR}` não resolvido de config antiga) não é
 * credencial nenhuma — deixá-la vencer reproduziria o servidor sem token.
 */
export function mergeEnvNoOverride(base, fileVars) {
  const out = { ...base };
  for (const [k, v] of Object.entries(fileVars)) {
    if (out[k] === undefined || out[k] === "") out[k] = v;
  }
  return out;
}

/**
 * Chaves cujo valor no ambiente (não vazio) difere do `.env` — o ambiente
 * vence (precedência inalterada); isto só alimenta o aviso. Mesma lógica de
 * `warnOnEnvDivergence` (`scripts/lib/env-loader.ts`), reimplementada aqui
 * porque aquela lê o `.env` inteiro e avisaria sobre chaves que o servidor
 * nem recebe (ex.: `GOOGLE_CLIENT_ID` injetado pelo app desktop, #8237).
 */
export function divergentKeys(env, fileVars) {
  return Object.entries(fileVars)
    .filter(([k, v]) => env[k] !== undefined && env[k] !== "" && env[k] !== v)
    .map(([k]) => k);
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

const MATERIALIZE_HINT = "rode `npx tsx scripts/materialize-google-ads-credentials.ts` (ver docs/google-ads-api-setup.md)";

/**
 * Decide como subir o google-ads-mcp. Primeiro a credencial: sem developer
 * token, ou com `GOOGLE_APPLICATION_CREDENTIALS` vazio/apontando pra arquivo
 * inexistente, devolve erro — subir o servidor assim reproduz o #8994.
 * Depois o comando: binário instalado (rápido) ou, se ausente,
 * `pipx run --spec ...` (re-resolve o spec git a cada start — medido no Neo
 * 54,5s com cache frio, acima do timeout de 30s do harness; 9,3s quente).
 */
export function resolveGoogleAdsLaunch(env, { find = (n) => findOnPath(n), exists = existsSync } = {}) {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    return { error: `[run-google-ads-mcp] GOOGLE_ADS_DEVELOPER_TOKEN ausente — adicione ao .env do projeto.` };
  }
  const adc = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!adc) {
    return { error: `[run-google-ads-mcp] GOOGLE_APPLICATION_CREDENTIALS ausente — ${MATERIALIZE_HINT}.` };
  }
  if (!exists(adc)) {
    return {
      error: `[run-google-ads-mcp] GOOGLE_APPLICATION_CREDENTIALS aponta para arquivo inexistente (${adc}) — ${MATERIALIZE_HINT}.`,
    };
  }
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
      `que re-resolve o repo git a cada start e, com cache frio, pode estourar o timeout do harness. ` +
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
 * Ambiente do filho do doppler: tira o `DOPPLER_MCP_TOKEN` cru (o servidor
 * só precisa de `DOPPLER_TOKEN`) e aplica `childEnv` por cima — inclusive
 * sobre um `DOPPLER_TOKEN` herdado de escopo mais amplo.
 */
export function buildDopplerChildEnv(base, childEnv) {
  const { [DOPPLER_MCP_TOKEN_KEY]: _omit, ...rest } = base;
  return { ...rest, ...childEnv };
}

/**
 * Monta o spawn. `.cmd`/`.bat` no Windows não podem ser spawnados sem shell
 * (Node com o patch do CVE-2024-27980 recusa com EINVAL) — passa pelo
 * `cmd.exe` com o caminho entre aspas. Args aqui são sempre constantes
 * nossas (sem entrada externa).
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

/**
 * Carrega do `.env` só `keys`, faz merge sem sobrescrever o ambiente e
 * devolve também as chaves divergentes (pra aviso em stderr, sem valor).
 * Lança `EnvFileReadError` se o `.env` existe mas é ilegível.
 */
export function envWithProjectKeys(keys, { root = PROJECT_ROOT, env = process.env, readFile = readEnvFile } = {}) {
  const fileVars = pickKeys(readFile(join(root, ".env")), keys);
  return { env: mergeEnvNoOverride(env, fileVars), divergent: divergentKeys(env, fileVars) };
}

/**
 * Cola dos entrypoints: carrega o env, avisa divergências (nome da chave,
 * nunca o valor) e converte `EnvFileReadError` em stderr + exit 1.
 */
export function loadEnvOrExit(keys) {
  try {
    const { env, divergent } = envWithProjectKeys(keys);
    for (const k of divergent) {
      process.stderr.write(`[mcp-wrapper] ${k}: ambiente e .env divergem — usando o do ambiente\n`);
    }
    return env;
  } catch (err) {
    if (!(err instanceof EnvFileReadError)) throw err;
    process.stderr.write(err.message + "\n");
    process.exit(1);
  }
}

/**
 * Cola com o processo real: spawn com stdio herdado, repassa sinais e o
 * código de saída. Só stderr para diagnóstico.
 *
 * Limite no Windows: o harness encerra o wrapper via TerminateProcess, que
 * não roda handler de sinal nenhum — o repasse abaixo não acontece e o filho
 * (ou o neto, quando há `cmd.exe` no meio) não é morto por nós. Ele termina
 * sozinho quando o stdin herdado fecha (EOF), que é como servidor MCP stdio
 * encerra. Por isso o guard `!child.killed` só existe no win32 (lá `kill`
 * é TerminateProcess e repetir não acrescenta nada); fora dele, todo sinal
 * recebido é repassado.
 */
export function launch(spec, env) {
  const child = spawn(spec.command, spec.args, { stdio: "inherit", env, ...spec.options });
  const forward = (sig) => {
    if (process.platform === "win32" && child.killed) return;
    child.kill(sig);
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
