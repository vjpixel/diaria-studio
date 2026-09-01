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
 * ## #6849 (01/09/2026) — o lado positivo trocou de prosa livre pra marcador com nonce
 *
 * `INDEPENDENT_REVIEW_RE` (regex sobre a prosa "Review automatizado (N
 * agentes, effort X): ...") **caiu**. Achado ao vivo: `hermes/scripts/
 * continuo-pr-review.sh` — o revisor EXTERNO legítimo do #6871/#6865 — é
 * instruído a produzir exatamente essa prosa, então uma sessão fabricando
 * (mesmo padrão do #6713/#6715) e o revisor de verdade emitem a MESMA
 * primeira linha. Nenhum regex sobre texto livre distingue os dois — o
 * formato é público (script versionado) e trivialmente copiável. Não é um
 * regex frouxo que precisa endurecer; é um discriminador impossível.
 *
 * A correção não fecha essa lacuna de fundo (nada fecha por texto puro) —
 * troca o QUE conta como sinal: só o revisor externo (`continuo-pr-
 * review.sh`) conhece o `run`/`at` que ELE MESMO gerou antes de invocar a
 * sessão de review, e instrui essa sessão a colar esse valor, literal, no
 * comentário. Uma sessão fabricando o review (a delegação do próprio PR,
 * sem ferramenta Agent) não tem acesso a esse valor gerado pelo script
 * externo — só pode reproduzir o FORMATO do marcador (o script é público),
 * nunca o valor de uma execução real sem tê-lo visto. Ver `## Limitação
 * residual` abaixo — isto não é criptografia, é remover o acidente.
 *
 * ## Limitação residual, registrada explicitamente (achado do fleet review)
 *
 * Este gate é **honor-system em ambos os lados**, não uma verificação
 * criptográfica de que um dispatch real aconteceu. O lado negativo
 * (self-review) e o lado positivo (`INDEPENDENT_REVIEW_MARKER_RE`, desde o
 * #6849) têm a MESMA forma de âncora agora — um literal/padrão que só
 * aparece numa linha própria se a sessão seguir a instrução do respectivo
 * script. Nada aqui prova criptograficamente que a ferramenta Agent foi de
 * fato invocada, nem que o `run`/`at` do marcador vieram de uma execução
 * real do `continuo-pr-review.sh` (uma sessão que leia esse script consegue
 * fabricar um marcador com a mesma FORMA). O que muda desde o #6849: fabricar
 * deixa de acontecer por ACIDENTE — a prosa antiga é a forma natural de uma
 * sessão descrever o que ela acha que fez; um marcador com identidade de
 * execução não sai sem intenção explícita de reproduzi-lo. Se o blast radius
 * voltar a ser merge indevido (hoje, pós-#6864, o pior caso é PR órfã
 * pulada pelo pickup do overnight — ver SKILL do #6864), a opção descartada
 * no #6849 (credencial de review separada) é o próximo passo, não este
 * marcador.
 */

/** Marcador literal que a instrução do hook manda postar quando o Agent tool
 *  não está disponível — nunca reformular sem atualizar as duas pontas
 *  (a instrução em `.claude/hooks/pr-create-review.mjs` duplica esta
 *  constante como string literal, não por import — ver o docblock daquele
 *  arquivo sobre por que ele nunca importa `.ts` do repo). */
export const SELF_REVIEW_MARKER = "<!-- self-review: true -->";

/**
 * #6849: marcador com IDENTIDADE DE EXECUÇÃO que `hermes/scripts/
 * continuo-pr-review.sh` gera (`run`/`at`) ANTES de invocar a sessão de
 * review externa, e instrui a sessão a colar literalmente no comentário —
 * substitui `INDEPENDENT_REVIEW_RE` (regex sobre a prosa "Review
 * automatizado (...)"), que o revisor legítimo E uma sessão fabricando
 * produzem igual (ver docstring do módulo, "o lado positivo trocou de prosa
 * livre pra marcador com nonce"). Mesma âncora de LINHA PRÓPRIA que
 * `SELF_REVIEW_MARKER` — um review legítimo que discuta este módulo em
 * prosa citaria o literal e se autoclassificaria por engano, do mesmo jeito
 * que o #6820 corrigiu pro marcador de self-review.
 *
 * `run=` e `at=` não são validados contra nada FORA do comentário (sem
 * lookup externo, sem verificação criptográfica) — não prova que a
 * execução foi real. Ver "Limitação residual" no docstring do módulo:
 * fabricar deixou de ser algo que sai por acidente, não deixou de ser
 * possível. `at=` EXIGE o formato ISO 8601 UTC exato que `date -u
 * +%Y-%m-%dT%H:%M:%SZ` produz em `continuo-pr-review.sh` (frações de
 * segundo opcionais) — achado do review da PR #6903 (P2, confiança alta):
 * com `\S+` solto, a PRÓPRIA notação de placeholder usada nesta docstring
 * (`run=<id> at=<iso>`), se citada em linha própria por um review futuro
 * que discuta este módulo, colaria no regex sem nenhuma execução real ter
 * ocorrido — mesma classe de colisão acidental que o #6820 fechou pro
 * `SELF_REVIEW_MARKER` com um literal exato. `run=` continua `\S+`
 * (formato menos previsível, sem um padrão fixo pra travar sem também
 * travar o gerador do script).
 */
const INDEPENDENT_REVIEW_MARKER_RE =
  /^<!-- continuo-review: run=\S+ at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z(?: verdict=(approve|reject))? -->$/;

export type ReviewCommentKind = "self-review" | "independent-review" | "other";

/**
 * Classifica um único corpo de comentário. Pura, nunca lança.
 *
 * #6820 (fleet review do #6732): a checagem original fazia `body.includes
 * (SELF_REVIEW_MARKER)` — substring solta em QUALQUER lugar do corpo, sem a
 * mesma âncora que o sinal positivo já tinha. Um comentário de review
 * LEGÍTIMO que discutisse este próprio módulo/marcador em prosa (ex: um
 * review de uma PR futura que edite este arquivo) citaria o literal
 * `SELF_REVIEW_MARKER` e seria classificado `"self-review"` por engano —
 * falso-negativo pro lado que autoriza merge (fail-closed, nunca inseguro,
 * mas bloqueia review real). Fix: exigir que o marcador apareça como uma
 * LINHA PRÓPRIA (trimmed), exatamente como a instrução do hook manda
 * postar — "a linha literal `<!-- self-review: true -->` na própria
 * linha". #6849 aplica o MESMO tratamento ao marcador positivo
 * (`INDEPENDENT_REVIEW_MARKER_RE`), pelo mesmo motivo.
 */
export function classifyReviewComment(body: unknown): ReviewCommentKind {
  if (typeof body !== "string" || body.length === 0) return "other";
  const lines = body.split("\n").map((line) => line.trim());
  // Checar o marcador de self-review PRIMEIRO: uma sessão que copiasse o
  // texto de review real por engano ainda deve contar como self-review se
  // carregar o marcador — o marcador é a fonte de verdade, não o prefixo.
  if (lines.some((line) => line === SELF_REVIEW_MARKER)) return "self-review";
  if (lines.some((line) => INDEPENDENT_REVIEW_MARKER_RE.test(line))) return "independent-review";
  return "other";
}

export type ReviewVerdict = "approve" | "reject";

/**
 * #6926: `continuo-pr-review.sh` passou a instruir a sessão de review a
 * gravar `verdict=approve|reject` no próprio marcador de identidade de
 * execução (`INDEPENDENT_REVIEW_MARKER_RE` acima) — o portão 1 do merge
 * autônomo dessa PR lê ESTE veredito, não mais prosa livre a ser
 * interpretada (mesmo motivo do #6849 pro resto do marcador: texto livre
 * não é discriminável).
 *
 * Retorna `null` em dois casos DISTINTOS que o chamador (`scripts/lib/
 * continuo-merge-gate.ts`) trata IGUAL (fail-closed: sem veredito explícito,
 * não decide merge sozinho) mas que valem registrar aqui: (a) nenhum
 * comentário de review independente encontrado (mesmo caso de `no_review`
 * em `evaluatePrReviewAuthenticity`); (b) um marcador independente
 * encontrado, mas SEM o campo `verdict=` — formato legado, anterior ao
 * #6926, ou marcador de um review vindo de outra fonte que não este script.
 * A ausência do campo não é tratada como aprovação implícita: o gate de
 * merge escala em vez de mergear, mesmo que isso reduza o alcance do gate
 * pra reviews antigos — nunca inferir "approve" de silêncio num portão que
 * autoriza merge.
 *
 * Mesma varredura cronológica de trás para frente que
 * `evaluatePrReviewAuthenticity` — para no primeiro comentário que seja um
 * review (self ou independente); um self-review mais recente que qualquer
 * review independente anterior também retorna `null` (o self-review é o
 * sinal vigente, não uma aprovação anterior obsoleta).
 */
export function extractIndependentReviewVerdict(comments: unknown): ReviewVerdict | null {
  if (!Array.isArray(comments)) return null;

  for (let i = comments.length - 1; i >= 0; i--) {
    const node = comments[i] as PrCommentNode;
    const body = typeof node?.body === "string" ? node.body : "";
    const lines = body.split("\n").map((line) => line.trim());

    if (lines.some((line) => line === SELF_REVIEW_MARKER)) return null;

    for (const line of lines) {
      const match = INDEPENDENT_REVIEW_MARKER_RE.exec(line);
      if (match) {
        return match[2] === "approve" || match[2] === "reject" ? match[2] : null;
      }
    }
  }

  return null;
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
        reason: "review independente encontrado (marcador com identidade de execução, #6849)",
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
