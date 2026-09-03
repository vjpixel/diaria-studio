/**
 * test/issue-depends-on.test.ts (#7137)
 *
 * Trava a lógica pura de `scripts/lib/issue-depends-on.ts` — parsing do
 * marcador `depends-on:` e a decisão de aplicar/remover a label
 * `dependencia-aberta`. O caso mais importante do arquivo é o de regressão
 * #633: dependência fechada → a issue deixa de estar bloqueada SEM ninguém
 * remover label à mão (o incidente real da #7124/#6798).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEPENDS_ON_MARKER_RE,
  parseDependsOn,
  assessDependsOn,
  decideDependsOnLabelAction,
  type DependencyState,
} from "../scripts/lib/issue-depends-on.ts";

describe("parseDependsOn", () => {
  it("marcador ausente → []", () => {
    assert.deepEqual(parseDependsOn("sem marcador nenhum"), []);
    assert.deepEqual(parseDependsOn(""), []);
    assert.deepEqual(parseDependsOn(null), []);
    assert.deepEqual(parseDependsOn(undefined), []);
  });

  it("um número, com ou sem #", () => {
    assert.deepEqual(parseDependsOn("<!-- depends-on: #7113 -->"), [7113]);
    assert.deepEqual(parseDependsOn("<!-- depends-on: 7113 -->"), [7113]);
  });

  it("múltiplos números separados por vírgula, no mesmo marcador", () => {
    assert.deepEqual(
      parseDependsOn("<!-- depends-on: #7113, #6798 -->"),
      [6798, 7113],
    );
  });

  it("múltiplas linhas de marcador são unidas e deduplicadas", () => {
    const body = [
      "<!-- depends-on: #7113 -->",
      "",
      "prosa no meio",
      "",
      "<!-- depends-on: #6798, #7113 -->",
    ].join("\n");
    assert.deepEqual(parseDependsOn(body), [6798, 7113]);
  });

  it("tolera espaçamento variável e caixa alta", () => {
    assert.deepEqual(parseDependsOn("<!--depends-on:#7113-->"), [7113]);
    assert.deepEqual(parseDependsOn("<!--   DEPENDS-ON:   #7113   -->"), [7113]);
  });

  it("exclui auto-referência (issue #N dependendo de si mesma)", () => {
    assert.deepEqual(parseDependsOn("<!-- depends-on: #7137 -->", 7137), []);
    assert.deepEqual(
      parseDependsOn("<!-- depends-on: #7137, #6798 -->", 7137),
      [6798],
    );
  });

  // Mesma âncora de linha própria que WAIT_UNTIL_RE já usa (issue-exec-track.ts)
  // e pelo mesmo motivo: esta PRÓPRIA issue (#7137) documenta o marcador
  // citando-o em prosa como exemplo. Sem a âncora, isso se auto-bloquearia.
  describe("citação em prosa NÃO conta como marcador (mesma âncora do #5462)", () => {
    it("marcador citado inline no meio de uma frase", () => {
      const body = "Escreva `<!-- depends-on: #7113 -->` no corpo pra declarar a dependência.";
      assert.deepEqual(parseDependsOn(body), []);
    });

    it("marcador seguido de texto na mesma linha não conta", () => {
      assert.deepEqual(parseDependsOn("<!-- depends-on: #7113 --> ver também"), []);
    });

    it("marcador precedido de texto na mesma linha não conta", () => {
      assert.deepEqual(parseDependsOn("exemplo: <!-- depends-on: #7113 -->"), []);
    });

    it("marcador dentro de bloco de código continua sendo achado (mesmo comportamento de WAIT_UNTIL_RE — só a âncora de linha importa)", () => {
      const body = "```\n<!-- depends-on: #7113 -->\n```";
      assert.deepEqual(parseDependsOn(body), [7113]);
    });
  });

  it("marcador malformado (sem número) não lança, não produz entrada", () => {
    assert.deepEqual(parseDependsOn("<!-- depends-on: -->"), []);
    assert.doesNotThrow(() => parseDependsOn("<!-- depends-on: abc -->"));
  });
});

describe("DEPENDS_ON_MARKER_RE — smoke", () => {
  it("casa a forma canônica", () => {
    assert.ok(new RegExp(DEPENDS_ON_MARKER_RE.source, "im").test("<!-- depends-on: #7113 -->"));
  });
});

describe("assessDependsOn", () => {
  it("sem dependências → unresolved/indeterminate vazios", () => {
    const r = assessDependsOn([], {});
    assert.deepEqual(r.unresolved, []);
    assert.deepEqual(r.indeterminate, []);
  });

  it("todas fechadas → unresolved vazio", () => {
    const states: Record<number, DependencyState> = { 1: "closed", 2: "closed" };
    const r = assessDependsOn([1, 2], states);
    assert.deepEqual(r.unresolved, []);
    assert.deepEqual(r.indeterminate, []);
  });

  it("uma aberta entre fechadas → só a aberta em unresolved", () => {
    const states: Record<number, DependencyState> = { 1: "closed", 2: "open" };
    const r = assessDependsOn([1, 2], states);
    assert.deepEqual(r.unresolved, [2]);
    assert.deepEqual(r.indeterminate, []);
  });

  it("uma unknown (consulta falhou) → entra em unresolved E em indeterminate", () => {
    const states: Record<number, DependencyState> = { 1: "closed", 2: "unknown" };
    const r = assessDependsOn([1, 2], states);
    assert.deepEqual(r.unresolved, [2]);
    assert.deepEqual(r.indeterminate, [2]);
  });

  it("dependência ausente do mapa de estados é tratada como unknown", () => {
    const r = assessDependsOn([1, 2], { 1: "closed" });
    assert.deepEqual(r.unresolved, [2]);
    assert.deepEqual(r.indeterminate, [2]);
  });
});

describe("decideDependsOnLabelAction — núcleo do auto-desarme (#7137)", () => {
  it("sem marcador, sem label → noop", () => {
    assert.equal(decideDependsOnLabelAction({ dependsOn: [], unresolved: [] }, false), "noop");
  });

  it("sem marcador, MAS com a label (marcador removido depois de aplicada) → remove (cleanup)", () => {
    assert.equal(decideDependsOnLabelAction({ dependsOn: [], unresolved: [] }, true), "remove");
  });

  it("marcador com dependência aberta, sem label → add", () => {
    assert.equal(
      decideDependsOnLabelAction({ dependsOn: [7113], unresolved: [7113] }, false),
      "add",
    );
  });

  it("marcador com dependência aberta, já com label → noop (mantém bloqueado, sem chamada redundante)", () => {
    assert.equal(
      decideDependsOnLabelAction({ dependsOn: [7113], unresolved: [7113] }, true),
      "noop",
    );
  });

  // ─── REGRESSÃO CENTRAL (#633): dependência fechada → sai de bloqueada
  // SEM ninguém remover a label à mão — o exato incidente da #7124/#6798.
  it("REGRESSÃO #7124/#6798: todas as dependências fecharam, issue tinha a label → remove, auto-desarme", () => {
    assert.equal(
      decideDependsOnLabelAction({ dependsOn: [6798], unresolved: [] }, true),
      "remove",
    );
  });

  it("todas fechadas, sem label ainda → noop (já está correto)", () => {
    assert.equal(
      decideDependsOnLabelAction({ dependsOn: [6798], unresolved: [] }, false),
      "noop",
    );
  });

  it("múltiplas dependências, uma ainda aberta → mantém/aplica bloqueio (não desarma parcialmente)", () => {
    assert.equal(
      decideDependsOnLabelAction({ dependsOn: [1, 2], unresolved: [2] }, true),
      "noop",
    );
    assert.equal(
      decideDependsOnLabelAction({ dependsOn: [1, 2], unresolved: [2] }, false),
      "add",
    );
  });

  // ─── Regra de segurança não-negociável: nunca desarma por falha de
  // consulta, nunca trata indeterminado como fechada.
  describe("falha de consulta (unknown) nunca desarma", () => {
    it("dependência unknown, issue já bloqueada → noop, NUNCA remove", () => {
      assert.equal(
        decideDependsOnLabelAction({ dependsOn: [7113], unresolved: [7113] }, true),
        "noop",
      );
    });

    it("dependência unknown, issue ainda sem label → add (fail-closed, nunca assume resolvida)", () => {
      assert.equal(
        decideDependsOnLabelAction({ dependsOn: [7113], unresolved: [7113] }, false),
        "add",
      );
    });

    it("uma dependência confirmada fechada + outra unknown → continua bloqueada (unresolved não-vazio)", () => {
      // unresolved inclui a unknown (assessDependsOn já garante isso) — o
      // decisor nem precisa saber QUAL delas é unknown, só que unresolved
      // não está vazio.
      assert.equal(
        decideDependsOnLabelAction({ dependsOn: [1, 2], unresolved: [2] }, true),
        "noop",
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Integração assessDependsOn → decideDependsOnLabelAction, exercitando o
// fluxo completo que o reconciliador roda por issue.
describe("assessDependsOn + decideDependsOnLabelAction — fluxo completo", () => {
  it("dependência única, estado closed → remove", () => {
    const assessment = assessDependsOn([6798], { 6798: "closed" });
    assert.equal(decideDependsOnLabelAction(assessment, true), "remove");
  });

  it("dependência única, estado open → add (se ainda sem label)", () => {
    const assessment = assessDependsOn([6798], { 6798: "open" });
    assert.equal(decideDependsOnLabelAction(assessment, false), "add");
  });

  it("dependência única, consulta falhou (ausente do mapa) → nunca remove", () => {
    const assessment = assessDependsOn([6798], {});
    assert.equal(decideDependsOnLabelAction(assessment, true), "noop");
  });
});
