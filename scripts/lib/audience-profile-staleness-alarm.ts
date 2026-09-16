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

/** Pure: converte 1 ocorrência do guard num `AlarmFinding` — 1 issue GitHub por `today_file` distinto (nunca agrega 2 ocorrências na mesma issue: cada dia é um fato independente que o editor precisa poder investigar/descartar em separado). */
export function toAlarmFinding(entry: AudienceStalenessLogEntry): AlarmFinding {
  const todayFile = entry.details?.today_file ?? entry.timestamp.slice(0, 10);
  const latestFile = entry.details?.latest_file ?? "desconhecido";
  return {
    check: "audience-profile-staleness",
    fingerprint: `snapshot-${todayFile}`,
    family: "evento",
    title: `[diar.ia.br] Profile de audiência regenerou idêntico ao anterior (${todayFile})`,
    body: [
      "Achado automático do alarme `Diaria-Audience-Profile-Staleness-Alarm`",
      "(`scripts/audience-profile-staleness-alarm.ts`).",
      "",
      `O guard do #4366 (\`detectDuplicateArchiveWarning\`, \`scripts/update-audience.ts\`) detectou que o snapshot prestes a ser arquivado como \`${todayFile}\` era byte-a-byte idêntico ao arquivo de histórico mais recente já existente (\`${latestFile}\`).`,
      "",
      `Timestamp do disparo: ${entry.timestamp}.`,
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
