/**
 * scripts/lib/onboarding-continuity-alarm.ts (#7665, follow-up de detecção)
 *
 * ## Por que este arquivo existe, e por que NÃO é o alarme que a #7665
 * propôs originalmente
 *
 * A issue nasceu medindo o sintoma pelo canal ERRADO: `GET
 * /v4/sequences/{id}` (Kit) e `GET /v4/account/growth_stats` — sinais de um
 * onboarding que já não existia mais quando a issue foi aberta. O comentário
 * de correção da própria issue (08-09/09/2026) fechou essa leitura:
 *
 *   - A sequence do Kit morreu no downgrade pro plano free (#7365) — recurso
 *     pago, `PUT {active:true}` devolve 200 mas o reread confirma
 *     `active: false`. Não há o que reativar nem o que alarmar ali:
 *     "a parte de 'alarme de sequence inativa' pode ser descartada: sem
 *     plano pago, a sequence do Kit não volta, e o canal não é mais ele."
 *   - O onboarding passou INTEIRO para o Brevo transacional
 *     (`scripts/onboarding-welcome-run.ts`, #7599), com detecção via
 *     `created_at__gte` no Kit (não mais Beehiiv nem sequence).
 *   - O alarme de detecção zerada que a issue propunha como item 1 **já
 *     existe** — `zeroDetectionAlarm`/`updateZeroDetectionStreak`
 *     (`scripts/lib/onboarding-state.ts`), item 4 da própria #7599, com o
 *     streak persistido em `store.consecutive_zero_detections`.
 *   - O item 3 (log do skip por `KIT_WELCOME_SEQUENCE_ID` ausente) também
 *     já está resolvido (`workers/poll/src/subscribe.ts:856`).
 *   - O gap de bootstrap (quantos cadastros ficaram na janela entre o
 *     backend antigo e o novo) foi fechado pelo PR #7669 (`buildBackendSwitchNote`,
 *     `scripts/onboarding-welcome-run.ts`).
 *
 * ## O que sobra — e é o gap real que esta unidade fecha
 *
 * `zeroDetectionAlarm` já COMPUTA o alarme, mas o resultado só vira uma
 * linha em `summary.notes` + `process.stderr` (`onboarding-welcome-run.ts`,
 * bloco "#7599 item 4") — exatamente a classe de silêncio que motivou a
 * #7665 inteira: "nada observa o resultado". Ninguém lê stderr de uma task
 * agendada rotineiramente; o mecanismo comum deste repo pra isso é
 * `scripts/lib/alarm-issues.ts` (issue no GitHub + e-mail), que
 * `onboarding-welcome-run.ts` nunca chama. Este módulo fecha esse elo:
 * consome o MESMO streak já persistido pelo run diário (sem recomputar, sem
 * chamar nenhuma API — o run diário já fez a detecção) e decide se ele
 * cruza o alarme.
 *
 * ## Janela e limiar (decisão desta unidade)
 *
 * Reusa `ZERO_DETECTION_ALARM_THRESHOLD_RUNS` (3) de `onboarding-state.ts`
 * — não reinventa o limiar já decidido no #7599. A task
 * `Diaria-Onboarding-Welcome-Run` roda diária (09:05 BRT, `--send`), então
 * 3 rodadas consecutivas com `detected_new === 0` equivale a ~3 dias sem
 * detectar NENHUM cadastro novo — o mesmo threshold que já demonstrou não
 * disparar em falso na operação normal desde #7599 (documentado na
 * docstring de `zeroDetectionAlarm`).
 *
 * ## Tri-state honesto (regra do #7776, desta mesma rodada overnight)
 *
 * `evaluateOnboardingContinuity` NUNCA relata `"ok"` quando não conseguiu
 * ler o streak — só quando leu o store com sucesso E o streak está abaixo
 * do limiar. `store.json` ausente (junction `data/` não montada — a mesma
 * classe de falha que o `guard.requiredFile` das tasks-irmãs já cobre) ou
 * ilegível (`corrupted: true` de `readStore`) vira `"cannot-verify"`, nunca
 * `"ok"` nem `"stale"`.
 *
 * ## O que este alarme NÃO faz
 *
 * Não chama a API do Kit, não lê `growth_stats`, não reativa nada, não
 * reinscreve ninguém. Só observa um número que o run diário já persistiu.
 * Se o editor quiser distinguir "genuinamente sem cadastro" de "cadastro
 * aconteceu mas a detecção quebrou" quando este alarme disparar, o e-mail
 * aponta pro comando manual (`GET /v4/account/growth_stats` via Kit REST) —
 * verificação humana, não parte do detector automático.
 */

import { ZERO_DETECTION_ALARM_THRESHOLD_RUNS } from "./onboarding-state.ts";

export { ZERO_DETECTION_ALARM_THRESHOLD_RUNS };

// ---------------------------------------------------------------------------
// Veredito — tri-state, puro
// ---------------------------------------------------------------------------

export type OnboardingContinuityVerdict = "ok" | "stale" | "cannot-verify";

export type OnboardingContinuityCannotVerifyReason = "store_missing" | "store_corrupted";

export interface OnboardingContinuityEvaluation {
  verdict: OnboardingContinuityVerdict;
  /** `null` só quando `verdict === "cannot-verify"` — não há streak confiável pra reportar. */
  streak: number | null;
  threshold: number;
  cannotVerifyReason: OnboardingContinuityCannotVerifyReason | null;
}

/**
 * Decide o veredito a partir de sinais já resolvidos pelo caller (existência
 * do arquivo, `corrupted` de `readStore`, e o streak persistido) — sem I/O
 * aqui, pra ser testável sem tocar disco.
 *
 * @pure
 */
export function evaluateOnboardingContinuity(
  storeExists: boolean,
  corrupted: boolean,
  consecutiveZeroDetections: number,
  threshold: number = ZERO_DETECTION_ALARM_THRESHOLD_RUNS,
): OnboardingContinuityEvaluation {
  if (!storeExists) {
    return { verdict: "cannot-verify", streak: null, threshold, cannotVerifyReason: "store_missing" };
  }
  if (corrupted) {
    return { verdict: "cannot-verify", streak: null, threshold, cannotVerifyReason: "store_corrupted" };
  }
  const streak = consecutiveZeroDetections;
  return {
    verdict: streak >= threshold ? "stale" : "ok",
    streak,
    threshold,
    cannotVerifyReason: null,
  };
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1×/dia-calendário UTC (mesmo padrão de
// meta-capi-staleness.ts / ads-spend-ingest-alarm.ts)
// ---------------------------------------------------------------------------

export interface OnboardingContinuityAlarmState {
  lastAlarmedDay: string | null;
}

export function emptyOnboardingContinuityAlarmState(): OnboardingContinuityAlarmState {
  return { lastAlarmedDay: null };
}

export function shouldSendOnboardingContinuityAlarm(
  evaluation: OnboardingContinuityEvaluation,
  state: OnboardingContinuityAlarmState,
  now: Date,
): boolean {
  if (evaluation.verdict !== "stale") return false;
  const today = now.toISOString().slice(0, 10);
  return state.lastAlarmedDay !== today;
}

export function markOnboardingContinuityAlarmed(now: Date): OnboardingContinuityAlarmState {
  return { lastAlarmedDay: now.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildOnboardingContinuityAlarmEmail(
  evaluation: OnboardingContinuityEvaluation,
  issueLines: string,
): { subject: string; body: string } {
  const detail =
    evaluation.streak !== null
      ? `${evaluation.streak} rodadas diárias consecutivas de \`Diaria-Onboarding-Welcome-Run\` com 0 assinantes novos detectados (limiar ${evaluation.threshold}).`
      : "streak indisponível.";
  return {
    subject: "⚠️ Diaria-Onboarding-Continuity-Alarm: detecção de cadastro novo pode ter parado",
    body:
      `A detecção de assinantes novos do onboarding (Brevo transacional, #5908/#7599) parou de achar gente ` +
      `nova: ${detail}\n\n` +
      `Isto NÃO diz sozinho se é uma seca real de cadastros ou uma quebra silenciosa na detecção (fonte ` +
      `errada, filtro no-op, cursor travado — a mesma classe do #7599 e do #6043). Pra distinguir, checar ` +
      `manualmente se houve cadastro novo no Kit no mesmo período:\n\n` +
      `  GET https://api.kit.com/v4/account/growth_stats\n\n` +
      `Se growth_stats mostrar cadastros no período e o streak continuar subindo, é quebra de detecção — ` +
      `ver \`scripts/onboarding-welcome-run.ts\` (bloco de detecção, backend \`kit\`). Se growth_stats ` +
      `também mostrar zero, é seca real de cadastro (fora do escopo deste alarme).\n\n` +
      `Este alarme só observa o streak que o próprio run diário já persiste em ` +
      `\`data/onboarding/store.json\` — não chama a API do Kit, não reativa nada, não reinscreve ninguém.` +
      issueLines,
  };
}
