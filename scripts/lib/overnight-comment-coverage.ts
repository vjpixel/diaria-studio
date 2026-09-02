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
 *    ambígua, etc.) precisa de comentário explicando o motivo (regra do
 *    #5777). Candidata direto, sem I/O extra — o `status` já vem do
 *    `plan.json`. **Excluídos de propósito** (`#5909` + #7065): os motivos
 *    `deixado-para-o-helios` e `claimed-por-outra-sessao` são Coordenação de
 *    sessão, não bloqueio — a skill `.claude/skills/diaria-develop/SKILL.md`
 *    diz explicitamente que ambos NÃO levam comentário ("corrida evitada, não
 *    bloqueio" / "ruído sem valor quando dezenas ficam nesse status na mesma
 *    sessão"), e o roteamento label-driven (`classifyExecTrack`) já recoloca
 *    cada uma no track certo. Exigir comentário aqui produzia falso
 *    positivo sistemático em toda sessão develop sob `exhaust_all` (7 issues
 *    acusadas numa rodada real por outro sessão estar trabalhando cada uma).
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
 *
 * ## Cobertura de LABEL (#5844)
 *
 * O gate original (acima) só verifica se a issue `pulada` recebeu um
 * COMENTÁRIO explicando o motivo — nunca se a LABEL correspondente foi de
 * fato aplicada no GitHub. Achado ao vivo (21/08/2026): #5757/#5750/#5749/
 * #5748 foram classificadas `not-this-week` em comentário por 2 rodadas
 * overnight seguidas (260819c e 260820c), mas a label `not-this-week`
 * nunca foi aplicada em nenhuma — `classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`) só lê labels/marcador `aguardando-ate`
 * no corpo, nunca o texto do comentário, então a Triagem do Studio
 * continuava mostrando as 4 como elegíveis mesmo já decididas duas vezes.
 *
 * `requiredLabelForMotivo`/`MOTIVO_TO_LABEL` mapeiam o `motivo` textual
 * gravado em `plan.json` (vocabulário documentado em
 * `.claude/skills/diaria-overnight/SKILL.md` § Fase 0 passo 4) pra label
 * esperada no GitHub. Só motivos com label ÚNICA e inequívoca entram no
 * mapa — `requer-sessao-local` fica de fora de propósito: a issue #5844
 * documenta que esse motivo tem duas origens possíveis (label `windows` já
 * presente na issue, ou o próprio `exec-mode.ts` detectando sessão cloud) e
 * nenhuma label obrigatória única cobre as duas, então checá-la aqui daria
 * falso-positivo sistemático.
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
      // #5909 + #7065 — motivos de Coordenação de sessão são isentos de
      // propósito: a skill `.claude/skills/diaria-develop/SKILL.md` diz
      // explicitamente que estes NÃO levam comentário na issue
      // (`deixado-para-o-helios`: "sem comentário — corrida evitada, não
      // bloqueio"; `claimed-por-outra-sessao`: "sem comentário — corrida
      // evitada, não bloqueio"). O roteamento label-driven
      // (`classifyExecTrack`) já garante que cada uma reapareça no track
      // certo. Exigir comentário aqui produzia falso positivo sistemático
      // em toda sessão develop sob `exhaust_all` (7 issues acusadas em
      // rodada real por uma sessão overnight ativa estar trabalhando cada
      // uma) e, pior, gerava ruído de fato nas issues dos pares — um
      // comentário que diz "outra sessão já está trabalhando" não é
      // evidência de trabalho feito, é barulho.
      const motivo = typeof issue.motivo === "string" ? issue.motivo : null;
      if (motivo === "deixado-para-o-helios" || motivo === "claimed-por-outra-sessao") continue;
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
 * Sessão chamadora do gate (#6115). `overnight` | `develop` | `continuo` —
 * as 3 skills que hoje reusam este gate. `undefined` = agnóstico (aceita
 * qualquer um dos tokens, comportamento pré-#6115).
 */
export type CoverageSessionKind = "overnight" | "develop" | "continuo";

const KIND_TOKENS: Readonly<Record<CoverageSessionKind, RegExp>> = {
  overnight: /overnight/i,
  develop: /(diaria-)?develop/i,
  continuo: /(diaria-)?continuo/i,
};

/**
 * Pure: `true` se ao menos 1 comentário contém o token da sessão chamadora
 * (case-insensitive) — o sinal de "esta issue já recebeu o comentário
 * mandatado pelo SKILL.md/#5777". Ver docblock do módulo para o porquê de
 * não filtrar por timestamp/autor.
 *
 * #6115: o critério original exigia literalmente "overnight" em TODOS os
 * casos — falso positivo em toda sessão `/diaria-develop`, cujos comentários
 * dizem "sessão /diaria-develop..." e nunca contêm "overnight". Agora o
 * chamador informa a sessão (`kind`) e o token correspondente é aceito; sem
 * `kind`, qualquer dos 3 tokens cobre (comportamento legado preservado).
 */
export function hasOvernightComment(
  comments: IssueCommentLike[],
  kind?: CoverageSessionKind,
): boolean {
  const token = kind ? KIND_TOKENS[kind] : /(overnight|(diaria-)?develop|(diaria-)?continuo)/i;
  return comments.some((c) => typeof c.body === "string" && token.test(c.body));
}

/**
 * Pure: deriva a sessão chamadora do path do `plan.json` (#6115) —
 * `data/overnight/{AAMMDD}/plan.json` → `"overnight"`,
 * `data/develop/...` → `"develop"`, `data/continuo/...` → `"continuo"`.
 * Path desconhecido → `null` (chamador cai no modo agnóstico de
 * `hasOvernightComment`). Nunca lança.
 */
export function sessionKindFromPlanPath(planPath: string): CoverageSessionKind | null {
  if (/\/develop(\/|\.)/.test(planPath) || planPath.includes("data/develop")) return "develop";
  if (/\/continuo(\/|\.)/.test(planPath) || planPath.includes("data/continuo")) return "continuo";
  if (/\/overnight(\/|\.)/.test(planPath) || planPath.includes("data/overnight")) return "overnight";
  return null;
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
  kind?: CoverageSessionKind,
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
    if (!hasOvernightComment(comments, kind)) {
      missing.push(candidate);
    }
  }

  if (missing.length > 0) {
    return { status: "missing", missing: missing.sort((a, b) => a.number - b.number), unresolved };
  }
  return { status: "ok", missing: [], unresolved };
}

// ---------------------------------------------------------------------------
// #5844 — cobertura de LABEL (motivo → label esperada), gate irmão do
// comentário acima. Ver docblock do módulo pro rationale completo.
// ---------------------------------------------------------------------------

/** Vocabulário fechado (subconjunto): só motivos cuja label esperada é ÚNICA
 * e inequívoca. `requer-sessao-local` fica de fora de propósito (ver
 * docblock do módulo). Chave = `motivo` textual gravado em `plan.json`
 * (overnight); valor = label a conferir no GitHub. */
export const MOTIVO_TO_LABEL: Readonly<Record<string, string>> = {
  "not-this-week": "not-this-week",
  "bloqueio-externo": "external-blocker",
  ambigua: "trade-off-real",
};

/** Pure: `motivo` → label esperada, ou `null` se o motivo não tem label
 * única mapeada (`requer-sessao-local`, `sem-resposta`, `fora-do-escopo`,
 * ausente/desconhecido). Nunca lança. */
export function requiredLabelForMotivo(motivo: string | null | undefined): string | null {
  if (!motivo) return null;
  return MOTIVO_TO_LABEL[motivo] ?? null;
}

export interface LabelCandidateIssue {
  number: number;
  motivo: string;
  requiredLabel: string;
}

/**
 * Pure: entre as issues do plano já normalizadas, devolve as `status:
 * "pulada"` cujo `motivo` mapeia pra uma label esperada (via
 * `requiredLabelForMotivo`). Todo candidato aqui já é, por construção, um
 * candidato de `deriveCandidateIssues` (reason `pulada-sem-comentario`) —
 * então o CLI pode reusar o mesmo fetch de `gh issue view` (comments +
 * labels) sem uma 2ª rodada de chamadas.
 */
export function deriveLabelCandidates(issues: PlanIssueLike[]): LabelCandidateIssue[] {
  const out: LabelCandidateIssue[] = [];
  for (const issue of issues) {
    if (typeof issue.number !== "number" || !Number.isFinite(issue.number)) continue;
    if (issue.status !== "pulada") continue;
    const motivo = typeof issue.motivo === "string" ? issue.motivo : null;
    const requiredLabel = requiredLabelForMotivo(motivo);
    if (requiredLabel) out.push({ number: issue.number, motivo: motivo!, requiredLabel });
  }
  return out;
}

export type LabelCoverageVerdictStatus = "ok" | "missing" | "not-evaluated";

export interface LabelCoverageVerdict {
  status: LabelCoverageVerdictStatus;
  missing: LabelCandidateIssue[];
}

/**
 * Pure: veredito final a partir das candidatas de label já derivadas + os
 * nomes de label de cada issue (já buscados). `labelsByIssue.get(number)`
 * ausente é tratado como "sem labels" (`[]`) — nunca lança; distinto do
 * gate de comentário, que trata fetch-falho como `unresolved` separado —
 * aqui não há esse 3º estado porque a label vem do MESMO fetch que já
 * populou `commentsByIssue` (se aquele falhou, o CLI já reportou
 * `unresolved` e este veredito de label não é nem calculado para a issue —
 * ver `check-overnight-comment-coverage.ts`).
 */
export function checkLabelCoverage(
  candidates: LabelCandidateIssue[],
  labelsByIssue: Map<number, string[]>,
): LabelCoverageVerdict {
  if (candidates.length === 0) return { status: "not-evaluated", missing: [] };

  const missing = candidates.filter((c) => !(labelsByIssue.get(c.number) ?? []).includes(c.requiredLabel));

  if (missing.length > 0) {
    return { status: "missing", missing: missing.sort((a, b) => a.number - b.number) };
  }
  return { status: "ok", missing: [] };
}
