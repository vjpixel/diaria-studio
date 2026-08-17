/**
 * scripts/lib/systemd-failed-units-alarm.ts (#5563 follow-up)
 *
 * Lógica PURA do sweep genérico de units systemd `--user` `diaria-*.service`
 * em estado `failed` — cobre de graça as ~34 tasks do registro
 * (`scripts/lib/scheduled-tasks.ts`), em vez de um alarme artesanal por
 * task (padrão que a própria #5563 identificou como não escalável: o
 * `diaria-edicao-diaria.service` falhou 4x em silêncio porque
 * `systemctl --user list-timers` continua mostrando o timer como saudável
 * mesmo com o service morto — o estado de falha só aparece em
 * `systemctl status <service>`, que ninguém consulta por rotina).
 *
 * **O que cobre nativamente:** qualquer unit `diaria-*.service` cujo último
 * `ExecStart=` saiu com exit != 0 e systemd o marcou `failed` — inclui o
 * caso concreto do #5563 (`spawnSync claude ENOENT`), e generaliza pra
 * qualquer uma das outras ~33 tasks sem precisar de alarme dedicado por
 * task.
 *
 * **O que NÃO cobre (documentado, não é lacuna desta unidade):** um service
 * que nunca chegou a ser DISPARADO pelo timer (ex: timer nunca armado,
 * `systemctl --user enable --now` nunca rodado, ou máquina desligada na
 * hora do disparo) não aparece como `failed` — não há nada pra falhar. Esse
 * caso ("nunca disparou") é estruturalmente diferente de "disparou e
 * falhou" e não dá pra detectar via `--state=failed`; é o motivo de
 * `edicao-diaria-staleness-alarm.ts` (companheiro desta unidade, #5563)
 * continuar existindo como check ESPECÍFICO da task `diaria-edicao-diaria`
 * — o sweep genérico aqui cobre "falhou", o check específico cobre "nunca
 * disparou" via `data/editions/{AAMMDD}/` + `overnight-schedule.log`.
 *
 * I/O (`systemctl --user list-units 'diaria-*.service' --state=failed`,
 * SÓ LEITURA — nunca `start`/`stop`/`restart`) fica em
 * `scripts/systemd-failed-units-alarm.ts`.
 */

/** Pure — extrai os nomes de unit da saída de
 * `systemctl --user list-units 'diaria-*.service' --state=failed --plain --no-legend`.
 * Formato de cada linha: `UNIT LOAD ACTIVE SUB DESCRIPTION...` (colunas
 * separadas por espaço/tab) — só a 1ª coluna importa. `--no-legend` remove
 * header/footer ("N loaded units listed."); `--plain` remove os glyphs de
 * árvore (`●`) que às vezes prefixam a linha — mas o parser não assume
 * nenhuma das duas flags, ele tolera glyphs residuais ignorando qualquer
 * token inicial que não termine em `.service`. */
export function parseSystemctlListUnitsFailedOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tokens = line.split(/\s+/);
      // Tolera um glyph de árvore residual (`●`) como 1º token quando
      // `--plain` não foi honrado por alguma versão do systemd — pega o
      // primeiro token que efetivamente termina em `.service`.
      return tokens.find((t) => t.endsWith(".service")) ?? "";
    })
    .filter((name) => name.length > 0);
}

export type SystemdFailedUnitsVerdict = "ok" | "alarm-failed-units";

export interface SystemdFailedUnitsEvaluation {
  verdict: SystemdFailedUnitsVerdict;
  /** Sempre ordenado — estabiliza comparação de estado (idempotência) e
   * output do e-mail/issue independente da ordem retornada pelo systemctl. */
  failedUnits: string[];
}

/** Pure — `failedUnits` já vem parseado (I/O feito pelo caller). */
export function evaluateSystemdFailedUnits(failedUnits: string[]): SystemdFailedUnitsEvaluation {
  const sorted = [...failedUnits].sort();
  return { verdict: sorted.length > 0 ? "alarm-failed-units" : "ok", failedUnits: sorted };
}

export function isAlarmingVerdict(verdict: SystemdFailedUnitsVerdict): boolean {
  return verdict === "alarm-failed-units";
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1 alarme por CONJUNTO de units falhas (reenvia se
// o conjunto mudar: unit nova falhou, ou uma unit saiu do conjunto e outra
// permanece — mesmo padrão de OnedriveSyncAlarmState, adaptado pra um
// conjunto em vez de um único verdict).
// ---------------------------------------------------------------------------

export interface SystemdFailedUnitsAlarmState {
  /** `null` = nunca alarmado ainda. Lista SEMPRE ordenada (ver `evaluateSystemdFailedUnits`). */
  lastAlarmedUnits: string[] | null;
}

export function emptySystemdFailedUnitsAlarmState(): SystemdFailedUnitsAlarmState {
  return { lastAlarmedUnits: null };
}

function sameUnitSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function shouldSendSystemdFailedUnitsAlarm(
  evaluation: SystemdFailedUnitsEvaluation,
  state: SystemdFailedUnitsAlarmState,
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  if (state.lastAlarmedUnits === null) return true;
  return !sameUnitSet(state.lastAlarmedUnits, evaluation.failedUnits);
}

export function markSystemdFailedUnitsAlarmed(failedUnits: string[]): SystemdFailedUnitsAlarmState {
  return { lastAlarmedUnits: [...failedUnits].sort() };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

export function buildSystemdFailedUnitsAlarmEmail(
  evaluation: SystemdFailedUnitsEvaluation,
  issueLines: string,
): { subject: string; body: string } {
  const list = evaluation.failedUnits.map((u) => `  - ${u}`).join("\n");
  return {
    subject: `⚠️ ${evaluation.failedUnits.length} unit(s) systemd falhando: ${evaluation.failedUnits.join(", ")}`,
    body:
      `${evaluation.failedUnits.length} unit(s) systemd --user com prefixo diaria-*.service estão em estado ` +
      `"failed":\n\n${list}\n\n` +
      `Investigar com \`journalctl --user -u <unit> -n 50\` e \`systemctl --user status <unit>\`. ` +
      `Religar/reiniciar é ação manual do editor (este alarme nunca muta o serviço).\n\n` +
      `Achado automático de \`Diaria-Systemd-Failed-Units-Alarm\` ` +
      `(\`scripts/systemd-failed-units-alarm.ts\`, #5563 follow-up).${issueLines}`,
  };
}
