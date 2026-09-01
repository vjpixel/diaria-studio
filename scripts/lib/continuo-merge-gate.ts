/**
 * continuo-merge-gate.ts (#6926)
 *
 * Lógica PURA/testável do gate de merge autônomo de `continuo-pr-review.sh`
 * — o script bash (não o modelo, ver docstring dele) decide se mergeia a PR
 * que acabou de revisar. Módulo puro, mesmo padrão de `pr-checks-gate.ts`/
 * `pr-review-authenticity.ts`: todo I/O (chamadas `gh`, `git log`) fica no
 * entrypoint CLI (`scripts/check-continuo-merge-gate.ts`); este arquivo só
 * decide a partir dos dados já coletados.
 *
 * ## Por que existe
 *
 * Até o #6926, `gh pr merge` estava fora do `--allowedTools` da sessão de
 * review (#6864/#6865) e o ÚNICO merger de PR `continuo/*` era o pickup do
 * `/diaria-overnight` (#6823) — que só roda quando o editor inicia uma
 * rodada manualmente. PR #6901 (01/09/2026): 10h29 com review independente
 * `verdict=pass`, CI 100% verde, `mergeable=MERGEABLE`, e nenhum merger
 * rodando — mergeada à mão pelo editor. O #6926 dá autoridade de merge ao
 * `continuo-pr-review.sh`, SEM tirar `gh pr merge` do `--allowedTools`
 * (isso continua fora, e `test/continuo-pr-review-never-merges.test.ts`
 * continua verde e intocado): o modelo emite veredito estruturado
 * (`verdict=approve|reject` no marcador que já escreve, ver
 * `scripts/lib/pr-review-authenticity.ts`), e é o SCRIPT BASH, depois que a
 * sessão do modelo já saiu, que decide mergear — nunca uma ferramenta que o
 * modelo invoca. Um modelo persuadido a "aprovar" uma PR ruim não consegue
 * mergear nada sozinho: ele só grava um veredito que passa por MAIS 8
 * portões determinísticos (lista abaixo), todos fail-closed, antes que
 * qualquer `gh pr merge` rode.
 *
 * ## Por que não contradiz o #6864
 *
 * O #6864 proibiu merge porque avaliador e avaliado eram o MESMO processo,
 * mesma credencial `gh`. Aqui não são: quem abre a PR `continuo/*` é o
 * tick (`hermes-diaria-continuo`, cron próprio); quem revisa e decide
 * mergear é ESTE script (`continuo-pr-review.sh`, cron separado, prompt e
 * escopo de ferramentas diferentes) — a mesma separação avaliador/avaliado
 * que já vale hoje pro pickup do `/diaria-overnight`.
 *
 * ## Ordem dos portões (primeira condição que decide vence)
 *
 * 1. `superseded` — issue(s) já fechada(s) por outra coisa → `reject`
 *    incondicional, ANTES até do veredito da revisão (não importa o que o
 *    review achou: não há mais nada útil a mergear, #6238).
 * 2. veredito da revisão == `reject` → `reject`.
 * 3. `reviewedHeadSha` desconhecido (`null` — nenhum review independente
 *    encontrado, ou marcador legado sem o campo `head=`, #6926) →
 *    `escalate`. Sem SHA revisado não há como saber SE o HEAD atual é o
 *    mesmo que foi revisado — nunca assumir que sim.
 * 4. HEAD mudou depois do início da revisão (`currentHeadSha !==
 *    reviewedHeadSha` — corrida do #5716 aplicada aqui: a revisão não
 *    cobre commits pós-revisão) → `escalate` (não `reject` — a PR pode
 *    estar ótima, só precisa de review de novo no SHA novo; o próximo tick
 *    do cron cobre isso).
 * 5. caminho sensível (guard fail-closed: `null`/erro conta como sensível)
 *    → `escalate` — revisão humana.
 * 6. CI não `pass` → `escalate` — não decide sozinho enquanto CI não
 *    resolveu (vermelho, pendente, erro, ou bloqueado por conflito).
 * 7. `mergeable !== "MERGEABLE"` → `escalate` — GitHub ainda não confirmou
 *    que dá pra mergear sem conflito.
 * 8. tamanho de diff desconhecido → `escalate` — não adivinha.
 * 9. diff ≥ limiar (reusa `EFFORT_DIFF_LINE_THRESHOLD` de
 *    `.claude/hooks/pr-create-review.mjs`, #4813/#6393 — não inventa limiar
 *    novo) → `escalate` — a revisão desta sessão é rasa por design (Sonnet,
 *    `--effort low`), só decide sobre o que consegue julgar; diff grande
 *    fica pro overnight/editor.
 * 10. nada do acima → `merge`.
 */

export type ContinuoMergeAction = "merge" | "escalate" | "reject";

export interface ContinuoMergeGateInput {
  /** `true` quando o gate de superseded (#6238) já confirmou que toda issue
   *  referenciada pela PR está `CLOSED` — ver `computeSupersededVerdict`. */
  superseded: boolean;
  /** Veredito extraído do marcador de review (#6926) — `null` cobre TANTO
   *  "nenhum review independente encontrado" QUANTO "encontrado mas sem
   *  campo `verdict=`" (marcador legado, pré-#6926). Nos dois casos o gate
   *  escala, nunca infere aprovação do silêncio. */
  verdict: "approve" | "reject" | null;
  /** SHA do HEAD no momento em que a decisão de merge está sendo tomada.
   *  Comparado contra `reviewedHeadSha` — divergência fecha a corrida do
   *  #5716 (revisão que não cobre o SHA atual). */
  currentHeadSha: string | null;
  /** SHA do HEAD que a revisão mais recente de fato cobriu — extraído do
   *  campo `head=` do marcador de review (#6926,
   *  `extractIndependentReviewHeadSha`), NUNCA fabricado a partir do HEAD
   *  atual pelo chamador (achado do review da PR #6932: um chamador que
   *  fizesse `reviewedHeadSha = currentHeadSha` neutralizaria o portão 4
   *  por construção — os dois SEMPRE bateriam). `null` cobre "nenhum
   *  review independente encontrado" e "marcador legado sem o campo
   *  `head=`" — os dois casos escalam (portão 3), nunca assumem que o
   *  HEAD atual foi o revisado. */
  reviewedHeadSha: string | null;
  /** `null` = a lista de arquivos alterados não pôde ser obtida/validada
   *  de `gh pr view` — o guard `classifyChangedPaths` em si é puro e não
   *  falha; é a AUSÊNCIA de uma lista de arquivos utilizável que produz
   *  este `null`. Fail-closed: tratado como sensível (nunca "sensitive:
   *  false" por omissão). */
  sensitive: boolean | null;
  checksVerdict: "pass" | "fail" | "pending" | "error" | "blocked_by_conflict";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  /** `null` = não foi possível medir (gh/git falhou) — nunca assume "diff
   *  pequeno" por omissão. */
  diffLineCount: number | null;
  diffLineThreshold: number;
}

export interface ContinuoMergeGateResult {
  action: ContinuoMergeAction;
  reason: string;
}

export function evaluateContinuoMergeGate(input: ContinuoMergeGateInput): ContinuoMergeGateResult {
  if (input.superseded) {
    return {
      action: "reject",
      reason: "superseded: issue(s) referenciada(s) já fechada(s) por outra coisa (#6238)",
    };
  }

  if (input.verdict === "reject") {
    return { action: "reject", reason: "veredito da revisão: reject" };
  }

  if (input.reviewedHeadSha === null) {
    return {
      action: "escalate",
      reason:
        "SHA revisado desconhecido (nenhum review independente com campo head=, ou marcador legado pré-#6926) — não é possível confirmar que a revisão cobre o HEAD atual",
    };
  }

  if (input.currentHeadSha !== input.reviewedHeadSha) {
    return {
      action: "escalate",
      reason: `HEAD mudou depois do início da revisão (revisado=${input.reviewedHeadSha}, atual=${input.currentHeadSha ?? "desconhecido"}) — corrida do #5716, revisão não cobre o SHA atual`,
    };
  }

  if (input.sensitive !== false) {
    return {
      action: "escalate",
      reason:
        input.sensitive === null
          ? "sensitive-path-guard falhou ou saída inválida — fail-closed"
          : "caminho sensível de publicação/render — requer revisão humana",
    };
  }

  if (input.checksVerdict !== "pass") {
    return { action: "escalate", reason: `CI: ${input.checksVerdict}` };
  }

  if (input.mergeable !== "MERGEABLE") {
    return { action: "escalate", reason: `mergeable=${input.mergeable ?? "desconhecido"}` };
  }

  if (input.diffLineCount === null) {
    return { action: "escalate", reason: "tamanho do diff desconhecido — não decide sozinho" };
  }

  if (input.diffLineCount >= input.diffLineThreshold) {
    return {
      action: "escalate",
      reason: `diff (${input.diffLineCount} linhas) >= limiar (${input.diffLineThreshold}) — revisão rasa não decide sozinha, escala pro overnight/editor`,
    };
  }

  if (input.verdict !== "approve") {
    // Caminho LEGÍTIMO, não caso defensivo improvável: `verdict === null`
    // chegando até aqui é o resultado normal de um marcador com `head=`
    // válido (passou o portão 3 acima) mas SEM o campo `verdict=` — ex.
    // review de formato legado que já tinha `head=` antes de `verdict=`
    // existir, hipoteticamente, ou uma fonte de marcador diferente deste
    // script. Fail-closed: exige `"approve"` explícito, nunca aprova por
    // eliminação de `verdict !== "reject"`.
    return { action: "escalate", reason: "sem veredito de review explícito (verdict=approve ausente)" };
  }

  return {
    action: "merge",
    reason: "veredito approve, CI verde, mergeable, caminho não-sensível, diff dentro do limiar",
  };
}
