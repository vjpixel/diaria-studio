/**
 * overnight-comment-coverage.ts (#5816)
 *
 * Lógica PURA/testável para o gate mecânico de "toda issue trabalhada-mas-
 * não-fechada (PR com `REFS #N, NÃO CLOSES`) ou pulada mid-round recebe um
 * comentário overnight-visível na issue" — mesma classe de guard de
 * `scripts/lib/state-changed-tracker.ts` (re-triagem pendente) e
 * `scripts/check-overnight-token-instrumentation.ts` (instrumentação de
 * token), aplicada a um 3º achado da mesma rodada 260819c/e: duas regras já
 * documentadas em prosa (SKILL.md — "toda issue trabalhada ou bloqueada
 * recebe comentário"; #5777 — "toda classificação pulada comenta na issue
 * com o motivo") não foram seguidas mesmo estando escritas, porque nada
 * verificava mecanicamente.
 *
 * O I/O (ler `plan.json`, chamar `gh pr view`/`gh issue view`) fica no
 * entrypoint CLI (`scripts/check-overnight-comment-coverage.ts`) — este
 * módulo só decide, a partir de dados já buscados, quais issues são
 * candidatas à checagem e se a cobertura de comentário está satisfeita.
 *
 * ## Os dois cenários cobertos
 *
 * 1. **`status: "pulada"`** — issue pulada mid-round (bloqueio externo,
 *    ambígua, `claimed-por-outra-sessao`, etc.) precisa de comentário
 *    explicando o motivo (regra do #5777). Candidata direto, sem I/O extra —
 *    o `status` já vem do `plan.json`.
 *
 * 2. **`status: "mergeada"` com PR usando `REFS #N, NÃO CLOSES`** — issue
 *    trabalhada mas não fechada pelo merge (instrumentação aplicada, causa
 *    raiz não confirmada, etc. — regra #5010/item 9 de
 *    `context/overnight-dispatch-rules.md`, "PR mergeado com REFS" ≠ "issue
 *    fechada"). Candidata só depois de buscar o body do PR (`gh pr view
 *    {pr} --json body`) e confirmar o padrão `REFS #{N} ... NÃO CLOSES` —
 *    `Closes #N` normal NUNCA entra aqui (regra "issues resolvidas
 *    dispensam comentário extra" do SKILL.md).
 *
 * Para cada candidata, o critério de "tem comentário overnight" é: **existe
 * pelo menos 1 comentário na issue cujo corpo contém a palavra "overnight"
 * (case-insensitive)** — sem filtro de timestamp/autor. Escolha deliberada
 * (documentada aqui, não só no código): tanto `check-state-changed-pending`
 * quanto o histórico do #5777 tratam "existe comentário overnight" como
 * sinal suficiente sem exigir correlação fina com `started_at`/autor — o
 * volume de comentários por issue neste repo é baixo o bastante (issues são
 * de projeto interno, não um tracker público de alto tráfego) para que
 * falso-positivo por comentário overnight de RODADA ANTERIOR seja um risco
 * aceitável frente à complexidade de filtrar por timestamp/sessão, e o
 * critério mais simples é também o mais robusto a variação de formato entre
 * skills (overnight/develop/continuo podem não compartilhar o mesmo
 * `started_at` no ponto em que este script roda).
 */

export type CoverageCandidateReason = "pulada-sem-comentario" | "refs-not-closes-sem-comentario";

/** Shape mínimo de uma entrada de `plan.json.issues` relevante aqui — já
 * normalizada via `normalizeIssues` (`./plan-issues-normalize.ts`) pelo
 * chamador, agnóstica de o `plan.json` de origem guardar array (overnight)
 * ou dict chaveado por número (develop). */
export interface PlanIssueLike {
  number: number;
  status?: string;
  pr?: number;
  [key: string]: unknown;
}

export interface CandidateIssue {
  number: number;
  reason: CoverageCandidateReason;
  /** Presente só quando `reason === "refs-not-closes-sem-comentario"`. */
  pr?: number;
}

/**
 * Pure: detecta se o body de um PR usa a convenção `REFS #{issueNumber} ...
 * NÃO CLOSES` (regra #5010) em vez de `Closes #{issueNumber}` — tolera
 * variação de acentuação (NAO/NÃO), espaçamento, e texto livre entre o
 * número da issue e "NÃO CLOSES" (ex: "REFS #5791, NÃO CLOSES (causa raiz
 * não confirmada)"). `body` ausente/vazio → `false` (nunca lança).
 */
export function isRefsNotClosesBody(body: string | null | undefined, issueNumber: number): boolean {
  if (!body) return false;
  const re = new RegExp(`REFS\\s*#${issueNumber}\\b[\\s\\S]{0,120}?N[ÃA]O\\s*CLOSES`, "i");
  return re.test(body);
}

/**
 * Pure: entre as issues do plano já normalizadas, devolve as candidatas à
 * checagem de cobertura de comentário — ver os 2 cenários no docblock do
 * módulo. `prBodies` mapeia número de PR → body (ou `null` se o fetch
 * falhou/PR não encontrado — tratado como "não bate o padrão", nunca como
 * candidata forçada; um PR ilegível não deveria travar o gate por um motivo
 * que não é o que a issue #5816 pede pra cobrir).
 */
export function deriveCandidateIssues(
  issues: PlanIssueLike[],
  prBodies: Map<number, string | null>,
): CandidateIssue[] {
  const out: CandidateIssue[] = [];
  for (const issue of issues) {
    if (typeof issue.number !== "number" || !Number.isFinite(issue.number)) continue;
    if (issue.status === "pulada") {
      out.push({ number: issue.number, reason: "pulada-sem-comentario" });
      continue;
    }
    if (issue.status === "mergeada" && typeof issue.pr === "number") {
      const body = prBodies.get(issue.pr) ?? null;
      if (isRefsNotClosesBody(body, issue.number)) {
        out.push({ number: issue.number, reason: "refs-not-closes-sem-comentario", pr: issue.pr });
      }
    }
  }
  return out;
}

/** Shape mínimo de um comentário retornado por `gh issue view --json comments`. */
export interface IssueCommentLike {
  body?: string | null;
  [key: string]: unknown;
}

/**
 * Pure: `true` se ao menos 1 comentário contém "overnight" (case-
 * insensitive) — o sinal de "esta issue já recebeu o comentário mandatado
 * pelo SKILL.md/#5777". Ver docblock do módulo para o porquê de não filtrar
 * por timestamp/autor.
 */
export function hasOvernightComment(comments: IssueCommentLike[]): boolean {
  return comments.some((c) => typeof c.body === "string" && /overnight/i.test(c.body));
}

export type CoverageVerdictStatus = "ok" | "missing" | "not-evaluated";

export interface CoverageVerdict {
  status: CoverageVerdictStatus;
  /** Candidatas sem comentário de cobertura — vazio quando `status !== "missing"`. */
  missing: CandidateIssue[];
  /** Candidatas cujo fetch de comentários falhou — reportadas separadamente,
   * nunca somadas a `missing` (fail-soft por issue: não force falha do gate
   * por um problema de rede/gh pontual numa única issue). */
  unresolved: CandidateIssue[];
}

/**
 * Pure: veredito final a partir das candidatas já derivadas + o resultado
 * (por issue) da busca de comentários. `commentsByIssue` mapeia número da
 * issue → array de comentários (já buscado) OU `null` se o fetch falhou
 * para aquela issue especificamente (fail-soft — ver `unresolved` acima).
 *
 * `status: "not-evaluated"` só acontece quando não há candidatas (nada pra
 * checar) — distinto de `"ok"` só por semântica de mensagem no chamador; o
 * chamador decide se os dois merecem o mesmo texto de sucesso.
 */
export function checkCoverage(
  candidates: CandidateIssue[],
  commentsByIssue: Map<number, IssueCommentLike[] | null>,
): CoverageVerdict {
  if (candidates.length === 0) return { status: "not-evaluated", missing: [], unresolved: [] };

  const missing: CandidateIssue[] = [];
  const unresolved: CandidateIssue[] = [];
  for (const candidate of candidates) {
    const comments = commentsByIssue.get(candidate.number);
    if (comments === undefined || comments === null) {
      unresolved.push(candidate);
      continue;
    }
    if (!hasOvernightComment(comments)) {
      missing.push(candidate);
    }
  }

  if (missing.length > 0) {
    return { status: "missing", missing: missing.sort((a, b) => a.number - b.number), unresolved };
  }
  return { status: "ok", missing: [], unresolved };
}
