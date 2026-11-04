/**
 * test/route-reason-guard.test.ts (#7288 Parte A)
 *
 * Cobre `scripts/lib/route-reason-guard.ts` — `detectNonDateReason`. O
 * corpus principal é o item explícito do "Escopo" da #7288: "os 11 motivos
 * reais desta auditoria como corpus de regressão... o último item é o que
 * fecha o loop do #633 — os casos existem, medidos, e não precisam ser
 * inventados." A auditoria original mediu 11 casos no total; só 10 têm
 * número de issue citado explicitamente na tabela de motivos da #7288 (ver
 * docstring de `route-reason-guard.ts`) — esses 10, incluindo `#7201`
 * (marcado como menos certo na tabela original, mas MANTIDO aqui — ver
 * abaixo), são o corpus verificável usado neste arquivo. Cada caso abaixo é
 * uma paráfrase fiel do motivo real citado na issue (mesma
 * família/vocabulário), mapeado à issue original.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNonDateReason } from "../scripts/lib/route-reason-guard.ts";

describe("detectNonDateReason — corpus de regressão da auditoria #7288 (10 motivos reais nomeados, de 11 totais medidos)", () => {
  const dependencyCases: Array<[string, string]> = [
    ["#6771", "segurar até o #6716 fechar antes de reavaliar"],
    ["#7043", "mesma cautela que já adia #6621/#6623 — segurar até o cluster fechar"],
    ["#6624", "mesma cautela do cluster #6621/#6623"],
  ];
  for (const [issue, reason] of dependencyCases) {
    it(`${issue}: "${reason}" -> categoria dependencia`, () => {
      const finding = detectNonDateReason(reason);
      assert.ok(finding, "esperava um finding");
      assert.equal(finding?.category, "dependencia");
      assert.match(finding?.message ?? "", /depends-on/);
    });
  }

  const conditionalCases: Array<[string, string]> = [
    ["#7036", "só morde quando a assinatura da API voltar a funcionar"],
    ["#6783", "reavaliar só se a assinatura recorrer"],
  ];
  for (const [issue, reason] of conditionalCases) {
    it(`${issue}: "${reason}" -> categoria gatilho-condicional`, () => {
      const finding = detectNonDateReason(reason);
      assert.ok(finding, "esperava um finding");
      assert.equal(finding?.category, "gatilho-condicional");
      assert.match(finding?.message ?? "", /track bloqueada/);
    });
  }

  const scopeCases: Array<[string, string]> = [
    ["#7206", "fatia própria — merece issue dedicada, não cabe nesta rodada"],
    ["#7204", "grande demais pra uma unidade de rodada, fatiar depois"],
    ["#7137", "escopo residual — fatia própria do trabalho maior"],
    ["#7201", "fatia própria do épico, tamanho grande demais"],
  ];
  for (const [issue, reason] of scopeCases) {
    it(`${issue}: "${reason}" -> categoria escopo`, () => {
      const finding = detectNonDateReason(reason);
      assert.ok(finding, "esperava um finding");
      assert.equal(finding?.category, "escopo");
      assert.match(finding?.message ?? "", /gh issue create/);
    });
  }

  // O 10º (e último) motivo NOMEADO real (#6674) era EM BRANCO — não tem
  // padrão de texto pra detectar (é ausência, não conteúdo). A auditoria
  // original mediu 11 casos no total; #6674 fecha os 10 que têm número de
  // issue citado explicitamente na tabela de origem (ver docstring do
  // describe acima e de route-reason-guard.ts). `detectNonDateReason` não
  // cobre este caso de propósito: `routeIssue` (scripts/route-issue.ts)
  // recusa reason vazio ANTES de chamar esta função, incondicionalmente
  // (sem --force possível) — ver describe("routeIssue — reason
  // obrigatório...") em test/issue-route.test.ts.
  it("motivo em branco não é responsabilidade desta função (null, nunca lança)", () => {
    assert.equal(detectNonDateReason(""), null);
  });
});

describe("detectNonDateReason — razão que É uma data legítima passa", () => {
  it("razão que só descreve o EVENTO externo esperado (sem citar #N nem gatilho vago) não é recusada", () => {
    assert.equal(detectNonDateReason("aguardando resposta da Beehiiv sobre o plano Scale"), null);
    assert.equal(detectNonDateReason("aguardando o fechamento do ciclo Clarice T1-W4"), null);
  });
});

describe("detectNonDateReason — ordem de checagem quando mais de 1 padrão bate", () => {
  it('"mesma cautela que #6621" bate dependencia (mais especifica) e nao gatilho-condicional', () => {
    const finding = detectNonDateReason("mesma cautela que #6621, segurar até fechar");
    assert.equal(finding?.category, "dependencia");
  });
});

// #12167 — `#N` citado como CONTEXTO (PR que já mergeou) não é dependência;
// só conta com verbo de condição na mesma oração.
describe("detectNonDateReason — #N só é dependência com verbo de condição (#12167)", () => {
  it("razão real da rodada 261104b: 'PR #N mergeada; reavaliar em DATA' passa", () => {
    assert.equal(detectNonDateReason("PR #12129 mergeada; reavaliar em 2026-12-01"), null);
    assert.equal(
      detectNonDateReason("PR #12129 mergeada (teste A/B do assunto no ar). Reavaliar o resultado em 2026-12-01"),
      null,
    );
    assert.equal(detectNonDateReason("reconciliação diária (#6198): marcador ainda futuro"), null);
  });

  const conditionCases = [
    "aguardando #12000",
    "aguardando o PR #12000 mergear",
    "depende de #7113",
    "depois que #6798 fechar",
    "só após o #6798",
    "bloqueada por #7113; reavaliar em 2026-12-01",
    "espera #7113 ser resolvida",
    "esperando #7113",
    "condicionado ao #7113",
  ];
  for (const reason of conditionCases) {
    it(`"${reason}" continua recusada como dependencia`, () => {
      assert.equal(detectNonDateReason(reason)?.category, "dependencia");
    });
  }

  it("contexto e condição em orações separadas: só a oração com verbo conta", () => {
    // PR citado como contexto numa oração, e a condição real (data) em outra.
    assert.equal(detectNonDateReason("PR #12129 mergeada — aguardar 2 semanas de dados, reavaliar em 2026-12-01"), null);
    // Oração com #N e verbo de espera: recusa, mesmo com o PR de contexto na outra.
    assert.equal(
      detectNonDateReason("PR #12129 mergeada; aguardando #12130 antes de reavaliar")?.category,
      "dependencia",
    );
  });

  it("'até DATA' na oração do PR de contexto é a data, não espera por #N", () => {
    assert.equal(detectNonDateReason("PR #12129 mergeada, reavaliar até 2026-12-01"), null);
    assert.equal(detectNonDateReason("PR #12129 mergeada, olhar de novo depois de 01/12"), null);
    // Verbo de espera real na mesma oração continua recusando.
    assert.equal(detectNonDateReason("aguardando #12130 até 2026-12-01")?.category, "dependencia");
  });

  it("#12215: #N entre parênteses na oração do verbo de condição continua recusado", () => {
    assert.equal(
      detectNonDateReason("aguardando o merge da PR (#12129); reavaliar em 2026-12-01")?.category,
      "dependencia",
    );
    assert.equal(
      detectNonDateReason("depende do fix de deploy (#9001) — reavaliar em 2026-12-01")?.category,
      "dependencia",
    );
    assert.equal(detectNonDateReason("esperando o deploy [#9001, #9002]")?.category, "dependencia");
    assert.equal(detectNonDateReason("aguardando os dois fixes (#9001 e #9002)")?.category, "dependencia");
    // casos já suportados seguem iguais
    assert.equal(detectNonDateReason("PR #12129 mergeada; reavaliar em 2026-12-01"), null);
    assert.equal(detectNonDateReason("aguardando #12000")?.category, "dependencia");
    // atribuição só-#N SEM verbo na oração segue sendo contexto
    assert.equal(detectNonDateReason("reconciliação diária (#6198): marcador ainda futuro"), null);
    assert.equal(detectNonDateReason("PR mergeada (#12129); reavaliar em 2026-12-01"), null);
  });

  it("'adicionar' não é lido como 'adiar'", () => {
    assert.equal(detectNonDateReason("PR #12129 vai adicionar a métrica; reavaliar em 2026-12-01"), null);
  });
});

// ─── Limitações conhecidas — documentadas, NÃO consertadas (#7316 review) ──
//
// Achado do review do #7316 (comment-analyzer/code-reviewer): o detector é
// regex sobre vocabulário observado, não entendimento semântico — ele
// erra dos dois lados, de forma medida e aceita (ver docstring de
// route-reason-guard.ts, seção "Falsos positivos/negativos conhecidos").
// Registrado aqui como comportamento ATUAL documentado, não como bug a
// corrigir sem antes medir a taxa real em produção.

describe("detectNonDateReason — limitações conhecidas (falso positivo/negativo aceitos)", () => {
  it("FALSO POSITIVO: razão com data real mas vocabulário parecido com gatilho condicional é recusada mesmo assim", () => {
    // A razão TEM uma data real (2026-09-10) mas também usa "só ... se",
    // que CONDITIONAL_RE não distingue de um gatilho vago sem data. O
    // escape hatch (--force, em routeIssue) existe exatamente pra este
    // caso — não é um bug do regex, é o limite conhecido da abordagem.
    const finding = detectNonDateReason("só volto a olhar isso se a Beehiiv não responder até 2026-09-10");
    assert.equal(finding?.category, "gatilho-condicional");
  });

  it("FALSO POSITIVO: razão com data real mas vocabulário parecido com escopo é recusada mesmo assim", () => {
    const finding = detectNonDateReason("ficou grande demais até fecharmos a fatia em 2026-09-09");
    assert.equal(finding?.category, "escopo");
  });

  it("FALSO NEGATIVO: razão vaga sem #N e sem os 2 gatilhos de texto passa batida", () => {
    // Nenhum dos 3 padrões medidos na auditoria original cobre "vaguidão"
    // em geral — só o vocabulário específico observado nos 10 casos reais.
    // Uma razão vaga que não usa esse vocabulário nunca é pega.
    assert.equal(detectNonDateReason("ainda não sei bem quando isso vai fazer sentido"), null);
  });
});
