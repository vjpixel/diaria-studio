/**
 * test/hub-fact-gate-5060.test.ts (#5060 Parte B1)
 *
 * Cobertura do gate mecânico de `scripts/lib/shared/hub-fact-gate.ts`: caso
 * feliz + 1 fixture por modo de falha (cronologia errada, parágrafo sem
 * âncora de data, link ausente de sourceEditions, data futura), MAIS um
 * regression guard rodando `checkHubFacts` contra os hubs REAIS de
 * `HUB_LOADERS` — nenhum deles deve acusar violação (o mecanismo é novo, o
 * conteúdo já publicado é o que motivou a issue a dizer "hoje correto, só
 * não há trava").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HubContent } from "../scripts/lib/shared/hub-page.ts";
import {
  checkChronologyConsistency,
  checkParagraphDateAnchors,
  checkSourceLinksCited,
  checkNoFutureDates,
  checkHubFacts,
  extractAbsoluteDates,
  extractOffsetEvents,
  recomputeHubFactGate,
} from "../scripts/lib/shared/hub-fact-gate.ts";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";

/** Fixture mínima e válida — mesmo padrão das `minimalHub`/`base` já usadas
 * em `test/build-hub-page.test.ts`/`test/brand-wordmark-site-4797.test.ts`.
 * Cada teste abaixo faz um spread + 1 alteração cirúrgica, nunca reescreve o
 * objeto inteiro — assim cada fixture testa exatamente UM modo de falha. */
function baseHub(overrides: Partial<HubContent> = {}): HubContent {
  return {
    slug: "teste-5060",
    title: "Teste",
    metaDescription: "Descrição de teste.",
    introHeading: "Pergunta de teste?",
    introParagraph: "Intro de teste, sem link nem cronologia.",
    sections: [
      {
        heading: "Seção",
        paragraphs: ["Em 1 de junho de 2026, [o evento aconteceu](https://diar.ia.br/p/edicao-teste)."],
      },
    ],
    faq: Array.from({ length: 6 }, (_, i) => ({ question: `Pergunta ${i + 1}?`, answer: `Resposta ${i + 1}.` })),
    sourceEditions: [{ date: "2026-06-01", title: "Edição de teste", url: "https://diar.ia.br/p/edicao-teste" }],
    publishedDate: "2026-06-01",
    updatedDate: "2026-06-01",
    footerNavUtm: { source: "hub-teste-5060", medium: "footer-nav" },
    methodologyNote: "O levantamento vem de 1 edição publicada em junho de 2026; os números saem do arquivo da diar.ia.br.",
    ...overrides,
  };
}

describe("#5060 Parte B1 — caso feliz", () => {
  it("hub mínimo bem formado não acusa nenhuma violação", () => {
    assert.deepEqual(checkHubFacts(baseHub()), []);
  });
});

describe("#5060 Parte B1 — check 1: cronologia derivada", () => {
  it("aceita 'N dias depois' que bate com a data absoluta citada", () => {
    const hub = baseHub({
      sections: [
        {
          heading: "Seção",
          paragraphs: [
            "Em 1 de junho de 2026, [o primeiro evento aconteceu](https://diar.ia.br/p/edicao-teste). 10 dias depois, em 11 de junho de 2026, veio a resposta.",
          ],
        },
      ],
    });
    assert.deepEqual(checkChronologyConsistency(hub), []);
  });

  it("rejeita 'N dias depois' que NÃO bate com a data absoluta citada — regression do bug real", () => {
    const hub = baseHub({
      sections: [
        {
          heading: "Seção",
          paragraphs: [
            "Em 1 de junho de 2026, [o primeiro evento aconteceu](https://diar.ia.br/p/edicao-teste). 10 dias depois, em 20 de junho de 2026, veio a resposta.",
          ],
        },
      ],
    });
    const errors = checkChronologyConsistency(hub);
    assert.ok(
      errors.some((e) => /"10 dias depois" a partir de 2026-06-01 deveria cair em 2026-06-11/.test(e) && /2026-06-20/.test(e)),
      errors.join("; "),
    );
  });

  it("extractAbsoluteDates: extenso e DD/MM/AAAA, na ordem", () => {
    const dates = extractAbsoluteDates("Em 3 de fevereiro de 2026 e depois em 15/03/2026.");
    assert.deepEqual(
      dates.map((d) => d.iso),
      ["2026-02-03", "2026-03-15"],
    );
  });

  it("extractOffsetEvents: dígito e por extenso, 'antes' é descartado", () => {
    const events = extractOffsetEvents("12 dias depois, sessenta e três dias mais tarde, 5 dias antes.");
    assert.deepEqual(
      events.map((e) => e.days),
      [12, 63],
    );
  });
});

describe("#5060 Parte B1 — check 2: link de edição existe em sourceEditions", () => {
  it("aceita link presente em sourceEditions", () => {
    assert.deepEqual(checkSourceLinksCited(baseHub()), []);
  });

  it("rejeita link ausente de sourceEditions — regression: typo de URL ou fonte não regenerada", () => {
    const hub = baseHub({
      sections: [
        {
          heading: "Seção",
          paragraphs: ["Em 1 de junho de 2026, [outro evento](https://diar.ia.br/p/edicao-que-nao-existe)."],
        },
      ],
    });
    const errors = checkSourceLinksCited(hub);
    assert.ok(
      errors.some((e) => e.includes("edicao-que-nao-existe") && /não existe em sourceEditions/.test(e)),
      errors.join("; "),
    );
  });
});

describe("#5060 Parte B1 — check 3: todo parágrafo tem âncora de data absoluta", () => {
  it("aceita parágrafo com data absoluta", () => {
    assert.deepEqual(checkParagraphDateAnchors(baseHub()), []);
  });

  it("rejeita parágrafo sem nenhuma data absoluta — regressão do #4917", () => {
    const hub = baseHub({ sections: [{ heading: "Seção", paragraphs: ["Um parágrafo qualquer, sem nenhuma data."] }] });
    const errors = checkParagraphDateAnchors(hub);
    assert.ok(
      errors.some((e) => e.startsWith("sections[0].paragraphs[0]") && /sem âncora de data absoluta/.test(e)),
      errors.join("; "),
    );
  });
});

describe("#5060 Parte B1 — check 4: nenhuma data no futuro em relação a updatedDate", () => {
  it("aceita data igual a updatedDate", () => {
    assert.deepEqual(checkNoFutureDates(baseHub()), []);
  });

  it("rejeita data posterior a updatedDate", () => {
    const hub = baseHub({
      sections: [
        {
          heading: "Seção",
          paragraphs: ["Em 1 de junho de 2026, [o evento aconteceu](https://diar.ia.br/p/edicao-teste), e em 15 de agosto de 2026 veio outro."],
        },
      ],
      updatedDate: "2026-06-01",
    });
    const errors = checkNoFutureDates(hub);
    assert.ok(
      errors.some((e) => /2026-08-15.*posterior a updatedDate \(2026-06-01\)/.test(e)),
      errors.join("; "),
    );
  });
});

describe("#5060 Parte B1 — checkHubFacts contra os hubs REAIS de HUB_LOADERS", () => {
  it("cobre TODO hub do registry, não uma lista escrita à mão", () => {
    assert.ok(Object.keys(HUB_LOADERS).length >= 4, "HUB_LOADERS regrediu?");
  });

  for (const [slug, load] of Object.entries(HUB_LOADERS)) {
    it(`hub "${slug}": zero violações do gate mecânico`, () => {
      const violations = checkHubFacts(load());
      assert.deepEqual(violations, [], `${slug}:\n  ${violations.join("\n  ")}`);
    });
  }
});

describe("#5060 fleet review item 3 — recomputeHubFactGate (recálculo determinístico do gate do fact-checker mode:hub)", () => {
  it("caso feliz: só claims SUSTAINED/INFERRED, sem contradições -> não bloqueia", () => {
    const result = recomputeHubFactGate(
      [
        { claim_id: "s0p0c0", verdict: "SUSTAINED" },
        { claim_id: "s0p1c0", verdict: "INFERRED" },
      ],
      [],
      [],
    );
    assert.deepEqual(result, { blocked: false, blocking_items: [] });
  });

  it("claim divergente SEM aprovação -> bloqueia", () => {
    const result = recomputeHubFactGate([{ claim_id: "s0p0c0", verdict: "DIVERGENT" }], [], []);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blocking_items, ["s0p0c0"]);
  });

  it("claim divergente COM aprovação explícita -> não bloqueia", () => {
    const result = recomputeHubFactGate([{ claim_id: "s0p0c0", verdict: "DIVERGENT" }], [], ["s0p0c0"]);
    assert.deepEqual(result, { blocked: false, blocking_items: [] });
  });

  it("NOT_FOUND_IN_SOURCE/SOURCE_UNREACHABLE sem aprovação também bloqueiam (só SUSTAINED/INFERRED escapam)", () => {
    const result = recomputeHubFactGate(
      [
        { claim_id: "a", verdict: "NOT_FOUND_IN_SOURCE" },
        { claim_id: "b", verdict: "SOURCE_UNREACHABLE" },
      ],
      [],
      [],
    );
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blocking_items.sort(), ["a", "b"]);
  });

  it("contradição COM resolvable_with_source_url preenchido mas SEM aprovação -> bloqueia mesmo assim (#5060 fleet review item 2 — a issue motivadora não teria sido pega pela regra antiga)", () => {
    const result = recomputeHubFactGate(
      [],
      [{ claim_id: "contradiction0", resolvable_with_source_url: "https://senado.leg.br/materia/157233" }],
      [],
    );
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blocking_items, ["contradiction0"]);
  });

  it("contradição com resolvable_with_source_url null e SEM aprovação -> bloqueia (comportamento já esperado antes do fix)", () => {
    const result = recomputeHubFactGate([], [{ claim_id: "contradiction0", resolvable_with_source_url: null }], []);
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blocking_items, ["contradiction0"]);
  });

  it("contradição COM aprovação explícita -> não bloqueia, independente de resolvable_with_source_url", () => {
    const withUrl = recomputeHubFactGate(
      [],
      [{ claim_id: "contradiction0", resolvable_with_source_url: "https://senado.leg.br/materia/157233" }],
      ["contradiction0"],
    );
    const withoutUrl = recomputeHubFactGate([], [{ claim_id: "contradiction0", resolvable_with_source_url: null }], ["contradiction0"]);
    assert.deepEqual(withUrl, { blocked: false, blocking_items: [] });
    assert.deepEqual(withoutUrl, { blocked: false, blocking_items: [] });
  });

  it("agrega claims E contradições não aprovadas na mesma lista de blocking_items", () => {
    const result = recomputeHubFactGate(
      [{ claim_id: "s0p0c0", verdict: "DIVERGENT" }],
      [{ claim_id: "contradiction0", resolvable_with_source_url: null }],
      [],
    );
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blocking_items.sort(), ["contradiction0", "s0p0c0"]);
  });
});
