/**
 * scripts/lib/gdrive-data-bisync-config.ts (#12478)
 *
 * Config do bisync dedicado de `data/` lida pelo lado TS (o alarme
 * `scripts/gdrive-sync-alarm.ts`), com as MESMAS regras do wrapper
 * `scripts/systemd/gdrive-data-bisync.sh`:
 *
 *   - arquivo `~/.config/diaria/gdrive-data-bisync.env` (ou
 *     `GDRIVE_DATA_ENV_FILE`), uma linha `CHAVE=valor` sem aspas, lido linha a
 *     linha e NUNCA executado como shell;
 *   - `#` no início comenta, linha vazia é pulada, `\r` final (CRLF) sai,
 *     linha sem `=` e chave fora da lista viram aviso;
 *   - a 1ª ocorrência de uma chave vence (o wrapper só exporta a chave que
 *     ainda não está definida);
 *   - variável já presente no ambiente vence o arquivo, mesmo vazia (o
 *     wrapper testa `${CHAVE+x}`), e valor vazio cai no default.
 *
 * Sem isto o alarme achava o state dir só pelo ambiente: um
 * `GDRIVE_DATA_STATE_DIR` posto no arquivo fazia o bisync carimbar num lugar
 * e o alarme olhar outro (sinal `not-installed`, mudo). Os defaults abaixo
 * têm paridade travada com o shell em `test/gdrive-data-bisync-12478.test.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Chaves aceitas no arquivo de env (mesma lista do `case` do wrapper). */
export const DATA_BISYNC_ENV_KEYS = [
  "GDRIVE_DATA_REMOTE",
  "GDRIVE_DATA_LOCAL",
  "GDRIVE_DATA_MOUNT",
  "GDRIVE_DATA_FILTERS",
  "GDRIVE_DATA_STATE_DIR",
  "GDRIVE_DATA_WORKDIR",
  "GDRIVE_DATA_MAX_DELETE",
] as const;
export type DataBisyncEnvKey = (typeof DATA_BISYNC_ENV_KEYS)[number];

/** Remote default: conta diaria.editor (#12575), fora do Drive da vjpixel. */
export const DEFAULT_DATA_BISYNC_REMOTE = "gdrive-diaria:diaria-studio-data";
export const DEFAULT_DATA_BISYNC_MOUNT = "/mnt/hd-sata";
/** Pasta local default, relativa ao ponto de montagem. Fica FORA de
 * `/mnt/hd-sata/GoogleDrive` (espelho do bisync do Drive inteiro). */
export const DEFAULT_DATA_BISYNC_LOCAL_REL = "GoogleDrive-diaria/diaria-studio-data";

export interface ParsedDataBisyncEnvFile {
  values: Partial<Record<DataBisyncEnvKey, string>>;
  warnings: string[];
}

export function parseDataBisyncEnvFile(text: string): ParsedDataBisyncEnvFile {
  const values: Partial<Record<DataBisyncEnvKey, string>> = {};
  const warnings: string[] = [];
  const keys = new Set<string>(DATA_BISYNC_ENV_KEYS);
  // `read` do shell parte por `\n`; o `\r` final de cada linha sai depois.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      warnings.push("linha sem '=' ignorada");
      continue;
    }
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);
    if (!keys.has(key)) {
      warnings.push(`chave desconhecida ${key} ignorada`);
      continue;
    }
    const k = key as DataBisyncEnvKey;
    if (!(k in values)) values[k] = val;
  }
  return { values, warnings };
}

export interface DataBisyncConfig {
  envFile: string;
  remote: string;
  mount: string;
  local: string;
  stateDir: string;
  workdir: string;
  warnings: string[];
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Resolve a config efetiva do bisync de `data/` como o wrapper resolveria.
 * `readText` é injetável (teste); o default lê o arquivo se existir. */
export function resolveDataBisyncConfig(
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => string | null = readIfExists,
): DataBisyncConfig {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const envFile =
    env.GDRIVE_DATA_ENV_FILE && env.GDRIVE_DATA_ENV_FILE.length > 0
      ? env.GDRIVE_DATA_ENV_FILE
      : join(home, ".config", "diaria", "gdrive-data-bisync.env");
  const text = readText(envFile);
  const parsed = text === null ? { values: {}, warnings: [] } : parseDataBisyncEnvFile(text);
  const pick = (k: DataBisyncEnvKey): string => {
    if (env[k] !== undefined) return env[k] ?? "";
    return (parsed.values as Record<string, string | undefined>)[k] ?? "";
  };
  const orDefault = (v: string, d: string) => (v.length > 0 ? v : d);
  const mount = orDefault(pick("GDRIVE_DATA_MOUNT"), DEFAULT_DATA_BISYNC_MOUNT);
  const stateDir = orDefault(pick("GDRIVE_DATA_STATE_DIR"), join(home, ".cache", "diaria", "gdrive-data-bisync"));
  return {
    envFile,
    remote: orDefault(pick("GDRIVE_DATA_REMOTE"), DEFAULT_DATA_BISYNC_REMOTE),
    mount,
    local: orDefault(pick("GDRIVE_DATA_LOCAL"), `${mount}/${DEFAULT_DATA_BISYNC_LOCAL_REL}`),
    stateDir,
    workdir: orDefault(pick("GDRIVE_DATA_WORKDIR"), `${stateDir}/rclone-workdir`),
    warnings: parsed.warnings.map((w) => `${w} em ${envFile}`),
  };
}
