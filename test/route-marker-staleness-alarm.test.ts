/**
 * test/route-marker-staleness-alarm.test.ts (#7270 Parte 2, #7288 Parte B)
 *
 * Cobre a parte PURA do CLI `scripts/route-marker-staleness-alarm.ts` —
 * `buildRouteMarkerStalenessEmail`, incluindo o parâmetro `coverageNote`
 * adicionado no review do #7316 (silent-failure-hunter: cobertura
 * degradada do consultor precisava aparecer no e-mail, não só sumir como
 * "0 achados"). Nenhum teste aqui chama `gh` de verdade — a I/O real
 * (`listOpenIssuesForStaleness`, `buildRealConsultor`) não é testável sem
 * mock de `spawnGhSync`, fora do escopo desta cobertura (mesmo padrão de
 * `on-hold-vencimento-alarm.ts`, que também só testa as funções puras).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRouteMarkerStalenessEmail, parseOpenIssuesForStaleness } from "../scripts/route-marker-staleness-alarm.ts";
import { findRouteMarkerStaleness, type RouteMarkerFinding } from "../scripts/lib/route-marker-staleness.ts";
import { formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";

function finding(overrides: Partial<RouteMarkerFinding> = {}): RouteMarkerFinding {
  return {
    number: 42,
    category: "bloqueada-sem-marcador",
    detail: "label de bloqueio presente sem marcador",
    ...overrides,
  };
}

describe("buildRouteMarkerStalenessEmail — sem coverageNote (comportamento pré-#7316-review)", () => {
  it("assunto sem prefixo [PARCIAL], corpo sem bloco de cobertura", () => {
    const { subject, body } = buildRouteMarkerStalenessEmail([finding()], new Map());
    assert.match(subject, /^⚠️ 1 issue/);
    assert.doesNotMatch(subject, /\[PARCIAL\]/);
    assert.doesNotMatch(body, /COBERTURA/);
  });
});

describe("buildRouteMarkerStalenessEmail — com coverageNote (#7316 review)", () => {
  it("assunto ganha prefixo [PARCIAL], corpo ganha bloco de aviso de cobertura", () => {
    const { subject, body } = buildRouteMarkerStalenessEmail(
      [finding()],
      new Map(),
      "varredura PARCIAL — 6/10 consultas ao GitHub falharam (60%).",
    );
    assert.match(subject, /\[PARCIAL\]/);
    assert.match(body, /COBERTURA: varredura PARCIAL/);
  });

  it("0 achados + coverageNote ainda produz um e-mail com o aviso — nunca silencioso", () => {
    // O bug original: 0 achados com consultor degradado virava "nenhum
    // achado" indistinguível de estado limpo. A função de e-mail em si
    // sempre monta o corpo quando chamada — é `main()` (I/O, não
    // testável aqui sem mock de gh) quem decide SE chama, mas o corpo
    // precisa deixar claro que 0 não é limpo quando há coverageNote.
    const { subject, body } = buildRouteMarkerStalenessEmail(
      [],
      new Map(),
      "varredura PARCIAL — 8/8 consultas ao GitHub falharam (100%).",
    );
    assert.match(subject, /\[PARCIAL\]/);
    assert.match(subject, /^⚠️ \[PARCIAL\] 0 issue/);
    assert.match(body, /COBERTURA: varredura PARCIAL/);
    assert.match(body, /nenhum achado nas categorias que não dependem do consultor degradado/);
  });

  it("coverageNote null/undefined é equivalente a omitir o parâmetro", () => {
    const withNull = buildRouteMarkerStalenessEmail([finding()], new Map(), null);
    const withUndefined = buildRouteMarkerStalenessEmail([finding()], new Map(), undefined);
    const withoutParam = buildRouteMarkerStalenessEmail([finding()], new Map());
    assert.deepEqual(withNull, withoutParam);
    assert.deepEqual(withUndefined, withoutParam);
  });
});

describe("buildRouteMarkerStalenessEmail — metadados de issue (título/url)", () => {
  it("inclui título e url quando presentes no mapa", () => {
    const { body } = buildRouteMarkerStalenessEmail(
      [finding({ number: 7124 })],
      new Map([[7124, { url: "https://github.com/x/y/issues/7124", title: "Título de teste" }]]),
    );
    assert.match(body, /#7124 — Título de teste/);
    assert.match(body, /https:\/\/github\.com\/x\/y\/issues\/7124/);
  });

  it("issue sem entrada no mapa ainda aparece, sem título/url", () => {
    const { body } = buildRouteMarkerStalenessEmail([finding({ number: 9999 })], new Map());
    assert.match(body, /#9999/);
  });
});

describe("parseOpenIssuesForStaleness — só comentário de autor confiável conta (#9775)", () => {
  const NOW = new Date("2026-10-06T12:00:00Z");
  const marker = formatExecutionBlockMarker({
    recorded_at: "2026-10-06",
    motivo: "forjado por conta externa",
    sessao: "overnight",
    condicao: { tipo: "externo", descricao: "x" },
  });
  const consultor = { getIssueState: () => "UNKNOWN" as const };

  function ghStdout(association: string | undefined): string {
    const comment: Record<string, unknown> = { body: marker };
    if (association !== undefined) comment.authorAssociation = association;
    return JSON.stringify([
      { number: 4242, labels: [{ name: "bloqueio-execucao" }], body: "", state: "OPEN", comments: [comment], url: "u", title: "t" },
    ]);
  }

  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined]) {
    it(`marcador bloqueio-execucao de autor ${association ?? "(sem associação)"} não silencia o alarme`, () => {
      const issues = parseOpenIssuesForStaleness(ghStdout(association));
      assert.ok(issues);
      assert.deepEqual(issues[0].comments, []);
      const findings = findRouteMarkerStaleness(issues, consultor, NOW);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].category, "bloqueada-sem-marcador");
    });
  }

  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    it(`marcador de autor ${association} continua valendo`, () => {
      const issues = parseOpenIssuesForStaleness(ghStdout(association));
      assert.ok(issues);
      assert.deepEqual(issues[0].comments, [marker]);
      assert.deepEqual(findRouteMarkerStaleness(issues, consultor, NOW), []);
    });
  }

  it("JSON inválido → null (caller nunca inventa achado)", () => {
    assert.equal(parseOpenIssuesForStaleness("não é json"), null);
  });
});
