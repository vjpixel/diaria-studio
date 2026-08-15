/**
 * test/issue-decisions.test.ts (#5373)
 *
 * Regressão pura pra `scripts/lib/issue-decisions.ts` — nenhum teste aqui
 * chama `gh` de verdade (as funções puras recebem os bodies já buscados).
 * Cobre a lista pedida pela issue:
 *
 *   - parse de marcador válido
 *   - marcador ausente (retorna null)
 *   - múltiplos marcadores (pega o mais recente por decided_at)
 *   - marcador malformado (JSON inválido — ignora, não lança)
 *   - lista de comentários vazia
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDecisionMarker,
  parseDecisionMarkers,
  latestDecisionFor,
  type IssueDecision,
} from "../scripts/lib/issue-decisions.ts";

function decision(overrides: Partial<IssueDecision> = {}): IssueDecision {
  return {
    decided_at: "2026-08-14T05:38:00Z",
    pergunta: "Consertar ou aposentar GA4?",
    resposta: "CONSERTAR, não aposentar",
    sessao: "continuo",
    ...overrides,
  };
}

describe("formatDecisionMarker + parseDecisionMarkers round-trip", () => {
  it("marcador formatado é reconhecido pelo parser", () => {
    const d = decision();
    const marker = formatDecisionMarker(d);
    assert.match(marker, /^<!-- decisao-editor: \{.*\} -->$/);
    const parsed = parseDecisionMarkers([`Decisão do editor: CONSERTAR.\n\n${marker}`]);
    assert.deepEqual(parsed, [d]);
  });
});

describe("parseDecisionMarkers", () => {
  it("marcador ausente retorna lista vazia", () => {
    assert.deepEqual(parseDecisionMarkers(["comentário qualquer sem marcador"]), []);
  });

  it("lista de comentários vazia retorna lista vazia", () => {
    assert.deepEqual(parseDecisionMarkers([]), []);
  });

  it("marcador malformado (JSON inválido) é ignorado, não lança", () => {
    const bad = "<!-- decisao-editor: {not valid json} -->";
    assert.doesNotThrow(() => parseDecisionMarkers([bad]));
    assert.deepEqual(parseDecisionMarkers([bad]), []);
  });

  it("marcador com campo faltando é ignorado", () => {
    const incomplete = '<!-- decisao-editor: {"decided_at":"2026-08-14T00:00:00Z"} -->';
    assert.deepEqual(parseDecisionMarkers([incomplete]), []);
  });

  it("extrai múltiplos marcadores válidos de múltiplos comentários", () => {
    const d1 = decision({ decided_at: "2026-08-12T20:02:00Z" });
    const d2 = decision({ decided_at: "2026-08-14T14:34:00Z" });
    const bodies = [formatDecisionMarker(d1), formatDecisionMarker(d2)];
    assert.deepEqual(parseDecisionMarkers(bodies), [d1, d2]);
  });
});

describe("latestDecisionFor", () => {
  it("nenhum marcador -> null", () => {
    assert.equal(latestDecisionFor(["sem marcador aqui"]), null);
  });

  it("lista vazia -> null", () => {
    assert.equal(latestDecisionFor([]), null);
  });

  it("múltiplos marcadores -> devolve o mais recente por decided_at", () => {
    const older = decision({ decided_at: "2026-08-12T20:02:00Z", resposta: "resposta antiga" });
    const newer = decision({ decided_at: "2026-08-15T16:00:00Z", resposta: "resposta atual" });
    const middle = decision({ decided_at: "2026-08-14T14:34:00Z", resposta: "resposta do meio" });
    const bodies = [
      formatDecisionMarker(older),
      formatDecisionMarker(newer),
      formatDecisionMarker(middle),
    ];
    assert.deepEqual(latestDecisionFor(bodies), newer);
  });

  it("mistura de marcador válido e malformado -> ignora o malformado, acha o válido", () => {
    const valid = decision();
    const bodies = ["<!-- decisao-editor: {broken -->", formatDecisionMarker(valid)];
    assert.deepEqual(latestDecisionFor(bodies), valid);
  });
});
