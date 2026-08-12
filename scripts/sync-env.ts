/**
 * sync-env.ts (#5149, fix pós-review do PR #5150)
 *
 * Baixa o snapshot atual do vault Doppler pra `.env`, escrevendo
 * ATOMICAMENTE (tmp + rename) — nunca deixa `.env` truncado numa falha
 * transitória do Doppler (sessão expirada, rede, projeto/config errado).
 *
 * **Por que isto existe, e não `doppler secrets download ... > .env` puro:**
 * o code-review do PR #5150 achou (e reproduziu ao vivo) que a redireção de
 * shell `>` trunca o arquivo de destino ANTES do comando rodar, independente
 * do exit code — qualquer falha do Doppler zerava as ~40 credenciais em
 * produção. Ver `docs/doppler-env-sync.md`.
 *
 * Uso: `npm run sync-env` (wrapper em package.json).
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Executa o comando Doppler e retorna stdout; lança em exit code != 0. */
export type DopplerRunner = (args: string[]) => string;

export const defaultDopplerRunner: DopplerRunner = (args) =>
  execFileSync("doppler", args, { encoding: "utf8" });

/**
 * Baixa o snapshot do Doppler e escreve em `envPath` só se o download tiver
 * sucesso — se `runner` lançar, `envPath` fica intocado (nunca truncado).
 */
export function syncEnv(envPath: string, runner: DopplerRunner = defaultDopplerRunner): void {
  const tmpPath = `${envPath}.tmp`;
  const content = runner(["secrets", "download", "--no-file", "--format", "env"]);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, envPath);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = resolve(root, ".env");
  const tmpPath = `${envPath}.tmp`;
  try {
    syncEnv(envPath);
    console.log(`.env atualizado a partir do Doppler (${envPath}).`);
  } catch (err) {
    // Limpa um .tmp órfão se o writeFileSync chegou a rodar mas o rename não
    // (cenário raro — writeFileSync/renameSync já são a mesma operação
    // atômica de destino, mas cobre falha entre as duas chamadas).
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    console.error("Falha ao sincronizar .env via Doppler:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
