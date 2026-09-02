/**
 * scripts/lib/alarm-retirement-candidates.ts (#6798)
 *
 * Lógica PURA do mecanismo de auto-aposentadoria de alarme pedido pela
 * auditoria do #6798: "alarme que dispara sem gerar ação em N execuções
 * vira candidato a aposentadoria" — MECANISMO que IDENTIFICA candidatos,
 * nunca aposenta nada sozinho (decisão do editor, 01/09/2026 — "implemente
 * o mecanismo... ele não deve aposentar nada sozinho — só reportar").
 *
 * ─── O que já existe no repo, e por que este módulo não inventa nada novo ──
 *
 * A auditoria original (#6798, corpo da issue) identificou o pré-requisito:
 * "distinguir mecanicamente 'issue de alarme corrigida' de 'issue de alarme
 * descartada' — label dedicada no fechamento, ou `stateReason: not_planned`
 * no auto-close e na varredura de limpeza. Sem isso a regra não é
 * computável." A PR #7019 fechou esse pré-requisito: `closeAlarmIssue`
 * (`scripts/lib/alarm-issues.ts`) passou a fechar com `gh issue close
 * --reason "not planned"`, produzindo `stateReason: "NOT_PLANNED"` no
 * GitHub — em vez do `"COMPLETED"` que TODA issue fechada carregava antes
 * (inclusive as descartadas), tornando as duas classes indistinguíveis sem
 * cruzar com PRs mergeados à mão (o que a auditoria original precisou
 * fazer pra medir "12% de retorno").
 *
 * ─── Critério escolhido para "disparou sem gerar ação" ─────────────────────
 *
 * Uma issue de alarme (label `alarm`, ver `ALARM_LABEL`) fechada com
 * `stateReason === "NOT_PLANNED"`. Duas rotas produzem esse estado:
 *
 *   1. Auto-close MECÂNICO deste próprio módulo (`closeAlarmIssue` — achado
 *      parou de reproduzir por N execuções consecutivas do alarme, sem
 *      nenhum PR envolvido).
 *   2. Fechamento MANUAL do editor com `gh issue close --reason "not
 *      planned"` (varredura de limpeza, achado descartado como não
 *      acionável) — a MESMA convenção, só que humana em vez de mecânica.
 *
 * Uma issue fechada de verdade por `Closes #NNNN` num PR mergeado continua
 * `stateReason: "COMPLETED"` (não passa por `closeAlarmIssue`, e a
 * convenção de commit do repo — CLAUDE.md #9/#5010 — exige `Closes` por
 * issue totalmente resolvida) — então `"COMPLETED"` é o proxy de "gerou
 * ação real", e este módulo NUNCA conta uma issue `COMPLETED` como "sem
 * ação".
 *
 * ─── Limitação assumida, documentada em vez de escondida ───────────────────
 *
 * Este critério é um PROXY, não uma medição direta de "o editor não fez
 * nada". Dois furos conhecidos, ambos na direção de SUBESTIMAR o problema
 * (nunca de inflar um alarme saudável em candidato):
 *
 *   - Um fechamento manual DESCUIDADO (o editor fecha como "Completed" via
 *     UI/CLI sem passar `--reason`, mesmo sem ter corrigido nada) conta como
 *     "ação" aqui, quando na prática não houve nenhuma. Sem uma 2ª fonte
 *     (PR que referencia a issue, como a auditoria original cruzou à mão),
 *     não há como distinguir isso de uma correção real só a partir do
 *     `stateReason` — aceito porque é exatamente o gap que a auditoria
 *     identificou como não-computável sem o pré-requisito do #7019, e o
 *     pré-requisito resolve o caso mecânico (majoritário: auto-close é
 *     `closeAlarmIssue` sempre, fechamento manual de limpeza costuma seguir
 *     a mesma convenção desde que ela existe).
 *   - Issue `DUPLICATE` (consolidada em outra) não conta como "sem ação"
 *     nem como "ação" — fica de fora da contagem. Duplicata não é
 *     "descartada sem olhar" nem "corrigida"; é sinal de dedup falho
 *     (mesmo modo de falha do `[watch-continuo] PRs sem prefixo`, item 4 do
 *     plano de corte original), não de alarme sem retorno. Contá-la junto
 *     de `NOT_PLANNED` misturaria dois problemas diferentes.
 *
 * Um proxy honesto e documentado > uma métrica nova (telemetria extra por
 * alarme, contador dedicado) que a issue explicitamente pediu para NÃO
 * inventar.
 */

/** N execuções fechadas como "sem ação" (ver critério acima) a partir das
 * quais um `check` vira candidato a aposentadoria — decisão do editor
 * (01/09/2026, #6798: "Regra de auto-aposentadoria com N=3"). Ajustável
 * nesta linha; nenhum outro lugar do código precisa mudar. */
export const ALARM_RETIREMENT_THRESHOLD = 3;

/** GitHub `stateReason` que marca "fechada sem ação" pela convenção deste
 * repo (ver docstring do módulo). */
const NO_ACTION_STATE_REASON = "NOT_PLANNED";

/** Formato mínimo consumido por este módulo — subconjunto do que `gh issue
 * list --json number,title,body,stateReason,closedAt --label alarm --state
 * closed` devolve. `stateReason`/`closedAt` chegam `null` quando o GitHub
 * não os preenche (issue reaberta e refechada sem reason, ou API antiga) —
 * tratados como "não é NOT_PLANNED"/"data desconhecida", nunca fabricados. */
export interface ClosedAlarmIssueRecord {
  number: number;
  title: string;
  body: string;
  stateReason: string | null;
  closedAt: string | null;
}

export interface AlarmRetirementEvidence {
  issueNumber: number;
  title: string;
  closedAt: string | null;
}

export interface AlarmRetirementCandidate {
  /** O `check` extraído do marcador de dedup (`AlarmFinding.check`, ver
   * `scripts/lib/alarm-issues.ts`) — identifica QUAL alarme, não qual
   * achado individual. */
  check: string;
  /** Quantas issues deste `check` fecharam como "sem ação" (ver critério no
   * docstring do módulo). Sempre `>= threshold` — candidatos abaixo do
   * limiar não aparecem no resultado. */
  noActionCount: number;
  /** Uma entrada por issue que contou para `noActionCount`, ordenada por
   * `closedAt` crescente (mais antiga primeiro) — dá ao editor o histórico
   * pra decidir, não só o número. */
  evidence: AlarmRetirementEvidence[];
}

/** Pura — extrai o `check` do marcador `<!-- alarm-finding: {check}:{fingerprint} -->`
 * embutido no corpo pela `ensureAlarmIssue` (ver `alarmFindingMarker` em
 * `scripts/lib/alarm-issues.ts`). `null` se o corpo não carrega o marcador
 * (issue de alarme criada antes do #5112, ou corpo editado manualmente
 * removendo o marcador) — o caller pula issues sem `check` identificável em
 * vez de contá-las num grupo "desconhecido" que ninguém consegue agir
 * sobre. */
export function extractAlarmCheck(body: string): string | null {
  const match = body.match(/<!--\s*alarm-finding:\s*([^:]+):/);
  return match ? match[1] : null;
}

/**
 * Pura — agrupa `closedIssues` por `check` (via `extractAlarmCheck`),
 * filtra pelo critério "sem ação" (`stateReason === "NOT_PLANNED"`, ver
 * docstring do módulo) e devolve os `check`s cuja contagem atinge
 * `threshold` (default `ALARM_RETIREMENT_THRESHOLD`). Ordenado por
 * `noActionCount` decrescente (o mais barulhento-sem-retorno primeiro);
 * empate desempata por nome do `check` (determinístico, sem depender da
 * ordem de chegada de `closedIssues`).
 *
 * Nunca aposenta nada — só relata. A decisão de cortar um alarme continua
 * do editor (mesmo veredito de #6798: "ele não deve aposentar nada
 * sozinho").
 */
export function findAlarmRetirementCandidates(
  closedIssues: readonly ClosedAlarmIssueRecord[],
  threshold: number = ALARM_RETIREMENT_THRESHOLD,
): AlarmRetirementCandidate[] {
  const byCheck = new Map<string, ClosedAlarmIssueRecord[]>();
  for (const issue of closedIssues) {
    if (issue.stateReason !== NO_ACTION_STATE_REASON) continue;
    const check = extractAlarmCheck(issue.body);
    if (!check) continue;
    const list = byCheck.get(check) ?? [];
    list.push(issue);
    byCheck.set(check, list);
  }

  const candidates: AlarmRetirementCandidate[] = [];
  for (const [check, issues] of byCheck) {
    if (issues.length < threshold) continue;
    const evidence = [...issues]
      .sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""))
      .map((i) => ({ issueNumber: i.number, title: i.title, closedAt: i.closedAt }));
    candidates.push({ check, noActionCount: issues.length, evidence });
  }

  return candidates.sort((a, b) => b.noActionCount - a.noActionCount || a.check.localeCompare(b.check));
}
