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
import type { KitSendRunRecord } from "./onboarding-kit-transport.ts";

export { ZERO_DETECTION_ALARM_THRESHOLD_RUNS };

// ---------------------------------------------------------------------------
// Transporte ativo (#7922, pré-requisito do corte — §3 de
// docs/onboarding-kit-cutover.md)
// ---------------------------------------------------------------------------

/**
 * Qual transporte ENTREGA os e-mails novos do onboarding. A DETECÇÃO (e a
 * streak `consecutive_zero_detections` que este alarme lê) é a mesma nos
 * dois regimes: quem detecta é sempre `onboarding-welcome-run.ts`, que
 * continua rodando depois do corte (§2.2 do doc — os dois executores rodam
 * sempre). O que muda é quem envia — e, com o Kit ativo, o alarme também
 * precisa observar o executor Kit (`evaluateKitTransportHealth`), porque a
 * streak de detecção continua saudável mesmo se o Kit parar de criar os
 * broadcasts.
 */
export type OnboardingTransport = "brevo" | "kit";

/** Deriva o transporte ativo de `onboarding.kit_transport.enabled` — só
 *  `true` literal liga o Kit (mesma regra do kill switch em
 *  `isWriteBlockedByKillSwitch`/`filterBrevoPlanForKitCutover`).
 *
 *  @pure */
export function resolveActiveOnboardingTransport(kitTransportEnabled: unknown): OnboardingTransport {
  return kitTransportEnabled === true ? "kit" : "brevo";
}

function transportLabel(transport: OnboardingTransport): string {
  return transport === "kit"
    ? "Kit — broadcasts segmentados por tag, `onboarding-kit-transport-run.ts` (#7922)"
    : "Brevo transacional, `onboarding-welcome-run.ts` (#5908/#7599)";
}

// ---------------------------------------------------------------------------
// Veredito — tri-state, puro
// ---------------------------------------------------------------------------

export type OnboardingContinuityVerdict = "ok" | "stale" | "cannot-verify";

export type OnboardingContinuityCannotVerifyReason =
  | "store_missing"
  | "store_corrupted"
  /** #7665 (P1 do review da PR #7805): store existe e é legível, mas não diz
   *  QUANDO a rodada diária atualizou a streak — store anterior ao campo. */
  | "run_timestamp_ausente"
  /** A rodada diária parou de atualizar a streak. Sem isto, uma streak
   *  congelada ABAIXO do limiar renderia `ok` indefinidamente, com o alarme
   *  mudo exatamente quando a situação é pior. */
  | "run_parado";

/** Quantas horas sem a rodada diária atualizar a streak antes de o alarme
 *  parar de confiar nela. 48h = 2 janelas diárias, tolerando um dia pulado
 *  por guard (`data/` ausente numa máquina) sem virar ruído. */
export const RUN_FRESHNESS_MAX_HORAS = 48;

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
  /** ISO da última atualização da streak (`store.last_zero_detection_run_at`)
   *  e o instante de referência. Ausentes → `cannot-verify`. */
  lastRunAtIso?: string | null,
  now: Date = new Date(),
): OnboardingContinuityEvaluation {
  if (!storeExists) {
    return { verdict: "cannot-verify", streak: null, threshold, cannotVerifyReason: "store_missing" };
  }
  if (corrupted) {
    return { verdict: "cannot-verify", streak: null, threshold, cannotVerifyReason: "store_corrupted" };
  }
  // #7665 (P1 do review da PR #7805): a streak sozinha não distingue "rodou e
  // detectou zero" de "parou de rodar". Se o run morre, ela CONGELA — e
  // congelada abaixo do limiar, o veredito seria `ok` pra sempre. O detector
  // precisa saber se ele próprio ainda está sendo alimentado; é a mesma
  // classe do #7776, um nível acima.
  if (lastRunAtIso === undefined || lastRunAtIso === null || lastRunAtIso === "") {
    return {
      verdict: "cannot-verify",
      streak: null,
      threshold,
      cannotVerifyReason: "run_timestamp_ausente",
    };
  }
  const lastRunMs = Date.parse(lastRunAtIso);
  if (Number.isNaN(lastRunMs)) {
    return {
      verdict: "cannot-verify",
      streak: null,
      threshold,
      cannotVerifyReason: "run_timestamp_ausente",
    };
  }
  const horas = (now.getTime() - lastRunMs) / 3_600_000;
  if (horas > RUN_FRESHNESS_MAX_HORAS) {
    return { verdict: "cannot-verify", streak: null, threshold, cannotVerifyReason: "run_parado" };
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
  /** #7922: transporte que ENVIA os e-mails hoje. A detecção é a mesma nos
   *  dois — o texto só nomeia o transporte certo. Default `brevo` = o regime
   *  em produção antes do corte. */
  transport: OnboardingTransport = "brevo",
): { subject: string; body: string } {
  const detail =
    evaluation.streak !== null
      ? `${evaluation.streak} rodadas diárias consecutivas de \`Diaria-Onboarding-Welcome-Run\` com 0 assinantes novos detectados (limiar ${evaluation.threshold}).`
      : "streak indisponível.";
  return {
    subject: "⚠️ Diaria-Onboarding-Continuity-Alarm: detecção de cadastro novo pode ter parado",
    body:
      `A detecção de assinantes novos do onboarding (feita por \`onboarding-welcome-run.ts\` em qualquer ` +
      `transporte; transporte de envio ativo: ${transportLabel(transport)}) parou de achar gente ` +
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

// ---------------------------------------------------------------------------
// Saúde do executor Kit (#7922) — só avaliada com o transporte Kit ativo
// ---------------------------------------------------------------------------

/** Rodadas `--send` consecutivas do executor Kit que falharam em entregar
 *  (`isFailedKitSendRun`: ≥1 lote falho, ou refresh de todos os candidatos
 *  falho) antes de alarmar. 2 e não 1: uma falha transitória de API (timeout, 5xx) num dia
 *  se resolve sozinha na rodada seguinte (o lote do dia seguinte tem chave
 *  nova, `buildLotId`); 2 seguidas é falha persistente — e cada rodada
 *  falha é um dia de e-mail 1/2 que não saiu. Diferente do limiar 3 da
 *  detecção zerada, que pode ser seca legítima de cadastro: broadcast que
 *  não é criado nunca é legítimo. */
export const KIT_SEND_FAILURE_ALARM_THRESHOLD_RUNS = 2;

export type KitTransportCannotVerifyReason =
  | "store_missing"
  | "store_corrupted"
  /** Transporte Kit ativo mas o executor nunca registrou uma rodada
   *  `--send` (`kit_transport.last_send_run` ausente) — ou ainda não rodou
   *  depois do flip, ou roda com código anterior a este campo. */
  | "kit_run_timestamp_ausente"
  /** Última rodada `--send` registrada há mais de `RUN_FRESHNESS_MAX_HORAS`
   *  — o executor parou de rodar (task desarmada, crash). Mesma semântica de
   *  `run_parado` da detecção. */
  | "kit_run_parado";

export interface KitTransportHealthEvaluation {
  verdict: OnboardingContinuityVerdict;
  /** `null` só com `verdict === "cannot-verify"`. */
  consecutiveFailedRuns: number | null;
  /** Lotes falhos na última rodada registrada — `null` com `cannot-verify`. */
  lastRunFailedLots: number | null;
  lastRunAt: string | null;
  threshold: number;
  cannotVerifyReason: KitTransportCannotVerifyReason | null;
}

/**
 * Tri-state honesto (#7776) sobre o que o executor Kit grava em
 * `store.kit_transport` (`stampKitSendRun` em
 * `onboarding-kit-transport-run.ts`): nunca `ok` sem uma rodada `--send`
 * registrada e fresca.
 *
 * @pure
 */
export function evaluateKitTransportHealth(
  storeExists: boolean,
  corrupted: boolean,
  kitTransport: { last_send_run?: KitSendRunRecord | null; consecutive_failed_send_runs?: number } | undefined,
  threshold: number = KIT_SEND_FAILURE_ALARM_THRESHOLD_RUNS,
  now: Date = new Date(),
): KitTransportHealthEvaluation {
  const cannot = (reason: KitTransportCannotVerifyReason, lastRunAt: string | null = null): KitTransportHealthEvaluation => ({
    verdict: "cannot-verify",
    consecutiveFailedRuns: null,
    lastRunFailedLots: null,
    lastRunAt,
    threshold,
    cannotVerifyReason: reason,
  });
  if (!storeExists) return cannot("store_missing");
  if (corrupted) return cannot("store_corrupted");
  const run = kitTransport?.last_send_run ?? null;
  if (run == null || typeof run.at !== "string" || run.at === "") return cannot("kit_run_timestamp_ausente");
  const lastMs = Date.parse(run.at);
  if (Number.isNaN(lastMs)) return cannot("kit_run_timestamp_ausente");
  if ((now.getTime() - lastMs) / 3_600_000 > RUN_FRESHNESS_MAX_HORAS) return cannot("kit_run_parado", run.at);
  const streak = kitTransport?.consecutive_failed_send_runs ?? 0;
  return {
    verdict: streak >= threshold ? "stale" : "ok",
    consecutiveFailedRuns: streak,
    lastRunFailedLots: run.lots_failed,
    lastRunAt: run.at,
    threshold,
    cannotVerifyReason: null,
  };
}

export function buildKitTransportAlarmEmail(
  evaluation: KitTransportHealthEvaluation,
  issueLines: string,
): { subject: string; body: string } {
  return {
    subject: "⚠️ Diaria-Onboarding-Continuity-Alarm: transporte Kit do onboarding não está criando os broadcasts",
    body:
      `O executor do transporte Kit do onboarding (\`onboarding-kit-transport-run.ts --send\`, #7922) teve ` +
      `${evaluation.consecutiveFailedRuns ?? "?"} rodada(s) consecutiva(s) sem conseguir entregar — lote que falhou ao ` +
      `taguear/criar/agendar o broadcast, ou o refresh de TODOS os candidatos falhou (Kit fora do ar/auth) ` +
      `(limiar ${evaluation.threshold}; última rodada ${evaluation.lastRunAt ?? "?"}, ` +
      `${evaluation.lastRunFailedLots ?? "?"} lote(s) falho(s)). Enquanto isso, quem foi detectado não recebe ` +
      `o e-mail 1/2 — a detecção continua saudável, então o alarme de detecção zerada NÃO cobre esta falha.\n\n` +
      `Onde olhar: \`last_error\` dos lotes em \`data/onboarding/store.json\` (\`kit_transport.lots\`) e o ` +
      `stderr da rodada. Rollback: §6 de docs/onboarding-kit-cutover.md (desligar ` +
      `\`onboarding.kit_transport.enabled\` devolve os candidatos novos à Brevo).\n\n` +
      `Este alarme só lê o que o próprio executor Kit gravou no store — não chama a API do Kit.` +
      issueLines,
  };
}
