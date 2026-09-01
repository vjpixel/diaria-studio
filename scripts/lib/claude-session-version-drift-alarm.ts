/**
 * scripts/lib/claude-session-version-drift-alarm.ts (#6927)
 *
 * Lógica PURA (sem I/O) do alarme "sem política" que nomeia o estado
 * medido ao vivo em #6875/#6891 (helios, 01/09/2026): uma sessão de Claude
 * Code de vida longa (`--remote-control`, tmux) mantém em memória o
 * binário da versão que carregou no START, mesmo depois de o
 * auto-updater reinstalar em disco — e o updater compara a versão contra
 * a que o PROCESSO carregou, não contra a do disco, então esse
 * descompasso realimenta o ciclo (o #6891 mediu reinstalações a cada
 * ~30min em sessões de 31h/36h, ~214MB por ciclo sem ninguém consumir o
 * resultado, e 4 quebras de cron em ~15h antes do fix mecânico).
 *
 * O #6891 já fechou o dano operacional (Partes A/B: `DISABLE_AUTOUPDATER=1`
 * nos crons + auto-reparo no preflight). Isto é a Parte C: a política
 * decidida foi a opção 3 do #6927 ("alarme, sem política") — nomear o
 * estado exato (sessão velha + processo≠disco) sem escolher entre reiniciar
 * periodicamente (opção 1) ou desligar o auto-update nas interativas
 * (opção 2). Nenhuma ação automática de reparo vive aqui — só e-mail.
 *
 * Sinal de drift usado (#6875, medição ao vivo): `readlink /proc/<pid>/exe`
 * de um processo de vida longa aponta para um path dentro do staging
 * temporário do npm terminando em `(deleted)` — o kernel mantém o inode
 * vivo enquanto o processo mantiver o arquivo aberto, mesmo depois de o
 * npm remover o staging numa reinstalação. É o sinal mais confiável
 * disponível: `claude --version` sempre spawna um processo NOVO e lê o
 * disco, nunca revela o que a sessão de vida longa tem carregado agora.
 *
 * Mesma classificação conceitual de `family: "estado"` do `alarm-issues.ts`
 * (embora este alarme não use esse mecanismo — não abre issue, só e-mail,
 * ver docstring do CLI wrapper): a condição é RE-CHECÁVEL a cada execução;
 * some
 * sozinha assim que a sessão for reiniciada (o próprio disco já reflete a
 * versão nova, só o processo antigo estava atrasado).
 *
 * `scripts/claude-session-version-drift-alarm.ts` é quem faz o I/O
 * (`ps` pra enumerar processos + idade, `readlink` de `/proc/<pid>/exe`) e
 * usa este módulo pra decidir SE/O-QUE alarmar — mesmo molde de
 * `scripts/lib/node-modules-loop-alarm.ts`/`scripts/lib/worker-drift-check.ts`.
 */

export interface ClaudeSessionProcess {
  pid: number;
  /** Linha de comando completa (`ps ... args=`), usada só pra exibição no
   * e-mail — nunca para decidir status (isso é `ageSeconds` + `exeLinkTarget`). */
  cmd: string;
  /** Idade do processo em segundos (`ps -o etimes=`). */
  ageSeconds: number;
}

export type SessionDriftStatus =
  /** Processo mais novo que o threshold — não é "vida longa" pra este alarme, nem checado. */
  | "too-young"
  /** Vida longa, mas o exe link não indica staging removido — nada a alarmar. */
  | "ok"
  /** Vida longa E `/proc/<pid>/exe` aponta pra um binário cujo staging já foi
   * removido do disco (`(deleted)`) — processo ≠ disco, o sintoma do #6875. */
  | "drift"
  /** Vida longa, mas não foi possível ler `/proc/<pid>/exe` (processo já
   * morreu entre o `ps` e o `readlink`, permissão, ou qualquer outro erro
   * de leitura) — estado INDETERMINADO, nunca tratado como "ok" por omissão. */
  | "unresolved";

export interface SessionDriftEvaluation {
  pid: number;
  cmd: string;
  ageHours: number;
  status: SessionDriftStatus;
  /** Alvo cru de `readlink /proc/<pid>/exe`, ou `null` quando a leitura
   * falhou (inclusive quando `status === "too-young"`, caso em que a
   * leitura nem é tentada). */
  exeLinkTarget: string | null;
  message: string;
}

/** Marcador que o kernel Linux adiciona ao alvo de `readlink /proc/<pid>/exe`
 * quando o arquivo original foi removido do disco mas o processo ainda o
 * mantém aberto — a evidência concreta medida em #6875. */
const DELETED_MARKER = "(deleted)";

/**
 * Pura — avalia UM processo. `exeLinkTarget` já é o resultado do
 * `readlink` (ou `null` se falhou/não tentado) — este módulo nunca toca o
 * filesystem.
 */
export function evaluateSessionDrift(
  session: ClaudeSessionProcess,
  exeLinkTarget: string | null,
  thresholdHours: number,
): SessionDriftEvaluation {
  const ageHours = session.ageSeconds / 3600;

  if (ageHours < thresholdHours) {
    return {
      pid: session.pid,
      cmd: session.cmd,
      ageHours,
      status: "too-young",
      exeLinkTarget: null,
      message: `pid ${session.pid}: ${ageHours.toFixed(1)}h < limiar de ${thresholdHours}h — não checado.`,
    };
  }

  if (exeLinkTarget === null) {
    return {
      pid: session.pid,
      cmd: session.cmd,
      ageHours,
      status: "unresolved",
      exeLinkTarget: null,
      message: `pid ${session.pid}: ${ageHours.toFixed(1)}h de vida, mas /proc/${session.pid}/exe não pôde ser lido (indeterminado).`,
    };
  }

  if (exeLinkTarget.includes(DELETED_MARKER)) {
    return {
      pid: session.pid,
      cmd: session.cmd,
      ageHours,
      status: "drift",
      exeLinkTarget,
      message: `pid ${session.pid}: ${ageHours.toFixed(1)}h de vida, binário em memória removido do disco (${exeLinkTarget}) — processo != disco.`,
    };
  }

  return {
    pid: session.pid,
    cmd: session.cmd,
    ageHours,
    status: "ok",
    exeLinkTarget,
    message: `pid ${session.pid}: ${ageHours.toFixed(1)}h de vida, binário em memória ainda presente no disco — ok.`,
  };
}

/** Pura — `true` quando o status merece alarme: `drift` confirmado OU
 * `unresolved` (mesma disciplina de `node-modules-loop-alarm.ts` — estado
 * indeterminado numa sessão já velha o bastante pra ser suspeita nunca é
 * tratado como "ok" por omissão). `too-young` nunca alarma. */
export function isSessionDriftPending(evaluation: Pick<SessionDriftEvaluation, "status">): boolean {
  return evaluation.status === "drift" || evaluation.status === "unresolved";
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

export interface ClaudeSessionDriftAlarmState {
  /** Fingerprint do CONJUNTO de sessões pendentes na última vez que
   * alarmou, ou `null` se nunca alarmou / última checagem não tinha
   * achado. */
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyClaudeSessionDriftAlarmState(): ClaudeSessionDriftAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — fingerprint estável do CONJUNTO de sessões pendentes (ordenado
 * por pid, pra não depender da ordem que `ps` devolveu). Inclui o pid (não
 * só a contagem) — se uma sessão em drift for reiniciada e OUTRA pid nova
 * entrar em drift depois, o conjunto muda e re-alarma; se a MESMA sessão
 * continuar em drift execução após execução, o fingerprint não muda e o
 * e-mail não repete. */
export function claudeSessionDriftFindingKey(evaluations: readonly SessionDriftEvaluation[]): string {
  const pending = evaluations.filter(isSessionDriftPending);
  return pending
    .map((e) => `${e.pid}:${e.status}`)
    .sort()
    .join(",");
}

/** Pura — avança o cursor. Fingerprint vazio (`""`) quando não há achado
 * pendente nesta checagem — mesmo padrão de `advanceNodeModulesLoopAlarmState`,
 * re-arma pra próxima ocorrência (`shouldAlarm` abaixo nunca casa `""` contra
 * um fingerprint não-vazio de uma execução futura). */
export function advanceClaudeSessionDriftAlarmState(
  evaluations: readonly SessionDriftEvaluation[],
  now: Date,
): ClaudeSessionDriftAlarmState {
  const pending = evaluations.some(isSessionDriftPending);
  return {
    lastAlarmedFingerprint: pending ? claudeSessionDriftFindingKey(evaluations) : null,
    lastCheckedAt: now.toISOString(),
  };
}

/** Pura — `true` quando há pelo menos 1 sessão pendente E o fingerprint do
 * conjunto difere do último já alarmado. */
export function shouldAlarmClaudeSessionDrift(
  state: ClaudeSessionDriftAlarmState,
  evaluations: readonly SessionDriftEvaluation[],
): boolean {
  const pending = evaluations.filter(isSessionDriftPending);
  if (pending.length === 0) return false;
  return claudeSessionDriftFindingKey(evaluations) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `buildNodeModulesLoopAlarmEmail`/`buildRobotsDriftAlarmEmail`). */
export function buildClaudeSessionDriftAlarmEmail(
  evaluations: readonly SessionDriftEvaluation[],
  thresholdHours: number,
  now: Date = new Date(),
): { subject: string; body: string } {
  const pending = evaluations.filter(isSessionDriftPending);
  const driftCount = pending.filter((e) => e.status === "drift").length;
  const unresolvedCount = pending.filter((e) => e.status === "unresolved").length;

  const subject =
    driftCount > 0
      ? `[diar.ia.br] ${driftCount} sessão(ões) Claude Code de vida longa com binário defasado do disco`
      : `[diar.ia.br] ${unresolvedCount} sessão(ões) Claude Code de vida longa sem confirmação de versão`;

  const lines: string[] = [
    "O alarme `Diaria-Claude-Session-Version-Drift-Alarm`",
    "(`scripts/claude-session-version-drift-alarm.ts`) encontrou sessão(ões)",
    `de Claude Code rodando há mais de ${thresholdHours}h cujo binário em memória`,
    "pode estar defasado do que está em disco (#6875/#6891/#6927).",
    "",
    "Isto é UM ALARME SEM POLÍTICA (decisão explícita do #6927): não reinicia",
    "nada sozinho, nem desliga auto-update — só nomeia o estado. O dano",
    "operacional (crons quebrando) já está contido pelo #6891 (Partes A/B).",
    "Ação sugerida, se incomodar: reiniciar a sessão listada abaixo quando",
    "for conveniente (derruba o contexto acumulado dela, não é gratuito).",
    "",
  ];

  for (const e of pending) {
    lines.push(
      `pid ${e.pid} (${e.ageHours.toFixed(1)}h) — ${e.status === "drift" ? "DRIFT confirmado" : "indeterminado"}`,
      `  cmd: ${e.cmd}`,
      `  exe: ${e.exeLinkTarget ?? "(não lido)"}`,
      "",
    );
  }

  lines.push(`(alarme automático — checagem rodou em ${now.toISOString()})`);

  return { subject, body: lines.join("\n") };
}
