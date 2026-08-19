/**
 * sync-env.ts (#5149, fix pós-review do PR #5150; backup + guard local-only #5155)
 *
 * Baixa o snapshot atual do vault Doppler pra `.env`, escrevendo
 * ATOMICAMENTE (tmp + rename) — nunca deixa `.env` truncado numa falha
 * transitória do Doppler (sessão expirada, rede, projeto/config errado).
 * Achado do code-review do PR #5150 (reproduzido ao vivo ali, não incidente
 * em produção): `doppler secrets download ... > .env` puro trunca o arquivo
 * de destino antes do comando rodar, independente do exit code.
 *
 * **#5155 — incidente em produção**, achado ao rodar pela primeira vez numa
 * 2ª máquina o `sync-env` do #5150: `ANTHROPIC_API_KEY` — viva só no `.env`
 * local, nunca posta no vault — foi apagada em silêncio pelo 1º sync
 * bem-sucedido ali (sem backup, sem checagem de chave só-local). Duas
 * proteções adicionais, na ordem em que de fato executam (o abort do guard
 * nunca chega no backup):
 *
 * 1. Guard de chave só-local — aborta com `LocalOnlyEnvKeysError` antes de
 *    tocar `.env`/`.env.bak` quando alguma chave existe só no `.env` local.
 * 2. Backup de 1 nível em `.env.bak` (retenção rasa, sobrescreve o
 *    anterior), escrito atomicamente (tmp + rename), antes de sobrescrever
 *    `.env` — só roda se o guard acima não abortou.
 *
 * Ver `docs/doppler-env-sync.md` pro mecanismo completo (setup, racional de
 * abortar em vez de mesclar, caminho inverso pra subir chave pro vault).
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
  /**
   * Ignora o guard de chave só-local e sobrescreve mesmo assim. O backup em
   * `.env.bak` acontece de qualquer forma, com `force: true` ou sem — a
   * chave só-local não sobrevive no `.env` final, mas continua recuperável
   * no backup.
   */
  force?: boolean;
}

/**
 * Lançado quando o `.env` local tem chave(s) ausentes no snapshot do
 * Doppler e `force` não foi passado. `keys` traz só os NOMES das variáveis
 * — nunca os valores (podem ser segredos).
 */
export class LocalOnlyEnvKeysError extends Error {
  constructor(public readonly keys: readonly string[]) {
    super(
      `.env local tem ${keys.length} chave(s) ausente(s) no snapshot do Doppler: ${keys.join(", ")}. ` +
        `Sync abortado pra não apagar credencial silenciosamente — adicione a(s) chave(s) ao vault ` +
        `(doppler secrets set) ou rode de novo com --force pra sobrescrever mesmo assim (a(s) chave(s) some(m) do .env, mas fica(m) preservada(s) em .env.bak).`,
    );
    this.name = "LocalOnlyEnvKeysError";
  }
}

/**
 * Lançado quando falha uma operação LOCAL da fase pós-download (ler o
 * `.env` existente antes do backup, ou escrever `.env.bak`) — nunca uma
 * falha do Doppler. Distinguir a fase evita mandar o operador investigar
 * login/rede/config do Doppler por um erro que não tem nada a ver com isso
 * (ex: `.env.bak` sem permissão de escrita, disco cheio).
 */
export class EnvBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvBackupError";
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
 * `envPath`/`.env.bak` — quando há chave presente só localmente e
 * `options.force` não foi passado; (2) caso contrário, faz backup ATÔMICO
 * (tmp + rename) do conteúdo atual em `${envPath}.bak` antes de
 * sobrescrever. Falha lendo o `.env` existente ou escrevendo o backup lança
 * `EnvBackupError` — fase local, distinta de falha do Doppler (`runner`).
 */
export function syncEnv(
  envPath: string,
  runner: DopplerRunner = defaultDopplerRunner,
  options: SyncEnvOptions = {},
): void {
  const tmpPath = `${envPath}.tmp`;
  const backupPath = `${envPath}.bak`;
  const backupTmpPath = `${backupPath}.tmp`;
  const content = runner(["secrets", "download", "--no-file", "--format", "env"]);

  if (existsSync(envPath)) {
    let existingContent: string;
    try {
      existingContent = readFileSync(envPath, "utf8");
    } catch (err) {
      throw new EnvBackupError(
        `Falha ao ler .env existente em ${envPath} antes do backup: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (!options.force) {
      const localKeys = parseEnvKeys(existingContent);
      const remoteKeys = parseEnvKeys(content);
      const localOnlyKeys = [...localKeys].filter((key) => !remoteKeys.has(key));
      if (localOnlyKeys.length > 0) {
        throw new LocalOnlyEnvKeysError(localOnlyKeys);
      }
    }

    try {
      writeFileSync(backupTmpPath, existingContent, "utf8");
      renameSync(backupTmpPath, backupPath);
    } catch (err) {
      // Limpeza best-effort do .tmp do backup — nunca deixa uma falha
      // SECUNDÁRIA aqui (ex: o próprio unlink falhando) mascarar o erro
      // ORIGINAL do backup, que é o que importa reportar.
      try {
        if (existsSync(backupTmpPath)) unlinkSync(backupTmpPath);
      } catch {
        // ignorado de propósito — best-effort
      }
      throw new EnvBackupError(
        `Falha ao fazer backup de .env em ${backupPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
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
    if (err instanceof LocalOnlyEnvKeysError || err instanceof EnvBackupError) {
      console.error(err.message);
    } else {
      console.error("Falha ao sincronizar .env via Doppler:", err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  }
}

// Comparação em paths nativos (não URLs) — no Windows, `import.meta.url` é
// `file:///C:/Users/...` (barras normais, 3 slashes) enquanto
// `process.argv[1]` é `C:\Users\...` (barras invertidas). Reconstruir uma
// URL a partir de `argv[1]` (`file://${process.argv[1]}`) nunca bate nessa
// plataforma — o script virava um no-op silencioso (exit 0, nada escrito).
// `fileURLToPath` normaliza o lado da URL pro formato nativo do SO antes de
// comparar (#5679).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
