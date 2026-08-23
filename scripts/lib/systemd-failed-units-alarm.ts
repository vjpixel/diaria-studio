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
// Campos diagnósticos (#5963) — allowlist FECHADA de `systemctl --user show`
// ---------------------------------------------------------------------------

/**
 * Allowlist FECHADA (#5963) — só estes 6 nomes de propriedade são elegíveis
 * a aparecer no corpo da issue. Todos são enum, inteiro, timestamp ou UUID —
 * nenhum campo de texto livre (nunca `ExecMainStatusText`, stdout/stderr,
 * nem qualquer outra propriedade que `systemctl show` exponha). Repositório
 * é PÚBLICO — a allowlist é a barreira contra vazar dado sensível (resposta
 * de API, e-mail de assinante, token em mensagem de erro) que um texto livre
 * carregaria.
 */
export const UNIT_DIAGNOSTIC_PROPERTIES = [
  "Result",
  "ExecMainStatus",
  "NRestarts",
  "ActiveEnterTimestamp",
  "InactiveEnterTimestamp",
  "InvocationID",
] as const;

export type UnitDiagnosticProperty = (typeof UNIT_DIAGNOSTIC_PROPERTIES)[number];

/** Campos capturados de uma unit — só os que existiam na saída E passaram na
 * validação de forma (2ª barreira). Chave ausente = descartada, nunca
 * incluída com valor vazio/placeholder. */
export type UnitDiagnosticFields = Partial<Record<UnitDiagnosticProperty, string>>;

/** Result= é sempre um destes tokens systemd conhecidos (enum fechado do
 * próprio systemd — `man systemd.exec` §Result). Qualquer outra coisa é
 * saída inesperada e é descartada. */
const KNOWN_RESULT_VALUES = new Set([
  "success",
  "protocol",
  "timeout",
  "exit-code",
  "signal",
  "core-dump",
  "watchdog",
  "start-limit-hit",
  "resources",
  "oom-kill",
]);

/** Formato systemd timestamp — ex: `Sat 2026-08-23 09:00:12 UTC` (ou vazio
 * quando a unit nunca entrou/saiu desse estado). String vazia é uma forma
 * VÁLIDA (systemd usa `""` pra "nunca aconteceu", não omite a chave) — só
 * texto com conteúdo inesperado (não-timestamp) é descartado. */
const SYSTEMD_TIMESTAMP_RE = /^[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? [A-Za-z0-9+\-:]+$/;

/** UUID v4-ish sem hífen — formato de `InvocationID=` (32 hex chars). */
const INVOCATION_ID_RE = /^[0-9a-f]{32}$/i;

/** Valida a FORMA de um valor contra o que a propriedade permite — 2ª
 * barreira (#5963): mesmo vindo de uma propriedade da allowlist, um valor
 * que não bate o formato esperado é descartado em vez de repassado cego.
 * Protege contra uma versão futura do systemd mudando o formato ou
 * populando a propriedade com algo inesperado. @pure */
export function isValidUnitDiagnosticValue(property: UnitDiagnosticProperty, value: string): boolean {
  switch (property) {
    case "Result":
      return KNOWN_RESULT_VALUES.has(value);
    case "ExecMainStatus":
    case "NRestarts":
      return /^-?\d+$/.test(value);
    case "ActiveEnterTimestamp":
    case "InactiveEnterTimestamp":
      return value === "" || value === "n/a" || SYSTEMD_TIMESTAMP_RE.test(value);
    case "InvocationID":
      // string vazia é válida — unit nunca invocada (ex: carregada mas nunca
      // disparada) não tem invocation id ainda.
      return value === "" || INVOCATION_ID_RE.test(value);
    default:
      return false;
  }
}

/**
 * Parseia a saída de `systemctl --user show <unit> --property={allowlist}`
 * — N linhas `Chave=Valor`. Só chaves na allowlist E com valor validado
 * (`isValidUnitDiagnosticValue`) entram no resultado; tudo mais é
 * descartado silenciosamente (nunca lança — saída inesperada do systemd é
 * esperado ser tolerada, não travar o alarme). @pure
 */
export function parseUnitDiagnosticShowOutput(output: string): UnitDiagnosticFields {
  const result: UnitDiagnosticFields = {};
  const allowlist = new Set<string>(UNIT_DIAGNOSTIC_PROPERTIES);
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!allowlist.has(key)) continue;
    const property = key as UnitDiagnosticProperty;
    if (!isValidUnitDiagnosticValue(property, value)) continue;
    result[property] = value;
  }
  return result;
}

/** Formata os campos capturados como tabela markdown — vazio se nenhum
 * campo sobreviveu à validação (caller decide se omite a seção inteira).
 * @pure */
export function formatUnitDiagnosticFieldsTable(fields: UnitDiagnosticFields): string {
  const rows = UNIT_DIAGNOSTIC_PROPERTIES.filter((p) => fields[p] !== undefined).map(
    (p) => `| ${p} | \`${fields[p]}\` |`,
  );
  if (rows.length === 0) return "";
  return ["| Campo | Valor |", "| --- | --- |", ...rows].join("\n");
}

/** Instrução de investigação — usa `InvocationID` quando disponível (journal
 * da execução ESPECÍFICA que falhou, recuperável mesmo depois de outras
 * rodadas); cai pro comando genérico (última execução, pode não ser a que
 * falhou) quando ausente/descartado. @pure */
export function buildUnitInvestigationCommand(unitName: string, fields: UnitDiagnosticFields): string {
  const invocationId = fields.InvocationID;
  if (invocationId) {
    return `journalctl --user _SYSTEMD_INVOCATION_ID=${invocationId}`;
  }
  return `journalctl --user -u ${unitName} -n 50`;
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1 alarme por CONJUNTO de units falhas (reenvia se
// o conjunto mudar: unit nova falhou, ou uma unit saiu do conjunto e outra
// permanece — mesmo padrão de OnedriveSyncAlarmState, adaptado pra um
// conjunto em vez de um único verdict), COM EXPIRAÇÃO (#5978): o dedup por
// conjunto sozinho nunca expirava — enquanto o mesmo conjunto de units
// permanecesse failed (dias, no incidente que motivou o #5978), nenhum
// e-mail novo saía. `lastAlarmedAt` estampa quando o alarme mais recente foi
// enviado; `shouldSendSystemdFailedUnitsAlarm` reenvia o digest se o mesmo
// conjunto persistir além de `SYSTEMD_FAILED_UNITS_ALARM_DEDUP_HOURS`,
// mesmo sem nenhuma mudança no conjunto.
// ---------------------------------------------------------------------------

/** Limiar de expiração do dedup por conjunto (#5978, sugestão da issue) —
 * mesmo conjunto de units failed reenvia o digest a cada N horas em vez de
 * nunca mais, enquanto a condição persistir. */
export const SYSTEMD_FAILED_UNITS_ALARM_DEDUP_HOURS = 6;

export interface SystemdFailedUnitsAlarmState {
  /** `null` = nunca alarmado ainda. Lista SEMPRE ordenada (ver `evaluateSystemdFailedUnits`). */
  lastAlarmedUnits: string[] | null;
  /** #5978 — ISO timestamp do último e-mail efetivamente enviado. `null` =
   * nunca alarmado ainda (mesma semântica de `lastAlarmedUnits === null`) OU
   * entry pré-#5978 sem este campo — `shouldSendSystemdFailedUnitsAlarm`
   * trata ausência como "expirado" (reenvia), nunca como "recém-alarmado". */
  lastAlarmedAt: string | null;
}

export function emptySystemdFailedUnitsAlarmState(): SystemdFailedUnitsAlarmState {
  return { lastAlarmedUnits: null, lastAlarmedAt: null };
}

function sameUnitSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * `now` injetável pra teste (default `new Date()`). Regras, em ordem:
 *   1. verdict "ok" (nenhuma unit failed) -> nunca alarma.
 *   2. nunca alarmado antes (`lastAlarmedUnits === null`) -> alarma.
 *   3. conjunto MUDOU desde o último alarme -> alarma (comportamento
 *      pré-#5978, inalterado).
 *   4. mesmo conjunto, MAS `lastAlarmedAt` ausente ou além do limiar de
 *      `SYSTEMD_FAILED_UNITS_ALARM_DEDUP_HOURS` -> alarma (#5978 — é isto
 *      que resolve "parado há 2 dias, alarme nunca reenvia").
 *   5. mesmo conjunto, dentro do limiar -> não alarma (dedup normal contra
 *      spam de execução em execução).
 */
export function shouldSendSystemdFailedUnitsAlarm(
  evaluation: SystemdFailedUnitsEvaluation,
  state: SystemdFailedUnitsAlarmState,
  now: Date = new Date(),
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  if (state.lastAlarmedUnits === null) return true;
  if (!sameUnitSet(state.lastAlarmedUnits, evaluation.failedUnits)) return true;
  if (!state.lastAlarmedAt) return true;
  const lastAlarmedMs = Date.parse(state.lastAlarmedAt);
  if (Number.isNaN(lastAlarmedMs)) return true; // estado corrompido -> trata como expirado, nunca como "recente"
  const elapsedHours = (now.getTime() - lastAlarmedMs) / (1000 * 60 * 60);
  return elapsedHours >= SYSTEMD_FAILED_UNITS_ALARM_DEDUP_HOURS;
}

export function markSystemdFailedUnitsAlarmed(
  failedUnits: string[],
  now: Date = new Date(),
): SystemdFailedUnitsAlarmState {
  return { lastAlarmedUnits: [...failedUnits].sort(), lastAlarmedAt: now.toISOString() };
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
