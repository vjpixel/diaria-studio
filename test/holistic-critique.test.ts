/**
 * test/holistic-critique.test.ts (#7981)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCritiqueVote, runHolisticCritique, buildCritiquePrompt } from "../scripts/lib/holistic-critique.ts";

describe("parseCritiqueVote (#7981)", () => {
  it("parseia VEREDITO: APROVA + JUSTIFICATIVA", () => {
    const vote = parseCritiqueVote("VEREDITO: APROVA\nJUSTIFICATIVA: texto soa natural.");
    assert.deepEqual(vote, { passes: true, reasoning: "texto soa natural." });
  });

  it("parseia VEREDITO: REJEITA", () => {
    const vote = parseCritiqueVote("VEREDITO: REJEITA\nJUSTIFICATIVA: soa robótico.");
    assert.equal(vote?.passes, false);
  });

  it("case-insensitive no marcador", () => {
    const vote = parseCritiqueVote("veredito: aprova\njustificativa: ok");
    assert.equal(vote?.passes, true);
  });

  it("retorna null se não achar o marcador VEREDITO — resposta malformada NUNCA vira aprovação/rejeição por default", () => {
    const vote = parseCritiqueVote("Acho que está bom, mas não tenho certeza.");
    assert.equal(vote, null);
  });

  it("sem JUSTIFICATIVA explícita, usa o texto inteiro como reasoning (fallback)", () => {
    const vote = parseCritiqueVote("VEREDITO: APROVA\nsem marcador de justificativa aqui");
    assert.equal(vote?.passes, true);
    assert.ok(vote?.reasoning.includes("sem marcador"));
  });
});

describe("runHolisticCritique (#7981)", () => {
  it("3 votos concordantes (APROVA): consistent=true, majorityPasses=true", () => {
    const callFn = () => "VEREDITO: APROVA\nJUSTIFICATIVA: ok.";
    const result = runHolisticCritique("prompt", { cwd: "/tmp" }, 3, callFn as any);
    assert.equal(result.votes.length, 3);
    assert.equal(result.consistent, true);
    assert.equal(result.majorityPasses, true);
  });

  it("3 votos concordantes (REJEITA): consistent=true, majorityPasses=false", () => {
    const callFn = () => "VEREDITO: REJEITA\nJUSTIFICATIVA: não.";
    const result = runHolisticCritique("prompt", { cwd: "/tmp" }, 3, callFn as any);
    assert.equal(result.consistent, true);
    assert.equal(result.majorityPasses, false);
  });

  it("divergência entre os 3 votos: consistent=false, majorityPasses=null (bloqueio automático, NUNCA decide por maioria simples)", () => {
    let call = 0;
    const responses = ["VEREDITO: APROVA\nJUSTIFICATIVA: a", "VEREDITO: APROVA\nJUSTIFICATIVA: b", "VEREDITO: REJEITA\nJUSTIFICATIVA: c"];
    const callFn = () => responses[call++];
    const result = runHolisticCritique("prompt", { cwd: "/tmp" }, 3, callFn as any);
    assert.equal(result.consistent, false);
    assert.equal(result.majorityPasses, null);
  });

  it("1 voto malformado entre 3 já invalida consistência (nunca ignora o voto ruim e decide 2 de 2)", () => {
    let call = 0;
    const responses = ["VEREDITO: APROVA\nJUSTIFICATIVA: a", "resposta sem marcador nenhum", "VEREDITO: APROVA\nJUSTIFICATIVA: c"];
    const callFn = () => responses[call++];
    const result = runHolisticCritique("prompt", { cwd: "/tmp" }, 3, callFn as any);
    assert.equal(result.consistent, false);
    assert.equal(result.majorityPasses, null);
    assert.equal(result.votes[1], null);
  });

  it("chama callFn exatamente `votesCount` vezes", () => {
    let calls = 0;
    const callFn = () => {
      calls++;
      return "VEREDITO: APROVA\nJUSTIFICATIVA: ok";
    };
    runHolisticCritique("prompt", { cwd: "/tmp" }, 5, callFn as any);
    assert.equal(calls, 5);
  });
});

describe("buildCritiquePrompt (#7981)", () => {
  it("inclui o corpo do critic + o candidato + o formato de resposta exigido", () => {
    const prompt = buildCritiquePrompt("Instruções do critic aqui.", "candidato X");
    assert.ok(prompt.includes("Instruções do critic aqui."));
    assert.ok(prompt.includes("candidato X"));
    assert.ok(prompt.includes("VEREDITO: APROVA"));
    assert.ok(prompt.includes("VEREDITO: REJEITA"));
  });
});
