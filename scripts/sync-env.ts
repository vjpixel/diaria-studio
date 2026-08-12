/**
 * sync-env.ts (#5149, fix pós-review do PR #5150; backup + guard local-only #5155)
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
 * **#5155 — duas proteções adicionais, achadas na mesma incidência que o
 * #5150 (uma chave viva — `ANTHROPIC_API_KEY` — sobrevivia só no `.env`
 * local, nunca tinha sido posta no vault, e o primeiro `sync-env` bem-
 * sucedido a apagou silenciosamente):**
 *
 * 1. **Backup de 1 nível (`.env.bak`).** Antes de sobrescrever um `.env`
 *    existente, o conteúdo atual é copiado pra `.env.bak` (sobrescrevendo
 *    qualquer backup anterior). Escolha deliberada de retenção rasa — o
 *    caso de uso é "desfazer o ÚLTIMO sync" (rodou por engano, vault estava
 *    desatualizado), não arqueologia de N gerações; um histórico mais fundo
 *    acumularia arquivo sem necessidade real e sem rotação.
 *
 * 2. **Guard de chave só-local.** Antes de sobrescrever, comparamos as
 *    CHAVES (nunca os valores) do `.env` atual contra as do snapshot
 *    baixado. Se alguma chave existe só localmente, o sync ABORTA sem
 *    tocar `.env` — nunca faz merge silencioso nem escolhe sozinho o que
 *    preservar. Optamos por abortar (exigindo `--force` explícito pra
 *    prosseguir mesmo assim) em vez de mesclar automaticamente: merge
 *    esconderia o motivo mais comum do drift (a chave foi de fato removida
 *    do vault de propósito, e o guard estaria mascarando isso indefinidamente
 *    em vez de forçar uma decisão consciente a cada ocorrência). Abortar é
 *    também a opção mais simples de implementar sem introduzir um formato de
 *    merge próprio (comentários do Doppler, ordem de chaves, etc.).
 *
 * Uso: `npm run sync-env` (wrapper em package.json). `npm run sync-env -- --force`
 * ignora o guard de chave só-local e sobrescreve mesmo assim (ainda com backup).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Executa o comando Doppler e retorna stdout; lança em exit code != 0. */
export type DopplerRunner = (args: string[]) => string;

export const defaultDopplerRunner: DopplerRunner = (args) =>
  execFileSync("doppler", args, { encoding: "utf8" });

export interface SyncEnvOptions {
  /** Ignora o guard de chave só-local e sobrescreve mesmo assim. */
  force?: boolean;
}

/**
 * Lançado quando o `.env` local tem chave(s) ausentes no snapshot do
 * Doppler e `force` não foi passado. `keys` traz só os NOMES das variáveis
 * — nunca os valores (podem ser segredos).
 */
export class LocalOnlyEnvKeysError extends Error {
  constructor(public readonly keys: string[]) {
    super(
      `.env local tem ${keys.length} chave(s) ausente(s) no snapshot do Doppler: ${keys.join(", ")}. ` +
        `Sync abortado pra não apagar credencial silenciosamente — adicione a(s) chave(s) ao vault ` +
        `(doppler secrets set) ou rode de novo com --force pra sobrescrever mesmo assim (a(s) chave(s) some(m) do .env, mas fica(m) preservada(s) em .env.bak).`,
    );
    this.name = "LocalOnlyEnvKeysError";
  }
}

/** Extrai o conjunto de nomes de variável (`KEY=`) de um conteúdo `.env`-like. */
function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    let key = line.slice(0, eqIndex).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Baixa o snapshot do Doppler e escreve em `envPath` só se o download tiver
 * sucesso — se `runner` lançar, `envPath` fica intocado (nunca truncado).
 *
 * Se `envPath` já existe: (1) aborta com `LocalOnlyEnvKeysError` — sem tocar
 * `envPath` — quando há chave presente só localmente e `options.force` não
 * foi passado; (2) caso contrário, faz backup do conteúdo atual em
 * `${envPath}.bak` antes de sobrescrever.
 */
export function syncEnv(
  envPath: string,
  runner: DopplerRunner = defaultDopplerRunner,
  options: SyncEnvOptions = {},
): void {
  const tmpPath = `${envPath}.tmp`;
  const backupPath = `${envPath}.bak`;
  const content = runner(["secrets", "download", "--no-file", "--format", "env"]);

  if (existsSync(envPath)) {
    const existingContent = readFileSync(envPath, "utf8");

    if (!options.force) {
      const localKeys = parseEnvKeys(existingContent);
      const remoteKeys = parseEnvKeys(content);
      const localOnlyKeys = [...localKeys].filter((key) => !remoteKeys.has(key));
      if (localOnlyKeys.length > 0) {
        console.warn(
          `[sync-env] Chave(s) só-local (ausente(s) no Doppler), .env NÃO sobrescrito: ${localOnlyKeys.join(", ")}`,
        );
        throw new LocalOnlyEnvKeysError(localOnlyKeys);
      }
    }

    writeFileSync(backupPath, existingContent, "utf8");
  }

  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, envPath);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = resolve(root, ".env");
  const tmpPath = `${envPath}.tmp`;
  const force = process.argv.includes("--force");
  try {
    syncEnv(envPath, defaultDopplerRunner, { force });
    console.log(`.env atualizado a partir do Doppler (${envPath}).`);
  } catch (err) {
    // Limpa um .tmp órfão se o writeFileSync chegou a rodar mas o rename não
    // (cenário raro — writeFileSync/renameSync já são a mesma operação
    // atômica de destino, mas cobre falha entre as duas chamadas).
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    if (err instanceof LocalOnlyEnvKeysError) {
      console.error(err.message);
    } else {
      console.error("Falha ao sincronizar .env via Doppler:", err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
