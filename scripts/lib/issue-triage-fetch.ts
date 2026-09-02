/**
 * scripts/lib/issue-triage-fetch.ts (#7018 item 2)
 *
 * Guard de varredura: encapsula o `gh issue list` da Fase 0 (overnight,
 * develop, continuo — três `SKILL.md` reproduziam essa string de campos à
 * mão) num único ponto, pra que a lista de `--json` correta seja mantida
 * uma vez, na fonte, em vez de reescrita/reconferida em cada skill toda vez
 * que um novo campo entra na classificação (foi exatamente a divergência —
 * varredura sem `body` — que causou o #7018: 4 issues `agendada` dispatchadas
 * como `overnight` porque a chamada real da rodada 260901b não incluía
 * `body` no `--json`, sem nenhum sinal de erro).
 *
 * Mesmo padrão fail-soft de `scripts/check-decision-label-drift.ts` /
 * `scripts/lib/state-changed-tracker.ts` (`fetchOpenIssuesForConvergence`):
 * nunca lança por falha de `gh`/rede — falha de transporte volta como
 * `{ issues: [], error }` pro caller decidir degradar (#738). A ÚNICA coisa
 * que este módulo trata como erro FATAL (mesmo com `gh` tendo respondido
 * 200 e JSON válido) é a AUSÊNCIA da chave `body` no primeiro item — sinal
 * de que o comando saiu sem `body` no `--json`, o próprio bug do #7018 —
 * porque campos vêm uniformes em todos os itens de uma chamada, checar o
 * 1º já garante a chamada inteira.
 *
 * Cada item validado passa por `classifyExecTrackFromListItem`
 * (`scripts/lib/issue-exec-track.ts`, também #7018) — fail-closed por item
 * como 2ª camada, redundante com a checagem acima de propósito (a checagem
 * acima é uma otimização "falha rápido, 1 vez"; a validação por item é a
 * garantia real, chamada pelo array vazio caso a lista de issues seja `[]`
 * e a checagem acima nunca rode).
 *
 * @see scripts/lib/issue-exec-track.ts (classifyExecTrackFromListItem)
 * @see scripts/lib/state-changed-tracker.ts (fetchOpenIssuesForConvergence — mesmo padrão, escopo de campos menor)
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 3
 * @see .claude/skills/diaria-develop/SKILL.md § Fase 0 passo 3
 * @see .claude/skills/diaria-continuo/SKILL.md
 */

import { spawnSync } from "node:child_process";
import {
  classifyExecTrackFromListItem,
  normalizeGhIssueListLabels,
  type GhIssueListRawItem,
  type ExecTrack,
} from "./issue-exec-track.ts";

/** Issue já normalizada + classificada — pronta pro coordenador consumir
 * sem precisar rechamar `classifyExecTrack` por conta própria. */
export interface TriageIssue {
  number: number;
  title: string;
  labels: string[];
  body: string | null;
  url: string;
  updatedAt: string | null;
  state: string | null;
  execTrack: ExecTrack;
}

export interface FetchOpenIssuesForTriageResult {
  issues: TriageIssue[];
  error?: string;
}

/** Campos exigidos pela classificação completa da Fase 0 — `body` é o campo
 * cuja ausência este módulo existe pra prevenir; os demais (title, url,
 * updatedAt) são consumidos pelo passo 4 do overnight/develop (comparação
 * com `decided_at`, exibição no plano). */
const TRIAGE_JSON_FIELDS = "number,title,labels,body,url,updatedAt,state";

const TRIAGE_ISSUE_LIMIT = 200;

/**
 * Busca as issues abertas (até `TRIAGE_ISSUE_LIMIT`) via `gh issue list`
 * com o conjunto de campos completo da varredura de classificação da Fase
 * 0, já normalizadas e classificadas via `classifyExecTrackFromListItem`.
 * Nunca lança por falha de `gh`/rede (fail-soft, #738); lança apenas se
 * `gh` responder sem a chave `body` no `--json` — nesse caso o bug é NOSSO
 * (comando errado), não uma falha de transporte, então fail-soft
 * mascararia exatamente a classe de erro que este módulo existe pra pegar.
 */
export function fetchOpenIssuesForTriage(cwd: string, now?: Date): FetchOpenIssuesForTriageResult {
  const result = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--limit", String(TRIAGE_ISSUE_LIMIT), "--json", TRIAGE_JSON_FIELDS],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { issues: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      issues: [],
      error: `gh issue list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (!result.stdout) {
    return { issues: [], error: "gh issue list retornou stdout vazio" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { issues: [], error: `JSON malformado de gh issue list: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { issues: [], error: "gh issue list retornou payload que não é um array" };
  }
  const raw = parsed as GhIssueListRawItem[];
  // Mesmo achado do #5713/fila-convergence-gate: `--limit N` bate exatamente
  // em N sem sinalizar truncamento — tratado como fetch incompleto, nunca
  // como sucesso parcial silencioso.
  if (raw.length === TRIAGE_ISSUE_LIMIT) {
    return {
      issues: [],
      error: `gh issue list retornou exatamente ${TRIAGE_ISSUE_LIMIT} issues (o limite) — resultado pode estar truncado; tratando como fetch incompleto`,
    };
  }
  const issues: TriageIssue[] = raw.map((item) => ({
    number: typeof item.number === "number" ? item.number : Number(item.number),
    title: typeof item.title === "string" ? item.title : "",
    labels: normalizeGhIssueListLabels(item.labels),
    body: (item.body ?? null) as string | null,
    url: typeof item.url === "string" ? item.url : "",
    updatedAt: (item.updatedAt ?? null) as string | null,
    state: (item.state ?? null) as string | null,
    // Lança (fail-closed, #7018) se `body` estiver ausente — não capturado
    // aqui de propósito, propaga pro caller do fetch inteiro.
    execTrack: classifyExecTrackFromListItem(item, { now }),
  }));
  return { issues };
}
