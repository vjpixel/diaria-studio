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
 * tentar cumprir a instrução, lia o diff ela mesma e postava um comentário se
 * passando por review de verdade. **Medido em pelo menos DUAS formas de
 * texto distintas** (achado do fleet review do #6820, corrigindo uma citação
 * anterior deste docstring que afirmava as duas serem iguais): PR #6713
 * postou `"Review automatizado (1 agente, effort low — desconto
 * overnight): sem findings..."`; PR #6715 (também `continuo/`, mesma
 * fabricação, formato diferente) postou `"Code review (pr-review-
 * toolkit:code-reviewer, sonnet, diff ...): sem findings..."`. O gate de
 * auto-merge do #5251 lê esse texto em prosa — um autor se auto-aprovando
 * satisfazia o gate com a mesma evidência que um review independente
 * produziria.
 *
 * ## A correção (decisão do editor, opção 2 do #6732)
 *
 * Não dar a ferramenta Agent à delegação (custo — #6712). Em vez disso,
 * `buildReviewInstruction` (`.claude/hooks/pr-create-review.mjs`) agora
 * instrui: se o Agent tool não está disponível nesta sessão, rotular
 * honestamente — comentário começando pela linha literal `SELF_REVIEW_MARKER`
 * abaixo, nunca com texto que soe como review de verdade. Este módulo
 * classifica o comentário mais recente do PR e decide se o gate está
 * satisfeito.
 *
 * **Fail-closed por design** (mesmo padrão do passo 2 do §3 da SKILL —
 * `sensitive-path-guard.ts`): ausência de review, erro de payload, ou
 * self-review explícito NUNCA autorizam merge. Só `"independent-review"`
 * autoriza.
 *
 * ## Limitação residual, registrada explicitamente (achado do fleet review)
 *
 * Este gate é **honor-system em ambos os lados**, não uma verificação
 * criptográfica de que um dispatch real aconteceu. O lado negativo
 * (self-review) tem uma âncora forte — `SELF_REVIEW_MARKER` é um literal
 * exato que só aparece se a sessão seguir a instrução nova. O lado positivo
 * (`INDEPENDENT_REVIEW_RE`) é regex sobre prosa livre que um LLM compõe —
 * e a própria descoberta de que #6713/#6715 fabricaram em DOIS formatos
 * diferentes mostra que a mesma sessão pode produzir texto que nem o
 * marcador de self-review nem o regex reconhecem (caindo em `"other"` →
 * `no_review`, fail-closed — nunca um falso `"pass"`) ou que, por acaso,
 * COINCIDE com `INDEPENDENT_REVIEW_RE` sem um dispatch real ter ocorrido.
 * Nada aqui prova criptograficamente que a ferramenta Agent foi de fato
 * invocada. O gate garante uma coisa, e só uma: uma sessão que segue a nova
 * instrução do hook nunca produz um falso `"pass"` disfarçado de self-review
 * explícito — não garante que toda prosa de review genuína seja reconhecida,
 * nem impede uma fabricação em formato ainda não observado de colar por
 * acidente no regex positivo.
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

/**
 * Classifica um único corpo de comentário. Pura, nunca lança.
 *
 * #6820 (fleet review do #6732): a checagem original fazia `body.includes
 * (SELF_REVIEW_MARKER)` — substring solta em QUALQUER lugar do corpo, sem a
 * mesma âncora que `INDEPENDENT_REVIEW_RE` já tinha (início de linha, pra
 * não casar uma citação incidental). Um comentário de review LEGÍTIMO que
 * discutisse este próprio módulo/marcador em prosa (ex: um review de uma PR
 * futura que edite este arquivo) citaria o literal `SELF_REVIEW_MARKER` e
 * seria classificado `"self-review"` por engano — falso-negativo pro lado
 * que autoriza merge (fail-closed, nunca inseguro, mas bloqueia review real).
 * Fix: exigir que o marcador apareça como uma LINHA PRÓPRIA (trimmed),
 * exatamente como a instrução do hook manda postar — "a linha literal
 * `<!-- self-review: true -->` na própria linha".
 */
export function classifyReviewComment(body: unknown): ReviewCommentKind {
  if (typeof body !== "string" || body.length === 0) return "other";
  // Checar o marcador de self-review PRIMEIRO: uma sessão que copiasse o
  // texto de review real por engano ainda deve contar como self-review se
  // carregar o marcador — o marcador é a fonte de verdade, não o prefixo.
  const hasOwnLineMarker = body
    .split("\n")
    .some((line) => line.trim() === SELF_REVIEW_MARKER);
  if (hasOwnLineMarker) return "self-review";
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
 * premissa de `detectLabelDriftDetailed` em `scripts/lib/decision-label-
 * drift.ts`, não de `evaluatePrChecksGate` — aquele opera sobre
 * `statusCheckRollup`, sem noção de ordem cronológica de comentário;
 * corrigido no #6820 depois do fleet review flagar a citação errada). Varre
 * de trás para frente e para no
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
      reason: "campo comments ausente ou não é um array (comando falhou, JSON malformado, ou schema inesperado do gh)",
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
