#!/usr/bin/env node
/**
 * scripts/aquisicao-reconcile-daily.ts (#8591)
 *
 * Wrapper agendável de `scripts/aquisicao-reconcile.ts` — fecha o item 3 da
 * issue #8591 ("Nada alarma quando o painel de ads descola dos cadastros
 * reais"): rodar `baseline` todo dia, sem depender de alguém lembrar de
 * invocar o comando manual.
 *
 * ## O que este script FAZ
 *
 * Roda `baseline` (`aggregateBaseline` + `fetchSubscribersByBackend`, ambos
 * de `aquisicao-reconcile.ts`, inalterados) para o dia BRT ANTERIOR ao
 * horário de execução, grava o JSON de sempre em
 * `data/aquisicao/reconcile-baseline-{dia}_{dia}.json` (idempotente por
 * dia — reexecução no mesmo dia sobrescreve o mesmo arquivo) e imprime a
 * coorte real por canal. Backend (Kit ou Beehiiv) resolvido por
 * `resolveNewsletterSubscriberBackend()` — mesmo dispatch do subcomando
 * manual; item 1 da #8591 ("baseline lê a fonte errada") já foi corrigido
 * no #7561 (06/09/2026), antes desta issue ter sido aberta — este script
 * não precisa (nem deveria) tocar nesse dispatch.
 *
 * ## O painel agora chega sozinho (item 2 da #8591, fechado 28/09/2026)
 *
 * O bloqueio original era decidir, por plataforma, qual AÇÃO de conversão
 * conta como "cadastro" — trade-off editorial genuíno (critério 2 de
 * "Perguntar é exceção", CLAUDE.md), não uma escolha mecânica que este
 * script pudesse inventar sozinho. O editor decidiu via `/diaria-desbloqueia`
 * em 28/09/2026 (comentário da issue): **CompleteRegistration** — Meta
 * `complete_registration` (Graph API `insights.actions`), Google a ação
 * PRIMÁRIA de cadastro newsletter (`7418673798 "Assinatura Confirmada"`,
 * distinta da ação de confirmação DOI do #8555/#8573, secundária).
 *
 * `scripts/aquisicao-conversions-ingest.ts` (task própria, agendada ANTES
 * desta) busca essas conversões diariamente e grava
 * `data/aquisicao/painel/{dia}.json` — o MESMO caminho que este script já
 * lia manualmente. Este script não muda: `factor` roda sobre qualquer
 * arquivo que estiver nesse caminho quando ele processar o dia, sem saber
 * (nem precisar saber) se foi escrito à mão ou pelo ingest automático — se
 * não existir (credencial ausente, API fora do ar, ou alguém preferir
 * editar à mão pra um dia específico), loga que o passo foi pulado por
 * falta de painel e segue, nunca trata isso como erro.
 *
 * ## Alarme por faixa sobre janela de 7 dias (item 3 da #8591, fechado 28/09/2026)
 *
 * A issue original propunha começar em log-only e medir 2-3 semanas antes
 * de decidir a faixa — mas o piso de VOLUME (`RECONCILE_MIN_VOLUME_REAL`,
 * `scripts/lib/aquisicao-reconcile-alarm.ts`) já cumpre o mesmo papel
 * mecanicamente: a soma de `coorte_real` de 7 dias só passa do piso quando
 * a série tiver volume de fato, então o alarme não tem como disparar sobre
 * ruído dos primeiros dias — não precisa de um cutover manual depois de uma
 * janela de calendário. Faixa e piso documentados e justificados na
 * docstring de `aquisicao-reconcile-alarm.ts` (1,5× / 0,67× / piso 20
 * cadastros / janela 7 dias — os mesmos 4 números que decidiriam o
 * cutover de log-only pra alarme de verdade, só que decididos agora em vez
 * de depois). Achado que sair da faixa vira issue (`family: "estado"`,
 * mesmo mecanismo de `alarm-issues.ts` que `home-meta-check.ts` já usa) —
 * fecha sozinha quando o fator volta pra dentro da faixa por
 * `CLOSE_ALARM_ISSUE_AFTER_RUNS` execuções seguidas.
 *
 * ## Fail-soft
 *
 * Mesma disciplina de `google-ads-ingest-spend.ts`/`meta-ads-ingest-spend.ts`:
 * qualquer falha (MCP fora do ar, API fora do ar, `data/` não montada)
 * imprime o motivo e sai com **exit 0** — a task agendada nunca falha
 * ruidosamente por uma ingestão de observabilidade.
 *
 * Uso:
 *   npx tsx scripts/aquisicao-reconcile-daily.ts                # dia BRT anterior
 *   npx tsx scripts/aquisicao-reconcile-daily.ts --day AAAA-MM-DD  # override p/ teste/backfill
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { brtDateOf, shiftDate } from "./lib/ads-rolling-window.ts";
import {
  aggregateBaseline,
  computeFactor,
  fetchSubscribersByBackend,
  type BaselineFile,
  type FactorResult,
  type PanelInput,
} from "./aquisicao-reconcile.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import {
  evaluateReconcileDrift,
  flattenFactorResultsByDay,
  RECONCILE_WINDOW_DAYS,
  type ReconcileDriftEvaluation,
} from "./lib/aquisicao-reconcile-alarm.ts";
import {
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
} from "./lib/alarm-issues.ts";

const ALARM_STATE_PATH = resolve("data", "aquisicao", "alarm-issues.json");
/** Mesmo teto de `home-meta-check.ts` — 3 execuções diárias limpas seguidas
 *  antes de fechar sozinho (evita fechar/reabrir no ruído de 1 dia isolado
 *  em cima do piso de fronteira). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 3;

/** Dia BRT a processar por default: o dia ANTERIOR ao instante de execução
 * (mesma lógica de "roda de manhã sobre o dia que já fechou" dos ingests de
 * gasto vizinhos). @pure em relação a `now`. */
export function defaultProcessingDay(now: Date): string {
  return shiftDate(brtDateOf(now), -1);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv).values;
  const day = typeof args.day === "string" && args.day ? args.day : defaultProcessingDay(new Date());

  console.log(`[aquisicao-reconcile-daily] dia ${day} — backend=${resolveNewsletterSubscriberBackend()}`);

  let baseline: BaselineFile;
  try {
    const subs = await fetchSubscribersByBackend(resolveNewsletterSubscriberBackend());
    baseline = aggregateBaseline(subs, day, day);
  } catch (e) {
    console.error(
      `[aquisicao-reconcile-daily] falha ao drenar a coorte real (${e instanceof Error ? e.message : String(e)}) — pulando o dia, sem alarmar (fail-soft, mesma disciplina dos ingests de gasto)`,
    );
    return 0;
  }

  const baselinePath = resolve("data", "aquisicao", `reconcile-baseline-${day}_${day}.json`);
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`[aquisicao-reconcile-daily] coorte real ${day}: ${baseline.total} cadastros`);
  for (const [channel, count] of Object.entries(baseline.per_channel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${channel}: ${count}`);
  }

  const panelPath = resolve("data", "aquisicao", "painel", `${day}.json`);
  if (!existsSync(panelPath)) {
    console.log(
      `[aquisicao-reconcile-daily] sem painel em ${panelPath} — fator não calculado hoje (ingestão automática de conversões do painel é bloqueio documentado da #8591, item 2: nenhum canal expõe conversões pelos ingests de gasto atuais)`,
    );
    return 0;
  }

  let panel: PanelInput;
  try {
    panel = JSON.parse(readFileSync(panelPath, "utf8")) as PanelInput;
  } catch (e) {
    console.error(
      `[aquisicao-reconcile-daily] painel em ${panelPath} não é JSON válido (${e instanceof Error ? e.message : String(e)}) — pulando o fator do dia, sem alarmar`,
    );
    return 0;
  }

  const result = computeFactor(baseline, panel);
  console.log(`[aquisicao-reconcile-daily] fator do dia ${day}:`);
  for (const row of result.rows) {
    const fator = row.fator_superestimacao == null ? "SEM COORTE" : `${row.fator_superestimacao.toFixed(2)}x`;
    console.log(`  ${row.channel.padEnd(12)} painel=${row.reported_conversions} real=${row.coorte_real} fator=${fator}`);
  }
  const fatorPath = resolve("data", "aquisicao", "painel", `${day}.fator.json`);
  writeFileSync(fatorPath, JSON.stringify(result, null, 2) + "\n");

  evaluateAndAlarmDrift(day);
  return 0;
}

/**
 * Lê os `{dia}.fator.json` dos últimos `RECONCILE_WINDOW_DAYS` dias
 * (incluindo `day`, o dia recém-processado), agrega por canal e abre/fecha
 * issue de alarme via `alarm-issues.ts` para quem saiu da faixa aceitável
 * (`evaluateReconcileDrift`, `scripts/lib/aquisicao-reconcile-alarm.ts`).
 * Fail-soft por inteiro (#8591 item 3 herda a mesma disciplina do resto
 * deste script) — qualquer falha de leitura/`gh` aqui é logada e NUNCA faz
 * a task sair com erro; o cálculo do fator do dia (acima) já terminou e foi
 * persistido antes desta função ser chamada.
 */
function evaluateAndAlarmDrift(latestDay: string): void {
  try {
    const byDay = new Map<string, FactorResult>();
    for (let i = 0; i < RECONCILE_WINDOW_DAYS; i++) {
      const d = shiftDate(latestDay, -i);
      const p = resolve("data", "aquisicao", "painel", `${d}.fator.json`);
      if (!existsSync(p)) continue;
      try {
        byDay.set(d, JSON.parse(readFileSync(p, "utf8")) as FactorResult);
      } catch (e) {
        console.warn(`[aquisicao-reconcile-daily] alarme — ${p} não é JSON válido, pulando esse dia na janela (${e instanceof Error ? e.message : e})`);
      }
    }
    const rows = flattenFactorResultsByDay(byDay);
    const evaluations = evaluateReconcileDrift(rows);
    const drifting = evaluations.filter((e) => e.status === "alto" || e.status === "baixo");

    if (evaluations.length === 0) {
      console.log("[aquisicao-reconcile-daily] alarme — sem histórico suficiente na janela ainda, nada a avaliar.");
      return;
    }
    for (const e of evaluations) {
      console.log(
        `[aquisicao-reconcile-daily] alarme janela(${RECONCILE_WINDOW_DAYS}d) ${e.channel.padEnd(12)} ` +
          `real=${e.real_sum} painel=${e.reported_sum} fator=${e.factor == null ? "n/d" : e.factor.toFixed(2) + "x"} status=${e.status}`,
      );
    }
    if (drifting.length === 0) return;

    const findings: AlarmFinding[] = drifting.map((e) => buildDriftAlarmFinding(e, latestDay));
    const state = loadAlarmIssuesState(ALARM_STATE_PATH);
    const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, {
      cwd: process.cwd(),
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState, ALARM_STATE_PATH);
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`[aquisicao-reconcile-daily] alarme — issue não criada/reusada para ${o.fingerprint}: ${o.error}`);
      } else {
        console.log(`[aquisicao-reconcile-daily] alarme — issue #${o.issueNumber} (${o.action}) para ${o.fingerprint}: ${o.url}`);
      }
    }
  } catch (e) {
    console.error(
      `[aquisicao-reconcile-daily] falha ao avaliar/alarmar drift do fator (${e instanceof Error ? e.message : String(e)}) — sem alarmar hoje, sem afetar o resultado já gravado acima (fail-soft)`,
    );
  }
}

/** @pure */
export function buildDriftAlarmFinding(e: ReconcileDriftEvaluation, day: string): AlarmFinding {
  const direcao = e.status === "alto" ? "acima" : "abaixo";
  const fatorTxt = e.factor == null ? "n/d" : e.factor.toFixed(2) + "×";
  return {
    check: "aquisicao-reconcile-drift",
    fingerprint: `aquisicao-reconcile-drift:${e.cohort_key}`,
    family: "estado",
    priority: "P2",
    labels: ["bug"],
    title: `Fator de superestimação (${e.cohort_key}) fora da faixa: ${fatorTxt}`,
    body: [
      `O fator de superestimação do canal \`${e.cohort_key}\` está **${direcao} da faixa aceitável** (0,67×–1,5×,`,
      "ver docstring de `scripts/lib/aquisicao-reconcile-alarm.ts`), medido em `Diaria-Aquisicao-Reconcile-Daily`",
      `na janela móvel dos últimos ${RECONCILE_WINDOW_DAYS} dias (última data processada: ${day}).`,
      "",
      `- Coorte real (soma da janela): **${e.real_sum}**`,
      `- Conversões reportadas pelo painel (soma da janela): **${e.reported_sum}**`,
      `- Fator: **${fatorTxt}**`,
      `- Dias com dado na janela: ${e.days_with_data}/${RECONCILE_WINDOW_DAYS}`,
      "",
      "Origem: #8591 (mecanismo de alarme), #8572 (o caso concreto — Meta contando 2,4×",
      "— que motivou este alarme existir).",
    ].join("\n"),
  };
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(0);
    });
}
