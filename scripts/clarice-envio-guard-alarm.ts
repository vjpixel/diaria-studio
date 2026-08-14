#!/usr/bin/env node
/**
 * scripts/clarice-envio-guard-alarm.ts (#5220)
 *
 * Task diária (~06:15 BRT — depois do guard das 05:00, antes/perto do
 * disparo das 06:00): lê o relatório MAIS RECENTE que `clarice-envio-guard.ts`
 * escreveu HOJE na própria FAMÍLIA (`data/clarice-subscribers/envio-reports/
 * envio-{aammdd}-guard-*.md` — TODO caminho de saída do guard grava
 * exatamente 1) e classifica o desfecho. Deliberadamente SEPARADA de
 * `Diaria-Clarice-Envio-Alarm` (20:30 BRT, #5058) — aquela olha
 * `envio-{aammdd}*.md` do dia inteiro e pega o mais recente por mtime, o que
 * faz o relatório do RUN das 19:00 sempre vencer o do guard da MESMA manhã
 * (~15h mais novo) e esconder uma falha do guard (Gap 2 da issue #5220).
 *
 * Lógica pura em `scripts/lib/clarice-envio-guard-alarm.ts` — este arquivo é
 * só I/O (listar arquivos, ler mtimes, enviar e-mail). Mesmo molde de
 * `scripts/clarice-envio-alarm.ts` (#5058).
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-guard-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-envio-guard-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-envio-guard-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário pra ENVIAR o alarme;
 * a leitura dos relatórios não precisa de credencial nenhuma.
 *
 * Estado (idempotência): `data/clarice-subscribers/envio-guard-alarm-state.json`
 * (dedicado — NÃO compartilha `envio-alarm-state.json` do run das 19:00,
 * senão um alarme do run "consumiria" o slot do dia e o guard nunca
 * alarmaria, ou vice-versa) — 1 alarme por `aammdd`, mesmo que esta task
 * rode mais de 1x no mesmo dia.
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
  evaluateGuardAlarm,
  shouldSendGuardAlarm,
  markGuardAlarmed,
  emptyEnvioGuardAlarmState,
  buildGuardAlarmEmail,
  type EnvioGuardAlarmReportFile,
  type EnvioGuardAlarmState,
} from "./lib/clarice-envio-guard-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-guard-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-guard-alarm]";

export function loadState(statePath: string = STATE_PATH): EnvioGuardAlarmState {
  if (!existsSync(statePath)) return emptyEnvioGuardAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<EnvioGuardAlarmState>;
    const lastAlarmedAammdd = typeof raw.lastAlarmedAammdd === "string" || raw.lastAlarmedAammdd === null
      ? raw.lastAlarmedAammdd ?? null
      : null;
    return { lastAlarmedAammdd };
  } catch {
    return emptyEnvioGuardAlarmState();
  }
}

export function saveState(state: EnvioGuardAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Lista os relatórios `envio-{aammdd}-guard-*.md` de HOJE — cada
 * `writeAndRegisterReport` de `runEnvioGuard` grava exatamente 1 por
 * invocação, então >1 candidato só acontece se o guard rodou mais de 1x no
 * dia (retry manual). Filtra pelo prefixo `-guard` explicitamente — NUNCA
 * pega um relatório do run das 19:00 (`envio-{aammdd}.md`,
 * `envio-{aammdd}-paused.md`, etc — sem o `-guard`), que é justamente o Gap
 * 2 da issue #5220. Ausência de `data/` (junction não montada) devolve
 * `[]` — o guard de registro (`requiredFile`) já cobre esse caso antes de a
 * task chegar aqui, mas `existsSync` defensivo evita um `readdirSync`
 * lançando em cima disso.
 */
export function listTodayGuardReports(reportsDir: string, aammdd: string): EnvioGuardAlarmReportFile[] {
  if (!existsSync(reportsDir)) return [];
  const prefix = `envio-${aammdd}-guard`;
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
  const candidates = listTodayGuardReports(REPORTS_DIR, aammdd);
  const evaluation = evaluateGuardAlarm(candidates, aammdd);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} candidatos=${candidates.length} verdict=${evaluation.verdict}` +
      (evaluation.reportId ? ` reportId=${evaluation.reportId}` : ""),
  );

  const state = loadState();
  if (!shouldSendGuardAlarm(evaluation, state, aammdd)) {
    console.log(
      evaluation.verdict === "ok"
        ? `${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`
        : `${LOG_PREFIX} já alarmado pra ${aammdd} nesta invocação anterior — não reenvia.`,
    );
    return;
  }

  const { subject, body } = buildGuardAlarmEmail(evaluation, aammdd);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markGuardAlarmed(state, aammdd));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
