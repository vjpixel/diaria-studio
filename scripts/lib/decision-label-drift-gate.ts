/**
 * scripts/lib/decision-label-drift-gate.ts (#5955)
 *
 * Miolo determinístico do gate `scripts/check-decision-label-drift-gate.ts`:
 * dado o `plan.json` da rodada e as issues abertas já buscadas, decide QUAIS
 * issues o gate avalia, com qual prosa, e se precisa buscar comentários.
 *
 * Existe separado do script por testabilidade — mesmo padrão dos gates irmãos
 * (`check-pr-terminal-state.ts`, `check-overnight-comment-coverage.ts`), que
 * mantêm a lógica em `lib/` justamente pra exercitá-la sem `gh`. Antes desta
 * extração, tudo isto vivia no `main()` do script e nada em CI o cobria —
 * achado do review da PR #5958, e a parte do diff mais propensa a regredir em
 * silêncio, porque uma decisão errada aqui não falha: só deixa de reportar.
 *
 * Puro: sem I/O, sem rede, sem `gh`.
 *
 * @see scripts/lib/decision-label-drift.ts (detecção de padrão em si)
 * @see scripts/check-decision-label-drift-gate.ts (CLI que faz o I/O)
 */
import { classifyExecTrack, type ExecTrack } from "./issue-exec-track.ts";

/** Entrada do `plan.json` que o gate consome. */
export interface GatePlanIssue {
  number: number;
  in_round?: boolean;
  /**
   * Por que a issue foi pulada. É o campo REAL desta fonte: presente em
   * dezenas de planos reais, e exigido pela skill em toda issue `pulada`.
   */
  motivo?: string;
  /**
   * Nota de escopo opcional. Medido em 81 planos (overnight + develop,
   * ago/2026): aparece **uma** vez, e nenhum SKILL a documenta — é campo
   * ad-hoc que uma sessão gravou por conta própria. (A medição roda sobre
   * `data/overnight/`+`data/develop/`, que vivem FORA do git — junction
   * OneDrive, ver CLAUDE.md —, então não é auditável a partir de um clone;
   * foi feita na checkout do editor em 23/08/2026.) Lido quando presente
   * porque foi justamente o texto que descrevia o bloqueio com mais precisão
   * no caso de origem (#5140, rodada 260823), mas a cobertura desta fonte
   * depende de `motivo`, não dela.
   */
  scope_note?: string;
}

/** Issue aberta vinda de `gh issue list --json number,labels,body`. */
export interface GateOpenIssue {
  number: number;
  labels: string[];
  /** Necessário pro marcador `aguardando-ate:` que `classifyExecTrack` lê. */
  body?: string;
}

/** Uma issue que o gate vai de fato avaliar. */
export interface GateEvaluation {
  issueNumber: number;
  labels: string[];
  planTexts: string[];
  currentTrack: ExecTrack;
  /** Se o CLI deve gastar um `gh issue view` buscando comentários. */
  needsComments: boolean;
}

/** Textos de prosa do plano pra uma issue, sem vazios. */
export function planTextsFor(entry: GatePlanIssue): string[] {
  return [entry.motivo, entry.scope_note].filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
}

/**
 * Decide o conjunto de avaliação do gate. Regras, nesta ordem:
 *
 *  1. **Só issues do plano da rodada** — nunca todas as abertas; não reportar
 *     drift em issue que esta rodada nem olhou.
 *  2. **Só quem ainda classifica `overnight`** — é o único caso em que a
 *     label faltante muda o roteamento e a issue volta pra fila toda rodada.
 *     Sem este corte o gate trava a rodada por issue já corretamente roteada
 *     (medido na 260823: #4549 `on-hold`, #5917 `aguardando-ate`).
 *  3. **Comentários só quando `in_round` não é `false`** — custam um `gh
 *     issue view` por issue. Ausência de `in_round` conta como `true`, o
 *     fail-open que a SKILL documenta pra plan.json legado ("Ausente em
 *     plan.json legado → `true`"); a comparação estrita `=== true` que estava
 *     aqui divergia dessa convenção (achado de review, PR #5958).
 *  4. **Descarta quem não tem prosa nenhuma pra varrer** — sem `planTexts` e
 *     sem comentários a buscar, não há o que avaliar.
 *
 * A prosa do PLANO, ao contrário dos comentários, é lida inclusive de issues
 * `in_round: false` — são as excluídas antes do despacho
 * (`bloqueada-externa`, `fora-do-escopo`, `ambígua/trade-off-real`), ou seja,
 * as mais propensas a carregar um veredito que nunca virou label. Custo zero:
 * já está em disco.
 */
export function buildGateEvaluations(
  planIssues: readonly GatePlanIssue[],
  openIssues: readonly GateOpenIssue[],
  now: Date = new Date(),
): GateEvaluation[] {
  const planByNumber = new Map<number, GatePlanIssue>();
  for (const entry of planIssues) planByNumber.set(entry.number, entry);

  const evaluations: GateEvaluation[] = [];
  for (const issue of openIssues) {
    const entry = planByNumber.get(issue.number);
    if (!entry) continue;

    // Todas as issues aqui vêm de `gh issue list --state open`, daí o `state`
    // fixo — documenta o invariante em vez de deixá-lo implícito.
    const currentTrack = classifyExecTrack({
      labels: issue.labels,
      body: issue.body,
      state: "OPEN",
      now,
    });
    if (currentTrack !== "overnight") continue;

    const planTexts = planTextsFor(entry);
    const needsComments = entry.in_round !== false;
    if (planTexts.length === 0 && !needsComments) continue;

    evaluations.push({
      issueNumber: issue.number,
      labels: issue.labels,
      planTexts,
      currentTrack,
      needsComments,
    });
  }
  return evaluations;
}
