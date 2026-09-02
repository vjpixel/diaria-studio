/**
 * scripts/lib/npm-version-drift-alarm.ts (#6960)
 *
 * Lógica PURA (sem I/O) do contrapeso que o #6960 pede depois de o editor
 * decidir, em 01/09/2026, desligar o auto-updater do Claude Code no
 * `helios` (motivo/decisão registrados em comentário na #6927 — o binário
 * quebrou 5x no mesmo dia). O alarme do #6927
 * (`scripts/claude-session-version-drift-alarm.ts`) mede um sintoma
 * diferente: `/proc/<pid>/exe` terminando em `(deleted)`, sinal de que
 * HOUVE uma reinstalação recente. Com o updater desligado, reinstalações
 * param, esse marcador nunca aparece, e o alarme do #6927 silencia por
 * construção — o silêncio dele fica indistinguível de saúde.
 *
 * Este módulo mede outra coisa: a DEFASAGEM entre a versão em disco
 * (`npm root -g`/@anthropic-ai/claude-code/package.json`) e a versão
 * publicada no registry (`npm view @anthropic-ai/claude-code version`) —
 * "atualizar deliberadamente" (o procedimento que a issue também pede)
 * deixou de acontecer, há quanto tempo?
 *
 * `scripts/npm-version-drift-alarm.ts` é quem faz o I/O (`npm root -g`,
 * leitura do `package.json`, `npm view`) e usa este módulo pra decidir
 * SE/O-QUE alarmar — mesmo molde de
 * `scripts/lib/claude-session-version-drift-alarm.ts`/
 * `scripts/lib/node-modules-loop-alarm.ts`.
 */

export interface NpmVersionCheck {
  /** Versão lida do `package.json` em disco (`npm root -g`/.../package.json`). */
  diskVersion: string;
  /** Versão publicada no registry (`npm view @anthropic-ai/claude-code version`). */
  upstreamVersion: string;
}

export type NpmVersionDriftStatus =
  /** Disco == upstream — nada a fazer. */
  | "in-sync"
  /** Disco != upstream, mas ainda dentro do limiar (defasagem normal de
   * cadência de release — o Claude Code publica quase todo dia). */
  | "drift-fresh"
  /** Disco != upstream há mais do que `thresholdDays` — o estado que a
   * issue existe pra nomear: "desligamos o updater" virou "esquecido". */
  | "drift-stale";

export interface NpmVersionDriftEvaluation {
  diskVersion: string;
  upstreamVersion: string;
  status: NpmVersionDriftStatus;
  /** Dias desde que a defasagem começou (ISO `driftSince`), ou `0` quando
   * `status === "in-sync"`. `null` só é impossível aqui — diferente do
   * alarme do #6927, este módulo nunca herda um estado "indeterminado":
   * a I/O que produz `NpmVersionCheck` PROPAGA em vez de devolver um
   * resultado parcial (ver docstring do wrapper). */
  ageDays: number;
  message: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pura — avalia UMA checagem. `driftSinceIso` é o cursor de estado (`null`
 * se a última checagem estava em sincronia, ou se esta é a 1ª execução) —
 * quem chama (`advanceNpmVersionDriftState` abaixo) decide como esse
 * cursor evolui; esta função só lê.
 */
export function evaluateNpmVersionDrift(
  check: NpmVersionCheck,
  driftSinceIso: string | null,
  now: Date,
  thresholdDays: number,
): NpmVersionDriftEvaluation {
  if (check.diskVersion === check.upstreamVersion) {
    return {
      diskVersion: check.diskVersion,
      upstreamVersion: check.upstreamVersion,
      status: "in-sync",
      ageDays: 0,
      message: `disco (${check.diskVersion}) == upstream (${check.upstreamVersion}) — em sincronia.`,
    };
  }

  const since = driftSinceIso ? Date.parse(driftSinceIso) : now.getTime();
  const ageDays = Number.isFinite(since) ? Math.max(0, (now.getTime() - since) / MS_PER_DAY) : 0;
  const status: NpmVersionDriftStatus = ageDays >= thresholdDays ? "drift-stale" : "drift-fresh";

  return {
    diskVersion: check.diskVersion,
    upstreamVersion: check.upstreamVersion,
    status,
    ageDays,
    message:
      status === "drift-stale"
        ? `disco (${check.diskVersion}) defasado de upstream (${check.upstreamVersion}) há ${ageDays.toFixed(1)}d (>= limiar de ${thresholdDays}d).`
        : `disco (${check.diskVersion}) diverge de upstream (${check.upstreamVersion}) há ${ageDays.toFixed(1)}d (< limiar de ${thresholdDays}d — cadência normal de release).`,
  };
}

/** Pura — `true` quando o status merece alarme (`drift-stale`, o único
 * caso: `in-sync` nunca alarma, `drift-fresh` é esperado — o Claude Code
 * lança quase todo dia, então 1-2 versões de defasagem é ruído, não
 * sinal). */
export function isNpmVersionDriftPending(evaluation: Pick<NpmVersionDriftEvaluation, "status">): boolean {
  return evaluation.status === "drift-stale";
}

// ─── Estado (cursor de "desde quando" + idempotência do e-mail) ───────────

export interface NpmVersionDriftAlarmState {
  /** ISO de quando a defasagem atual COMEÇOU, ou `null` se a última
   * checagem estava em sincronia. Reseta pra `null` assim que
   * disco == upstream de novo (ex: alguém atualizou manualmente). */
  driftSince: string | null;
  /** Fingerprint (`disco->upstream`) do último e-mail enviado, pra não
   * repetir o mesmo par a cada execução — mesma disciplina de
   * `claudeSessionDriftFindingKey`. */
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyNpmVersionDriftAlarmState(): NpmVersionDriftAlarmState {
  return { driftSince: null, lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — fingerprint do par (disco, upstream) em drift. Vazio quando
 * `status !== "drift-stale"`. */
export function npmVersionDriftFindingKey(evaluation: NpmVersionDriftEvaluation): string {
  if (!isNpmVersionDriftPending(evaluation)) return "";
  return `${evaluation.diskVersion}->${evaluation.upstreamVersion}`;
}

/**
 * Pura — avança o cursor `driftSince` a partir do estado anterior + a
 * checagem atual: `in-sync` reseta pra `null`; drift que já vinha do
 * estado anterior MANTÉM o `driftSince` original (não reinicia a contagem
 * a cada execução); drift novo (estado anterior era `null`) começa agora.
 */
export function advanceNpmVersionDriftState(
  prev: NpmVersionDriftAlarmState,
  check: NpmVersionCheck,
  now: Date,
): NpmVersionDriftAlarmState {
  const inSync = check.diskVersion === check.upstreamVersion;
  const driftSince = inSync ? null : (prev.driftSince ?? now.toISOString());
  return {
    driftSince,
    lastAlarmedFingerprint: inSync ? null : prev.lastAlarmedFingerprint,
    lastCheckedAt: now.toISOString(),
  };
}

/** Pura — `true` quando a checagem ATUAL está em `drift-stale` E o
 * fingerprint difere do último já alarmado. Recebe `driftSince` já
 * avançado (`advanceNpmVersionDriftState(...).driftSince`), não o `prev`. */
export function shouldAlarmNpmVersionDrift(
  state: NpmVersionDriftAlarmState,
  check: NpmVersionCheck,
  now: Date,
  thresholdDays: number,
): boolean {
  const evaluation = evaluateNpmVersionDrift(check, state.driftSince, now, thresholdDays);
  if (!isNpmVersionDriftPending(evaluation)) return false;
  return npmVersionDriftFindingKey(evaluation) !== state.lastAlarmedFingerprint;
}

/** Pura — grava o fingerprint recém-alarmado no estado (chamar depois de
 * enviar o e-mail com sucesso). */
export function markNpmVersionDriftAlarmed(
  state: NpmVersionDriftAlarmState,
  evaluation: NpmVersionDriftEvaluation,
): NpmVersionDriftAlarmState {
  return { ...state, lastAlarmedFingerprint: npmVersionDriftFindingKey(evaluation) };
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme, mesmo padrão de
 * `buildClaudeSessionDriftAlarmEmail`/`buildNodeModulesLoopAlarmEmail`. */
export function buildNpmVersionDriftAlarmEmail(
  evaluation: NpmVersionDriftEvaluation,
  thresholdDays: number,
  now: Date = new Date(),
): { subject: string; body: string } {
  const subject = `[diar.ia.br] Claude Code defasado ${evaluation.ageDays.toFixed(0)}d — disco ${evaluation.diskVersion}, upstream ${evaluation.upstreamVersion}`;

  const lines: string[] = [
    "O alarme `Diaria-Npm-Version-Drift-Alarm`",
    "(`scripts/npm-version-drift-alarm.ts`) detectou que o binário do Claude",
    "Code instalado no disco está defasado da versão publicada no npm há mais",
    `do que o limiar de ${thresholdDays}d (#6960).`,
    "",
    "Contexto: o auto-updater deste host foi DESLIGADO deliberadamente",
    "(decisão registrada na #6927 — o binário quebrou 5x no mesmo dia).",
    "Este alarme é o contrapeso: sem atualização automática, 'desligado' pode",
    "virar 'esquecido' em silêncio. O alarme do #6927 não cobre este caso —",
    "ele mede reinstalação recente (processo != disco), não versão velha",
    "parada (disco == processo, os dois defasados do upstream).",
    "",
    `disco:    ${evaluation.diskVersion}`,
    `upstream: ${evaluation.upstreamVersion}`,
    `defasado há: ${evaluation.ageDays.toFixed(1)}d`,
    "",
    "Ação sugerida: atualizar deliberadamente (rodar o install.cjs do",
    "@anthropic-ai/claude-code, confirmar `claude --version`, e reiniciar as",
    "sessões de vida longa depois — senão a máquina volta ao loop do #6875).",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  ];

  return { subject, body: lines.join("\n") };
}
