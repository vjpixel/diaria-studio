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
 * Estado: `data/clarice-subscribers/envio-alarm-issues.json` (tracking de
 * issue por achado, `alarm-issues.ts`).
 *
 * **E-mail (#7960, migrado do estado próprio `lastAlarmedAammdd` pro portão
 * `notifyEditorForOutcomes`):** severidade `"acao"` — só cria/reusa a issue,
 * nunca manda e-mail sob `notifications.email_policy: "urgent_only"`. Sob
 * `"legacy"`, `legacyResendIntent: "dedupe-new-occurrences-only"` preserva
 * o comportamento histórico: o fingerprint inclui `aammdd`, então
 * re-executar no MESMO dia reusa a issue (`action: "reused"`) e não deve
 * re-emitir e-mail — era esse o dedup que `lastAlarmedAammdd` fazia antes.
 * `shouldSendEnvioAlarm`/`markEnvioAlarmed`/`envio-alarm-state.json`
 * continuam definidos em `lib/clarice-envio-alarm.ts` (e testados lá) mas
 * não são mais chamados por este script.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import {
  evaluateEnvioAlarm,
  buildEnvioAlarmEmail,
  type EnvioAlarmEvaluation,
  type EnvioAlarmReportFile,
} from "./lib/clarice-envio-alarm.ts";
import {
  BASE_COLLAPSE_REPORT_SUFFIX,
  HALT_STALE_REPORT_SUFFIX,
  haltAlarmFingerprint,
  readClariceEnvioHalt,
  type ClariceEnvioHaltRead,
} from "./lib/clarice-envio-halt.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-alarm]";
/** #5339: task roda diária (20:30) — 2 execuções limpas consecutivas (2
 * dias, já que o fingerprint inclui `aammdd`) fecham a issue automaticamente,
 * mesmo valor de cadência diária usado pelos alarmes já wired (lote 1/3). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima.

/** Converte uma avaliação NÃO-ok no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome (#5339). `check` fixo
 * ("clarice-envio"); `fingerprint` inclui `aammdd` — cada dia é seu próprio
 * achado (a rodada de amanhã é logicamente outro EVENTO), então uma falha de
 * HOJE nunca "esconde" atrás do estado de ontem. Sem PII: só `aammdd`,
 * verdict e `reportId` (nenhum e-mail de assinante entra aqui).
 *
 * `family: "evento"` (#5553) — a falha de um `aammdd` específico é um fato
 * histórico: a checagem de amanhã avalia OUTRO dia, então este achado
 * simplesmente sai de `pending` sem que nada tenha sido corrigido. Mesmo
 * racional de `clarice-guardrail-alarm.ts` (fingerprint `campaign-{id}`).
 *
 * **Exceção: parada vencida (#10123).** `reportId` terminando em
 * `HALT_STALE_REPORT_SUFFIX` não é falha de um dia — é uma CONDIÇÃO que
 * persiste até o `--clear`. Por isso ganha fingerprint derivado da parada
 * (`haltAlarmFingerprint`, ex.: `halt:2610-11:2026-10-01T22:00:00.000Z`, sem
 * `aammdd`), `family: "estado"` (fecha sozinha depois que a parada some, via
 * streak de `CLOSE_ALARM_ISSUE_AFTER_RUNS`) e título/corpo próprios — o
 * texto de "falhou"/"monte a onda manualmente" contradizia a parada. Antes,
 * uma parada sem decisão abria uma issue P2 nova por dia. `halt` é a leitura
 * de `data/clarice-envio-halt.json` no momento do alarme. */
export function toAlarmFinding(
  evaluation: EnvioAlarmEvaluation,
  aammdd: string,
  halt: ClariceEnvioHaltRead | null = null,
): AlarmFinding {
  if (evaluation.reportId?.endsWith(HALT_STALE_REPORT_SUFFIX)) {
    const fingerprint = haltAlarmFingerprint(halt);
    const haltLine =
      halt && halt.halted
        ? halt.invalid
          ? `parada: data/clarice-envio-halt.json ILEGÍVEL (${halt.error})`
          : `parada: desde ${halt.halt.since}, ciclo ${halt.halt.cycle} (${halt.halt.reportId}) — fila ${halt.halt.queueAvailable}, desejado ${halt.halt.desiredVolume}`
        : "parada: arquivo ausente no momento do alarme (já limpa?)";
    return {
      check: "clarice-envio",
      fingerprint,
      family: "estado",
      title: `[diar.ia.br] Clarice: rampa parada há tempo demais por fila insuficiente (${fingerprint})`,
      body: [
        "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
        "(`scripts/clarice-envio-alarm.ts`, #10118/#10123).",
        "",
        `primeira detecção: ${aammdd}`,
        `relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md`,
        haltLine,
        "",
        "A rampa Clarice está PARADA de propósito (regra 260811, parada durável #10096) e a",
        "parada venceu: passou do limite de dias, o ciclo virou desde ela ou o arquivo está",
        "ilegível. Não é erro de execução; nenhuma onda é agendada até decisão do editor:",
        "",
        "- retomar a automação: `npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason \"...\"`",
        "- envio pontual com volume confirmado: `/diaria-clarice-envio --volume N` (não limpa a parada)",
        "",
        "Uma issue por parada (achado de ESTADO, #10123): as rodadas seguintes com a mesma",
        "parada reusam esta issue, e ela se fecha sozinha depois do `--clear`.",
      ].join("\n"),
      labels: ["bug"],
      priority: "P2",
    };
  }
  // #10114 — base colapsada também é CONDIÇÃO (re-derivada do histórico da
  // Brevo toda rodada até o editor decidir), não evento de um dia: mesma
  // lógica do #10123 — fingerprint estável, `family: "estado"`, uma issue
  // enquanto durar, fecha sozinha depois do `--accept-base`/envio confirmado.
  if (evaluation.reportId?.endsWith(BASE_COLLAPSE_REPORT_SUFFIX)) {
    return {
      check: "clarice-envio",
      fingerprint: "base-colapsada",
      family: "estado",
      title: "[diar.ia.br] Clarice: volume-base da rampa colapsou — rodada agendada parada (base-colapsada)",
      body: [
        "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
        "(`scripts/clarice-envio-alarm.ts`, #10114).",
        "",
        `primeira detecção: ${aammdd}`,
        `relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md`,
        "",
        "O último dia com onda da rampa (dN) ficou muito abaixo do pico recente — provável",
        "resíduo de onda parcial depois de uma parada. A rodada agendada não escala sobre essa",
        "base e não agenda nada até decisão do editor:",
        "",
        "- envio com volume confirmado: `/diaria-clarice-envio --volume N`",
        "- aceitar a base baixa e retomar: `npx tsx scripts/lib/clarice-envio-halt.ts --accept-base --reason \"...\"`",
        "",
        "Achado de ESTADO: as rodadas seguintes com a base ainda colapsada reusam esta issue.",
      ].join("\n"),
      labels: ["bug"],
      priority: "P2",
    };
  }
  return {
    check: "clarice-envio",
    fingerprint: `${aammdd}:${evaluation.verdict}:${evaluation.reportId ?? "no-report"}`,
    family: "evento",
    title:
      evaluation.verdict === "alarm-no-report"
        ? `[diar.ia.br] Diaria-Clarice-Envio: nenhum relatório encontrado pra ${aammdd}`
        : `[diar.ia.br] Diaria-Clarice-Envio falhou em ${aammdd} (${evaluation.reportId})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
      "(`scripts/clarice-envio-alarm.ts`).",
      "",
      `aammdd: ${aammdd}`,
      `verdict: ${evaluation.verdict}`,
      evaluation.reportId ? `reportId: ${evaluation.reportId}` : "Nenhum relatório encontrado — a rodada nem chegou a rodar.",
      "",
      "Monte a onda manualmente via /diaria-clarice-envio (skill manual) se ainda",
      "não houver onda agendada pra amanhã 06:00 BRT — não espere a task de amanhã.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) — achado de EVENTO",
      "PASSADO (#5553): a falha é do dia acima, não se auto-fecha quando a checagem",
      "seguinte avaliar outro dia. Fica aberta até um humano investigar/fechar",
      "(rota Overnight na Triagem).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
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

  // #5339 — reconcilia issue pro achado (se houver) ANTES de montar o
  // e-mail (o e-mail cita a issue), mesmo padrão do lote 1/3. Roda toda
  // execução não-dry-run. #7960: o e-mail (abaixo) é decidido a partir do
  // OUTCOME desta reconciliação (`notifyEditorForOutcomes`), não mais de
  // um estado `lastAlarmedAammdd` separado.
  // #10123: parada vencida usa a identidade da parada (não o dia) — lê o
  // arquivo de parada só nesse caso.
  const haltRead = evaluation.reportId?.endsWith(HALT_STALE_REPORT_SUFFIX) ? readClariceEnvioHalt(ROOT) : null;
  const alarmFindings: AlarmFinding[] = evaluation.verdict !== "ok" ? [toAlarmFinding(evaluation, aammdd, haltRead)] : [];
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`);
    return;
  }

  const result = await notifyEditorForOutcomes(
    findingOutcomes,
    "acao",
    (qualifying) => buildEnvioAlarmEmail(evaluation, aammdd, qualifying[0]),
    {
      cwd: ROOT,
      platformConfigPath: PLATFORM_CONFIG_PATH,
      emailTo: toOverride,
      // #10123: na parada vencida o fingerprint é a parada (sem `aammdd`) —
      // os dias seguintes reusam a issue e, por este mesmo intent, não
      // re-enviam e-mail: 1 aviso por parada, não 1 por dia.
      // #8271: fingerprint inclui `aammdd` — 1 ocorrência por dia, não um
      // conjunto persistente que precisa cutucar toda execução enquanto não
      // resolvido. Reexecução no MESMO dia reusa a issue (`action: "reused"`)
      // e não deve re-emitir e-mail sob `email_policy: "legacy"` — era esse
      // o dedup que o estado próprio `lastAlarmedAammdd` fazia antes.
      legacyResendIntent: "dedupe-new-occurrences-only",
    },
  );
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
