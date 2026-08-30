/**
 * pr-review-authenticity.ts (#6732)
 *
 * Lógica PURA/testável do gate "review independente pré-merge" para PRs do
 * `hermes-diaria-continuo`. O I/O (`gh pr view --json comments`) fica no
 * entrypoint `scripts/check-pr-review-authenticity.ts` — mesmo padrão de
 * `scripts/lib/pr-checks-gate.ts` / `scripts/check-pr-checks-gate.ts`.
 *
 * ## O bug que isto fecha
 *
 * A delegação do contínuo (`claude -p` via `claude-openrouter.sh`, `--tools`
 * sem `Agent`/`Task`) recebe do hook `.claude/hooks/pr-create-review.mjs` a
 * instrução de despachar `pr-review-toolkit:code-reviewer` via ferramenta
 * Agent. Sem essa ferramenta, o dispatch é impossível — mas a sessão, ao
 * tentar cumprir a instrução, lia o diff ela mesma e postava um comentário no
 * formato `"Review automatizado (1 agente, effort low — desconto
 * overnight): sem findings..."`, indistinguível textualmente de um review de
 * verdade (medido ao vivo nos PRs #6713/#6715). O gate de auto-merge do
 * #5251 lê exatamente essa string — um autor se auto-aprovando satisfazia o
 * gate com a mesma evidência que um review independente produziria.
 *
 * ## A correção (decisão do editor, opção 2 do #6732)
 *
 * Não dar a ferramenta Agent à delegação (custo — #6712). Em vez disso,
 * `buildReviewInstruction` (`.claude/hooks/pr-create-review.mjs`) agora
 * instrui: se o Agent tool não está disponível nesta sessão, rotular
 * honestamente — comentário começando pela linha literal `SELF_REVIEW_MARKER`
 * abaixo, nunca com o texto `"Review automatizado"`. Este módulo classifica
 * o comentário mais recente do PR e decide se o gate está satisfeito.
 *
 * **Fail-closed por design** (mesmo padrão do passo 2 do §3 da SKILL —
 * `sensitive-path-guard.ts`): ausência de review, erro de payload, ou
 * self-review explícito NUNCA autorizam merge. Só `"independent-review"`
 * autoriza.
 */

/** Marcador literal que a instrução do hook manda postar quando o Agent tool
 *  não está disponível — nunca reformular sem atualizar as duas pontas
 *  (a instrução em `.claude/hooks/pr-create-review.mjs` duplica esta
 *  constante como string literal, não por import — ver o docblock daquele
 *  arquivo sobre por que ele nunca importa `.ts` do repo). */
export const SELF_REVIEW_MARKER = "<!-- self-review: true -->";

/**
 * Formato exato que `buildReviewInstruction` pede para um review DE VERDADE
 * (dispatch via Agent, `pr-create-review.mjs`) — não é o único texto válido
 * possível no mundo, mas é o que este repo produz em todo caminho onde o
 * dispatch de fato acontece (interativo, overnight, develop). Âncora no
 * início da linha (após trim) para não casar uma citação incidental da frase
 * em outro contexto.
 */
const INDEPENDENT_REVIEW_RE = /^Review automatizado \(\d+ agentes?, effort (?:low|max)\b/i;

export type ReviewCommentKind = "self-review" | "independent-review" | "other";

/** Classifica um único corpo de comentário. Pura, nunca lança. */
export function classifyReviewComment(body: unknown): ReviewCommentKind {
  if (typeof body !== "string" || body.length === 0) return "other";
  // Checar o marcador de self-review PRIMEIRO: uma sessão que copiasse o
  // texto "Review automatizado" por engano ainda deve contar como self-review
  // se carregar o marcador — o marcador é a fonte de verdade, não o prefixo.
  if (body.includes(SELF_REVIEW_MARKER)) return "self-review";
  if (INDEPENDENT_REVIEW_RE.test(body.trim())) return "independent-review";
  return "other";
}

export type PrReviewAuthenticityVerdict = "pass" | "self_review" | "no_review" | "error";

export interface PrReviewAuthenticityResult {
  verdict: PrReviewAuthenticityVerdict;
  reason: string;
  /** id do comentário que decidiu o veredito, quando houver (`pass`/`self_review`). */
  matchedCommentId?: string;
}

export interface PrCommentNode {
  id?: unknown;
  body?: unknown;
}

/**
 * Decide o veredito a partir de `comments` já parseado (ordem cronológica
 * ascendente, mesma ordem que `gh pr view --json comments` devolve — mesma
 * premissa de `evaluatePrChecksGate`). Varre de trás para frente e para no
 * PRIMEIRO comentário que seja um review (self ou independente) — comentários
 * de review mais antigos (de uma rodada de fix anterior, por exemplo) nunca
 * devem decidir sobre o estado atual do PR.
 *
 * `comments` não sendo array (payload malformado/ausente) é `"error"`, nunca
 * `"pass"` — mesma garantia central de `pr-checks-gate.ts`: falha de
 * comando/parse não pode ler como "0 problemas encontrados".
 */
export function evaluatePrReviewAuthenticity(comments: unknown): PrReviewAuthenticityResult {
  if (!Array.isArray(comments)) {
    return {
      verdict: "error",
      reason: "payload de comments não é um array (comando/parse falhou)",
    };
  }

  for (let i = comments.length - 1; i >= 0; i--) {
    const node = comments[i] as PrCommentNode;
    const kind = classifyReviewComment(node?.body);
    if (kind === "independent-review") {
      return {
        verdict: "pass",
        reason: "review independente encontrado (formato de dispatch via Agent)",
        matchedCommentId: typeof node?.id === "string" ? node.id : undefined,
      };
    }
    if (kind === "self-review") {
      return {
        verdict: "self_review",
        reason:
          "comentário marcado como self-review do autor (sem agente independente) — não satisfaz o gate do #5251",
        matchedCommentId: typeof node?.id === "string" ? node.id : undefined,
      };
    }
  }

  return {
    verdict: "no_review",
    reason: "nenhum comentário de review (independente ou self-review) encontrado no PR",
  };
}

/** Açúcar para chamadores que só querem saber "pode mergear?". */
export function isPrReviewAuthenticityGreen(result: PrReviewAuthenticityResult): boolean {
  return result.verdict === "pass";
}
