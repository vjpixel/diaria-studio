#!/usr/bin/env npx tsx
/**
 * scripts/continuo-capture-tick-sidecars.ts (#7814)
 *
 * Extrai sidecars enxutos de `~/.hermes/logs/agent.log*` (o 300) pra
 * `data/continuo/tick-sidecars/` — a evidência ORIGINAL que o `agent.log`
 * roda o risco de rotacionar pra fora ANTES de alguém investigar um alarme
 * de fabricação de conclusão (#7537), a issue que motivou este script. Ver
 * `scripts/lib/continuo-tick-sidecar.ts` pra racional completo (formato de
 * linha, por que o bracket do log não é o mesmo `sessionId` do
 * session-registry, e por que "chamadas de ferramenta enxutas" basta em vez
 * de reter o transcript inteiro).
 *
 * Só LÊ `~/.hermes/logs/` (nunca escreve lá) e só ESCREVE dentro de
 * `data/continuo/tick-sidecars/` deste repo — não é o verbo único de
 * escrita em runtime do Hermes (`scripts/write-hermes-config.ts`), porque
 * não escreve NADA sob `~/.hermes/`.
 *
 * Roda 1x/dia via `hermes/scripts/watch-continuo-health.sh` (cron
 * determinístico, sem LLM — a mesma garantia de execução independente do
 * modelo que já vale pros outros detectores do watch), então a captura
 * acontece mesmo se o coordenador do tick nunca escrever nada por conta
 * própria (o buraco do item 4 da #7814 — sessão sem registro próprio).
 *
 * Uso:
 *   npx tsx scripts/continuo-capture-tick-sidecars.ts
 *   npx tsx scripts/continuo-capture-tick-sidecars.ts --json
 *   npx tsx scripts/continuo-capture-tick-sidecars.ts \
 *     --logs-dir /path/to/logs --sidecar-dir /path/to/data/continuo/tick-sidecars \
 *     --now-iso 2026-09-10T06:00:00.000Z --min-idle-minutes 60 --max-age-days 45
 *
 * Exit code é SEMPRE 0 — mesma disciplina de `check-continuo-auth-stall.ts`:
 * este script só extrai/persiste, quem decide o que fazer com a ausência de
 * sidecar (ou com uma falha de leitura) é quem chama, sem confundir
 * "não consegui capturar" com um veredito de alarme.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { CONTINUO_JOB_ID } from "./check-continuo-auth-stall.ts";
import {
  buildTickSidecar,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MIN_IDLE_MINUTES,
  groupBySession,
  parseAgentLogText,
  selectSessionsToCapture,
  selectSidecarsToPrune,
  sidecarFileName,
  filterToolCallsBySessionPrefix,
  type ToolCallEvent,
} from "./lib/continuo-tick-sidecar.ts";

const LOG_PREFIX = "[continuo-capture-tick-sidecars]";

export const DEFAULT_LOGS_DIR = join(homedir(), ".hermes", "logs");

/** Repo root a partir deste arquivo (`scripts/` -> repo root). */
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
export const DEFAULT_SIDECAR_DIR = join(DIARIA_STUDIO_ROOT, "data", "continuo", "tick-sidecars");

/** `agent.log` + rotações numeradas (`.1`, `.2`, `.3`, ...) — sem assumir
 * um teto fixo de rotações: lista o diretório e casa o padrão, então um
 * `backupCount` maior/menor não quebra a descoberta. */
function findLogFiles(logsDir: string): string[] {
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((name) => name === "agent.log" || /^agent\.log\.\d+$/.test(name))
    .map((name) => join(logsDir, name));
}

function readAllToolCallEvents(logFiles: readonly string[]): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];
  for (const path of logFiles) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`${LOG_PREFIX} falha ao ler ${path}: ${(err as Error).message}`);
      continue;
    }
    events.push(...parseAgentLogText(text));
  }
  return events;
}

/**
 * Escreve o sidecar de forma atômica: grava num arquivo temporário no MESMO
 * diretório e só então `renameSync` pro nome final (`renameSync` é atômico
 * em POSIX — o kernel troca a entrada do diretório de uma vez, nunca deixa
 * um estado parcial visível). Sem isso, um `writeFileSync` direto no nome
 * final deixa o `.json` truncado/inválido se o processo for morto no meio
 * da escrita (timeout do cron/SIGKILL) — e como `listAlreadyCaptured()` só
 * checa existência do nome, o arquivo corrompido marcaria a sessão como
 * "já capturada" pra sempre (achado do self-review do #7889).
 */
function writeSidecarAtomically(sidecarDir: string, sessionId: string, contents: string): void {
  const finalPath = join(sidecarDir, sidecarFileName(sessionId));
  const tmpPath = join(sidecarDir, `.${sidecarFileName(sessionId)}.tmp-${process.pid}`);
  writeFileSync(tmpPath, contents, "utf8");
  renameSync(tmpPath, finalPath);
}

function listAlreadyCaptured(sidecarDir: string): Set<string> {
  if (!existsSync(sidecarDir)) return new Set();
  const captured = new Set<string>();
  for (const name of readdirSync(sidecarDir)) {
    if (name.endsWith(".json")) captured.add(name.slice(0, -".json".length));
  }
  return captured;
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const logsDir = values["logs-dir"] ?? DEFAULT_LOGS_DIR;
  const sidecarDir = values["sidecar-dir"] ?? DEFAULT_SIDECAR_DIR;
  const nowIso = values["now-iso"] ?? new Date().toISOString();
  const minIdleMinutes = values["min-idle-minutes"] ? Number(values["min-idle-minutes"]) : DEFAULT_MIN_IDLE_MINUTES;
  const maxAgeDays = values["max-age-days"] ? Number(values["max-age-days"]) : DEFAULT_MAX_AGE_DAYS;
  const sessionPrefix = values["session-prefix"] ?? `cron_${CONTINUO_JOB_ID}_`;
  const asJson = flags.has("json");

  const logFiles = findLogFiles(logsDir);
  if (logFiles.length === 0) {
    const summary = { captured: [], pruned: [], logFiles: [], error: `nenhum arquivo de log em ${logsDir}` };
    if (asJson) console.log(JSON.stringify(summary));
    else console.error(`${LOG_PREFIX} nenhum arquivo de log em ${logsDir} — nada a capturar`);
    process.exit(0);
  }

  const allEvents = readAllToolCallEvents(logFiles);
  const continuoEvents = filterToolCallsBySessionPrefix(allEvents, sessionPrefix);
  const sessionsWithEvents = groupBySession(continuoEvents);
  const alreadyCaptured = listAlreadyCaptured(sidecarDir);

  const toCapture = selectSessionsToCapture(sessionsWithEvents, alreadyCaptured, nowIso, minIdleMinutes);

  if (toCapture.length > 0) mkdirSync(sidecarDir, { recursive: true });
  for (const sessionId of toCapture) {
    const events = sessionsWithEvents.get(sessionId) ?? [];
    const sidecar = buildTickSidecar(sessionId, events, nowIso);
    writeSidecarAtomically(sidecarDir, sessionId, `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  // Prune (item 2/3 da #7814: retido por semanas, não indefinidamente).
  let pruned: string[] = [];
  if (existsSync(sidecarDir)) {
    const existing = readdirSync(sidecarDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          const parsed = JSON.parse(readFileSync(join(sidecarDir, name), "utf8"));
          return { name, capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : "" };
        } catch {
          return { name, capturedAt: "" };
        }
      });
    pruned = selectSidecarsToPrune(existing, nowIso, maxAgeDays);
    for (const name of pruned) {
      try {
        unlinkSync(join(sidecarDir, name));
      } catch (err) {
        console.error(`${LOG_PREFIX} falha ao apagar ${name}: ${(err as Error).message}`);
      }
    }
  }

  const summary = { captured: toCapture, pruned, logFiles };
  if (asJson) {
    console.log(JSON.stringify(summary));
  } else {
    console.error(
      `${LOG_PREFIX} capturados=${toCapture.length} podados=${pruned.length} logFiles=${logFiles.length}`,
    );
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
