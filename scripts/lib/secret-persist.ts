/**
 * secret-persist.ts (#10786) — grava segredos no Doppler e no `.env` local.
 *
 * Movido de `scripts/linkedin-personal-oauth.ts`, onde nasceu (#9568). Os
 * setups de OAuth do YouTube e do token de página do Facebook importavam
 * estes helpers DE OUTRO SCRIPT: funcionava só por causa do guard de main, e
 * um efeito colateral futuro no topo do script do LinkedIn quebraria os dois
 * sem aviso. Aqui é módulo de lib, sem efeito no import.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { upsertEnvVar } from "./google-ads-credentials.ts";

export type DopplerSet = (name: string, value: string) => { ok: boolean; error?: string };

export type DopplerSpawn = (
  bin: string,
  args: string[],
  opts: { input: string; shell: boolean },
) => { error?: (Error & { code?: string }) | undefined; status: number | null; stderr: string };

const realSpawn: DopplerSpawn = (bin, args, opts) => {
  const r = spawnSync(bin, args, { input: opts.input, encoding: "utf8", shell: opts.shell });
  return { error: r.error as (Error & { code?: string }) | undefined, status: r.status, stderr: r.stderr ?? "" };
};

/**
 * Monta o `DopplerSet` com a mesma resolução de binário de `scripts/sync-env.ts`
 * (#8795, `defaultDopplerRunner`): `DOPPLER_BIN` quando setada (só ela);
 * senão `doppler` do PATH e, se ele não existir (ENOENT — shell não-login de
 * systemd/SSH não lê `~/.profile`), `~/.local/bin/doppler`. Injetável para teste.
 */
export function makeDopplerSet(deps: {
  spawn?: DopplerSpawn;
  env?: Record<string, string | undefined>;
  fallbackPath?: string;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
} = {}): DopplerSet {
  const spawn = deps.spawn ?? realSpawn;
  const env = deps.env ?? process.env;
  const fallbackPath = deps.fallbackPath ?? resolve(homedir(), ".local", "bin", "doppler");
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  return (name, value) => {
    const args = ["secrets", "set", name, "--silent"];
    const override = env.DOPPLER_BIN?.trim();
    let r = override
      ? spawn(override, args, { input: value, shell: false })
      : spawn("doppler", args, { input: value, shell: platform === "win32" });
    if (!override && r.error?.code === "ENOENT" && exists(fallbackPath)) {
      r = spawn(fallbackPath, args, { input: value, shell: false });
    }
    if (r.error || r.status !== 0) {
      // stderr do Doppler (sem o valor — ele foi pelo stdin) explica a causa:
      // `doppler login` vencido, ou diretório sem `doppler setup` (projeto/config).
      return { ok: false, error: (r.error?.message ?? (r.stderr || "").trim()) || `exit ${r.status}` };
    }
    return { ok: true };
  };
}

/** `doppler secrets set NAME --silent` com o valor pelo stdin (nunca na linha de comando). */
export const defaultDopplerSet: DopplerSet = makeDopplerSet();

export type PersistResult = { doppler: string[]; dopplerFailed: string[]; dopplerErrors: string[]; envWritten: boolean };

/**
 * Grava os segredos no Doppler e no `.env`. Falha do Doppler não aborta o
 * `.env` (o token vale nesta máquina), mas é reportada: sem Doppler o `300`
 * nunca recebe o token. Pura em relação ao I/O (tudo injetado).
 */
export function persistSecrets(args: {
  secrets: Record<string, string>;
  dopplerSet: DopplerSet;
  envPath: string;
  readEnv: (p: string) => string | null;
  writeEnv: (p: string, content: string) => void;
}): PersistResult {
  const doppler: string[] = [];
  const dopplerFailed: string[] = [];
  const dopplerErrors: string[] = [];
  for (const [name, value] of Object.entries(args.secrets)) {
    const r = args.dopplerSet(name, value);
    if (r.ok) doppler.push(name);
    else {
      dopplerFailed.push(name);
      if (r.error && !dopplerErrors.includes(r.error)) dopplerErrors.push(r.error);
    }
  }
  let content = args.readEnv(args.envPath) ?? "";
  for (const [name, value] of Object.entries(args.secrets)) content = upsertEnvVar(content, name, value);
  args.writeEnv(args.envPath, content.endsWith("\n") ? content : content + "\n");
  return { doppler, dopplerFailed, dopplerErrors, envWritten: true };
}
