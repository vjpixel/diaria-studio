#!/usr/bin/env node
/**
 * scripts/linkedin-weekly-staleness-alarm.ts (#5111)
 *
 * Task semanal (domingo à noite, ver `scripts/lib/scheduled-tasks.ts`): checa
 * se `data/weekly/{cycle}/ln-{cycle}.json` existe pra última semana de
 * conteúdo completa — se não, alarma o editor por e-mail. Fecha o buraco de
 * observabilidade achado ao vivo em 260812 (ciclo `26w32` perdido em
 * silêncio, recuperado 2 dias depois só porque o editor lembrou sozinho).
 *
 * Lógica pura em `scripts/lib/linkedin-weekly-staleness-alarm.ts` — este
 * arquivo é só I/O (existsSync, envio de e-mail).
 *
 * Uso:
 *   npx tsx scripts/linkedin-weekly-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/linkedin-weekly-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/linkedin-weekly-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos
 * outros alarmes locais deste repo) — só necessário pra ENVIAR o alarme; a
 * checagem de existência do artefato não precisa de credencial nenhuma.
 *
 * Estado (idempotência): `data/weekly/linkedin-staleness-alarm-state.json` —
 * 1 alarme por ciclo, mesmo que esta task rode mais de 1x na mesma semana.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import {
  mostRecentCompletedCycle,
  evaluateLinkedinWeeklyStalenessAlarm,
  shouldSendLinkedinWeeklyStalenessAlarm,
  markLinkedinWeeklyStalenessAlarmed,
  emptyLinkedinWeeklyStalenessAlarmState,
  buildLinkedinWeeklyStalenessAlarmEmail,
  type LinkedinWeeklyStalenessAlarmState,
} from "./lib/linkedin-weekly-staleness-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "weekly", "linkedin-staleness-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[linkedin-weekly-staleness-alarm]";

export function loadState(statePath: string = STATE_PATH): LinkedinWeeklyStalenessAlarmState {
  if (!existsSync(statePath)) return emptyLinkedinWeeklyStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<LinkedinWeeklyStalenessAlarmState>;
    const lastAlarmedCycle =
      typeof raw.lastAlarmedCycle === "string" || raw.lastAlarmedCycle === null ? raw.lastAlarmedCycle ?? null : null;
    return { lastAlarmedCycle };
  } catch {
    return emptyLinkedinWeeklyStalenessAlarmState();
  }
}

export function saveState(state: LinkedinWeeklyStalenessAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** `data/weekly/{cycle}/ln-{cycle}.json` existe no disco? (I/O isolado pra facilitar teste do resto do fluxo.) */
export function artifactExistsForCycle(cycle: string, rootDir: string = ROOT): boolean {
  return existsSync(join(rootDir, weeklyLinkedinRelDir(cycle), `ln-${cycle}.json`));
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const cycle = mostRecentCompletedCycle(new Date());
  const exists = artifactExistsForCycle(cycle);
  const evaluation = evaluateLinkedinWeeklyStalenessAlarm(cycle, exists);
  console.log(`${LOG_PREFIX} cycle=${cycle} artifact_exists=${exists} verdict=${evaluation.verdict}`);

  const state = loadState();
  if (!shouldSendLinkedinWeeklyStalenessAlarm(evaluation, state)) {
    console.log(
      evaluation.verdict === "ok"
        ? `${LOG_PREFIX} ciclo ${cycle} OK — nenhum alarme necessário.`
        : `${LOG_PREFIX} já alarmado pra ${cycle} nesta invocação anterior — não reenvia.`,
    );
    return;
  }

  const { subject, body } = buildLinkedinWeeklyStalenessAlarmEmail(cycle);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markLinkedinWeeklyStalenessAlarmed(cycle));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (cycle=${cycle}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
