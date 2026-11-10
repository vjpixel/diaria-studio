/**
 * test/overnight-selfreview-note-12677.test.ts
 *
 * #12677 — rodada overnight 261110c: threads de self-review "Confiança alta,
 * P3" que eram notas informativas (sem defeito a corrigir) ficaram em `held`
 * no `--low-severity-only` e travaram o trem (lotes #12623/#12627, PRs #12648 e
 * #12651) até o coordenador resolvê-las por `--thread ID`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFindingSeverity } from "../scripts/resolve-review-threads.ts";
import { AUTO_REVIEW_MARKER } from "../scripts/lib/auto-review-marker.ts";

const withMarker = (s: string) => `${s}\n\n${AUTO_REVIEW_MARKER}`;

// Os 3 textos da issue, como postados na rodada 261110c (PRs #12627/#12623).
const NAO_BLOQUEIA_DEPLOY = withMarker(
  "Confiança alta, P3: a mudança só chega ao leitor depois do deploy do Worker onboarding-form, que não foi feito nesta rodada (por ordem do coordenador). Fica pendente pós-merge; sem ele a página em produção continua prometendo o e-mail. Não bloqueia o merge.",
);
const ESCOPO_PARCIAL_REFS =
  "Confiança alta, P2: escopo parcial, declarado como REFS. O item 5 da issue (Artigo Especial, retrospectiva mensal/anual e perfil pessoal) não está no diff. Precisa de follow-up para essas superfícies.";
const DEPLOY_PENDENTE =
  "Confiança alta, P3: deploy pendente pós-merge do Worker onboarding-form; sem ele a página em produção continua prometendo o e-mail.";

describe("classifyFindingSeverity: nota informativa (#12677)", () => {
  it("REGRESSÃO: 'Não bloqueia o merge.' fechando o finding P3 de confiança alta sai low", () => {
    assert.equal(classifyFindingSeverity(NAO_BLOQUEIA_DEPLOY), "low");
    assert.equal(classifyFindingSeverity("Confiança alta, P3: limite aceito.\n\nNão bloqueia o merge."), "low");
    assert.equal(classifyFindingSeverity("Confiança alta, P2: nota de escopo. Nao bloqueia merge"), "low");
  });

  it("os 3 textos com o rótulo `nota` no prefixo (forma do item 7 das regras) saem low", () => {
    for (const body of [NAO_BLOQUEIA_DEPLOY, ESCOPO_PARCIAL_REFS, DEPLOY_PENDENTE]) {
      const tagged = body.replace(/^(Confiança alta, P[23]):/, "$1, nota:");
      assert.notEqual(tagged, body, "fixture precisa ter o prefixo");
      assert.equal(classifyFindingSeverity(withMarker(tagged)), "low", tagged);
    }
    assert.equal(classifyFindingSeverity("Nota, P3: deploy pendente pós-merge"), "low");
    assert.equal(classifyFindingSeverity("**Confiança:** alta, P3 (informativo): escopo parcial em REFS"), "low");
  });

  it("sem rótulo nem frase de fecho, confiança alta segue retida (fail-closed)", () => {
    assert.equal(classifyFindingSeverity(ESCOPO_PARCIAL_REFS), "high");
    assert.equal(classifyFindingSeverity(DEPLOY_PENDENTE), "high");
  });

  it("descrição de defeito com 'não bloqueia o merge' no meio da frase segue high", () => {
    assert.equal(classifyFindingSeverity("Confiança alta, P3: o gate não bloqueia o merge quando o CI falha."), "high");
    assert.equal(classifyFindingSeverity("Confiança alta, P3: Não bloqueia o merge quando o CI falha."), "high");
    assert.equal(classifyFindingSeverity("Confiança alta, P3: isso não bloqueia o merge."), "high");
  });

  it("`nota` só vale no prefixo: no corpo é texto do finding", () => {
    assert.equal(classifyFindingSeverity("Confiança alta, P3: a nota fiscal sai sem CNPJ"), "high");
  });

  it("nota nunca rebaixa P0/P1", () => {
    assert.equal(classifyFindingSeverity("Confiança alta, P1, nota: deploy pendente"), "high");
    assert.equal(classifyFindingSeverity("Confiança média, P0: leak.\n\nNão bloqueia o merge."), "high");
  });

  it("1ª linha sem tag segue untagged mesmo com a frase de fecho", () => {
    assert.equal(classifyFindingSeverity("achado sem tag\n\nNão bloqueia o merge."), "untagged");
  });
});
