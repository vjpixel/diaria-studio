/**
 * test/pr-review-authenticity.test.ts (#6732, marcador com nonce #6849)
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
 * dispatch real.
 *
 * #6849 (01/09/2026): esse formato de prosa deixou de ser reconhecido —
 * achado ao vivo que o revisor EXTERNO legítimo (`hermes/scripts/continuo-
 * pr-review.sh`) é instruído a produzir a MESMA prosa, então nenhum regex
 * distinguia fabricação de review real. O sinal positivo agora é um
 * marcador `<!-- continuo-review: run=... at=... -->` com identidade de
 * execução, gerada só pelo script externo. O teste que mais importa aqui:
 * o texto fabricado EXATO do #6713 (que antes casava `INDEPENDENT_REVIEW_RE`)
 * tem que classificar como `"other"`, nunca `"independent-review"`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewComment,
  evaluatePrReviewAuthenticity,
  extractIndependentReviewVerdict,
  extractIndependentReviewHeadSha,
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

const MARKER = "<!-- continuo-review: run=abc123 at=2026-09-01T02:00:00Z -->";

describe("classifyReviewComment", () => {
  it("comentário com o marcador de self-review -> 'self-review'", () => {
    const body = `${SELF_REVIEW_MARKER}\n\nSelf-review do autor (Agent tool indisponível nesta sessão).`;
    assert.equal(classifyReviewComment(body), "self-review");
  });

  it("comentário com o marcador de review independente (run=/at=) -> 'independent-review'", () => {
    const body = `Review automatizado (1 agente, effort low): sem findings P0/P1/P2.\n${MARKER}`;
    assert.equal(classifyReviewComment(body), "independent-review");
  });

  it("run=/at= com valores/formato distintos ainda casam — só a FORMA é validada, não o conteúdo", () => {
    const body = "<!-- continuo-review: run=hermes-cron-xyz-789 at=2026-09-01T04:00:00.000Z -->";
    assert.equal(classifyReviewComment(body), "independent-review");
  });

  // #6849 — regressão central: o texto fabricado EXATO medido no #6713
  // (que casava `INDEPENDENT_REVIEW_RE`, o regex de prosa agora removido)
  // não tem o marcador — não pode mais classificar como review real.
  it("REGRESSÃO (#6849): texto fabricado exato do #6713 (sem marcador) -> 'other', NUNCA 'independent-review'", () => {
    const body = "Review automatizado (1 agente, effort low — desconto overnight): sem findings.";
    assert.equal(classifyReviewComment(body), "other");
  });

  // #6849: o formato do #6715 (outra fabricação, formato diferente) também
  // nunca teve o marcador — mesma garantia, texto totalmente distinto.
  it("REGRESSÃO (#6849): texto fabricado do #6715 (sem marcador) -> 'other'", () => {
    const body = "Code review (pr-review-toolkit:code-reviewer, sonnet, diff ...): sem findings.";
    assert.equal(classifyReviewComment(body), "other");
  });

  it("marcador de self-review presente VENCE, mesmo com o marcador de review independente também presente", () => {
    // Cenário defensivo: se os dois aparecerem (nunca deveria acontecer em
    // produção), o marcador de self-review é a fonte de verdade — mesma
    // regra que já valia pro regex de prosa antigo.
    const body = `${SELF_REVIEW_MARKER}\n\n${MARKER}`;
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

  it("'continuo-review: run=' citado em PROSA, não em linha própria -> 'other', evita casar citação incidental", () => {
    const body = "Este PR adiciona o marcador <!-- continuo-review: run=X at=Y --> usado pelo gate do #6849, mas não é ele mesmo um review.";
    assert.equal(classifyReviewComment(body), "other");
  });

  // REGRESSÃO (review da PR #6903, P2 confiança alta): a notação de
  // PLACEHOLDER usada na própria docstring do módulo (`run=<id> at=<iso>`)
  // não pode colar no regex mesmo citada em LINHA PRÓPRIA — um review
  // futuro que discuta este mecanismo em prosa (ex: revisando esta mesma
  // PR) citaria essa notação exatamente assim, e `\S+` sem restrição em
  // `at=` colava nela por acidente (achado ao vivo: `<iso>` é não-espaço,
  // então `run=\S+ at=\S+` casava). Fix: `at=` exige o formato ISO 8601
  // UTC exato que `date -u +%Y-%m-%dT%H:%M:%SZ` produz — `<iso>` nunca bate.
  it("REGRESSÃO (#6903): notação de placeholder da docstring ('run=<id> at=<iso>') em linha própria -> 'other', não 'independent-review'", () => {
    const body = "<!-- continuo-review: run=<id> at=<iso> -->";
    assert.equal(classifyReviewComment(body), "other");
  });

  // #6820 (fleet review do #6732), mesma disciplina aplicada ao marcador
  // positivo pelo #6849: SELF_REVIEW_MARKER citado NO MEIO de um review
  // real (não em linha própria) não deve virar self-review por engano.
  it("SELF_REVIEW_MARKER citado NO MEIO de um review real (não em linha própria) -> 'independent-review', não 'self-review'", () => {
    const body =
      `Review automatizado (1 agente, effort low): sem findings. ` +
      `Nota: este PR adiciona o marcador ${SELF_REVIEW_MARKER} usado pelo gate do #6732.\n${MARKER}`;
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

  it("marcador de review independente com espaços ao redor na própria linha ainda conta (trim)", () => {
    const body = `  ${MARKER}  \nSem findings.`;
    assert.equal(classifyReviewComment(body), "independent-review");
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

  // #6956: 'no_review' precisa deixar EXPLÍCITO, no próprio `reason`, que só
  // significa "sem o marcador que ESTE gate reconhece" — não "sem review em
  // geral". Medido ao vivo: PRs #6955/#6951/#6950 tiveram review real
  // (sessão coordenadora via ferramenta Agent, findings postados em prosa) e
  // saíram 'no_review' porque só `continuo-pr-review.sh` gera o marcador.
  it("#6956: reason de 'no_review' cita explicitamente o escopo (continuo-pr-review.sh, não 'sem review' em geral)", () => {
    const result = evaluatePrReviewAuthenticity([]);
    assert.equal(result.verdict, "no_review");
    assert.match(result.reason, /continuo-pr-review\.sh/);
    assert.match(result.reason, /#6956/);
  });

  it("#6956: review real de sessão interativa (prosa sem marcador) também sai 'no_review' com o mesmo reason explícito", () => {
    const result = evaluatePrReviewAuthenticity([
      comment(
        "c1",
        "Code review (pr-review-toolkit:code-reviewer, sonnet, diff base..HEAD): P0 reproduzido em X — ver linha 42.",
      ),
    ]);
    assert.equal(result.verdict, "no_review");
    assert.match(result.reason, /continuo-pr-review\.sh/);
  });

  it("único comentário é self-review => 'self_review', NUNCA 'pass' (o bug central da issue)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", `${SELF_REVIEW_MARKER}\n\nSelf-review do autor.`),
    ]);
    assert.equal(result.verdict, "self_review");
    assert.equal(result.matchedCommentId, "c1");
    assert.equal(isPrReviewAuthenticityGreen(result), false);
  });

  it("único comentário é review independente de verdade (com marcador run=/at=) => 'pass'", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", `Review automatizado (1 agente, effort low): sem findings P0/P1/P2.\n${MARKER}`),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(result.matchedCommentId, "c1");
    assert.equal(isPrReviewAuthenticityGreen(result), true);
  });

  // #6849: regressão central movida pra cá também — o texto que ANTES do
  // marcador satisfazia o gate (#6713/#6715) agora nunca vira 'pass'.
  it("REGRESSÃO (#6849): único comentário é o texto fabricado do #6713 (sem marcador) => 'no_review', NUNCA 'pass'", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", "Review automatizado (1 agente, effort low — desconto overnight): sem findings."),
    ]);
    assert.equal(result.verdict, "no_review");
    assert.equal(isPrReviewAuthenticityGreen(result), false);
  });

  it("comentários não-review misturados com o review real -> ignora os irrelevantes", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("c1", "Abrindo esta PR pra resolver a issue."),
      comment("c2", `Review automatizado (1 agente, effort low): sem findings.\n${MARKER}`),
      comment("c3", "Obrigado!"),
    ]);
    assert.equal(result.verdict, "pass");
    assert.equal(result.matchedCommentId, "c2");
  });

  it("self-review MAIS RECENTE que um review independente antigo -> 'self_review' (o estado atual é o que importa)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("old", `Review automatizado (1 agente, effort low): sem findings.\n${MARKER}`),
      comment("new", `${SELF_REVIEW_MARKER}\n\nSelf-review após novo commit.`),
    ]);
    assert.equal(result.verdict, "self_review");
    assert.equal(result.matchedCommentId, "new");
  });

  it("review independente MAIS RECENTE que um self-review antigo -> 'pass' (revisão real veio depois)", () => {
    const result = evaluatePrReviewAuthenticity([
      comment("old", `${SELF_REVIEW_MARKER}\n\nSelf-review inicial.`),
      comment("new", `Review automatizado (1 agente, effort low): sem findings.\n${MARKER}`),
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
      comment("c2", `Review automatizado (1 agente, effort low): sem findings.\n${MARKER}`),
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

// #6926: marcador ganha campo opcional verdict=approve|reject — o gate de
// merge de continuo-pr-review.sh lê ESTE veredito estruturado, não prosa.
describe("extractIndependentReviewVerdict (#6926)", () => {
  it("marcador com verdict=approve -> 'approve'", () => {
    const body = "Review automatizado: sem findings.\n<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=approve -->";
    assert.equal(extractIndependentReviewVerdict([comment("c1", body)]), "approve");
  });

  it("marcador com verdict=reject -> 'reject'", () => {
    const body = "Achei um bug P1.\n<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=reject -->";
    assert.equal(extractIndependentReviewVerdict([comment("c1", body)]), "reject");
  });

  it("marcador SEM campo verdict= (formato legado pré-#6926) -> null, nunca aprovação implícita", () => {
    assert.equal(extractIndependentReviewVerdict([comment("c1", `x\n${MARKER}`)]), null);
  });

  it("nenhum comentário de review -> null", () => {
    assert.equal(extractIndependentReviewVerdict([comment("c1", "conversa normal")]), null);
  });

  it("comments não é array -> null, nunca lança", () => {
    assert.equal(extractIndependentReviewVerdict(undefined), null);
    assert.equal(extractIndependentReviewVerdict(null), null);
  });

  it("self-review mais recente que review independente anterior -> null (sinal vigente é o self-review)", () => {
    const result = extractIndependentReviewVerdict([
      comment("c1", `x\n<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=approve -->`),
      comment("c2", SELF_REVIEW_MARKER),
    ]);
    assert.equal(result, null);
  });

  it("valor inválido em verdict= (não approve/reject) não casa o grupo opcional -> trata como marcador sem campo, null", () => {
    const body = "<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=talvez -->";
    // O grupo opcional só casa "approve"/"reject" — "talvez" faz o `(?:...)?`
    // inteiro falhar em casar, então cai no formato SEM o campo (linha ainda
    // bate o resto do marcador só se o sufixo bater exatamente " -->").
    // Aqui o marcador não casa `INDEPENDENT_REVIEW_MARKER_RE` de jeito
    // nenhum (sufixo "verdict=talvez -->" não é nem o formato com campo
    // válido nem o formato sem campo) — evaluatePrReviewAuthenticity trataria
    // isso como comentário comum ("other"), então o resultado aqui é null
    // pela ausência de qualquer marcador reconhecido, não por rejeição
    // explícita do campo.
    assert.equal(extractIndependentReviewVerdict([comment("c1", body)]), null);
  });
});

// #6926 (P0/P1 do review da PR #6932): `head=<sha>` fecha a corrida do
// #5716 — o chamador NUNCA deve fabricar reviewedHeadSha a partir do HEAD
// atual; tem que vir do marcador que a revisão de fato cobriu.
describe("extractIndependentReviewHeadSha (#6926)", () => {
  it("marcador com head=<sha> -> extrai o sha", () => {
    const body = "<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=approve head=abc123 -->";
    assert.equal(extractIndependentReviewHeadSha([comment("c1", body)]), "abc123");
  });

  it("marcador SEM campo head= (formato legado pré-#6926) -> null, nunca assume HEAD atual", () => {
    assert.equal(extractIndependentReviewHeadSha([comment("c1", `x\n${MARKER}`)]), null);
  });

  it("marcador com verdict= mas sem head= -> verdict extraído normalmente, head null (campos independentes)", () => {
    const body = "<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=approve -->";
    const c = [comment("c1", body)];
    assert.equal(extractIndependentReviewVerdict(c), "approve");
    assert.equal(extractIndependentReviewHeadSha(c), null);
  });

  it("nenhum comentário de review -> null", () => {
    assert.equal(extractIndependentReviewHeadSha([comment("c1", "conversa normal")]), null);
  });

  it("comments não é array -> null, nunca lança", () => {
    assert.equal(extractIndependentReviewHeadSha(undefined), null);
    assert.equal(extractIndependentReviewHeadSha(null), null);
  });

  it("self-review mais recente que review independente anterior -> null (sinal vigente é o self-review)", () => {
    const result = extractIndependentReviewHeadSha([
      comment("c1", `x\n<!-- continuo-review: run=x at=2026-09-01T02:00:00Z verdict=approve head=abc123 -->`),
      comment("c2", SELF_REVIEW_MARKER),
    ]);
    assert.equal(result, null);
  });

  it("verdict e head do MESMO comentário mais recente, mesmo com comentário de review mais antigo diferente antes", () => {
    const c = [
      comment("c1", "<!-- continuo-review: run=old at=2026-08-31T00:00:00Z verdict=reject head=old-sha -->"),
      comment("c2", "<!-- continuo-review: run=new at=2026-09-01T02:00:00Z verdict=approve head=new-sha -->"),
    ];
    assert.equal(extractIndependentReviewVerdict(c), "approve");
    assert.equal(extractIndependentReviewHeadSha(c), "new-sha");
  });
});
