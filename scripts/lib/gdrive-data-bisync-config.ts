/**
 * scripts/lib/gdrive-data-bisync-config.ts (#12478)
 *
 * Config do bisync dedicado de `data/` lida pelo lado TS (o alarme
 * `scripts/gdrive-sync-alarm.ts`). As regras são as MESMAS do wrapper
 * `scripts/systemd/gdrive-data-bisync.sh`, reimplementadas aqui: mudou uma,
 * mude a outra. O teste diferencial em `test/gdrive-data-bisync-12478.test.ts`
 * roda o wrapper real e compara o resultado com `resolveDataBisyncConfig`.
 *
 *   - arquivo `~/.config/diaria/gdrive-data-bisync.env` (ou
 *     `GDRIVE_DATA_ENV_FILE`, caminho absoluto), uma linha `CHAVE=valor` sem
 *     aspas, lido linha a linha e NUNCA executado como shell;
 *   - `#` no início comenta, linha vazia (ou só de espaços) é pulada, `\r`
 *     final (CRLF) sai;
 *   - ESTRITO: linha sem `=`, chave malformada (`export X`, espaço antes do
 *     `=`), espaço depois do `=`, BOM, chave fora da lista, chave repetida,
 *     arquivo existente mas ilegível e `GDRIVE_DATA_ENV_FILE` explícito
 *     inexistente são erro de configuração (o wrapper sai 78; o alarme abre
 *     achado). Arquivo default ausente não é erro;
 *   - variável já presente no ambiente vence o arquivo, mesmo vazia (o
 *     wrapper testa `${CHAVE+x}`), e valor vazio cai no default;
 *   - caminhos (LOCAL, MOUNT, FILTERS, STATE_DIR, WORKDIR) precisam ser
 *     absolutos; o remote precisa ser `remote:pasta` com remote diferente do
 *     do bisync grande; a pasta local não pode se sobrepor ao espelho do
 *     Drive inteiro.
 *
 * O alarme acha o state dir por aqui: um `GDRIVE_DATA_STATE_DIR` posto no
 * arquivo vale para o bisync e para o alarme ao mesmo tempo.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

/** Chaves aceitas no arquivo de env (mesma lista de `KEYS` no wrapper). */
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
/** Raiz fixa do espelho do bisync do Drive inteiro (default do gdrive-bisync.sh). */
export const FULL_DRIVE_MIRROR_ROOT = "/mnt/hd-sata/GoogleDrive";
/** Remote default do bisync do Drive inteiro. */
export const FULL_DRIVE_DEFAULT_REMOTE = "gdrive:";
/** Diretório do wrapper (default do filtro de data/). */
export const DEFAULT_DATA_BISYNC_SCRIPT_DIR = join(import.meta.dirname, "..", "systemd");

const BOM = "﻿";
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedDataBisyncEnvFile {
  values: Partial<Record<DataBisyncEnvKey, string>>;
  /** Erros de formato, um por linha problemática (o wrapper para no 1º). */
  errors: string[];
}

export function parseDataBisyncEnvFile(text: string, label = "arquivo de env"): ParsedDataBisyncEnvFile {
  const values: Partial<Record<DataBisyncEnvKey, string>> = {};
  const errors: string[] = [];
  const keys = new Set<string>(DATA_BISYNC_ENV_KEYS);
  // `read` do shell parte por `\n`; o `\r` final de cada linha sai depois.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(BOM)) {
      errors.push(`${label} linha ${n}: BOM no início do arquivo (salve como UTF-8 sem BOM)`);
      return;
    }
    if (line.startsWith("#")) return;
    if (/^[ \t]*$/.test(line)) return;
    const eq = line.indexOf("=");
    if (eq < 0) {
      errors.push(`${label} linha ${n}: sem '='`);
      return;
    }
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      errors.push(`${label} linha ${n}: chave malformada '${key}' (sem espaço, sem 'export')`);
      return;
    }
    if (/^[ \t]/.test(val)) {
      errors.push(`${label} linha ${n}: espaço depois do '=' em ${key}`);
      return;
    }
    if (!keys.has(key)) {
      errors.push(`${label} linha ${n}: chave desconhecida ${key}`);
      return;
    }
    const k = key as DataBisyncEnvKey;
    if (k in values) {
      errors.push(`${label} linha ${n}: chave ${key} repetida`);
      return;
    }
    values[k] = val;
  });
  return { values, errors };
}

export interface DataBisyncConfig {
  envFile: string;
  /** `true` quando veio de `GDRIVE_DATA_ENV_FILE`. */
  envFileExplicit: boolean;
  remote: string;
  /** Nome do remote, com `:` (`gdrive-diaria:`), para `rclone about`. */
  remoteName: string;
  mount: string;
  local: string;
  filters: string;
  stateDir: string;
  workdir: string;
  /** `null` = o default do gdrive-bisync.sh. */
  maxDelete: string | null;
  /** Erros de configuração: o wrapper sairia 78 com qualquer um deles. */
  errors: string[];
}

/** Leitor default: `null` = arquivo ausente; lança se existe e não lê. */
function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) throw new Error("não é um arquivo");
  return readFileSync(path, "utf8");
}

/** Sobreposição por componente de caminho (iguais, um dentro do outro).
 * Resolve `..` como o `realpath -m` do wrapper; symlinks não (o carimbo
 * exit 78 do wrapper cobre esse caso). */
export function pathsOverlap(a: string, b: string): boolean {
  const ca = posix.resolve(a);
  const cb = posix.resolve(b);
  if (ca === "/" || cb === "/") return true;
  return `${ca}/`.startsWith(`${cb}/`) || `${cb}/`.startsWith(`${ca}/`);
}

/** Resolve a config efetiva do bisync de `data/` como o wrapper resolveria.
 * `readText` é injetável (teste): `null` = ausente, exceção = ilegível. */
export function resolveDataBisyncConfig(
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => string | null = readIfExists,
  scriptDir: string = DEFAULT_DATA_BISYNC_SCRIPT_DIR,
): DataBisyncConfig {
  const errors: string[] = [];
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const envFileExplicit = !!(env.GDRIVE_DATA_ENV_FILE && env.GDRIVE_DATA_ENV_FILE.length > 0);
  const envFile = envFileExplicit
    ? (env.GDRIVE_DATA_ENV_FILE as string)
    : join(home, ".config", "diaria", "gdrive-data-bisync.env");
  let values: Partial<Record<DataBisyncEnvKey, string>> = {};
  if (!envFile.startsWith("/")) {
    errors.push(`GDRIVE_DATA_ENV_FILE precisa ser caminho absoluto (${envFile})`);
  } else {
    let text: string | null = null;
    try {
      text = readText(envFile);
    } catch (e) {
      errors.push(`arquivo de env ${envFile} existe mas não é um arquivo legível (${(e as Error).message})`);
    }
    if (text === null && envFileExplicit && errors.length === 0) {
      errors.push(`GDRIVE_DATA_ENV_FILE aponta para ${envFile}, que não existe`);
    }
    if (text !== null) {
      const parsed = parseDataBisyncEnvFile(text, envFile);
      values = parsed.values;
      errors.push(...parsed.errors);
    }
  }
  const pick = (k: DataBisyncEnvKey): string => {
    if (env[k] !== undefined) return env[k] ?? "";
    return values[k] ?? "";
  };
  const orDefault = (v: string, d: string) => (v.length > 0 ? v : d);
  const mount = orDefault(pick("GDRIVE_DATA_MOUNT"), DEFAULT_DATA_BISYNC_MOUNT);
  const remote = orDefault(pick("GDRIVE_DATA_REMOTE"), DEFAULT_DATA_BISYNC_REMOTE);
  const local = orDefault(pick("GDRIVE_DATA_LOCAL"), `${mount}/${DEFAULT_DATA_BISYNC_LOCAL_REL}`);
  const filters = orDefault(pick("GDRIVE_DATA_FILTERS"), `${scriptDir}/gdrive-data-bisync-filters.txt`);
  const stateDir = orDefault(pick("GDRIVE_DATA_STATE_DIR"), `${home}/.cache/diaria/gdrive-data-bisync`);
  const workdir = orDefault(pick("GDRIVE_DATA_WORKDIR"), `${stateDir}/rclone-workdir`);
  const maxDeleteRaw = pick("GDRIVE_DATA_MAX_DELETE");

  for (const [k, v] of [
    ["GDRIVE_DATA_LOCAL", local],
    ["GDRIVE_DATA_MOUNT", mount],
    ["GDRIVE_DATA_FILTERS", filters],
    ["GDRIVE_DATA_STATE_DIR", stateDir],
    ["GDRIVE_DATA_WORKDIR", workdir],
  ] as const) {
    if (!v.startsWith("/")) errors.push(`${k} precisa ser caminho absoluto (${v})`);
  }

  const colon = remote.indexOf(":");
  const name = colon > 0 ? remote.slice(0, colon) : "";
  if (colon <= 0) errors.push(`GDRIVE_DATA_REMOTE precisa ser remote:pasta (${remote})`);
  const bigRemote = env.GDRIVE_REMOTE && env.GDRIVE_REMOTE.length > 0 ? env.GDRIVE_REMOTE : FULL_DRIVE_DEFAULT_REMOTE;
  const bigName = bigRemote.split(":")[0];
  if (name.length > 0 && name === bigName) {
    errors.push(
      `GDRIVE_DATA_REMOTE usa o remote ${name}:, o mesmo do bisync do Drive inteiro — os dois sincronizariam a mesma conta`,
    );
  }

  if (local.startsWith("/")) {
    for (const root of [FULL_DRIVE_MIRROR_ROOT, env.GDRIVE_LOCAL ?? "", env.GDRIVE_DATA_FULL_DRIVE_LOCAL ?? ""]) {
      if (root.length > 0 && pathsOverlap(local, root)) {
        errors.push(`a pasta local de data/ (${local}) se sobrepõe ao espelho do bisync do Drive inteiro (${root})`);
        break;
      }
    }
  }

  return {
    envFile,
    envFileExplicit,
    remote,
    remoteName: `${name}:`,
    mount,
    local,
    filters,
    stateDir,
    workdir,
    maxDelete: maxDeleteRaw.length > 0 ? maxDeleteRaw : null,
    errors,
  };
}
