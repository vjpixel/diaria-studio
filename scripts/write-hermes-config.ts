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
import { buildBackupFileName, findMostRecentBackup, formatBackupTimestamp, redactConfigText, UnsafeMultilineSecretError } from "./lib/hermes-config-writer.ts";

const LOG_PREFIX = "[write-hermes-config]";
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

function resolveInputPath(raw: string): string {
  const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  return resolve(expanded);
}

function roots() {
  return defaultWorkdirRoots(homedir(), DIARIA_STUDIO_ROOT);
}

/** Gate de LEITURA que qualquer path cujo CONTEÚDO vai ser lido pra dentro
 * deste processo precisa passar — não só o `path` de destino da escrita.
 * Sem isto, `--content-file`/`--backup` podiam apontar pra fora da
 * allowlist (ex: `~/.hermes/auth.json`) e o conteúdo lido escaparia via
 * `path`/`--echo-to`, que É validado, mas só como DESTINO — a fonte nunca
 * passava por `isPathAllowed` (achado de review de segurança 260904).
 * Sai com exit 1 (mesma classe de "allowlist negou" do gate de escrita). */
function assertReadAllowed(path: string): void {
  const decision = isPathAllowed(path, "read", roots());
  if (!decision.allowed) {
    console.error(`${LOG_PREFIX} denied — leitura de ${path} negada: ${decision.reason}`);
    process.exit(1);
  }
}

/** `writeFileSync` com try/catch estruturado — falha real de I/O (disco
 * cheio, permissão, EISDIR) sai pelo formato `${LOG_PREFIX}` do resto do
 * arquivo em vez de stack trace crua do Node, com exit code 2 (taxonomia
 * do módulo: uso inválido / I/O). */
function safeWriteFileSync(path: string, content: string, label: string): void {
  try {
    writeFileSync(path, content, "utf8");
  } catch (e) {
    console.error(`${LOG_PREFIX} falha de I/O ao escrever ${label} (${path}): ${(e as Error).message}`);
    process.exit(2);
  }
}

/** `readFileSync` com try/catch estruturado — mesmo racional de
 * `safeWriteFileSync`, lado da leitura. */
function safeReadFileSync(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(`${LOG_PREFIX} falha de I/O ao ler ${label} (${path}): ${(e as Error).message}`);
    process.exit(2);
  }
}

/** `mkdirSync` com try/catch estruturado — mesmo racional. */
function safeMkdirSync(path: string, label: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (e) {
    console.error(`${LOG_PREFIX} falha de I/O ao criar diretório de ${label} (${path}): ${(e as Error).message}`);
    process.exit(2);
  }
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
  // `resolve(dir, backup)` descarta segmentos anteriores quando `backup` é
  // absoluto (ou escapa via `../..`) — sem este gate, `--backup
  // /home/x/.hermes/auth.json` (ou um `--backup` relativo escapando pra
  // lá) copiaria o CONTEÚDO do arquivo real pra `path` sem nunca passar
  // pela allowlist (achado de review de segurança 260904, mesma classe do
  // gate em `--content-file` no modo escrita).
  assertReadAllowed(backupPath);
  if (!existsSync(backupPath)) {
    console.error(`${LOG_PREFIX} backup não existe: ${backupPath}`);
    process.exit(2);
  }
  const backupContent = safeReadFileSync(backupPath, "backup");
  safeWriteFileSync(path, backupContent, "conteúdo restaurado");
  const confirm = safeReadFileSync(path, "conferência pós-revert");
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
  // O CONTEÚDO lido de `--content-file` acaba escrito em `path` (que já
  // passou pela allowlist acima) — mas a FONTE nunca tinha passado por
  // nada. `--content-file ~/.hermes/auth.json` lia o token em claro sem
  // nenhum gate (achado de review de segurança 260904) — mesma classe do
  // gate em `--backup` no modo revert.
  assertReadAllowed(contentFile);
  const newContent = safeReadFileSync(contentFile, "content-file");

  const dir = dirname(path);
  const base = basename(path);
  safeMkdirSync(dir, "destino");

  let backupPath: string | undefined;
  let originalContent: string | undefined;
  if (existsSync(path)) {
    originalContent = safeReadFileSync(path, "conteúdo atual (pré-backup)");
    const backupName = buildBackupFileName(base, reason, formatBackupTimestamp(new Date()));
    backupPath = resolve(dir, backupName);
    safeWriteFileSync(backupPath, originalContent, "backup");
    // Mesma disciplina de `doRevert` (nunca assume sucesso só porque
    // `writeFileSync` não lançou): confere que o backup gravado bate
    // byte-a-byte com o conteúdo original ANTES de prosseguir pra
    // sobrescrever `path`. Sem isto, um backup corrompido/truncado só
    // seria descoberto no dia em que um revert automático restaurasse
    // silenciosamente um config quebrado, reportando "REVERTIDO" como se
    // tivesse voltado ao estado bom.
    const backupConfirm = safeReadFileSync(backupPath, "conferência pós-backup");
    if (backupConfirm !== originalContent) {
      console.error(`${LOG_PREFIX} backup em ${backupPath} não bate byte-a-byte com o conteúdo original — abortando ANTES de tocar em ${path} (nada foi sobrescrito)`);
      process.exit(2);
    }
    console.log(`${LOG_PREFIX} backup criado e conferido: ${backupPath}`);
  } else {
    console.log(`${LOG_PREFIX} ${path} não existia — sem backup a fazer (1ª escrita)`);
  }

  safeWriteFileSync(path, newContent, "conteúdo novo");
  console.log(`${LOG_PREFIX} escrito: ${path}`);

  function revertAndExit(reasonMsg: string, cmdOutput: string): never {
    if (originalContent !== undefined) {
      safeWriteFileSync(path, originalContent, "conteúdo revertido");
      console.error(`${LOG_PREFIX} REVERTIDO — ${path} restaurado ao conteúdo anterior (${backupPath})`);
    } else {
      try {
        rmSync(path, { force: true });
        console.error(`${LOG_PREFIX} REVERTIDO — ${path} removido (não existia antes desta escrita)`);
      } catch (e) {
        console.error(`${LOG_PREFIX} falha de I/O ao remover ${path} durante revert: ${(e as Error).message}`);
        process.exit(2);
      }
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
      let redaction: { redacted: string; matchedKeys: readonly string[] } | undefined;
      try {
        redaction = redactConfigText(newContent, sensitiveKeys);
      } catch (e) {
        if (!(e instanceof UnsafeMultilineSecretError)) throw e;
        // FAIL LOUD, nunca produzir um eco que MENTE sobre estar seguro
        // (o achado que motivou isto: a versão anterior redigia só a
        // linha da chave de um block scalar YAML, deixando o segredo
        // real intacto nas linhas de continuação enquanto reportava
        // sucesso). Escrita principal em `path` já está aplicada e
        // validada — isto não reverte, só pula o eco.
        console.warn(`${LOG_PREFIX} eco pra ${echoPath} PULADO — ${e.message} (escrita principal em ${path} já está aplicada e validada, isto não reverte)`);
      }
      if (redaction) {
        const { redacted, matchedKeys } = redaction;
        safeMkdirSync(dirname(echoPath), "eco");
        safeWriteFileSync(echoPath, redacted, "eco redigido");
        console.log(`${LOG_PREFIX} eco redigido escrito em ${echoPath} (chaves redigidas: ${matchedKeys.length > 0 ? matchedKeys.join(", ") : "nenhuma casou"})`);
      }
    }
  }

  console.log(`${LOG_PREFIX} sucesso.`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
