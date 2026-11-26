/**
 * #14197: um `---` DENTRO do corpo de um destaque fechava o bloco, e o resto
 * dele (Aprofunde, "Por que isso importa") caía no `pool`. Mudar o "Por que
 * isso importa" do D2 saía como plano PARCIAL `pool`: o d2 não era rechecado,
 * e o merge (desde a #14148) recusa o claim novo do d2 por estar fora do
 * escopo. O d2 ficava com o veredito antigo.
 *
 * Correção (opção B da issue): texto de destaque depois do `---` que fechou o
 * bloco, antes do próximo header, deixa a partição ambígua, e o plano sai
 * COMPLETO (mecanismo de `ambiguous` que já existia). A partição dos layouts
 * normais não muda: o box entre destaques segue no `pool`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeUnitHashes, partitionNewsletter, planFactCheckScope } from "../scripts/lib/fact-check-units.ts";

function newsletter(o: { d2Why?: string; hrInsideD2?: boolean; whyMarker?: string; boxText?: string } = {}): string {
  const d2Tail = [
    o.whyMarker ?? "Por que isso importa:",
    "",
    o.d2Why ?? "Relevância 2: 7% dos usuários.",
    "",
  ];
  return [
    "TÍTULO",
    "",
    "---",
    "",
    "**DESTAQUE 1 | 🔬 PESQUISA**",
    "",
    "**[Título do D1](https://example.com/d1)**",
    "",
    "Corpo do D1.",
    "",
    "Por que isso importa:",
    "",
    "Relevância 1.",
    "",
    "---",
    "",
    o.boxText ?? "**Box de livros entre D1 e D2.**",
    "",
    "---",
    "",
    "**DESTAQUE 2 | 🇧🇷 BRASIL**",
    "",
    "**[Título do D2](https://example.com/d2)**",
    "",
    "Corpo do D2.",
    "",
    ...(o.hrInsideD2 ? ["---", ""] : []),
    ...d2Tail,
    "---",
    "",
    "**DESTAQUE 3 | 🧠 CONCEITO**",
    "",
    "**[Título do D3](https://example.com/d3)**",
    "",
    "Corpo do D3.",
    "",
    "---",
    "",
    "RADAR",
    "",
    "**[Item do radar](https://example.com/r1)** grátis por 30 dias.",
    "",
  ].join("\n");
}

const SOURCES = { approvedUrls: ["https://example.com/d1", "https://example.com/d2", "https://example.com/d3"], manifest: [], extras: [] };

describe("#14197: `---` dentro de um destaque", () => {
  it("cenário da issue: 'Por que isso importa' do D2 muda depois de um `---` interno => plano COMPLETO, nunca parcial `pool`", () => {
    const before = computeUnitHashes(newsletter({ hrInsideD2: true }), "", SOURCES);
    const after = computeUnitHashes(newsletter({ hrInsideD2: true, d2Why: "Relevância 2: 9% dos usuários." }), "", SOURCES);
    assert.match(after.ambiguous ?? "", /`---` dentro de d2/);
    const scope = planFactCheckScope(before, after, { hasPreviousResult: true });
    assert.equal(scope.mode, "full");
    assert.notDeepEqual(scope.units, ["pool"]);
  });

  it("vale para o rótulo em negrito e para o Aprofunde", () => {
    assert.match(partitionNewsletter(newsletter({ hrInsideD2: true, whyMarker: "**Por que isso importa:**" })).ambiguous ?? "", /d2/);
    assert.match(partitionNewsletter(newsletter({ hrInsideD2: true, whyMarker: "Aprofunde:" })).ambiguous ?? "", /d2/);
  });

  it("layout normal (sem `---` interno): sem ambiguidade, partição igual, e o ajuste no D2 segue parcial d2", () => {
    const md = newsletter();
    const p = partitionNewsletter(md);
    assert.equal(p.ambiguous, undefined);
    assert.deepEqual(Object.keys(p.units).sort(), ["d1", "d2", "d3", "pool"]);
    assert.match(p.units.pool, /Box de livros/);
    assert.match(p.units.d2, /Por que isso importa/);
    const before = computeUnitHashes(md, "", SOURCES);
    const after = computeUnitHashes(newsletter({ d2Why: "Relevância 2: 9% dos usuários." }), "", SOURCES);
    const scope = planFactCheckScope(before, after, { hasPreviousResult: true });
    assert.equal(scope.mode, "partial");
    assert.deepEqual(scope.units, ["d2"]);
  });

  it("box entre destaques que só cita a expressão no meio da frase não é tratado como texto de destaque", () => {
    const md = newsletter({ boxText: "Leia o livro e entenda por que isso importa para você." });
    assert.equal(partitionNewsletter(md).ambiguous, undefined);
  });

  it("depois de um header de seção (RADAR), 'Por que isso importa' no pool não marca ambiguidade", () => {
    const md = newsletter().replace("grátis por 30 dias.", "grátis por 30 dias.\n\nPor que isso importa:\n\nx");
    assert.equal(partitionNewsletter(md).ambiguous, undefined);
  });
});
