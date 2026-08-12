#!/usr/bin/env node
/**
 * scripts/clarice-envio-alarm.ts (#5058, item 2)
 *
 * Task diária (20:30 BRT — 1h30 depois do `Diaria-Clarice-Envio` das 19:00,
 * folga suficiente pro retry-com-backoff embutido em `clarice-envio-run.ts`
 * — até 3 tentativas, cap de 35min cada — esgotar antes desta checagem
 * rodar): lê o relatório mais recente que `runEnvio` escreveu HOJE
 * (`data/clarice-subscribers/envio-reports/envio-{aammdd}*.md`, TODO
 * caminho de saída grava exatamente 1) e classifica o desfecho. Se a rodada
 * falhou (ou nem rodou), alarma o editor por e-mail — sem isso, o único
 * sinal era um unit systemd vermelho que ninguém olha (achado ao vivo
 * 260811: a onda de 12/08 só existiu porque um humano montou à mão).
 *
 * Lógica pura em `scripts/lib/clarice-envio-alarm.ts` — este arquivo é só
 * I/O (listar arquivos, ler mtimes, enviar e-mail).
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-envio-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-envio-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário pra ENVIAR o alarme;
 * a leitura dos relatórios não precisa de credencial nenhuma.
 *
 * Estado (idempotência): `data/clarice-subscribers/envio-alarm-state.json` —
 * 1 alarme por `aammdd`, mesmo que esta task rode mais de 1x no mesmo dia.
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import {
  evaluateEnvioAlarm,
  shouldSendEnvioAlarm,
  markEnvioAlarmed,
  emptyEnvioAlarmState,
  buildEnvioAlarmEmail,
  type EnvioAlarmReportFile,
  type EnvioAlarmState,
} from "./lib/clarice-envio-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-alarm]";

export function loadState(statePath: string = STATE_PATH): EnvioAlarmState {
  if (!existsSync(statePath)) return emptyEnvioAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<EnvioAlarmState>;
    const lastAlarmedAammdd = typeof raw.lastAlarmedAammdd === "string" || raw.lastAlarmedAammdd === null
      ? raw.lastAlarmedAammdd ?? null
      : null;
    return { lastAlarmedAammdd };
  } catch {
    return emptyEnvioAlarmState();
  }
}

export function saveState(state: EnvioAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Lista os relatórios `envio-{aammdd}*.md` de HOJE — cada `writeAndRegisterReport`
 * de `runEnvio` grava exatamente 1 por invocação, então >1 candidato só
 * acontece se a rodada rodou mais de 1x no dia (retry manual). Ausência de
 * `data/` (junction não montada) devolve `[]` — o guard de registro
 * (`requiredFile: "clarice-subscribers/clarice-users.db"`) já cobre esse
 * caso antes de a task chegar aqui, mas `existsSync` defensivo evita um
 * `readdirSync` lançando em cima disso.
 */
export function listTodayEnvioReports(reportsDir: string, aammdd: string): EnvioAlarmReportFile[] {
  if (!existsSync(reportsDir)) return [];
  const prefix = `envio-${aammdd}`;
  return readdirSync(reportsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const reportId = f.slice(0, -".md".length);
      const mtimeMs = statSync(resolve(reportsDir, f)).mtimeMs;
      return { reportId, mtimeMs };
    });
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const aammdd = toAammdd(datePartsInTz(new Date(), BRT_TIMEZONE));
  const candidates = listTodayEnvioReports(REPORTS_DIR, aammdd);
  const evaluation = evaluateEnvioAlarm(candidates, aammdd);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} candidatos=${candidates.length} verdict=${evaluation.verdict}` +
      (evaluation.reportId ? ` reportId=${evaluation.reportId}` : ""),
  );

  const state = loadState();
  if (!shouldSendEnvioAlarm(evaluation, state, aammdd)) {
    console.log(
      evaluation.verdict === "ok"
        ? `${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`
        : `${LOG_PREFIX} já alarmado pra ${aammdd} nesta invocação anterior — não reenvia.`,
    );
    return;
  }

  const { subject, body } = buildEnvioAlarmEmail(evaluation, aammdd);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markEnvioAlarmed(state, aammdd));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
