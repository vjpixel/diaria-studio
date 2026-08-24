/**
 * pr-terminal-state.ts (#5831)
 *
 * Gate mecânico para o achado ao vivo da rodada `/diaria-develop` 260820:
 * nem `/diaria-develop` nem `/diaria-overnight` confirmam, antes de escrever
 * o relatório final (Fase 2), que TODO PR aberto por branches desta sessão
 * chegou a um estado terminal (mergeado ou fechado sem merge). O fluxo
 * dependia inteiramente do coordenador "lembrar" de voltar e checar cada PR
 * dispatchado — se ele fosse interrompido por pivot de escopo ou
 * compactação de contexto no meio do fluxo review→merge, o PR ficava órfão,
 * sem sinal de erro, sem timeout (achado: PR #5823, issue #5815, ~4h aberto,
 * CI verde, 0 reviews, nunca mergeado, sem ninguém notar).
 *
 * O I/O (ler `plan.json`, chamar `gh pr list`) fica no entrypoint CLI
 * (`scripts/check-pr-terminal-state.ts`) — este módulo só decide, a partir
 * de dados já buscados, se há divergência. Mesmo padrão de
 * `scripts/lib/overnight-comment-coverage.ts`/`scripts/lib/state-changed-tracker.ts`.
 *
 * ## Os dois cenários cobertos
 *
 * 1. **PR registrado em `plan.json` (campo `pr` de alguma issue) que segue
 *    aberto no GitHub sem status terminal-de-PR correspondente.** Uma issue
 *    pode estar `pendente`/`elegivel`/`pulada` — estados válidos DURANTE a
 *    sessão — mas na Fase 2 (fechamento da rodada) todo PR que a sessão
 *    abriu já deveria ter sido mergeado ou fechado sem merge. `mergeada` e
 *    `draft-ci-vermelho` (handoff intencional — PR fica aberto de propósito
 *    pro overnight seguinte pegar, ver `.claude/skills/diaria-develop/SKILL.md`
 *    § "'Nenhuma issue aberta' = estado terminal") são os dois status que já
 *    existem no schema e dizem "o coordenador sabe o que aconteceu com este
 *    PR". Nenhum dos dois presentes, e o PR segue aberto no GitHub →
 *    divergência: `registered-not-terminal`.
 *
 * 2. **PR aberto por branch com prefixo `develop/`/`overnight/`/`fix/`
 *    que não está sequer registrado no `plan.json`** (o caso real do
 *    #5823/#5815: a issue #5815 nunca recebeu o número do PR de volta,
 *    porque a sessão foi interrompida por compactação antes de fechar o
 *    loop). Não dá pra confirmar autoria com certeza só pelo nome do branch
 *    (outra sessão pode usar o mesmo prefixo em paralelo, #5156) — por isso
 *    isto NUNCA vira "divergência confirmada" igual ao cenário 1, e sim
 *    `unregistered-branch-candidate`: candidato pra revisão humana, listado
 *    separadamente no relatório em vez de bloqueado com a mesma certeza.
 */

/** Shape mínimo de uma entrada de `gh pr list --json headRefName,number,createdAt`. */
export interface OpenPrLike {
  number: number;
  headRefName?: string | null;
  createdAt?: string | null;
}

/** Shape mínimo de uma entrada de `plan.json.issues` relevante aqui — já
 * normalizada via `normalizeIssues` (`./plan-issues-normalize.ts`) pelo
 * chamador, agnóstica de array (overnight) vs dict (develop). */
export interface PlanIssueWithPrLike {
  number: number;
  status?: string;
  pr?: number;
  [key: string]: unknown;
}

/** Status de issue que atestam "o coordenador sabe o que aconteceu com o PR
 * desta issue" — o PR pode legitimamente seguir aberto no GitHub com
 * qualquer um destes (`draft-ci-vermelho`) ou já ter sido fechado
 * (`mergeada`, `fechada-sem-merge` — este último ainda não usado em
 * nenhuma skill hoje, mas é o literal citado na issue #5831 como o par de
 * `mergeada`; incluído aqui pra o schema já aceitar o dia em que alguma
 * skill passar a gravá-lo). */
export const PR_ACCOUNTED_STATUSES: ReadonlySet<string> = new Set([
  "mergeada",
  "draft-ci-vermelho",
  "fechada-sem-merge",
]);

/** Prefixos de branch usados pelas skills desta linha (overnight/develop)
 * mais o `fix/` legado citado explicitamente na issue #5831. */
export const SESSION_BRANCH_PREFIXES: readonly string[] = ["develop/", "overnight/", "fix/"];

type PrTerminalDivergenceKind = "registered-not-terminal" | "unregistered-branch-candidate";

export interface RegisteredNotTerminalDivergence {
  kind: "registered-not-terminal";
  pr: number;
  /** Todas as issues do plano que apontam pra este PR (lote = >1). */
  issueNumbers: number[];
  /** Status já registrado para essas issues, na mesma ordem — `undefined`
   * quando a issue não tem `status`. Útil pro relatório mostrar "estava em
   * X, não Y". */
  statuses: Array<string | undefined>;
}

export interface UnregisteredBranchCandidate {
  kind: "unregistered-branch-candidate";
  pr: number;
  headRefName: string;
}

type PrTerminalDivergence = RegisteredNotTerminalDivergence | UnregisteredBranchCandidate;

export interface PrTerminalStateVerdict {
  status: "ok" | "divergent";
  registeredNotTerminal: RegisteredNotTerminalDivergence[];
  unregisteredCandidates: UnregisteredBranchCandidate[];
}

/**
 * Pure: entre os PRs abertos no GitHub, devolve os que aparecem em
 * `plan.json` (campo `pr` de ≥1 issue) mas SEM nenhuma issue associada
 * carregando um status de `PR_ACCOUNTED_STATUSES`. PR aberto que não
 * aparece em nenhuma issue do plano NÃO entra aqui — é candidato do
 * cenário 2 (`findUnregisteredBranchCandidates`), tratado separadamente.
 */
export function findRegisteredNotTerminal(
  openPrs: OpenPrLike[],
  planIssues: PlanIssueWithPrLike[],
): RegisteredNotTerminalDivergence[] {
  const openPrNumbers = new Set(
    openPrs.map((p) => p.number).filter((n): n is number => typeof n === "number" && Number.isFinite(n)),
  );

  const byPr = new Map<number, PlanIssueWithPrLike[]>();
  for (const issue of planIssues) {
    if (typeof issue.pr !== "number" || !Number.isFinite(issue.pr)) continue;
    const list = byPr.get(issue.pr) ?? [];
    list.push(issue);
    byPr.set(issue.pr, list);
  }

  const out: RegisteredNotTerminalDivergence[] = [];
  for (const [pr, issues] of byPr) {
    if (!openPrNumbers.has(pr)) continue; // PR já fechado/mergeado no GitHub — nada a checar aqui
    const accounted = issues.some((i) => typeof i.status === "string" && PR_ACCOUNTED_STATUSES.has(i.status));
    if (accounted) continue;
    out.push({
      kind: "registered-not-terminal",
      pr,
      issueNumbers: issues
        .map((i) => i.number)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .sort((a, b) => a - b),
      statuses: issues.map((i) => i.status),
    });
  }
  return out.sort((a, b) => a.pr - b.pr);
}

/**
 * Pure: entre os PRs abertos no GitHub cujo branch bate com um dos
 * `SESSION_BRANCH_PREFIXES`, devolve os que NÃO aparecem registrados em
 * nenhuma issue do plano (campo `pr`). São candidatos — não divergência
 * confirmada, ver docblock do módulo — porque o nome do branch sozinho não
 * confirma autoria desta sessão (#5156, múltiplas sessões coexistem).
 */
export function findUnregisteredBranchCandidates(
  openPrs: OpenPrLike[],
  planIssues: PlanIssueWithPrLike[],
  branchPrefixes: readonly string[] = SESSION_BRANCH_PREFIXES,
): UnregisteredBranchCandidate[] {
  const registeredPrNumbers = new Set(
    planIssues
      .map((i) => i.pr)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n)),
  );

  const out: UnregisteredBranchCandidate[] = [];
  for (const pr of openPrs) {
    if (typeof pr.number !== "number" || !Number.isFinite(pr.number)) continue;
    if (registeredPrNumbers.has(pr.number)) continue;
    const ref = pr.headRefName ?? "";
    if (!branchPrefixes.some((prefix) => ref.startsWith(prefix))) continue;
    out.push({ kind: "unregistered-branch-candidate", pr: pr.number, headRefName: ref });
  }
  return out.sort((a, b) => a.pr - b.pr);
}

/**
 * Pure: veredito combinado — roda os dois checadores acima e agrega.
 * `status: "divergent"` se qualquer um dos dois arrays tiver ≥1 item.
 */
export function checkPrTerminalState(
  openPrs: OpenPrLike[],
  planIssues: PlanIssueWithPrLike[],
  branchPrefixes: readonly string[] = SESSION_BRANCH_PREFIXES,
): PrTerminalStateVerdict {
  const registeredNotTerminal = findRegisteredNotTerminal(openPrs, planIssues);
  const unregisteredCandidates = findUnregisteredBranchCandidates(openPrs, planIssues, branchPrefixes);
  const status: PrTerminalStateVerdict["status"] =
    registeredNotTerminal.length > 0 || unregisteredCandidates.length > 0 ? "divergent" : "ok";
  return { status, registeredNotTerminal, unregisteredCandidates };
}
