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

// ---------------------------------------------------------------------------
// Diagnóstico da unit falha (#5943)
//
// **O buraco que isto fecha:** o alarme roda NA máquina que tem o journal,
// mas escrevia uma issue mandando um leitor futuro rodar `journalctl` — um
// comando que só funciona naquela mesma máquina, mais tarde, quando o journal
// já pode ter rotacionado. Todo consumidor da issue (sessão cloud, o editor no
// celular, uma sessão `/diaria-develop`) recebia zero conteúdo diagnóstico.
// Foi exatamente o que aconteceu na #5943: a investigação foi encerrada com
// "Verificado: não há código para corrigir" sem que ninguém tivesse visto por
// que a unit falhou.
//
// **Por que NÃO anexamos o journal:** `vjpixel/diaria-studio` é um repositório
// PÚBLICO. A saída de `journalctl` carrega stdout/stderr dos scripts — que
// inclui resposta de API, e-mail de assinante e token em mensagem de erro.
// Anexar isso a uma issue pública é leak. O que anexamos é a allowlist fechada
// abaixo: enums, inteiros, timestamps e um UUID. Nenhum campo de texto livre —
// e cada valor ainda passa por uma validação de forma antes de entrar no corpo,
// de modo que uma saída inesperada do systemd é DESCARTADA, nunca repassada.
// ---------------------------------------------------------------------------

/** Allowlist FECHADA de propriedades de `systemctl show`. Adicionar campo aqui
 * exige checar que ele não carrega texto livre — ver o bloco acima.
 * `ExecStart`/`Environment` estão fora de propósito (linha de comando e env). */
export const UNIT_DIAGNOSTIC_PROPERTIES = [
  "Result",
  "ExecMainStatus",
  "NRestarts",
  "ActiveEnterTimestamp",
  "InactiveEnterTimestamp",
  "InvocationID",
] as const;

export type UnitDiagnosticProperty = (typeof UNIT_DIAGNOSTIC_PROPERTIES)[number];

/** Só as chaves da allowlist, e só quando o valor passou na validação de forma. */
export type UnitFailureDiagnostics = Partial<Record<UnitDiagnosticProperty, string>>;

/** Forma esperada por propriedade — 2ª barreira do guard de leak. Qualquer
 * valor fora da forma é descartado (não vai pra issue pública). */
const DIAGNOSTIC_VALUE_SHAPE: Record<UnitDiagnosticProperty, RegExp> = {
  Result: /^[a-z][a-z-]{0,30}$/,
  ExecMainStatus: /^\d{1,3}$/,
  NRestarts: /^\d{1,6}$/,
  // Formato systemd: "Sun 2026-08-23 04:10:12 -03" (ou vazio quando nunca ativou).
  ActiveEnterTimestamp: /^[A-Za-z]{3} [\d-]{10} [\d:]{8} [A-Z0-9+-]{1,6}$/,
  InactiveEnterTimestamp: /^[A-Za-z]{3} [\d-]{10} [\d:]{8} [A-Z0-9+-]{1,6}$/,
  InvocationID: /^[0-9a-f]{32}$/,
};

function isDiagnosticProperty(key: string): key is UnitDiagnosticProperty {
  return (UNIT_DIAGNOSTIC_PROPERTIES as readonly string[]).includes(key);
}

/** Pure — parseia `KEY=VALUE` de `systemctl --user show <unit> --property=...`.
 * Descarta chave fora da allowlist, valor vazio e valor fora da forma esperada.
 * O valor pode conter `=` (só o 1º separa), então o split é no primeiro índice. */
export function parseSystemctlShowOutput(stdout: string): UnitFailureDiagnostics {
  const out: UnitFailureDiagnostics = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!isDiagnosticProperty(key)) continue;
    if (value.length === 0) continue;
    if (!DIAGNOSTIC_VALUE_SHAPE[key].test(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Pure — tradução do enum `Result` do systemd pra causa em português. É a
 * informação que separa "o script saiu != 0" de "estourou timeout" ou "o
 * kernel matou por OOM" — três problemas com correções diferentes. */
export function explainSystemdResult(result: string): string | null {
  switch (result) {
    case "success":
      return "último ExecStart saiu 0 — a falha veio de ExecStartPre/ExecStartPost ou do próprio systemd, não do script";
    case "exit-code":
      return "o processo terminou com exit != 0 (ver `ExecMainStatus`)";
    case "timeout":
      return "estourou o timeout da unit (`TimeoutStartSec`/`RuntimeMaxSec`) — o script não terminou a tempo";
    case "signal":
      return "morto por sinal externo";
    case "core-dump":
      return "o processo abortou com core dump";
    case "oom-kill":
      return "o kernel matou o processo por falta de memória";
    case "watchdog":
      return "o watchdog da unit disparou";
    case "start-limit-hit":
      return "bateu `StartLimitBurst` — o systemd se recusou a tentar de novo";
    case "resources":
      return "o systemd não conseguiu alocar recursos pra iniciar a unit";
    case "protocol":
      return "a unit violou o protocolo esperado pelo seu `Type=`";
    default:
      return null;
  }
}

/** Pure — as linhas do bloco de diagnóstico do corpo da issue. Devolve `[]`
 * quando não há nada capturado (máquina sem systemd, `show` indisponível, ou
 * todos os valores reprovados na validação de forma) — o caller então mantém
 * só as instruções de investigação, que é o comportamento pré-#5943. */
export function formatUnitDiagnostics(diagnostics: UnitFailureDiagnostics): string[] {
  const entries = UNIT_DIAGNOSTIC_PROPERTIES.filter((k) => diagnostics[k] !== undefined);
  if (entries.length === 0) return [];

  const lines = ["Diagnóstico capturado no momento do achado (`systemctl --user show`):", ""];
  for (const key of entries) lines.push(`- \`${key}\`: \`${diagnostics[key]}\``);

  const explanation = diagnostics.Result ? explainSystemdResult(diagnostics.Result) : null;
  if (explanation) lines.push("", `\`Result=${diagnostics.Result}\`: ${explanation}.`);

  return lines;
}

/** Pure — corpo da issue de unit falha. `diagnostics` vazio degrada pro texto
 * de antes do #5943 (fail-soft: máquina sem systemd nunca vira issue pior). */
export function buildFailedUnitIssueBody(
  unitName: string,
  diagnostics: UnitFailureDiagnostics,
  closeAfterRuns: number,
): string {
  const diagnosticLines = formatUnitDiagnostics(diagnostics);

  // Com `InvocationID` o journal daquela execução específica continua
  // recuperável mesmo depois de outras rodadas da mesma unit — sem ele, `-n 50`
  // devolve a rodada mais recente, que pode não ser a que falhou.
  const journalCmd = diagnostics.InvocationID
    ? `journalctl --user _SYSTEMD_INVOCATION_ID=${diagnostics.InvocationID}`
    : `journalctl --user -u ${unitName} -n 50`;

  return [
    "Achado automático do alarme `Diaria-Systemd-Failed-Units-Alarm`",
    "(`scripts/systemd-failed-units-alarm.ts`, #5563 follow-up).",
    "",
    `A unit systemd --user \`${unitName}\` está em estado \`failed\`.`,
    ...(diagnosticLines.length > 0 ? ["", ...diagnosticLines] : []),
    "",
    `Investigar: \`${journalCmd}\` e \`systemctl --user status ${unitName}\`. ` +
      "Religar/reiniciar é ação manual do editor (este alarme nunca muta o serviço).",
    "",
    "O journal NÃO é anexado aqui de propósito: este repositório é público e a saída",
    "dos scripts carrega dado de assinante e credencial. Só entram no corpo os campos",
    "estruturados da allowlist de `scripts/lib/systemd-failed-units-alarm.ts`.",
    "",
    "Esta issue é criada automaticamente pelo alarme e será",
    "comentada/fechada sozinha quando o achado deixar de reproduzir por",
    `${closeAfterRuns} execuções consecutivas (mesmo padrão de #5112).`,
  ].join("\n");
}
