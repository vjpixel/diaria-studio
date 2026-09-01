/**
 * scripts/lib/systemd-unit-rate-alarm.ts (#5765)
 *
 * Lógica PURA do alarme de TAXA de sucesso de unit systemd `--user`
 * `diaria-*.service` — complementa (não substitui) o sweep de ESTADO
 * instantâneo `scripts/systemd-failed-units-alarm.ts` (#5563).
 *
 * ─── O ponto cego que este módulo fecha ────────────────────────────────────
 *
 * `systemctl --user list-units --state=failed` só vê uma unit que ESTÁ em
 * `failed` no momento da varredura. Uma oneshot disparada por timer (a forma
 * de quase toda task deste registro) não fica em `failed` — a execução
 * seguinte limpa o estado, sucesso ou não. Uma task que falha 69% das vezes
 * (caso real: #5763, `Diaria-Clarice-Novos`, 9 de 13 execuções falhas numa
 * semana) nunca aparece como problema persistente pro sweep de estado — só
 * como churn de issue que abre e fecha sozinha (#5733).
 *
 * ─── O que este módulo mede: TAXA sobre uma janela de N execuções ─────────
 *
 * `evaluateUnitFailureRate` recebe o histórico de invocações já parseado
 * (mais antiga → mais recente) e olha só as últimas `windowSize` — alarma
 * quando `failuresInWindow >= failureThreshold` dentro dessa janela. Menos
 * de `windowSize` invocações no histórico → `"insufficient-data"` (nunca
 * alarma por falta de dado — uma unit nova/rara não deve gerar ruído só por
 * ainda não ter 5 execuções registradas).
 *
 * ─── Critério de FECHAMENTO — por que reusar `alarm-issues.ts` sem
 *     lógica especial de janela é CORRETO aqui (não é o mesmo erro do
 *     alarme de estado) ──────────────────────────────────────────────────
 *
 * O alarme de ESTADO fecha quando a checagem seguinte não vê a unit em
 * `failed` — e uma oneshot SEMPRE limpa esse estado na execução seguinte,
 * sucesso ou não, daí o churn que esta issue existe pra corrigir.
 *
 * Este alarme de TAXA não tem esse problema: o "achado pendente" de uma
 * execução do script NÃO é "a última invocação falhou" — é "a JANELA das
 * últimas `windowSize` invocações tem `failureThreshold`+ falhas". Uma
 * execução isolada boa desloca a janela, mas as falhas anteriores continuam
 * dentro dela até saírem por idade — então o achado só desaparece de
 * `pending` (`verdict !== "alarm-rate"`) quando a janela inteira já
 * melhorou, nunca por 1 execução isolada passar. Isso já É, por
 * construção, "a taxa se recuperou ao longo de N execuções" — não precisa
 * de um critério de fechamento diferente do `family: "estado"` padrão de
 * `alarm-issues.ts` (`CLOSE_ALARM_ISSUE_AFTER_RUNS` script-invocations
 * consecutivas sem o achado em `pending`). O que muda entre os dois alarmes
 * é a definição de "achado pendente" (instantânea vs. janela deslizante),
 * não o mecanismo de streak — reusar o mecanismo é seguro justamente
 * porque a entrada dele (`pending`) já carrega a semântica de janela.
 * Ver testes de `evaluateUnitFailureRate` abaixo pra essa propriedade
 * verificada isoladamente (1 execução de recuperação isolada não muda o
 * veredito; só a janela inteira melhorando muda).
 *
 * ─── `successExitCodes` — ruído tratado, não ignorado ──────────────────────
 *
 * Uma task pode declarar `successExitCodes` (`scripts/lib/scheduled-tasks.ts`
 * — ex: `Diaria-Clarice-Novos`/`-Tarde`, exit 3 = resultado ambíguo normal,
 * não falha). `evaluateUnitFailureRate` recebe essa lista e trata uma
 * invocação com esse exit code como sucesso pro cálculo de taxa — do
 * contrário toda task com exit code "esperado" viraria ruído sistemático
 * neste alarme.
 *
 * ─── I/O (fora deste arquivo) ───────────────────────────────────────────────
 *
 * `scripts/systemd-unit-rate-alarm.ts` faz a leitura via `journalctl --user
 * -u <unit>` (SÓ LEITURA — nunca muta nada) e parseia com
 * `parseJournalUnitOutcomes` abaixo. Fail-soft em máquina sem systemd
 * `--user`/`journalctl` (sessão cloud, clone fresco): mesmo padrão de
 * `systemd-failed-units-alarm.ts`/`studio-liveness-alarm.ts` — ENOENT vira
 * "nada detectável", nunca alarme.
 */

/** Resultado de UMA invocação (execução completa) da unit, extraído do
 * journal. `"failure"` carrega o exit code quando disponível (`null` se a
 * linha "Failed with result" apareceu sem uma linha "Main process exited"
 * imediatamente anterior reconhecida — journal truncado/formato inesperado;
 * tratado como falha "genérica", nunca dispensada por `successExitCodes`
 * porque não dá pra saber se o code era esperado). */
export type UnitInvocationOutcome = { kind: "success" } | { kind: "failure"; exitCode: number | null };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pura — extrai o histórico de invocações (mais antiga → mais recente, mesma
 * ordem cronológica do `journalctl` default) das linhas de log que o
 * `systemd[1]` (o manager, não o processo da task) emite ao concluir uma
 * unit oneshot:
 *
 *   - sucesso: `"<unit>: Deactivated successfully."`
 *   - falha:   `"<unit>: Main process exited, code=exited, status=N/..."`
 *              seguida de `"<unit>: Failed with result 'exit-code'."`
 *
 * Não assume nenhum formato de coluna fixo (timestamp/host/pid variam por
 * versão do journalctl/locale) — casa só a SUBSTRING `"<unit>: <mensagem>"`
 * em qualquer posição da linha, mesma tolerância de
 * `parseSystemctlListUnitsFailedOutput` em `systemd-failed-units-alarm.ts`.
 *
 * **#6905 (01/09/2026) — sucesso tinha SÓ UM formato reconhecido, e não é
 * o que o `systemd` 259 (helios) emite.** Achado ao vivo: `"<unit>:
 * Deactivated successfully."` tem ZERO ocorrências no journal real desta
 * máquina — o que `systemd[1]` de fato loga ao concluir uma oneshot bem-
 * sucedida ali é `"Finished <unit> - <descrição>."` (unit seguido de
 * ` - `, não de `: `). Consequência: `successRe` nunca casava nada nesta
 * máquina, então TODA invocação bem-sucedida virava invisível pro parser —
 * só as 2 linhas de FALHA (que usam `: `, formato inalterado) continuavam
 * casando. O alarme de taxa mediu "falhas dentre falhas" por um período
 * inteiro, gerando ≥5 issues de falso P1 (#6456, #6457, #6458, #6794,
 * #6843) — indistinguível de uma unit saudável rodando sem log nenhum
 * (mesma classe do #5563: parser que não casa nada é indistinguível de
 * unit que nunca rodou). Fix: aceitar OS DOIS formatos — não trocar um
 * pelo outro, porque não há medição de qual versão do systemd roda em
 * outra máquina do projeto (Windows, outra sessão helios futura); trocar
 * só moveria o mesmo silêncio pra outra combinação de host/versão.
 */
export function parseJournalUnitOutcomes(lines: readonly string[], unitName: string): UnitInvocationOutcome[] {
  const escaped = escapeRegExp(unitName);
  const exitRe = new RegExp(`${escaped}: Main process exited, code=exited, status=(\\d+)`);
  const failedRe = new RegExp(`${escaped}: Failed with result 'exit-code'`);
  const successRe = new RegExp(`(?:${escaped}: Deactivated successfully\\.|Finished ${escaped}\\b)`);

  const outcomes: UnitInvocationOutcome[] = [];
  let pendingExitCode: number | null = null;
  let sawPendingExit = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const exitMatch = line.match(exitRe);
    if (exitMatch) {
      pendingExitCode = Number(exitMatch[1]);
      sawPendingExit = true;
      continue;
    }
    if (failedRe.test(line)) {
      outcomes.push({ kind: "failure", exitCode: sawPendingExit ? pendingExitCode : null });
      pendingExitCode = null;
      sawPendingExit = false;
      continue;
    }
    if (successRe.test(line)) {
      outcomes.push({ kind: "success" });
      pendingExitCode = null;
      sawPendingExit = false;
      continue;
    }
  }

  return outcomes;
}

/** Default sugerido na issue (#5765): alarma quando ≥2 das últimas 5
 * execuções falharam. Calibrável por `evaluateUnitFailureRate(...opts)` —
 * estes são só os defaults usados pelo script de produção. */
export const DEFAULT_WINDOW_SIZE = 5;
export const DEFAULT_FAILURE_THRESHOLD = 2;

export type UnitFailureRateVerdict = "ok" | "alarm-rate" | "insufficient-data";

export interface UnitFailureRateEvaluation {
  verdict: UnitFailureRateVerdict;
  windowSize: number;
  failureThreshold: number;
  /** Quantas invocações da janela considerada falharam (após aplicar
   * `successExitCodes`). `0` quando `verdict === "insufficient-data"` —
   * não há janela completa pra contar. */
  failuresInWindow: number;
  /** As invocações efetivamente consideradas (últimas `windowSize`, ou
   * menos se o histórico for mais curto — nesse caso `verdict` já é
   * `"insufficient-data"`). */
  windowOutcomes: UnitInvocationOutcome[];
}

export interface EvaluateUnitFailureRateOptions {
  windowSize?: number;
  failureThreshold?: number;
  /** Exit codes ALÉM de 0 tratados como sucesso pro cálculo de taxa — mesmo
   * campo `ScheduledTaskDefinition.successExitCodes`. */
  successExitCodes?: readonly number[];
}

/**
 * Pura — decide o veredito de taxa sobre as últimas `windowSize` invocações
 * de `outcomes` (mais antiga → mais recente; só a cauda é considerada).
 * Menos de `windowSize` invocações disponíveis → `"insufficient-data"`,
 * nunca alarme (evita ruído em task nova/rara sem histórico suficiente).
 */
export function evaluateUnitFailureRate(
  outcomes: readonly UnitInvocationOutcome[],
  opts: EvaluateUnitFailureRateOptions = {},
): UnitFailureRateEvaluation {
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW_SIZE;
  const failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const successExitCodes = new Set(opts.successExitCodes ?? []);

  const window = outcomes.slice(-windowSize);
  if (window.length < windowSize) {
    return { verdict: "insufficient-data", windowSize, failureThreshold, failuresInWindow: 0, windowOutcomes: window };
  }

  const failuresInWindow = window.filter((o) => {
    if (o.kind === "success") return false;
    if (o.exitCode !== null && successExitCodes.has(o.exitCode)) return false;
    return true;
  }).length;

  return {
    verdict: failuresInWindow >= failureThreshold ? "alarm-rate" : "ok",
    windowSize,
    failureThreshold,
    failuresInWindow,
    windowOutcomes: window,
  };
}

export function isAlarmingRateVerdict(verdict: UnitFailureRateVerdict): boolean {
  return verdict === "alarm-rate";
}

/**
 * #6905 — detecta o PRÓXIMO silêncio antes que ele vire outra rodada de
 * falso positivo: o journal TEM linhas pra esta unit (não é ausência de
 * dado), o parser extraiu pelo menos 1 outcome, mas ZERO deles é
 * `"success"` e pelo menos 1 é `"failure"`. Uma unit que só falha existe de
 * verdade, mas é rara o bastante pra merecer verificação humana em vez de
 * um `N/N` que parece medição confiável — é exatamente o padrão que o
 * bug original produzia (as 2 linhas de FALHA usam `: `, formato que nunca
 * mudou, então continuavam casando; só o SUCESSO ficava invisível).
 *
 * Pura, nunca lança. `journalHasLines` distingue "unit sem NENHUMA linha
 * no journal" (rotação de log, unit nova — nada a suspeitar) de "unit com
 * linhas, mas o parser não reconheceu nenhum sucesso" (o caso suspeito).
 */
export function detectPossibleParserDesync(
  outcomes: readonly UnitInvocationOutcome[],
  journalHasLines: boolean,
): boolean {
  if (!journalHasLines || outcomes.length === 0) return false;
  const hasSuccess = outcomes.some((o) => o.kind === "success");
  const hasFailure = outcomes.some((o) => o.kind === "failure");
  return !hasSuccess && hasFailure;
}
