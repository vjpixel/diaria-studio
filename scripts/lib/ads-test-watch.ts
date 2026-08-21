/**
 * scripts/lib/ads-test-watch.ts (#5845)
 *
 * Lógica PURA da task diária `Diaria-Ads-Test-Watch` — cobra sozinha os
 * marcos do ciclo de vida do teste de 3 canais pagos (#5524) que hoje
 * dependem 100% da memória do editor (`data/aquisicao/campanhas-260816/00-PROTOCOLO.md`
 * §7.1/§7.2/§8.3). I/O (leitura de `run-state.json`/`clicks-2608.csv`,
 * envio de e-mail, invocação de `build-origem-map.ts`+`cac-report.ts`) mora
 * em `scripts/ads-test-watch.ts` — este arquivo só decide.
 *
 * ## As 5 checagens diárias (independentes, não mutuamente exclusivas)
 *
 * `planAdsTestWatchActions` decide, pra cada dia, quais das 5 ações abaixo
 * são cabíveis HOJE — várias podem coexistir (ex: se a task ficou parada
 * dias, religar-brevo e apuração podem estar ambas atrasadas no mesmo run):
 *
 * 1. `alarmMissingD0Overdue` — D0 planejado já passou e ninguém rodou
 *    `ads-test-d0.ts` ainda.
 * 2. `checkClicksCoverage` — dentro da janela: falta linha de ONTEM em
 *    `clicks-2608.csv` pra algum dos 3 braços?
 * 3. `checkDeathConditions` — dentro da janela: alguma condição de morte da
 *    §3.2 disparou (aqui, só o item 3, "gasto acumulado > 2× o planejado",
 *    que é o único verificável a partir da série de `clicks-2608.csv" — os
 *    outros dois, reprovação de política e limite de conta, exigem
 *    julgamento humano do painel)?
 * 4. `triggerReligarBrevo` — D+21 chegou e o religamento ainda não foi
 *    disparado (idempotente — 1x só, `AdsTestWatchState.religarBrevoTriggeredAt`).
 * 5. `runApuracao` — a data de apuração pré-registrada chegou e a apuração
 *    ainda não rodou (idempotente — 1x só, `AdsTestWatchState.apuracaoCompletedAt`
 *    — re-rodar sobrescreveria o relatório congelado, §7.2).
 *
 * ## Idempotência assimétrica (#5845 item 3)
 *
 * `triggerReligarBrevo`/`runApuracao` são eventos de UMA VEZ — repetir
 * geraria ruído (religar 2×) ou dano real (sobrescrever o relatório
 * congelado). `alarmMissingD0Overdue`/`checkClicksCoverage`/
 * `checkDeathConditions` são, de propósito, o OPOSTO: repetem TODO dia
 * enquanto a condição continuar verdadeira — dinheiro real em jogo (achado
 * faltando reconciliação ou condição de morte tem custo assimétrico de
 * esquecer, ver corpo da issue). Por isso `AdsTestWatchState` só persiste
 * os dois primeiros; os três "repeat" não têm cursor de idempotência
 * nenhum — o caller (I/O) os reavalia do zero a cada execução.
 */

import Papa from "papaparse";
import { addDays, daysBetween, type DateOnlyString } from "./ads-test-schedule.ts";
import type { AdsTestRunState } from "./ads-test-run-state.ts";

// ---------------------------------------------------------------------------
// Plano diário
// ---------------------------------------------------------------------------

/** Estado persistido (`data/aquisicao/teste-2608/watch-state.json`) — só os
 *  2 marcos de UMA VEZ. Ver docstring do módulo pra por que os demais não
 *  entram aqui. */
export interface AdsTestWatchState {
  religarBrevoTriggeredAt: string | null;
  apuracaoCompletedAt: string | null;
  apuracaoReportPath: string | null;
}

export function emptyAdsTestWatchState(): AdsTestWatchState {
  return { religarBrevoTriggeredAt: null, apuracaoCompletedAt: null, apuracaoReportPath: null };
}

export interface AdsTestWatchPlan {
  alarmMissingD0Overdue: boolean;
  checkClicksCoverage: boolean;
  checkDeathConditions: boolean;
  triggerReligarBrevo: boolean;
  runApuracao: boolean;
}

/**
 * Decide o plano de ações do dia. `plannedD0` é a data que o
 * `00-PROTOCOLO.md` recomenda pro acendimento (documentada em prosa, não
 * derivada de `run-state.json` — é justamente o caso "ninguém registrou
 * ainda" que este campo cobre); passe `null` quando não houver nenhuma data
 * planejada conhecida (o caller então nunca alarma `alarmMissingD0Overdue`).
 *
 * @pure
 */
export function planAdsTestWatchActions(
  nowDateStr: DateOnlyString,
  runState: AdsTestRunState | null,
  plannedD0: DateOnlyString | null,
  watchState: AdsTestWatchState,
): AdsTestWatchPlan {
  if (runState == null) {
    return {
      alarmMissingD0Overdue: plannedD0 != null && nowDateStr > plannedD0,
      checkClicksCoverage: false,
      checkDeathConditions: false,
      triggerReligarBrevo: false,
      runApuracao: false,
    };
  }
  const withinWindow = runState.d0 <= nowDateStr && nowDateStr <= runState.fim_janela;
  // `checkClicksCoverage` audita a linha de ONTEM (ver scripts/ads-test-watch.ts),
  // não a de hoje — por isso o gate dela é sobre `nowDateStr - 1`, não sobre
  // `nowDateStr` (que é o que `withinWindow` mede). Usar `withinWindow` direto
  // aqui tem 2 bugs simétricos (#5845 self-review, findings 1/2):
  //   1. no D0 exato, "ontem" é D0-1 — antes da campanha existir, nenhuma
  //      linha pode existir ainda, e o alarme de cobertura falso-dispara
  //      garantido todo D0.
  //   2. o ÚLTIMO dia da janela (fim_janela) nunca seria auditado, porque
  //      checá-lo exige rodar em fim_janela+1, que já é `nowDateStr >
  //      fim_janela` (fora de `withinWindow`).
  // Gate correto, independente do de `checkDeathConditions`: "ontem" cai
  // dentro de [d0, fim_janela] — cobre exatamente cada dia da janela, uma
  // vez, no dia seguinte.
  const yesterday = addDays(nowDateStr, -1);
  const coverageDateInRange = runState.d0 <= yesterday && yesterday <= runState.fim_janela;
  return {
    alarmMissingD0Overdue: false,
    checkClicksCoverage: coverageDateInRange,
    checkDeathConditions: withinWindow,
    triggerReligarBrevo: nowDateStr >= runState.religar_brevo && watchState.religarBrevoTriggeredAt == null,
    runApuracao: nowDateStr >= runState.apuracao_snapshot && watchState.apuracaoCompletedAt == null,
  };
}

export function markReligarBrevoTriggered(state: AdsTestWatchState, nowIso: string): AdsTestWatchState {
  return { ...state, religarBrevoTriggeredAt: nowIso };
}

export function markApuracaoCompleted(state: AdsTestWatchState, nowIso: string, reportPath: string): AdsTestWatchState {
  return { ...state, apuracaoCompletedAt: nowIso, apuracaoReportPath: reportPath };
}

// ---------------------------------------------------------------------------
// clicks-2608.csv — parse + cobertura + condição de morte (§3.2 item 3)
// ---------------------------------------------------------------------------

export const CLICKS_CSV_HEADERS = [
  "canal",
  "data_apuracao",
  "gasto_acumulado",
  "cliques",
  "impressoes",
  "cpc_medio",
  "conversoes",
  "custo_por_conversao",
  "perda_orcamento",
  "perda_ranking",
  "fonte",
] as const;

export interface ClicksCsvRow {
  canal: string;
  data_apuracao: DateOnlyString;
  gasto_acumulado: number;
}

export interface ClicksCsvRowError {
  line: number;
  reason: string;
}

export interface ClicksCsvParseResult {
  rows: ClicksCsvRow[];
  errors: ClicksCsvRowError[];
}

/**
 * Parse tolerante-mas-barulhento de `clicks-2608.csv` (mesma disciplina de
 * `aquisicao-spend.ts`): header faltando lança (arquivo inválido inteiro);
 * célula vazia/inválida numa linha específica exclui só aquela linha,
 * registrada em `errors`, nunca coagida a `0`/`""` silencioso.
 *
 * @pure
 */
export function parseClicksCsv(content: string): ClicksCsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];
  const missingHeaders = (["canal", "data_apuracao", "gasto_acumulado"] as const).filter((h) => !fields.includes(h));
  if (missingHeaders.length > 0) {
    throw new Error(
      `[clicks-2608.csv] coluna(s) obrigatória(s) ausente(s) no header: ${missingHeaders.join(", ")}. ` +
        `Esperado (mínimo): canal,data_apuracao,gasto_acumulado. Encontrado: ${fields.length > 0 ? fields.join(",") : "(vazio)"}.`,
    );
  }

  const rows: ClicksCsvRow[] = [];
  const errors: ClicksCsvRowError[] = [];
  parsed.data.forEach((raw, idx) => {
    const line = idx + 2;
    const canal = (raw.canal ?? "").trim();
    const data_apuracao = (raw.data_apuracao ?? "").trim();
    const gastoRaw = (raw.gasto_acumulado ?? "").trim();
    if (!canal || !data_apuracao || !gastoRaw) {
      errors.push({ line, reason: `campo(s) obrigatório(s) vazio(s) (canal/data_apuracao/gasto_acumulado)` });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_apuracao)) {
      errors.push({ line, reason: `"data_apuracao" não é YYYY-MM-DD: "${data_apuracao}"` });
      return;
    }
    const gasto_acumulado = Number(gastoRaw);
    if (!Number.isFinite(gasto_acumulado) || gasto_acumulado < 0) {
      errors.push({ line, reason: `"gasto_acumulado" não é um número não-negativo válido: "${gastoRaw}"` });
      return;
    }
    rows.push({ canal, data_apuracao, gasto_acumulado });
  });
  return { rows, errors };
}

/** Braços SEM nenhuma linha em `dateStr` (§8.3 — cobrança obrigatória
 *  diária). Retorna a sublista de `bracos` faltante, na mesma ordem. */
export function findMissingClicksBracosForDate(
  rows: readonly ClicksCsvRow[],
  bracos: readonly string[],
  dateStr: DateOnlyString,
): string[] {
  const present = new Set(rows.filter((r) => r.data_apuracao === dateStr).map((r) => r.canal));
  return bracos.filter((b) => !present.has(b));
}

export interface SpendOverageFinding {
  braco: string;
  /** Linha mais recente conhecida (`data_apuracao`) usada pra checar. */
  lastKnownDate: DateOnlyString;
  gastoAcumulado: number;
  plannedCumulativeBRL: number;
  ratio: number;
}

/**
 * §3.2 item 3 — "cobrança acima do nominal: gasto acumulado > 2× o
 * planejado do período". Pra cada braço, usa a linha mais recente conhecida
 * (`data_apuracao` mais próxima de `todayDateStr`, sem ultrapassá-lo) e
 * compara `gasto_acumulado` contra 2× o orçamento diário planejado
 * acumulado desde D0 até aquela data (inclusive). Braço sem nenhuma linha
 * ainda não entra na lista (nada a avaliar — vira achado de cobertura
 * faltante, não de morte).
 *
 * `plannedDailyBudgetBRL` é passado pelo caller (não hardcoded aqui) — o
 * número em si é decisão de negócio (`00-PROTOCOLO.md` §"Orçamento do 1º
 * mês", R$ 100/dia por braço na revisão de 18/08/2026) e pode mudar sem
 * exigir mudança de código.
 *
 * @pure
 */
export function evaluateSpendOverageDeathCondition(
  rows: readonly ClicksCsvRow[],
  bracos: readonly string[],
  d0: DateOnlyString,
  todayDateStr: DateOnlyString,
  plannedDailyBudgetBRL: number,
): SpendOverageFinding[] {
  const findings: SpendOverageFinding[] = [];
  for (const braco of bracos) {
    const candidateRows = rows.filter((r) => r.canal === braco && r.data_apuracao <= todayDateStr);
    if (candidateRows.length === 0) continue;
    const latest = candidateRows.reduce((a, b) => (a.data_apuracao >= b.data_apuracao ? a : b));
    const daysElapsed = Math.max(1, daysBetween(d0, latest.data_apuracao) + 1);
    const plannedCumulativeBRL = plannedDailyBudgetBRL * daysElapsed;
    const threshold = 2 * plannedCumulativeBRL;
    if (latest.gasto_acumulado > threshold) {
      findings.push({
        braco,
        lastKnownDate: latest.data_apuracao,
        gastoAcumulado: latest.gasto_acumulado,
        plannedCumulativeBRL,
        ratio: latest.gasto_acumulado / plannedCumulativeBRL,
      });
    }
  }
  return findings;
}

/** Orçamento diário planejado por braço, R$ (§"Orçamento do 1º mês",
 *  18/08/2026 — os 3 braços do teste 2608 têm o mesmo diário nominal).
 *  Override via `--planned-daily-budget` no script CLI se o valor de
 *  negócio mudar antes do código ser atualizado. */
export const DEFAULT_PLANNED_DAILY_BUDGET_BRL = 100;

// ---------------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------------

export function buildMissingD0OverdueEmail(plannedD0: DateOnlyString, nowDateStr: DateOnlyString): { subject: string; body: string } {
  return {
    subject: `⚠️ Teste 2608: D0 planejado (${plannedD0}) já passou sem registro`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `A data planejada de acendimento (${plannedD0}) já passou (hoje: ${nowDateStr}) e ninguém rodou`,
      `\`npx tsx scripts/ads-test-d0.ts --d0 AAAA-MM-DD\` ainda.`,
      "",
      "Se o teste já acendeu numa data diferente da planejada, rode o comando acima com a data REAL — o",
      "pré-registro precisa existir antes de qualquer reconciliação diária ser cobrada (00-PROTOCOLO.md §7.1).",
      "Se o teste ainda não vai acender, ignore este e-mail (ele repete todo dia até o registro existir).",
    ].join("\n"),
  };
}

export function buildMissingClicksCoverageEmail(missingBracos: readonly string[], dateStr: DateOnlyString): { subject: string; body: string } {
  return {
    subject: `⚠️ Teste 2608: reconciliação de gasto faltando para ${dateStr}`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `Falta linha de gasto em data/aquisicao/clicks-2608.csv para ${dateStr}, nos braços:`,
      ...missingBracos.map((b) => `  - ${b}`),
      "",
      "Reconciliar HOJE nos painéis (00-PROTOCOLO.md §8.3) — a regra de morte da §3.2 item 3",
      "(\"gasto acumulado > 2× o planejado\") fica inverificável sem série diária, e um braço que",
      "estourou não seria descoberto até a apuração final, quando já não há o que fazer.",
    ].join("\n"),
  };
}

export function buildDeathConditionEmail(findings: readonly SpendOverageFinding[]): { subject: string; body: string } {
  return {
    subject: `🚨 Teste 2608: condição de morte disparada (gasto > 2× o planejado)`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845) — 00-PROTOCOLO.md §3.2 item 3.`,
      "",
      "Braço(s) com gasto acumulado acima de 2× o planejado do período:",
      ...findings.map(
        (f) =>
          `  - ${f.braco}: R$ ${f.gastoAcumulado.toFixed(2)} acumulado até ${f.lastKnownDate} ` +
          `(planejado: R$ ${f.plannedCumulativeBRL.toFixed(2)}, razão ${f.ratio.toFixed(2)}×)`,
      ),
      "",
      "Ação: confirmar no painel da plataforma se é cobrança de entrega além do nominal (o Google pode",
      "gastar até 2× o diário num dia isolado — normal) ou um problema real de conta. Registrar a decisão",
      "no 00-PROTOCOLO.md §3.2/§4 antes de qualquer ação sobre a campanha (congelamento operacional §3.4).",
      "",
      "Este alarme REPETE todo dia enquanto a condição continuar verdadeira — dinheiro real em jogo.",
    ].join("\n"),
  };
}

export function buildReligarBrevoDueEmail(religarDate: DateOnlyString): { subject: string; body: string } {
  return {
    subject: `Teste 2608: D+21 chegou (${religarDate}) — religar Diaria-Brevo-Diaria-Evaluate`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `A data de religamento pré-registrada (D+21 = ${religarDate}) chegou. #5838 rastreia esta ação —`,
      "ver o comentário automático desta task nela, ou reverter manualmente `enabled: false` na entrada",
      "`Diaria-Brevo-Diaria-Evaluate` de scripts/lib/scheduled-tasks.ts.",
    ].join("\n"),
  };
}

export function buildApuracaoSnapshotUnusableEmail(snapshotDate: DateOnlyString, reason: string): { subject: string; body: string } {
  return {
    subject: `🚨 Teste 2608: apuração de ${snapshotDate} NÃO rodou — snapshot inutilizável`,
    body: [
      `Alarme automático do Diaria-Ads-Test-Watch (#5845).`,
      "",
      `Hoje é a data de apuração pré-registrada (${snapshotDate}), mas o snapshot correspondente de`,
      `data/beehiiv-backup/${snapshotDate}/ está inutilizável: ${reason}`,
      "",
      "A apuração NÃO foi rodada (00-PROTOCOLO.md §7.2 — um relatório congelado sobre snapshot ruim é",
      "pior que nenhum, porque o id do relatório é a data do snapshot e re-rodar sobrescreve). Este alarme",
      "REPETE todo dia até o snapshot ficar utilizável ou você intervir manualmente.",
    ].join("\n"),
  };
}

export function buildApuracaoSuccessEmail(snapshotDate: DateOnlyString, reportUrl: string): { subject: string; body: string } {
  return {
    subject: `Teste 2608: apuração congelada rodou (snapshot ${snapshotDate})`,
    body: [
      `A apuração pré-registrada (00-PROTOCOLO.md §7.1) rodou automaticamente hoje.`,
      "",
      `Relatório: ${reportUrl}`,
      "",
      "build-origem-map.ts rodou imediatamente antes de cac-report.ts, como exige a §7.2.",
    ].join("\n"),
  };
}
