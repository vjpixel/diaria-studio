/**
 * pr-merge-state.ts (#10928)
 *
 * Diagnóstico PURO do que o GitHub ainda bloqueia num PR cujos checks já
 * passaram na condição 1 do gate (`evaluatePrChecksGate` → `"pass"`).
 *
 * Achado ao vivo na rodada overnight 261022b: `check-pr-checks-gate.ts`
 * devolvia `verdict=pass` em PRs com `mergeStateStatus: BLOCKED` — por review
 * threads não resolvidas (`required_review_thread_resolution` do ruleset) e,
 * numa PR, por uma entrada `markdown-guards` presa como pendente no
 * `statusCheckRollup` com o run do mesmo check já concluído com sucesso. O
 * gate só lia os checks; o bloqueio só aparecia no `gh pr merge`.
 *
 * Este módulo NÃO muda o veredito da condição 1 (os consumidores leem os exit
 * codes — `wait-pr-checks.sh`, `continuo-resolve-stuck-prs.ts`, o pickup do
 * continuo — e threads são a condição 2 do gate, resolvida pelo coordenador
 * DEPOIS de esperar o CI). Ele produz a linha de diagnóstico que o CLI
 * imprime quando o PR está bloqueado por outra coisa que não os checks, pra
 * o coordenador saber ANTES do merge o que falta.
 */

import { keepLatestPerName, type PrCheckNode } from "./pr-checks-gate.ts";

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function isPassingCompleted(node: PrCheckNode): boolean {
  if (typeof node.state === "string" && typeof node.status !== "string") return node.state === "SUCCESS";
  return node.status === "COMPLETED" && typeof node.conclusion === "string" && PASSING_CONCLUSIONS.has(node.conclusion);
}

function isNotConcluded(node: PrCheckNode): boolean {
  if (typeof node.status === "string") return node.status !== "COMPLETED";
  if (typeof node.state === "string") return node.state === "PENDING" || node.state === "EXPECTED";
  return false;
}

/**
 * Nomes de checks com uma entrada PRESA no rollup: a entrada não está
 * concluída (rodando/enfileirada/pendente), mas o gate a descartou porque o
 * run vigente do MESMO nome (`keepLatestPerName`) já concluiu com sucesso.
 * Para o gate isso é run supersedido; para o GitHub pode seguir valendo como
 * pendente e segurar o merge (`BLOCKED`). Pendente REAL (o vigente ainda
 * rodando) nunca entra aqui — esse já sai como `verdict=pending`.
 *
 * Payload malformado (não-array) → `[]`. Nunca lança.
 */
export function findStuckCheckEntries(statusCheckRollup: unknown): string[] {
  if (!Array.isArray(statusCheckRollup)) return [];
  const nodes = statusCheckRollup.filter((n): n is PrCheckNode => typeof n === "object" && n !== null);
  const vigentes = new Set(keepLatestPerName(nodes));
  const vigentePassando = new Set<string>();
  for (const n of vigentes) {
    if (typeof n.name === "string" && n.name.length > 0 && isPassingCompleted(n)) vigentePassando.add(n.name);
  }
  const out: string[] = [];
  for (const n of nodes) {
    if (vigentes.has(n)) continue;
    if (typeof n.name !== "string" || !vigentePassando.has(n.name)) continue;
    if (!isNotConcluded(n)) continue;
    if (!out.includes(n.name)) out.push(n.name);
  }
  return out;
}

export interface MergeStateDiagnosisInput {
  /** `gh pr view --json mergeStateStatus` (`CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, `HAS_HOOKS`, `UNKNOWN`). */
  mergeStateStatus: string | null | undefined;
  /** Threads de review não resolvidas; `null` = não foi possível ler (nunca vira 0). */
  unresolvedThreads: number | null;
  /** Saída de `findStuckCheckEntries`. */
  stuckChecks: readonly string[];
}

/**
 * Linha de diagnóstico (`[check-pr-checks-gate] merge-state: ...`) ou `null`
 * quando não há nada a dizer (estado não-bloqueado e sem entrada presa).
 * Só faz sentido com a condição 1 em `pass` — o CLI só chama nesse caso.
 */
export function formatMergeStateLine(input: MergeStateDiagnosisInput): string | null {
  const status = typeof input.mergeStateStatus === "string" && input.mergeStateStatus.length > 0 ? input.mergeStateStatus : null;
  const blocked = status === "BLOCKED";
  if (!blocked && input.stuckChecks.length === 0) return null;

  const causes: string[] = [];
  if (blocked) {
    if (input.unresolvedThreads === null) causes.push("threads de review: não lidas (gh api graphql falhou — não é 0)");
    else if (input.unresolvedThreads > 0) causes.push(`${input.unresolvedThreads} thread(s) de review não resolvida(s)`);
  }
  if (input.stuckChecks.length > 0) {
    causes.push(
      `entrada de check presa como pendente com o run do mesmo nome já concluído com sucesso: ${input.stuckChecks.join(", ")} ` +
        "(re-rodar esse check ou o workflow dele limpa a entrada)",
    );
  }
  if (blocked && causes.length === 0) causes.push("causa não identificada pelos checks nem pelas threads (conferir o ruleset no GitHub)");

  const head = blocked
    ? "mergeStateStatus=BLOCKED — os checks passaram, mas o GitHub ainda recusa o merge"
    : `mergeStateStatus=${status ?? "desconhecido"}`;
  return `[check-pr-checks-gate] merge-state: ${head}; ${causes.join("; ")}`;
}
