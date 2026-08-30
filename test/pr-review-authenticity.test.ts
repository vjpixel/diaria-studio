/**
 * test/pr-review-authenticity.test.ts (#6732)
 *
 * Cobre `scripts/lib/pr-review-authenticity.ts` — a lógica pura do gate
 * "review independente pré-merge" do `hermes-diaria-continuo`. O I/O
 * (`gh pr view`) fica no entrypoint `scripts/check-pr-review-authenticity.ts`,
 * testado aqui só via a função pura que ele orquestra (mesmo padrão de
 * `test/pr-checks-gate.test.ts` pro gate irmão).
 *
 * Regressão central (#6732): a delegação do contínuo, sem ferramenta Agent,
 * fabricava um comentário no formato de review independente
 * ("Review automatizado (1 agente, effort low..."), indistinguível de um
 * dispatch real. O caso que mais importa aqui é o inverso do #6225: um
 * comentário SEM o marcador de self-review, mesmo sem ferramenta Agent
 * disponível, ainda casa o formato de review independente — é exatamente
 * esse texto pré-fix (medido nos PRs #6713/#6715) que continua classificando
 * como "independent-review" até a instrução do hook (que produz textos
 * NOVOS) incluir o marcador. O gate não pode reescrever o passado; só
 * precisa parar de aceitar o formato fabricado A PARTIR de agora.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewComment,
  evaluatePrReviewAuthenticity,
  isPrReviewAuthenticityGreen,
  SELF_REVIEW_MARKER,
  type PrCommentNode,
} from "../scripts/lib/pr-review-authenticity.ts";
import { SELF_REVIEW_MARKER as HOOK_SELF_REVIEW_MARKER } from "../.claude/hooks/pr-create-review.mjs";

// #6820 (fleet review do #6732): a constante é duplicada por STRING (não
// import) entre este módulo e o hook `.claude/hooks/pr-create-review.mjs`
// (que nunca importa `.ts` do repo, ver o docblock daquele arquivo). Os
// testes de CADA arquivo, isoladamente, só comparavam a própria cópia contra
// um literal hardcoded — nenhum dos dois pegaria as duas cópias divergindo
// entre si. Este teste é o guard real: importa AS DUAS e compara.
describe("SELF_REVIEW_MARKER — as duas cópias duplicadas nunca divergem (#6820)", () => {
  it("scripts/lib/pr-review-authenticity.ts e .claude/hooks/pr-create-review.mjs concordam byte-a-byte", () => {
    assert.equal(SELF_REVIEW_MARKER, HOOK_SELF_REVIEW_MARKER);
  });
});

function comment(id: string, body: string): PrCommentNode {
  return { id, body };
}

describe("classifyReviewComment", () => {
  it("comentário com o marcador de self-review -> 'self-review'", () => {
    const body = `${SELF_REVIEW_MARKER}\n\nSelf-review do autor (Agent tool indisponível nesta sessão).`;
    assert.equal(classifyReviewComment(body), "self-review");
  });

  it("comentário no formato de dispatch real -> 'independent-review'", () => {
    const body = "Review automatizado (1 agente, effort low — desconto overnight): sem findings P0/P1/P2.";
    assert.equal(classifyReviewComment(body), "independent-review");
  });

  it("effort=max também casa 'independent-review'", () => {
    const body = "Review automatizado (5 agentes, effort max): 2 findings P2.";
    assert.equal(classifyReviewComment(body), "independent-review");
  });

  it("marcador de self-review presente VENCE, mesmo citando o texto de review real", () => {
    // Cenário defensivo: uma sessão que ecoasse o prefixo por engano ainda é
    // pega pelo marcador, que é a fonte de verdade (docstring do módulo).
    const body = `${SELF_REVIEW_MARKER}\n\nReview automatizado (1 agente, effort low): sem findings.`;
    assert.equal(classifyReviewComment(body), "self-review");
  });

  it("comentário qualquer (comentário de progresso, dúvida do editor) -> 'other'", () => {
    assert.equal(classifyReviewComment("Só um comentário normal na PR."), "other");
  });

  it("body ausente/não-string -> 'other', nunca lança", () => {
    assert.equal(classifyReviewComment(undefined), "other");
    assert.equal(classifyReviewComment(null), "other");
    assert.equal(classifyReviewComment(42), "other");
  });

  it("'Review automatizado' no MEIO do texto (não no início) -> 'other', evita casar citação incidental", () => {
    const body = "Alguém mencionou que o 'Review automatizado' de PRs antigos era diferente.";
    assert.equal(classifyReviewComment(body), "other");
  });

  // #6820 (fleet review do #6732): a checagem original era `body.includes
  // (SELF_REVIEW_MARKER)` — substring solta, sem a mesma âncora que o regex
  // de review independente já tinha. Um review real que discutisse este
  // módulo em prosa (ex: uma PR futura editando este mesmo arquivo) citaria
  // o marcador NO MEIO da explicação e seria classificado como self-review
  // por engano — falso-negativo pro lado que autoriza merge.
  it("SELF_REVIEW_MARKER citado NO MEIO de um review real (não em linha própria) -> 'other', não 'self-review'", () => {
    const body =
      `Review automatizado (1 agente, effort low): sem findings. ` +
      `Nota: este PR adiciona o marcador ${SELF_REVIEW_MARKER} usado pelo gate do #6732.`;
    assert.equal(classifyReviewComment(body), "independent-review");
  });

  it("SELF_REVIEW_MARKER em linha PRÓPRIA (mesmo com texto ao redor) -> 'self-review'", () => {
    const body = `Algum preâmbulo.\n${SELF_REVIEW_MARKER}\nSelf-review do autor, sem agente independente.`;
    assert.equal(classifyReviewComment(body), "self-review");
  });

  it("SELF_REVIEW_MARKER com espaços ao redor na própria linha ainda conta (trim)", () => {
    const body = `  ${SELF_REVIEW_MARKER}  \nSelf-review do autor.`;
    assert.equal(classifyReviewComment(body), "self-review");
  });
});

describe("evaluatePrReviewAuthenticity — regressão #6732: self-review nunca vira pass", () => {
  it("comments undefined (payload sem o campo) => 'error', nunca 'pass'", () => {
    const result = evaluatePrReviewAuthenticity(undefined);
    assert.equal(result.verdict, "error");
    assert.equal(isPrReviewAuthenticityGreen(result), false);
  });

  it("comments null => 'error', nunca 'pass'", () => {
    const result = evaluatePrReviewAuthenticity(null);
    assert.equal(result.verdict, "error");
  });

  it("comments não é array (ex: objeto único) => 'error'", () => {
    const result = evaluatePrReviewAuthenticity({ id: "1", body: "x" });
    assert.equal(result.verdict, "error");
  });

  it("array vazio (PR sem nenhum comentário) => 'no_review'", () => {
    const result = evaluatePrReviewAuthenticity([]);
    assert.equal(result.verdict, "no_review");
    assert.equal(isPrReviewAuthenticityGreen(result), false);
  });

  it("único comentário é self-review => 'self_review', NUNCA 'pass' (o bug central da issue)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", `${SELF_REVIEW_MARKER}\n\nSelf-review do autor.`),
    ]);
    assert.equal(result.verdict, "self_review");
    assert.equal(result.matchedCommentId, "c1");
    assert.equal(isPrReviewAuthenticityGreen(result), false);
  });

  it("único comentário é review independente de verdade => 'pass'", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", "Review automatizado (1 agente, effort low — desconto overnight): sem findings P0/P1/P2."),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(result.matchedCommentId, "c1");
    assert.equal(isPrReviewAuthenticityGreen(result), true);
  });

  it("comentários não-review misturados com o review real -> ignora os irrelevantes", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", "Abrindo esta PR pra resolver a issue."),
      comment("c2", "Review automatizado (1 agente, effort low): sem findings."),
      comment("c3", "Obrigado!"),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(result.matchedCommentId, "c2");
  });

  it("self-review MAIS RECENTE que um review independente antigo -> 'self_review' (o estado atual é o que importa)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("old", "Review automatizado (1 agente, effort low): sem findings."),
      comment("new", `${SELF_REVIEW_MARKER}\n\nSelf-review após novo commit.`),
    ]);
    assert.equal(result.verdict, "self_review");
    assert.equal(result.matchedCommentId, "new");
  });

  it("review independente MAIS RECENTE que um self-review antigo -> 'pass' (revisão real veio depois)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("old", `${SELF_REVIEW_MARKER}\n\nSelf-review inicial.`),
      comment("new", "Review automatizado (1 agente, effort low): sem findings."),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(result.matchedCommentId, "new");
  });

  it("elemento null/primitivo misturado no array -> ignorado, nunca lança (payload malformado por item)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", "Comentário normal."),
      null,
      42,
      "string solta",
      comment("c2", "Review automatizado (1 agente, effort low): sem findings."),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(result.matchedCommentId, "c2");
  });

  it("nenhum comentário casa formato de review (só conversa normal) -> 'no_review'", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", "LGTM pra mim."),
      comment("c2", "Obrigado pela PR."),
    ]);
    assert.equal(result.verdict, "no_review");
  });
});
