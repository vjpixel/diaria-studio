#!/usr/bin/env node
/**
 * scripts/npm-version-drift-alarm.ts (#6960)
 *
 * O contrapeso pedido em #6960 depois de o editor desligar o auto-updater
 * do Claude Code no `helios` (decisão registrada na #6927 — o binário
 * quebrou 5x no mesmo dia). O alarme do #6927
 * (`scripts/claude-session-version-drift-alarm.ts`) mede reinstalação
 * RECENTE (`/proc/<pid>/exe` apontando pra staging removido) — com o
 * updater desligado, esse sinal nunca mais aparece, e o silêncio dele fica
 * indistinguível de saúde. Este script mede outra coisa: quantos dias faz
 * que a versão em disco diverge da versão publicada no npm.
 *
 * Lógica pura em `scripts/lib/npm-version-drift-alarm.ts` — este arquivo é
 * só I/O (`npm root -g`, leitura do `package.json`, `npm view`), mesmo
 * molde de `scripts/claude-session-version-drift-alarm.ts`.
 *
 * Uso:
 *   npx tsx scripts/npm-version-drift-alarm.ts                    # avalia + persiste + alarma se achado NOVO
 *   npx tsx scripts/npm-version-drift-alarm.ts --dry-run          # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/npm-version-drift-alarm.ts --to email@x       # override do destinatário
 *   npx tsx scripts/npm-version-drift-alarm.ts --threshold-days 7 # default 7
 *
 * Limiar (7 dias, default): o Claude Code publica com frequência alta
 * (medição citada na #6960: 2.1.251 → 2.1.257 em um dia), então 1-2 dias de
 * defasagem é ruído de cadência normal de release, não sinal. 7 dias é o
 * ponto em que "desligamos o updater" deixou de ser uma decisão recente e
 * passou a ser, na prática, "ninguém atualizou esta semana" — o estado
 * que a issue nomeia como risco.
 *
 * Restrição de desenho central da issue: NUNCA falhar em silêncio.
 * `npm root -g`, a leitura do `package.json` em disco, e `npm view`
 * PROPAGAM qualquer erro (rede indisponível, path mudou de lugar,
 * `package.json` ilegível/corrompido) — `main()` sai com `exitCode = 1`
 * sem tocar `saveState`, nunca lê um erro como "sem defasagem" (mesma
 * disciplina do `ps` propagando em `claude-session-version-drift-alarm.ts`,
 * achado de review #6953).
 *
 * Env: precisa de `data/.credentials.json` com o scope `gmail.send` só
 * quando há achado pra de fato enviar o e-mail. Persistir o cursor de
 * `driftSince`/idempotência precisa do junction `data/`.
 *
 * Estado: `data/npm-version-drift-alarm/state.json`.
 *
 * Escopo deliberadamente sem issue automática (mesma decisão do #6927
 * pro alarme irmão) — o achado reaparece toda semana que ninguém
 * atualizar, uma issue reaberta a cada ciclo seria ruído; só e-mail.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateNpmVersionDrift,
  advanceNpmVersionDriftState,
  shouldAlarmNpmVersionDrift,
  markNpmVersionDriftAlarmed,
  emptyNpmVersionDriftAlarmState,
  buildNpmVersionDriftAlarmEmail,
  type NpmVersionCheck,
  type NpmVersionDriftAlarmState,
} from "./lib/npm-version-drift-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "npm-version-drift-alarm", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[npm-version-drift-alarm]";
const PACKAGE_NAME = "@anthropic-ai/claude-code";

const DEFAULT_THRESHOLD_DAYS = 7;

// ─── Estado (idempotência + cursor "desde quando") ─────────────────────────

export function loadState(statePath: string = STATE_PATH): NpmVersionDriftAlarmState {
  if (!existsSync(statePath)) return emptyNpmVersionDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<NpmVersionDriftAlarmState>;
    const driftSince = typeof raw.driftSince === "string" || raw.driftSince === null ? (raw.driftSince ?? null) : null;
    const lastAlarmedFingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? (raw.lastAlarmedFingerprint ?? null)
        : null;
    const lastCheckedAt =
      typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? (raw.lastCheckedAt ?? null) : null;
    return { driftSince, lastAlarmedFingerprint, lastCheckedAt };
  } catch {
    return emptyNpmVersionDriftAlarmState();
  }
}

export function saveState(state: NpmVersionDriftAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Descoberta das duas versões (I/O) ─────────────────────────────────────

/** Injeção de `execFileSync`/`readFileSync` — só pra testabilidade
 * determinística, mesmo racional de `SessionDiscoveryOps` em
 * `claude-session-version-drift-alarm.ts`. */
export interface VersionCheckOps {
  execFileSync: typeof execFileSync;
  readFileSync: typeof readFileSync;
}

const defaultOps: VersionCheckOps = { execFileSync, readFileSync };

/**
 * Versão em disco: `npm root -g` + `<pkg>/package.json`. PROPAGA qualquer
 * falha (comando ausente, path inesperado, `package.json` ilegível ou sem
 * campo `version`) — nunca devolve `null`/placeholder. Silenciar aqui é
 * exatamente a garantia falsa que a issue pede pra evitar: um erro de
 * leitura não pode virar "sem defasagem".
 */
export function readDiskVersion(ops: VersionCheckOps = defaultOps): string {
  const globalRoot = ops.execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  if (!globalRoot) throw new Error(`${LOG_PREFIX} "npm root -g" devolveu string vazia — não dá pra localizar o pacote.`);
  const packageJsonPath = join(globalRoot, PACKAGE_NAME, "package.json");
  const raw = ops.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`${LOG_PREFIX} ${packageJsonPath} não tem campo "version" válido.`);
  }
  return parsed.version;
}

/**
 * Versão upstream: `npm view <pkg> version`. PROPAGA qualquer falha (sem
 * rede, registry fora do ar, nome de pacote mudou) — mesma disciplina de
 * `readDiskVersion`.
 */
export function readUpstreamVersion(ops: VersionCheckOps = defaultOps): string {
  const raw = ops.execFileSync("npm", ["view", PACKAGE_NAME, "version"], { encoding: "utf8" }).trim();
  if (!raw) throw new Error(`${LOG_PREFIX} "npm view ${PACKAGE_NAME} version" devolveu string vazia.`);
  return raw;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");
  const thresholdArg = getStringArg(argv, "threshold-days");
  const thresholdDays = thresholdArg ? Number(thresholdArg) : DEFAULT_THRESHOLD_DAYS;
  if (!Number.isFinite(thresholdDays) || thresholdDays <= 0) {
    throw new Error(`--threshold-days deve ser um número positivo, recebido "${thresholdArg}"`);
  }

  // Sem try/catch ao redor das duas leituras abaixo, de propósito: qualquer
  // falha (rede, path, parsing) deve propagar e sair com exitCode != 0 —
  // nunca virar "0 defasagem" por omissão (restrição central da #6960).
  const diskVersion = readDiskVersion();
  const upstreamVersion = readUpstreamVersion();
  const check: NpmVersionCheck = { diskVersion, upstreamVersion };

  const now = new Date();
  const prevState = loadState();
  const nextState = advanceNpmVersionDriftState(prevState, check, now);
  const evaluation = evaluateNpmVersionDrift(check, nextState.driftSince, now, thresholdDays);

  console.log(`${LOG_PREFIX} ${evaluation.message}`);

  const willAlarm = shouldAlarmNpmVersionDrift(nextState, check, now, thresholdDays);
  let finalState = nextState;

  if (willAlarm) {
    const { subject, body } = buildNpmVersionDriftAlarmEmail(evaluation, thresholdDays, now);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Sem try/catch — mesmo racional dos alarmes irmãos: se o envio
      // falhar, `sendGmailMessage` lança, `main()` propaga e `saveState`
      // abaixo nunca roda — o cursor `lastAlarmedFingerprint` fica intacto
      // pra próxima tentativa em vez de marcar "já avisado" sem o editor
      // ter de fato recebido o e-mail. Só depois de um `await` bem-sucedido
      // é que marcamos como alarmado.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
      finalState = markNpmVersionDriftAlarmed(nextState, evaluation);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (em sincronia, defasagem ainda fresca, ou par já alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  saveState(finalState);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
