/**
 * decision-label-drift.test.ts (#5589)
 *
 * Trava a lógica pura de `scripts/lib/decision-label-drift.ts`: casamento
 * de padrão de deferimento/decisão em prosa contra a label estrutural
 * esperada. Os dois primeiros blocos reproduzem os casos reais que
 * motivaram a issue (#5586: #5239 e #5125).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectLabelDrift,
  stripHtmlComments,
  DRIFT_PATTERNS,
} from "../scripts/lib/decision-label-drift.ts";

describe("detectLabelDrift — casos reais do #5586", () => {
  it("#5239: comentário 'não despachar agora, pré-requisito ainda não atendido' sem not-this-week/next-month → achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 5239,
      labels: ["P2", "enhancement"],
      commentBodies: [
        "Rodada 260817d: não despachar agora, pré-requisito ainda não atendido (aguardando #5230 fechar).",
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].patternId, "deferred-vague");
    assert.deepEqual(findings[0].expectedLabels, ["not-this-week", "next-month"]);
    assert.equal(findings[0].issueNumber, 5239);
  });

  it("#5125: trade-off-real declarado em prosa sem a label trade-off-real → achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 5125,
      labels: ["P3", "bug"],
      commentBodies: [
        "Não iniciar sem resposta do editor ao item 1 — isto é trade-off-real de produto.",
      ],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].patternId, "trade-off-real");
    assert.deepEqual(findings[0].expectedLabels, ["trade-off-real"]);
  });
});

describe("detectLabelDrift — label já aplicada não gera achado", () => {
  it("not-this-week presente resolve o padrão deferred-vague", () => {
    const findings = detectLabelDrift({
      issueNumber: 1,
      labels: ["not-this-week"],
      commentBodies: ["Aguardando o próximo ciclo pra retomar isso."],
    });
    assert.deepEqual(findings, []);
  });

  it("trade-off-real presente resolve o padrão trade-off-real", () => {
    const findings = detectLabelDrift({
      issueNumber: 2,
      labels: ["trade-off-real"],
      commentBodies: ["Julgamento: trade-off-real, escalado pro develop."],
    });
    assert.deepEqual(findings, []);
  });

  it("decisao-registrada satisfaz qualquer padrão, mesmo sem a label específica (regressão do falso-positivo do #5589 sobre si mesmo)", () => {
    const findings = detectLabelDrift({
      issueNumber: 5589,
      labels: ["P3", "decisao-registrada"],
      commentBodies: [
        'detecta padrão de deferimento no texto ("aguardando", "não despachar", "pré-requisito não atendido", etc.) — trade-off-real citado como exemplo',
      ],
    });
    assert.deepEqual(findings, []);
  });

  it("qualquer label do any-of já resolve (external-blocker)", () => {
    const findings = detectLabelDrift({
      issueNumber: 3,
      labels: ["beehiiv"],
      commentBodies: ["Bloqueio externo: falta acesso a um painel de terceiro."],
    });
    assert.deepEqual(findings, []);
  });
});

describe("detectLabelDrift — sem padrão, sem achado", () => {
  it("comentário comum sem nenhuma frase-gatilho não gera achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 4,
      labels: [],
      commentBodies: ["PR #123 aberto, self-review: 0 findings."],
    });
    assert.deepEqual(findings, []);
  });

  it("nenhum comentário → nenhum achado", () => {
    const findings = detectLabelDrift({ issueNumber: 5, labels: [], commentBodies: [] });
    assert.deepEqual(findings, []);
  });
});

describe("detectLabelDrift — marcador estruturado não conta como prosa", () => {
  it("padrão só dentro de um bloco <!-- --> (marcador) não é reportado como achado de PROSA", () => {
    // Simula um marcador cujo texto legível ("pergunta"/"resposta") NÃO
    // contém frase-gatilho, mas cujo blob base64 poderia colidir por acaso
    // — stripHtmlComments remove o bloco inteiro, então o teste garante que
    // o match só acontece fora dele.
    const findings = detectLabelDrift({
      issueNumber: 6,
      labels: [],
      commentBodies: [
        "<!-- decisao-editor: eyJhIjoiYWd1YXJkYW5kbyBhbGdvIGlycmVsZXZhbnRlIn0= -->\n\nComentário normal, sem gatilho.",
      ],
    });
    assert.deepEqual(findings, []);
  });

  it("stripHtmlComments remove blocos de comentário HTML preservando a prosa ao redor", () => {
    const out = stripHtmlComments("antes <!-- oculto --> depois");
    assert.ok(out.includes("antes"));
    assert.ok(out.includes("depois"));
    assert.ok(!out.includes("oculto"));
  });
});

describe("detectLabelDrift — dedup por (issue, padrão)", () => {
  it("dois comentários casando o mesmo padrão sem label geram só 1 achado", () => {
    const findings = detectLabelDrift({
      issueNumber: 7,
      labels: [],
      commentBodies: [
        "Aguardando resposta do editor.",
        "Ainda aguardando, sem novidade.",
      ],
    });
    assert.equal(findings.length, 1);
  });

  it("comentário mais recente com a label correta remove o achado do comentário mais antigo", () => {
    const findings = detectLabelDrift({
      issueNumber: 8,
      labels: ["not-this-week"],
      commentBodies: [
        "Aguardando pré-requisito não atendido ainda.", // mais antigo, sem label na época
        "Aplicada not-this-week — issue agora reflete o estado real.",
      ],
    });
    assert.deepEqual(findings, []);
  });
});

describe("detectLabelDrift — comentários não-string são ignorados sem lançar", () => {
  it("tolera entrada malformada no array de comentários", () => {
    const findings = detectLabelDrift({
      issueNumber: 9,
      labels: [],
      // @ts-expect-error — testando tolerância a input malformado em runtime
      commentBodies: [null, undefined, 42, "aguardando revisão"],
    });
    assert.equal(findings.length, 1);
  });
});

describe("DRIFT_PATTERNS — catálogo", () => {
  it("todo padrão tem ao menos 1 regex e ao menos 1 label esperada", () => {
    for (const pattern of DRIFT_PATTERNS) {
      assert.ok(pattern.textPatterns.length > 0, `${pattern.id} sem regex`);
      assert.ok(pattern.expectedLabels.length > 0, `${pattern.id} sem label esperada`);
    }
  });

  it("ids são únicos", () => {
    const ids = DRIFT_PATTERNS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
