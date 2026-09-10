#!/usr/bin/env node
/**
 * scripts/dmarc-enforcement-alarm.ts (#6442)
 *
 * Task agendada SEMANAL que roda o motor read-only de decisão DMARC
 * (`scripts/dmarc-enforcement-engine.ts` + `scripts/lib/
 * dmarc-enforcement-policy.ts`) e, quando a recomendação é `escalate` ou
 * `consider-rollback` (nunca em `hold`), abre/atualiza UMA issue via o
 * mesmo mecanismo genérico de alarme do resto do repo
 * (`scripts/lib/alarm-issues.ts`). O motor em si já é read-only por design
 * (nunca toca DNS/Cloudflare) — este script só fecha o laço de
 * observabilidade, o mesmo papel que `kit-subscriber-limit-alarm.ts`/
 * `acervo-staleness-alarm.ts` cumprem para os alarmes deles.
 *
 * Escopo desta unidade (residual declarado no #6442, comentário de
 * 28/08/2026: "integrar a task/script a um cron/hook real fica pra decisão
 * do editor"): fecha exatamente esse residual — o motor de decisão em si
 * (mergeado em `f80956d4`) não muda aqui.
 *
 * ## Uso
 *
 *   npx tsx scripts/dmarc-enforcement-alarm.ts               # avalia + cria/atualiza issue se necessário
 *   npx tsx scripts/dmarc-enforcement-alarm.ts --dry-run      # avalia + imprime, NÃO chama `gh`
 *
 * ## Fail-soft (#6442, escopo explícito)
 *
 * `KIT_API_KEY` ausente, ou qualquer falha de rede/DNS na leitura dos
 * sinais (`buildDmarcEnforcementReport`), vira LOG e `return` — nunca abre
 * issue a partir de uma leitura que falhou. Alarmar por instabilidade
 * momentânea de rede treinaria o editor a ignorar o alarme (mesmo racional
 * de `acervo-staleness-alarm.ts`: "sem dado" != "situação ruim").
 *
 * ## Guard de publicação
 *
 * Só LEITURA (Kit API `GET`, DNS `resolveTxt`, `gh issue create/comment` —
 * nenhuma dessas escreve DNS nem manda e-mail em nome do domínio). Nenhuma
 * chamada de escrita a `_dmarc.news.diar.ia.br`: aplicar a recomendação
 * segue ação manual do editor no Cloudflare, como a docstring do motor já
 * declara.
 *
 * Como os outros alarmes locais deste repo, o registro na task
 * (`scripts/lib/scheduled-tasks.ts` → `Diaria-Dmarc-Enforcement-Alarm`)
 * nasce DECLARADO — armar via `scripts/setup-systemd-timers.ts` na checkout
 * compartilhada (`helios`) é ação POSTERIOR do editor.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { buildDmarcEnforcementReport, DMARC_TARGET_DOMAIN } from "./dmarc-enforcement-engine.ts";
import { resolveDmarcEnforcementReport, toAlarmFindings } from "./lib/dmarc-enforcement-alarm.ts";
import {
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  planAlarmReconciliation,
  saveAlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "dmarc-enforcement", "alarm-issues.json");
const LOG_PREFIX = "[dmarc-enforcement-alarm]";
/** Semanal (não diária, não a cada 4h como o alarme de teto do Kit): uma
 *  transição de política DNS é rara e discreta, não um número que muda todo
 *  dia (ver docstring de `dmarc-enforcement-policy.ts`, ponto 3 da analogia
 *  com o freio Clarice) — 2 execuções limpas consecutivas = ~2 semanas sem
 *  achado antes de fechar a issue sozinha, coerente com a cadência semanal
 *  desta task. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadProjectEnv(ROOT);
  const isDryRun = hasFlag(argv, "dry-run");

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    console.log(`${LOG_PREFIX} ${kitConfigResult.reason} — nada a checar (fail-soft, nenhum alarme).`);
    return 0;
  }

  const outcome = await resolveDmarcEnforcementReport(
    (domain, now) => buildDmarcEnforcementReport({ domain, now }),
    DMARC_TARGET_DOMAIN,
    new Date(),
  );
  if (!outcome.ok) {
    // Rede/DNS/Kit indisponível vira "sem dado", nunca alarme — mesmo
    // racional de acervo-staleness-alarm.ts: instabilidade momentânea não
    // pode abrir issue (treinaria o editor a ignorar o alarme).
    console.log(`${LOG_PREFIX} falha ao ler sinais (${outcome.error}) — nada a checar (fail-soft, nenhum alarme).`);
    return 0;
  }
  const report = outcome.report;

  console.log(
    `${LOG_PREFIX} ${report.domain}: política=${report.currentPolicy ?? "none"} nível=${report.decision.level} ` +
      `recomendação=${report.decision.recommendation}${report.decision.nextPolicy ? ` (${report.decision.nextPolicy})` : ""} ` +
      `bounce=${report.decision.bounceRatePct.toFixed(2)}% complaint=${report.decision.complaintRatePct.toFixed(2)}%`,
  );

  const findings = toAlarmFindings(report);
  const state = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planAlarmReconciliation(findings, state, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
    return 0;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`${LOG_PREFIX} erro fatal: ${(e as Error).message}`);
      process.exitCode = 1;
    });
}
