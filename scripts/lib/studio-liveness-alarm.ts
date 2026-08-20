/**
 * scripts/lib/studio-liveness-alarm.ts (#5759)
 *
 * Lógica PURA do alarme de liveness do ORIGEM do Studio (`diaria-studio-server.service`,
 * `http://127.0.0.1:4174/`) — fecha o ponto cego confirmado ao vivo em
 * 20/08/2026: a unit ficou ~15min `active/running` mas sem escutar a porta
 * (zumbi de restart travado, `server.close()` pendurado em conexão SSE
 * aberta) — 502 na borda pro editor. A mecânica do zumbi já foi corrigida
 * no #5737/#5760 (`scripts/lib/shutdown-with-timeout.ts`); esta unidade é
 * só sobre DETECÇÃO, porque o único sweep genérico de serviço do repo
 * (`Diaria-Systemd-Failed-Units-Alarm`, #5563) é CEGO por construção a este
 * modo de falha — ele varre `systemctl --user list-units --state=failed`, e
 * uma unit zumbi nunca entra em `failed` (fica `active/running` o tempo
 * todo, é exatamente esse o problema).
 *
 * ─── Sinal: liveness HTTP, não estado da unit ──────────────────────────────
 *
 * `GET http://127.0.0.1:4174/` com timeout curto (I/O feito pelo caller,
 * `scripts/studio-liveness-alarm.ts`). Só um veredito por check: `"ok"`
 * (respondeu, qualquer status HTTP — mesmo um 4xx/5xx da APLICAÇÃO já prova
 * que o processo está escutando a porta, que é o sinal que importa aqui;
 * distinguir status de aplicação é escopo de outro alarme), `"failure"`
 * (conexão recusada/erro de rede) ou `"timeout"` (não respondeu dentro do
 * limite).
 *
 * ─── Por que 2 falhas CONSECUTIVAS, não 1 ──────────────────────────────────
 *
 * Um restart normal do Studio (`RestartSec=5` + boot do `tsx`) leva ~7s —
 * um único check falho durante essa janela é esperado e NUNCA deve alarmar
 * (senão todo `git pull` que troca código server-rendered dispara um
 * alarme falso a cada deploy). Só um SEGUNDO check falho, na PRÓXIMA
 * execução da task (10 min depois — ver `docs/scheduled-tasks-registry.md`),
 * indica que o processo não voltou a escutar a porta dentro de uma janela
 * muito maior que qualquer restart legítimo — é aí que o estado zumbi do
 * incidente de referência se distingue de um restart são.
 *
 * ─── Idempotência: 1 alarme por streak, não 1 por check ────────────────────
 *
 * `alarmedThisStreak` evita reenviar e-mail a cada execução enquanto o
 * serviço segue fora do ar (a task roda a cada 10 min; sem esse guard, um
 * outage de 2h viraria 12 e-mails idênticos). Qualquer `"ok"` reseta o
 * streak inteiro — a próxima queda dispara um novo alarme do zero (mesmo
 * padrão de `SystemdFailedUnitsAlarmState`/`OnedriveSyncAlarmState`).
 *
 * ─── Fail-soft: máquina sem o serviço ──────────────────────────────────────
 *
 * `scripts/studio-liveness-alarm.ts` só chama a lógica pura daqui quando
 * `systemctl --user is-active diaria-studio-server.service` retorna algo
 * DIFERENTE de "unknown" (unit não encontrada / systemctl ausente — sessão
 * cloud, clone fresco). Quando a unit é reconhecida (`active`, `inactive`
 * ou `failed` — todos os 3 provam que ESTA máquina é a que roda o serviço),
 * o check HTTP roda de verdade, mesmo que o systemd relate `active` (é
 * justamente o caso zumbi: systemd mente, a porta não responde). Mesmo
 * padrão de `onedrive-sync-alarm.ts`.
 */

export type StudioHttpCheckResult = "ok" | "failure" | "timeout";

/** Falhas consecutivas necessárias pra alarmar — 2 (ver docstring do módulo:
 * um restart normal de ~7s nunca produz 2 checks falhos seguidos numa task
 * de cadência 10min). */
export const CONSECUTIVE_FAILURE_THRESHOLD = 2;

export interface StudioLivenessAlarmState {
  /** Falhas (failure OU timeout) consecutivas até agora — reseta a 0 em
   * qualquer "ok". */
  consecutiveFailures: number;
  /** Já foi enviado alarme para o streak de falhas ATUAL — evita reenviar a
   * cada execução enquanto o serviço segue fora do ar. Reseta a `false` em
   * qualquer "ok". */
  alarmedThisStreak: boolean;
}

export function emptyStudioLivenessAlarmState(): StudioLivenessAlarmState {
  return { consecutiveFailures: 0, alarmedThisStreak: false };
}

export type StudioLivenessVerdict = "ok" | "degraded" | "alarm-unreachable";

export interface StudioLivenessEvaluation {
  /** `"ok"` — check atual respondeu. `"degraded"` — falhou, mas ainda não
   * cruzou o limiar de consecutivas (ex: 1ª falha isolada, possível
   * restart normal em andamento). `"alarm-unreachable"` — cruzou o limiar. */
  verdict: StudioLivenessVerdict;
  consecutiveFailures: number;
  latestResult: StudioHttpCheckResult;
}

export interface RecordStudioHttpCheckResult {
  nextState: StudioLivenessAlarmState;
  evaluation: StudioLivenessEvaluation;
}

/**
 * Pura — avança o estado com 1 novo resultado de check e devolve o
 * veredito. `"ok"` reseta tudo a zero (recuperação total — mesmo que o
 * streak anterior tivesse alarmado). Qualquer falha (`"failure"`/`"timeout"`)
 * incrementa `consecutiveFailures`; ao cruzar `CONSECUTIVE_FAILURE_THRESHOLD`
 * o veredito vira `"alarm-unreachable"` — independente de quantas falhas
 * consecutivas já passaram do limiar (2, 3, 4... todas retornam o mesmo
 * veredito; é `shouldSendStudioLivenessAlarm`/`alarmedThisStreak` que decide
 * se reenvia e-mail).
 */
export function recordStudioHttpCheck(
  state: StudioLivenessAlarmState,
  result: StudioHttpCheckResult,
): RecordStudioHttpCheckResult {
  if (result === "ok") {
    return {
      nextState: { consecutiveFailures: 0, alarmedThisStreak: false },
      evaluation: { verdict: "ok", consecutiveFailures: 0, latestResult: result },
    };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  const verdict: StudioLivenessVerdict =
    consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD ? "alarm-unreachable" : "degraded";
  return {
    nextState: { consecutiveFailures, alarmedThisStreak: state.alarmedThisStreak },
    evaluation: { verdict, consecutiveFailures, latestResult: result },
  };
}

export function isAlarmingVerdict(verdict: StudioLivenessVerdict): boolean {
  return verdict === "alarm-unreachable";
}

/**
 * Pura — decide se este check deve DISPARAR e-mail: veredito alarmante E o
 * streak atual ainda não foi alarmado. Não muta o state — o caller usa
 * `markStudioLivenessAlarmed` depois de enviar com sucesso (mesmo padrão de
 * `shouldSendSystemdFailedUnitsAlarm`/`markSystemdFailedUnitsAlarmed`).
 */
export function shouldSendStudioLivenessAlarm(
  evaluation: StudioLivenessEvaluation,
  state: StudioLivenessAlarmState,
): boolean {
  return isAlarmingVerdict(evaluation.verdict) && !state.alarmedThisStreak;
}

export function markStudioLivenessAlarmed(state: StudioLivenessAlarmState): StudioLivenessAlarmState {
  return { ...state, alarmedThisStreak: true };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildStudioLivenessAlarmEmail(
  evaluation: StudioLivenessEvaluation,
  issueLine: string,
): { subject: string; body: string } {
  return {
    subject: `⚠️ Studio server inacessível: ${evaluation.consecutiveFailures} falhas consecutivas`,
    body:
      `\`GET http://127.0.0.1:4174/\` falhou ${evaluation.consecutiveFailures}x seguidas ` +
      `(última: "${evaluation.latestResult}") — o serviço \`diaria-studio-server.service\` pode estar ` +
      `\`active\` no systemd (zumbi de restart travado — ver #5759, incidente 260820) mesmo sem escutar ` +
      `a porta 4174. Se estiver assim, o tunnel (\`studio.diar.ia.br\`) responde 502.\n\n` +
      `Investigar: \`systemctl --user status diaria-studio-server.service\` e ` +
      `\`journalctl --user -u diaria-studio-server.service -n 80\`. Religar/reiniciar é ação manual do ` +
      `editor (este alarme nunca muta o serviço).\n\n` +
      `Achado automático de \`Diaria-Studio-Liveness-Alarm\` (\`scripts/studio-liveness-alarm.ts\`, #5759).${issueLine}`,
  };
}
