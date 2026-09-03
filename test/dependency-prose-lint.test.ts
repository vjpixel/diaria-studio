/**
 * test/dependency-prose-lint.test.ts (#7137 item 4)
 *
 * Trava a lógica pura de `scripts/lib/dependency-prose-lint.ts`. Caso de
 * regressão mais importante (#633): reproduz o incidente real que abriu
 * o item — corpo de issue citando "depende do #7113"/"só depois do #6798"
 * sem o marcador `depends-on:` gera achado; o mesmo corpo COM o marcador
 * não gera achado nenhum.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectDependencyProseWithoutMarker, DEPENDENCY_PROSE_PATTERNS } from "../scripts/lib/dependency-prose-lint.ts";

describe("detectDependencyProseWithoutMarker", () => {
  it("regressão #7124/#6798: prosa de dependência sem marcador → achado", () => {
    const findings = detectDependencyProseWithoutMarker([
      { number: 7200, body: "Esta issue depende do #7113 e só depois do #6798 pode começar." },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].issueNumber, 7200);
  });

  it("mesma prosa, COM marcador depends-on: → nenhum achado", () => {
    const findings = detectDependencyProseWithoutMarker([
      {
        number: 7200,
        body: "Esta issue depende do #7113.\n\n<!-- depends-on: #7113 -->\n",
      },
    ]);
    assert.deepEqual(findings, []);
  });

  it("corpo sem nenhuma frase-gatilho → nenhum achado", () => {
    const findings = detectDependencyProseWithoutMarker([
      { number: 7201, body: "Corrige o bug do timeout no fetch de posts." },
    ]);
    assert.deepEqual(findings, []);
  });

  it("body null/undefined não lança e não gera achado", () => {
    assert.deepEqual(detectDependencyProseWithoutMarker([{ number: 1, body: null }]), []);
  });

  it("pré-requisito (com e sem hífen/acento) casa o mesmo padrão", () => {
    const a = detectDependencyProseWithoutMarker([{ number: 1, body: "Isso é pré-requisito pra outra issue." }]);
    const b = detectDependencyProseWithoutMarker([{ number: 2, body: "Isso é prerequisito pra outra issue." }]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].patternId, "prerequisito");
  });

  it("'antes de #N' e 'depois que #N' casam padrões distintos", () => {
    const antes = detectDependencyProseWithoutMarker([{ number: 1, body: "Fazer isso antes de #500." }]);
    const depois = detectDependencyProseWithoutMarker([{ number: 2, body: "Só rodar depois que #500 fechar." }]);
    assert.equal(antes[0].patternId, "antes-de-issue");
    assert.equal(depois[0].patternId, "depois-de-issue");
  });

  it("dedup: no máximo 1 achado por issue mesmo com múltiplas frases-gatilho", () => {
    const findings = detectDependencyProseWithoutMarker([
      { number: 42, body: "É pré-requisito. Depende do #10. Só depois disso." },
    ]);
    assert.equal(findings.length, 1);
  });

  it("marcador citado dentro de outro comentário HTML não conta como declarado (regex ainda vê a prosa)", () => {
    // Um comentário HTML qualquer, sem ser o marcador depends-on de fato,
    // não deve mascarar a ausência do marcador real.
    const findings = detectDependencyProseWithoutMarker([
      { number: 5, body: "<!-- algum outro marcador -->\nDepende do #10." },
    ]);
    assert.equal(findings.length, 1);
  });

  it("catálogo tem ids únicos", () => {
    const ids = DEPENDENCY_PROSE_PATTERNS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("excerto tem o trecho casado e não o body inteiro", () => {
    const longBody = `${"x".repeat(200)} depende do #10 ${"y".repeat(200)}`;
    const findings = detectDependencyProseWithoutMarker([{ number: 9, body: longBody }]);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].excerpt.length < longBody.length);
    assert.ok(findings[0].excerpt.includes("depende do #10"));
  });
});
