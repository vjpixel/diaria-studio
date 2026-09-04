#!/usr/bin/env npx tsx
/**
 * scripts/write-hermes-config.ts (#6817 item 3)
 *
 * Verbo único pra escrever config de RUNTIME do Hermes (`~/.hermes/
 * config.yaml`, `cron/jobs.json`, `profiles/*`) — nunca editar esses
 * arquivos com `Edit`/`Write` direto. Ver `scripts/lib/hermes-config-
 * writer.ts` pro racional completo (backup, redação, por que blacklist de
 * chave aqui e não allowlist de campo).
 *
 * ## Modo escrita
 *
 *   npx tsx scripts/write-hermes-config.ts \
 *     --path ~/.hermes/config.yaml --content-file /tmp/novo-config.yaml \
 *     --reason "trocar modelo do profile coding" \
 *     [--validate-cmd "hermes config validate ~/.hermes/config.yaml"] \
 *     [--smoke-cmd "hermes -z OK -m <modelo> --provider <provider>"] \
 *     [--echo-to ~/hermes-agent/config/hermes-home/config.yaml] \
 *     [--sensitive-keys password_hash,token]
 *
 * Sequência (primeiro passo que falha aborta e reverte os passos já
 * aplicados — nunca deixa o arquivo alvo num estado intermediário):
 *
 *   1. `isPathAllowed(path, "write")` — path precisa estar numa raiz
 *      habilitada da allowlist do #6817 item 1, e não pode casar
 *      `HARD_DENIED_SUFFIXES` (isto barra usar este verbo pra escrever
 *      `auth.json` — negação permanente, sem exceção nem por este caminho
 *      "oficial").
 *   2. backup: se `path` já existe, copia o conteúdo ATUAL pra
 *      `<path>.bak-<motivo>-<timestamp>` antes de tocar no arquivo. Se
 *      `path` não existe ainda (1ª escrita), pula o backup e registra isso
 *      explicitamente (nunca finge que fez backup de nada).
 *   3. escreve o conteúdo novo em `path`.
 *   4. se `--validate-cmd`: roda via shell; código de saída ≠ 0 → REVERT
 *      automático (restaura o backup, ou apaga o arquivo se não havia
 *      backup) e sai com erro — o config nunca fica no estado que falhou
 *      validação.
 *   5. se validação passou (ou foi omitida) e `--smoke-cmd`: mesma lógica —
 *      falha reverte.
 *   6. se tudo passou: se `--echo-to`, escreve uma cópia REDIGIDA
 *      (`redactConfigText`) no destino — que também precisa passar
 *      `isPathAllowed` (tipicamente sob a raiz `hermes-agent`). Falha do
 *      eco é reportada mas NÃO reverte a escrita principal (o config real
 *      já está correto e validado; o eco é um espelho, não a fonte da
 *      verdade).
 *
 * `--validate-cmd`/`--smoke-cmd` são strings de shell — este script não
 * conhece o binário `hermes`; quem chama decide o comando exato (o próprio
 * ambiente do `helios` é quem tem `hermes` no PATH, não este repo/CI).
 * Omitir os dois ainda produz backup + escrita — é o mínimo do verbo, nunca
 * um erro (nem toda mudança tem probe automatizado disponível).
 *
 * ## Modo revert
 *
 *   npx tsx scripts/write-hermes-config.ts --revert --path ~/.hermes/config.yaml \
 *     [--backup config.yaml.bak-trocar-modelo-20260904T120000Z]
 *
 * Sem `--backup`, pega o backup mais recente pelo prefixo (`findMostRecent
 * Backup`). Restaura byte-a-byte e CONFERE lendo de volta — se o conteúdo
 * pós-restore não bater com o backup, reporta erro (não assume sucesso só
 * porque o `writeFileSync` não lançou).
 *
 * Exit codes: 0 = sucesso; 1 = allowlist negou ou validação/probe falhou
 * (com revert aplicado); 2 = uso inválido / I/O (arquivo ausente, etc).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { hasFlag, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { defaultWorkdirRoots, isPathAllowed } from "./lib/continuo-workdir-allowlist.ts";
import { buildBackupFileName, findMostRecentBackup, formatBackupTimestamp, redactConfigText } from "./lib/hermes-config-writer.ts";

const LOG_PREFIX = "[write-hermes-config]";
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

function resolveInputPath(raw: string): string {
  const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  return resolve(expanded);
}

function roots() {
  return defaultWorkdirRoots(homedir(), DIARIA_STUDIO_ROOT);
}

function runCmd(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message };
  }
}

function doRevert(path: string, backupName: string | undefined): void {
  const dir = dirname(path);
  const base = basename(path);
  let backup = backupName;
  if (!backup) {
    const files = existsSync(dir) ? readdirSync(dir) : [];
    backup = findMostRecentBackup(base, files);
    if (!backup) {
      console.error(`${LOG_PREFIX} nenhum backup encontrado pra ${path} (prefixo ${base}.bak-)`);
      process.exit(2);
    }
  }
  const backupPath = resolve(dir, backup);
  if (!existsSync(backupPath)) {
    console.error(`${LOG_PREFIX} backup não existe: ${backupPath}`);
    process.exit(2);
  }
  const backupContent = readFileSync(backupPath, "utf8");
  writeFileSync(path, backupContent, "utf8");
  const confirm = readFileSync(path, "utf8");
  if (confirm !== backupContent) {
    console.error(`${LOG_PREFIX} revert aplicado mas a releitura NÃO bate byte-a-byte com o backup — investigar antes de confiar no estado de ${path}`);
    process.exit(2);
  }
  console.log(`${LOG_PREFIX} revert ok — ${path} restaurado a partir de ${backupPath}`);
  process.exit(0);
}

function main(): void {
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);
  const rawPath = values.path;
  if (!rawPath) {
    console.error(`${LOG_PREFIX} uso: --path <caminho> [--revert [--backup nome] | --content-file <arquivo> --reason <motivo> [--validate-cmd ...] [--smoke-cmd ...] [--echo-to <destino>] [--sensitive-keys a,b,c]]`);
    process.exit(2);
  }
  const path = resolveInputPath(rawPath);
  const decision = isPathAllowed(path, "write", roots());
  if (!decision.allowed) {
    console.error(`${LOG_PREFIX} denied — ${decision.reason}`);
    process.exit(1);
  }

  if (hasFlag(argv, "revert")) {
    doRevert(path, values.backup);
    return;
  }

  const reason = values.reason;
  const contentFile = values["content-file"];
  if (!reason || !contentFile) {
    console.error(`${LOG_PREFIX} modo escrita exige --content-file e --reason`);
    process.exit(2);
  }
  if (!existsSync(contentFile)) {
    console.error(`${LOG_PREFIX} --content-file não existe: ${contentFile}`);
    process.exit(2);
  }
  const newContent = readFileSync(contentFile, "utf8");

  const dir = dirname(path);
  const base = basename(path);
  mkdirSync(dir, { recursive: true });

  let backupPath: string | undefined;
  let originalContent: string | undefined;
  if (existsSync(path)) {
    originalContent = readFileSync(path, "utf8");
    const backupName = buildBackupFileName(base, reason, formatBackupTimestamp(new Date()));
    backupPath = resolve(dir, backupName);
    writeFileSync(backupPath, originalContent, "utf8");
    console.log(`${LOG_PREFIX} backup criado: ${backupPath}`);
  } else {
    console.log(`${LOG_PREFIX} ${path} não existia — sem backup a fazer (1ª escrita)`);
  }

  writeFileSync(path, newContent, "utf8");
  console.log(`${LOG_PREFIX} escrito: ${path}`);

  function revertAndExit(reasonMsg: string, cmdOutput: string): never {
    if (originalContent !== undefined) {
      writeFileSync(path, originalContent, "utf8");
      console.error(`${LOG_PREFIX} REVERTIDO — ${path} restaurado ao conteúdo anterior (${backupPath})`);
    } else {
      rmSync(path, { force: true });
      console.error(`${LOG_PREFIX} REVERTIDO — ${path} removido (não existia antes desta escrita)`);
    }
    console.error(`${LOG_PREFIX} motivo do revert: ${reasonMsg}\n${cmdOutput}`);
    process.exit(1);
  }

  const validateCmd = values["validate-cmd"];
  if (validateCmd) {
    const result = runCmd(validateCmd);
    if (!result.ok) {
      revertAndExit(`--validate-cmd falhou: ${validateCmd}`, result.output);
    }
    console.log(`${LOG_PREFIX} validate-cmd ok`);
  }

  const smokeCmd = values["smoke-cmd"];
  if (smokeCmd) {
    const result = runCmd(smokeCmd);
    if (!result.ok) {
      revertAndExit(`--smoke-cmd falhou: ${smokeCmd}`, result.output);
    }
    console.log(`${LOG_PREFIX} smoke-cmd ok`);
  }

  const echoTo = values["echo-to"];
  if (echoTo) {
    const echoPath = resolveInputPath(echoTo);
    const echoDecision = isPathAllowed(echoPath, "write", roots());
    if (!echoDecision.allowed) {
      console.warn(`${LOG_PREFIX} eco pra ${echoPath} PULADO — ${echoDecision.reason} (escrita principal em ${path} já está aplicada e validada, isto não reverte)`);
    } else {
      const sensitiveKeysValue = values["sensitive-keys"];
      const sensitiveKeys = sensitiveKeysValue ? sensitiveKeysValue.split(",").map((k) => k.trim()).filter(Boolean) : undefined;
      const { redacted, matchedKeys } = redactConfigText(newContent, sensitiveKeys);
      mkdirSync(dirname(echoPath), { recursive: true });
      writeFileSync(echoPath, redacted, "utf8");
      console.log(`${LOG_PREFIX} eco redigido escrito em ${echoPath} (chaves redigidas: ${matchedKeys.length > 0 ? matchedKeys.join(", ") : "nenhuma casou"})`);
    }
  }

  console.log(`${LOG_PREFIX} sucesso.`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
