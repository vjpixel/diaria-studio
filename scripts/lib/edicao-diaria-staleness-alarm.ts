/**
 * scripts/lib/edicao-diaria-staleness-alarm.ts (#5563)
 *
 * Lógica PURA do alarme de staleness específico da task
 * `diaria-edicao-diaria` — achado ao vivo (#5563): o service falhou em
 * 100% dos disparos entre 11 e 16/08/2026 (`spawnSync claude ENOENT`,
 * corrigido no PR #5562) e nada avisou. `systemctl --user list-timers`
 * continua mostrando o timer como saudável mesmo com o service morrendo em
 * ~1s — o único registro legível era uma linha `FAIL` em
 * `data/overnight-schedule.log`, que nada lia automaticamente.
 *
 * **Complementar ao sweep genérico** (`systemd-failed-units-alarm.ts`, do
 * mesmo lote #5563): o sweep genérico pega "disparou e falhou" de graça
 * pras ~34 tasks do registro via `systemctl --state=failed`. Este módulo
 * cobre o que o sweep genérico estruturalmente NÃO pode: "nunca disparou"
 * (timer nunca chegou a rodar o service — não há nada em `failed` pra um
 * service que nunca foi invocado). Os dois juntos fecham as 3 lacunas da
 * issue:
 *
 *   - nunca disparou            → só este módulo detecta (`alarm-never-fired`)
 *   - disparou e falhou         → os dois detectam (redundância aceita)
 *   - disparou e pulou (idempotência, edição já iniciada à mão) → NENHUM
 *     dos dois alarma — a edição existe em disco, caso legítimo.
 *   - desligado de propósito pelo editor → `timer-disabled` (#6898), não
 *     alarma: até então indistinguível de "nunca disparou".
 *
 * **Fonte de dado:** `data/overnight-schedule.log` (linha por execução,
 * formato `${ISO} | ${STATUS}  edition=${AAMMDD} ...` — ver
 * `scripts/overnight/run-scheduled-edicao.ts`) + existência de
 * a existência da edição em disco (ver `edicaoDirCandidates`) + o estado de
 * armamento da unit (`EdicaoTimerState`). I/O (leitura do log, `existsSync`,
 * `systemctl`, envio de e-mail) fica em
 * `scripts/edicao-diaria-staleness-alarm.ts`.
 */

import { join } from "node:path";

import { BRT_TIMEZONE } from "./next-edition-date.ts";
import { editionDir } from "./edition-paths.ts";
import type { AlarmIssueResult } from "./alarm-issues.ts";

// ---------------------------------------------------------------------------
// Parse de data/overnight-schedule.log
// ---------------------------------------------------------------------------

export type EdicaoLogStatus = "START" | "OK" | "FAIL" | "SKIP";

export interface EdicaoLogEntry {
  timestampIso: string;
  status: EdicaoLogStatus;
  edition: string;
}

// Formato gravado por `writeScheduleLog` em run-scheduled-edicao.ts:
// "2026-04-26T14:00:01-03:00 | START edition=260427 pid=12345"
// "2026-04-26T14:00:02-03:00 | SKIP  edition=260427 reason=already-started end=..."
const LOG_LINE_RE = /^(\S+)\s*\|\s*(START|OK|FAIL|SKIP)\s+edition=(\d{6})/;

/** Pure — parseia 1 linha de `data/overnight-schedule.log`. `null` se a
 * linha não bater o formato esperado (linha em branco, linha de outra
 * origem — o log é compartilhado — ou formato futuro desconhecido). */
export function parseOvernightScheduleLogLine(line: string): EdicaoLogEntry | null {
  const m = LOG_LINE_RE.exec(line.trim());
  if (!m) return null;
  return { timestampIso: m[1], status: m[2] as EdicaoLogStatus, edition: m[3] };
}

/** Pure — última entrada (mais recente, assumindo `lines` em ordem
 * cronológica de append) do log pra uma edição específica. `null` se nunca
 * apareceu nenhuma linha pra essa edição — o sinal de "nunca disparou". */
export function findLastEdicaoLogEntry(lines: string[], aammdd: string): EdicaoLogEntry | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseOvernightScheduleLogLine(lines[i]);
    if (entry && entry.edition === aammdd) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Onde a edição mora em disco (#6898 defeito 1)
// ---------------------------------------------------------------------------

/**
 * Pure — os caminhos (relativos à raiz do repo) em que a edição `aammdd`
 * pode existir, em ordem de preferência.
 *
 * O layout canônico é NESTED (`data/editions/{YYMM}/{AAMMDD}`, #2463) e é o
 * que `editionDir()` constrói. O alarme, porém, nasceu (#5563) checando o
 * layout FLAT e nunca acompanhou a migração — resultado medido em 01/09/2026:
 * ele afirmava "edição 260901 não foi preparada" enquanto
 * `data/editions/2609/260901/` tinha as 6 etapas concluídas. O flat segue
 * na lista como fallback porque `data/editions/` ainda tem pastas não
 * migradas (`260708` etc.; a migração do #2463 é gated com o editor) — é
 * checar os DOIS que mantém o alarme correto durante e depois da migração.
 */
export function edicaoDirCandidates(aammdd: string): string[] {
  return [editionDir(aammdd), join("data", "editions", aammdd)];
}

// ---------------------------------------------------------------------------
// Dia da semana coberto pelo timer (Sun-Thu, produz edição Mon-Fri)
// ---------------------------------------------------------------------------

const SCHEDULED_WEEKDAYS = new Set(["Sun", "Mon", "Tue", "Wed", "Thu"]);

/** Pure em relação ao formatter — usa `Intl` (sem dependência de I/O), mas
 * não é 100% pura no sentido estrito porque `Intl.DateTimeFormat` consulta
 * dados de fuso do runtime; mesma classificação já aceita por
 * `next-edition-date.ts`/`datePartsInTz`. `true` se `now`, em BRT, cai num
 * dia domingo-quinta (janela em que `diaria-edicao-diaria.timer` dispara às
 * 16:00 BRT — ver `docs/scheduled-edicao-setup.md`). */
export function isEdicaoDiariaScheduledWeekday(now: Date): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: BRT_TIMEZONE, weekday: "short" }).format(now);
  return SCHEDULED_WEEKDAYS.has(weekday);
}

// ---------------------------------------------------------------------------
// Veredito combinado
// ---------------------------------------------------------------------------

/**
 * #6898 — estado de armamento do `diaria-edicao-diaria.timer` como o caller o
 * obteve (`queryTaskArmed` de `scheduled-task-status.ts`). `"unknown"` cobre
 * TODOS os casos em que a consulta não deu resposta confiável
 * (`cannot_verify`, `not_armed`, ou caller que nem consultou) — ver
 * `evaluateEdicaoDiariaStaleness` pro porquê de só `"disabled"` silenciar.
 */
export type EdicaoTimerState = "armed" | "disabled" | "unknown";

export type EdicaoDiariaStalenessVerdict =
  | "not-applicable" // sexta/sábado — timer não dispara, nada a checar
  | "timer-disabled" // #6898: unit `disabled` — automação desligada de propósito, não é falha
  | "ok" // data/editions/{YYMM}/{AAMMDD}/ existe — sucesso OU editor já iniciou manualmente (idempotência, caso legítimo)
  | "in-progress" // START logado recentemente, ainda dentro da margem de duração esperada da run
  | "alarm-never-fired" // nenhuma linha no log pra esta edição — timer não disparou (ou nunca foi armado)
  | "alarm-failed" // última linha é FAIL — ou START MUITO antigo (run travada além da margem, tratado como falha)
  | "alarm-inconsistent"; // último status não bate com editionExists=false (ex: SKIP sem diretório — estado incoerente)

export interface EdicaoDiariaStalenessEvaluation {
  verdict: EdicaoDiariaStalenessVerdict;
  aammdd: string;
}

/** Margem além da qual um START sem conclusão (OK/FAIL) é tratado como
 * travado, não "ainda rodando" — folga generosa acima do
 * `--max-turns 120` do runner (tipicamente 50-90 turnos, ver
 * `docs/scheduled-edicao-setup.md`), mas finita: sem isso, uma run
 * genuinamente travada nunca alarmaria (ficaria em "in-progress" pra
 * sempre, já que o veredito só é recalculado 1x/dia por esta task). */
const IN_PROGRESS_TOLERANCE_MS = 3 * 60 * 60 * 1000; // 3h

/**
 * Pure — combina os sinais (`editionExists` e `lastEntry`, ambos I/O do
 * caller) num veredito único. Prioridade: dia não-agendado vence tudo
 * (nada esperado); `editionExists` vence sobre o log (cobre sucesso E
 * "pulou por idempotência" com o MESMO veredito `"ok"` — ambos são
 * legítimos e a distinção entre eles não muda a ação do editor, ver
 * docstring do módulo).
 */
export function evaluateEdicaoDiariaStaleness(
  aammdd: string,
  isScheduledDay: boolean,
  editionExists: boolean,
  lastEntry: EdicaoLogEntry | null,
  now: Date,
  timerState: EdicaoTimerState = "unknown",
): EdicaoDiariaStalenessEvaluation {
  if (!isScheduledDay) return { verdict: "not-applicable", aammdd };
  if (editionExists) return { verdict: "ok", aammdd };
  // #6898 defeito 2 — SÓ `"disabled"` silencia. `"unknown"` (systemctl
  // indisponível, máquina sem agendador reconhecido, unit ausente) mantém o
  // comportamento histórico de alarmar: a direção de falha segura aqui é o
  // falso POSITIVO, porque "nunca disparou" é justamente o buraco que este
  // alarme existe pra cobrir (#5563) — silenciá-lo por uma consulta que não
  // deu resposta reintroduziria o incidente original, e em silêncio.
  if (timerState === "disabled") return { verdict: "timer-disabled", aammdd };
  if (lastEntry === null) return { verdict: "alarm-never-fired", aammdd };
  if (lastEntry.status === "FAIL") return { verdict: "alarm-failed", aammdd };
  if (lastEntry.status === "START") {
    const startMs = Date.parse(lastEntry.timestampIso);
    const ageMs = Number.isNaN(startMs) ? Infinity : now.getTime() - startMs;
    if (ageMs >= 0 && ageMs < IN_PROGRESS_TOLERANCE_MS) return { verdict: "in-progress", aammdd };
    return { verdict: "alarm-failed", aammdd };
  }
  // status === "SKIP" mas editionExists === false: SKIP só é logado quando
  // o diretório JÁ existia no momento do guard — se ele não existe mais
  // agora, o estado é incoerente (diretório removido depois, ou corrida
  // entre processos). Alarma conservadoramente em vez de silenciar.
  return { verdict: "alarm-inconsistent", aammdd };
}

export function isAlarmingVerdict(verdict: EdicaoDiariaStalenessVerdict): boolean {
  return verdict === "alarm-never-fired" || verdict === "alarm-failed" || verdict === "alarm-inconsistent";
}

// ---------------------------------------------------------------------------
// Idempotência do e-mail — 1 alarme por edição (`aammdd`), nunca reenviado
// pro MESMO dia (mesmo padrão de LinkedinWeeklyStalenessAlarmState — o
// fingerprint natural aqui já é por-dia, então o próximo dia é sempre um
// aammdd novo e o alarme reavalia do zero, fechando sozinho o dia seguinte
// limpo, exatamente como a issue #5563 pediu).
// ---------------------------------------------------------------------------

export interface EdicaoDiariaStalenessAlarmState {
  lastAlarmedEdition: string | null;
}

export function emptyEdicaoDiariaStalenessAlarmState(): EdicaoDiariaStalenessAlarmState {
  return { lastAlarmedEdition: null };
}

export function shouldSendEdicaoDiariaStalenessAlarm(
  evaluation: EdicaoDiariaStalenessEvaluation,
  state: EdicaoDiariaStalenessAlarmState,
): boolean {
  if (!isAlarmingVerdict(evaluation.verdict)) return false;
  return state.lastAlarmedEdition !== evaluation.aammdd;
}

export function markEdicaoDiariaStalenessAlarmed(aammdd: string): EdicaoDiariaStalenessAlarmState {
  return { lastAlarmedEdition: aammdd };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

function verdictMessage(evaluation: EdicaoDiariaStalenessEvaluation): string {
  switch (evaluation.verdict) {
    case "alarm-never-fired":
      return (
        `Nenhuma linha em data/overnight-schedule.log menciona a edição ${evaluation.aammdd} — ` +
        `o timer diaria-edicao-diaria.timer não disparou hoje (ou nunca foi armado/reiniciado nesta ` +
        `máquina). Verificar: \`systemctl --user list-timers diaria-edicao-diaria.timer\` e ` +
        `\`systemctl --user status diaria-edicao-diaria.service\`.`
      );
    case "alarm-failed":
      return (
        `A última execução registrada pra edição ${evaluation.aammdd} terminou em FAIL (ou travou além ` +
        `da margem de 3h sem concluir) — o service disparou, mas não produziu ` +
        `data/editions/${evaluation.aammdd}/. Ver \`data/overnight-schedule.log\` (última linha ` +
        `edition=${evaluation.aammdd}) e \`journalctl --user -u diaria-edicao-diaria.service -n 50\` pro erro.`
      );
    default:
      return (
        `Estado incoerente detectado pra edição ${evaluation.aammdd} (verdict=${evaluation.verdict}) — ` +
        `checar data/overnight-schedule.log e data/editions/${evaluation.aammdd}/ manualmente.`
      );
  }
}

export function buildEdicaoDiariaStalenessAlarmEmail(
  evaluation: EdicaoDiariaStalenessEvaluation,
  issueRef?: AlarmIssueResult,
): { subject: string; body: string } {
  const issueLine = issueRef
    ? issueRef.action === "failed"
      ? `\n\nIssue: falha ao criar/reusar (${issueRef.error})`
      : `\n\nIssue: #${issueRef.issueNumber} (${issueRef.url})`
    : "";
  return {
    subject: `⚠️ Edição diária ${evaluation.aammdd}: ${evaluation.verdict}`,
    body:
      `${verdictMessage(evaluation)}\n\n` +
      `Achado automático de \`Diaria-Edicao-Diaria-Staleness-Alarm\` ` +
      `(\`scripts/edicao-diaria-staleness-alarm.ts\`, #5563).${issueLine}`,
  };
}
