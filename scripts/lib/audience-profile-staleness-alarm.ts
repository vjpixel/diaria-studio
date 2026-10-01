/**
 * scripts/lib/audience-profile-staleness-alarm.ts (#8148 item 1)
 *
 * Escala o guard de arquivamento duplicado do #4366
 * (`detectDuplicateArchiveWarning`, `scripts/update-audience.ts`) de
 * "console.warn + linha em `data/run-log.jsonl`" pra alarme de verdade.
 * O guard em si NUNCA errou — o problema medido (#8148) é o canal: 5
 * disparos em 4 semanas (18/08, 19/08, 29/08, 02/09, 14/09), nenhuma
 * issue aberta, nenhuma investigação, porque `data/run-log.jsonl` é o
 * mesmo beco morto operacional já registrado no CLAUDE.md pra série
 * #4966→#7964 ("detectar e esperar que alguém olhe").
 *
 * Este módulo é PURO — lê linhas já carregadas do run-log (I/O fica no
 * script chamador, `scripts/audience-profile-staleness-alarm.ts`) e
 * decide quais viram `AlarmFinding` pra `scripts/lib/alarm-issues.ts`
 * (mesmo mecanismo de dedup/criação de issue já usado por
 * `clarice-guardrail-alarm.ts`/`edicao-diaria-staleness-alarm.ts`).
 *
 * ## Por que `family: "evento"` (#5553), nunca `"estado"`
 *
 * Cada disparo do guard é um FATO histórico sobre um dia específico
 * (`today_file`, ex: `2026-09-14.md`) — não uma condição que se
 * "resolve" quando o run seguinte sai limpo. Se o run de hoje não repetir
 * o warning, isso não desfaz o disparo de ontem; declarar `"estado"` aqui
 * faria `planAlarmReconciliation` fechar a issue de ontem sozinha assim
 * que ela sumisse do scan (mesmo risco que o #5525 quase sofreu no
 * `clarice-guardrail-alarm.ts` antes da correção do #5553).
 *
 * ## Por que a causa raiz nomeada aqui é "escrita ausente", não git-sync
 *
 * `context/audience-profile.md` embute `**updated_at:** {today}` como a
 * PRIMEIRA linha de conteúdo — esse valor muda todo dia em que o script
 * roda com sucesso. Dois snapshots arquivados byte-a-byte IDÊNTICOS (o
 * que o guard detecta) só é possível se o `today` embutido nos dois for o
 * MESMO — ou seja, o run do dia intermediário nunca chegou a executar o
 * `writeFileSync` final (crashou antes, nunca foi disparado pelo Stage 0,
 * ou saiu cedo por "Nenhuma fonte disponível"). Isso não CONFIRMA a causa
 * raiz de cada ocorrência individual (exige correlacionar com
 * `data/overnight-schedule.log`/Stage 0 do dia intermediário, fora do
 * escopo deste alarme), mas restringe o espaço de hipóteses: a
 * regeneração em si não pode ter "rodado e produzido o mesmo conteúdo" —
 * ela precisa ter simplesmente NÃO rodado até o fim.
 */

import type { AlarmFinding } from "./alarm-issues.ts";

export interface AudienceStalenessLogDetails {
  today_file?: string;
  latest_file?: string;
  issue?: string;
  /** `"snapshot"` quando a entrada foi derivada da comparação de `docs/audience-history/` (#9232), sem disparo do guard no run-log. */
  source?: string;
}

export interface AudienceStalenessLogEntry {
  timestamp: string;
  agent: string | null;
  level: string;
  message: string;
  details: AudienceStalenessLogDetails | null;
}

/** Marcador que `buildDuplicateArchiveLogArgs` (`update-audience.ts`) grava em `details.issue` — única fonte de verdade pro que conta como "essa ocorrência". */
export const DUPLICATE_ARCHIVE_ISSUE_TAG = "#4366";

/** Pure: parseia 1 linha de `data/run-log.jsonl`. `null` se malformada ou não for um objeto — mesma tolerância de `parseOvernightScheduleLogLine`/outros parsers de log deste repo (linha alheia, formato futuro desconhecido, linha em branco). */
export function parseRunLogLine(line: string): AudienceStalenessLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    return obj as AudienceStalenessLogEntry;
  } catch {
    return null;
  }
}

/** Pure: filtra as linhas do run-log que são o warning do guard #4366 emitido por `update-audience.ts` (`buildDuplicateArchiveLogArgs`) — nunca casa por texto de `message` (frágil a reescrita), sempre pelo par estrutural `agent`+`details.issue`. */
export function findDuplicateArchiveEntries(lines: string[]): AudienceStalenessLogEntry[] {
  return lines
    .map(parseRunLogLine)
    .filter((e): e is AudienceStalenessLogEntry => e !== null)
    .filter((e) => e.agent === "update-audience" && e.details?.issue === DUPLICATE_ARCHIVE_ISSUE_TAG);
}

/** Pure: chave canônica `YYYY-MM-DD.md` da ocorrência — `details.today_file`, ou a data do timestamp normalizada com `.md` (mesma forma das entradas de snapshot, pra dedup e fingerprint casarem entre fontes, #9232). */
export function occurrenceKey(entry: AudienceStalenessLogEntry): string {
  return entry.details?.today_file ?? `${entry.timestamp.slice(0, 10)}.md`;
}

/** Pure: converte 1 ocorrência do guard num `AlarmFinding` — 1 issue GitHub por `today_file` distinto (nunca agrega 2 ocorrências na mesma issue: cada dia é um fato independente que o editor precisa poder investigar/descartar em separado). */
export function toAlarmFinding(entry: AudienceStalenessLogEntry): AlarmFinding {
  const todayFile = occurrenceKey(entry);
  const latestFile = entry.details?.latest_file ?? "desconhecido";
  const fromSnapshot = entry.details?.source === "snapshot";
  return {
    check: "audience-profile-staleness",
    fingerprint: `snapshot-${todayFile}`,
    family: "evento",
    title: `[diar.ia.br] Profile de audiência regenerou idêntico ao anterior (${todayFile})`,
    body: [
      "Achado automático do alarme `Diaria-Audience-Profile-Staleness-Alarm`",
      "(`scripts/audience-profile-staleness-alarm.ts`).",
      "",
      fromSnapshot
        ? `A comparação de \`docs/audience-history/\` (#9232) encontrou o snapshot \`${todayFile}\` byte-a-byte idêntico ao snapshot anterior (\`${latestFile}\`). Não há disparo correspondente do guard do #4366 em nenhum run-log lido, então não existe timestamp de disparo.`
        : `O guard do #4366 (\`detectDuplicateArchiveWarning\`, \`scripts/update-audience.ts\`) detectou que o snapshot prestes a ser arquivado como \`${todayFile}\` era byte-a-byte idêntico ao arquivo de histórico mais recente já existente (\`${latestFile}\`).`,
      "",
      fromSnapshot ? "Fonte: comparação de snapshots (sem disparo do guard no run-log)." : `Timestamp do disparo: ${entry.timestamp}.`,
      "",
      "**Por que isso importa:** `context/audience-profile.md` embute `**updated_at:**` com a data do dia — dois snapshots idênticos só são possíveis se o `today` embutido nos dois for o MESMO, ou seja, a regeneração do dia intermediário nunca chegou a completar o `writeFileSync` final (crashou antes de escrever, ou o Stage 0 nem chegou a invocar `update-audience.ts` naquele dia). O CTR/scorer daquele período rodou com o profile de audiência DESATUALIZADO, sem nenhum sinal visível na hora.",
      "",
      `Investigar \`data/overnight-schedule.log\`/o Stage 0 do dia anterior a \`${todayFile}\` pra confirmar se o run de fato não completou (e por quê). Ver #8148 pro histórico agregado (5 ocorrências em 4 semanas) e o critério de saída.`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** Pure: converte todas as ocorrências detectadas em `AlarmFinding[]` — `alarm-issues.ts` faz o dedup por fingerprint (1 issue por `today_file`, nunca recria a mesma), então é seguro/idempotente passar SEMPRE o histórico inteiro em toda execução (não precisa de um cursor "só as novas desde a última rodada" separado). */
export function buildAlarmFindings(entries: AudienceStalenessLogEntry[]): AlarmFinding[] {
  return entries.map(toAlarmFinding);
}

// ─── Fonte independente do run-log: snapshots arquivados (#9232) ───────────
//
// O evento do guard de 14/09/2026 (`2026-09-14T19:36:52Z`), citado
// literalmente no #8148, sumiu de TODOS os `data/run-log*.jsonl` (inclusive
// das cópias de conflito do OneDrive) — o append do `log-event.ts` acontece
// na máquina/checkout que rodou o `update-audience.ts` (cwd do processo,
// possivelmente um worktree descartado ou outra máquina cujo trecho perdeu
// pro sync), então o run-log NÃO é fonte confiável pra este alarme: lendo só
// ele, o alarme reportou `alarm=0` com o evento perdido e ficou cego sem
// avisar. Os snapshots em `docs/audience-history/` são versionados e são
// exatamente o que o guard compara. Não são infalíveis: só chegam ao `300`
// quando alguém os commita (lotes manuais, dias ou semanas depois — ver
// #9240), e um run num worktree descartado perde os snapshots tanto quanto o
// log. Ainda assim são uma fonte independente do run-log — dois snapshots ADJACENTES byte-a-byte idênticos são
// a própria condição do #4366, recomputável a qualquer momento sem depender
// de nenhum log ter sobrevivido.

/** Nome de snapshot arquivado (`YYYY-MM-DD.md`) — mesmo padrão de `HISTORY_FILE_RE` em `update-audience.ts`. */
export const SNAPSHOT_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Piso da varredura por snapshots: só pares cujo arquivo MAIS NOVO é
 * `>= 2026-09-15.md` viram finding. As duplicatas anteriores no histórico
 * (07-19, 07-21, 07-23, 07-30 e 09-14) já foram investigadas em bloco no
 * #8148 (fechado) — sem o piso, a 1ª execução pós-#9232 abriria 5 issues
 * retroativas sobre fatos já tratados. Também vale para as cópias de
 * conflito `run-log-*.jsonl` (fonte nova do #9232, mesma razão). O piso NÃO
 * se aplica ao run-log canônico (comportamento do #8166 preservado).
 */
export const SNAPSHOT_SCAN_SINCE = "2026-09-15.md";

export interface SnapshotFile {
  name: string;
  content: string;
}

/**
 * Pure: varre os snapshots arquivados (ordem lexicográfica = cronológica,
 * nome `YYYY-MM-DD.md`) e devolve 1 entrada sintética por par ADJACENTE
 * byte-a-byte idêntico — no mesmo formato das entradas do run-log
 * (`agent=update-audience`, `details.issue=#4366`), pra que
 * `toAlarmFinding` gere o MESMO fingerprint (`snapshot-{today_file}`) e o
 * dedup de `alarm-issues.ts` trate as duas fontes como uma só ocorrência.
 * Arquivos fora do padrão (`_consolidated.md`) são ignorados.
 */
/** Pure: data `YYYY-MM-DD` da linha `**updated_at:**` embutida no profile, ou `null`. */
export function embeddedUpdatedAt(content: string): string | null {
  const m = /\*\*updated_at:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(content);
  return m ? m[1] : null;
}

export function findDuplicateSnapshotEntries(
  files: SnapshotFile[],
  since: string = SNAPSHOT_SCAN_SINCE,
): AudienceStalenessLogEntry[] {
  const sorted = files
    .filter((f) => SNAPSHOT_FILE_RE.test(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: AudienceStalenessLogEntry[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.name < since) continue;
    if (cur.content !== prev.content) continue;
    // Rerun no mesmo dia (falso positivo, achado do review do #9232): o 2º run
    // de D arquiva o profile que o 1º run de D acabou de escrever, então
    // `prev` (D.md) já carrega `updated_at: D`; se os inputs não mudaram, o
    // run seguinte arquiva conteúdo idêntico. Falha real de regeneração tem
    // `updated_at` ANTERIOR à data de `prev` (ex.: 09-12/09-14 = 09-10).
    if (embeddedUpdatedAt(cur.content) === prev.name.slice(0, 10)) continue;
    out.push({
      timestamp: `${cur.name.slice(0, 10)}T00:00:00.000Z`,
      agent: "update-audience",
      level: "warn",
      message: `snapshot ${cur.name} idêntico ao anterior ${prev.name} (detectado por comparação de docs/audience-history/, #9232)`,
      details: { today_file: cur.name, latest_file: prev.name, issue: DUPLICATE_ARCHIVE_ISSUE_TAG, source: "snapshot" },
    });
  }
  return out;
}

/** Pure: arquivos de run-log a ler em `data/` — o canônico + as cópias de conflito do OneDrive (`run-log-{Máquina}[-N].jsonl`, `run-log-predator-safeBackup-NNNN.jsonl`), onde um evento perdido no canônico pode ter sobrevivido (#9232). */
export function selectRunLogFiles(dataDirEntries: string[], canonicalName = "run-log.jsonl"): string[] {
  const stem = canonicalName.replace(/\.jsonl$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const copyRe = new RegExp(`^${stem}-.+\\.jsonl$`);
  return dataDirEntries
    .filter((f) => f === canonicalName || copyRe.test(f))
    .sort((a, b) => (a === canonicalName ? -1 : b === canonicalName ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

/** Pure: une entradas de várias fontes (run-log canônico, cópias de conflito, snapshots) deduplicando por `today_file` — a 1ª ocorrência vence (passar o run-log ANTES dos snapshots preserva o timestamp real do disparo quando o log sobreviveu). */
export function mergeStalenessEntries(...sources: AudienceStalenessLogEntry[][]): AudienceStalenessLogEntry[] {
  const seen = new Set<string>();
  const out: AudienceStalenessLogEntry[] = [];
  for (const entry of sources.flat()) {
    const key = occurrenceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Pure: aplica o piso `SNAPSHOT_SCAN_SINCE` a entradas de fontes novas (cópias de conflito do run-log) — ver docstring do piso. */
export function applySinceFloor(
  entries: AudienceStalenessLogEntry[],
  since: string = SNAPSHOT_SCAN_SINCE,
): AudienceStalenessLogEntry[] {
  return entries.filter((e) => occurrenceKey(e) >= since);
}

/**
 * #9240 — idade máxima (em dias) do snapshot mais recente de
 * `docs/audience-history/` antes de virar alarme. `update-audience.ts` roda a
 * cada edição (Stage 0) e arquiva 1 snapshot por run, mas os arquivos só
 * entram no repositório por commit MANUAL (lotes #8146, #8321, #8597 —
 * intervalo observado entre lotes de 1 a 5 dias). 14 dias é conservador:
 * ~3x o maior intervalo normal, então só dispara quando a fonte de snapshots
 * do #9232 está de fato cega (caso medido em 01/10/2026: último snapshot
 * 2026-09-20, enquanto o profile já estava em `updated_at: 2026-09-27`).
 */
export const SNAPSHOT_MAX_AGE_DAYS = 14;

/** Fingerprint estável (1 issue por condição, não por dia). */
export const SNAPSHOT_AGE_FINGERPRINT = "audience-history:snapshot-age";

/**
 * Pure (#9240): finding `family: "estado"` quando o snapshot mais recente
 * (`YYYY-MM-DD.md`) tem MAIS de `maxAgeDays` dias em relação a `now` (dia UTC),
 * ou quando não há snapshot nenhum. `"estado"` (não `"evento"`) porque a
 * condição se resolve sozinha: quando snapshots novos chegam ao repo, a issue
 * fecha via `planAlarmReconciliation`. Devolve `null` se está em dia.
 */
export function findSnapshotAgeFinding(
  snapshotNames: string[],
  now: Date,
  maxAgeDays: number = SNAPSHOT_MAX_AGE_DAYS,
): AlarmFinding | null {
  const latest = snapshotNames.filter((n) => SNAPSHOT_FILE_RE.test(n)).sort().at(-1) ?? null;
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays =
    latest === null ? null : Math.floor((todayMs - Date.parse(`${latest.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  if (ageDays !== null && ageDays <= maxAgeDays) return null;
  const desc =
    latest === null
      ? "nenhum snapshot `YYYY-MM-DD.md` encontrado"
      : `snapshot mais recente é \`${latest}\` (${ageDays} dias atrás)`;
  return {
    check: "snapshot-age",
    fingerprint: SNAPSHOT_AGE_FINGERPRINT,
    title: `audience-history: nenhum snapshot novo há mais de ${maxAgeDays} dias`,
    body: [
      `\`docs/audience-history/\`: ${desc}; limite ${maxAgeDays} dias (#9240).`,
      "",
      "Sem snapshots recentes, a comparação de pares adjacentes do #9232 fica cega. " +
        "Verificar se `scripts/update-audience.ts` está rodando no Stage 0 e se os snapshots " +
        "gravados foram commitados (o commit é manual — o #9240 decidiu não automatizá-lo).",
    ].join("\n"),
    family: "estado",
    labels: ["bug"],
    priority: "P3",
  };
}
