/**
 * test/apoio-segments-canonical.test.ts (#4436)
 *
 * Testa `scripts/lib/apoio-segments-canonical.ts` — o drift check do passo 1
 * da skill `/diaria-apoios-sync`: comparação entre o `where` lido AO VIVO de
 * cada um dos 6 segmentos (`get_segment`) e a condição-alvo versionada no
 * repo. Nenhum teste bate na API — `liveSegments` é sempre uma fixture
 * `{name, where}[]` construída à mão.
 *
 * Caso obrigatório do corpo da issue: "parse do where não pode quebrar com
 * espaçamento/ordem diferente da UI" — a Beehiiv não garante uma ordem
 * estável ao reserializar `AND`, então a comparação precisa ser tolerante a
 * isso (ver `normalizeWhereClause`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APOIO_SEGMENTS_CANONICAL,
  APOIO_NIVEL_FIELD_ID,
  normalizeWhereClause,
  isSegmentConverged,
  computeSegmentDrift,
  allSegmentsConverged,
  evaluateSegmentCountGate,
  type SegmentMemberCounts,
} from "../scripts/lib/apoio-segments-canonical.ts";

describe("APOIO_SEGMENTS_CANONICAL (#4436)", () => {
  it("tem exatamente os 6 segmentos esperados, na ordem do desenho da issue", () => {
    assert.deepEqual(
      APOIO_SEGMENTS_CANONICAL.map((s) => s.name),
      ["Apoio — Amigo", "Apoio — Apoiador", "Apoio — Mantenedor", "Apoio — Patrono", "Apoio — Todos", "Apoio — Nenhum"],
    );
  });

  it("as 4 faixas usam o mesmo custom field ID e o mesmo valor no nome", () => {
    for (const [name, value] of [
      ["Apoio — Amigo", "amigo"],
      ["Apoio — Apoiador", "apoiador"],
      ["Apoio — Mantenedor", "mantenedor"],
      ["Apoio — Patrono", "patrono"],
    ] as const) {
      const seg = APOIO_SEGMENTS_CANONICAL.find((s) => s.name === name)!;
      assert.match(seg.where, new RegExp(`custom_field\\('${APOIO_NIVEL_FIELD_ID}'\\)\\s*=\\s*'${value}'`));
      assert.match(seg.where, /status = 'active'/);
    }
  });

  it("Todos usa EXISTS, Nenhum usa NOT EXISTS — complementares", () => {
    const todos = APOIO_SEGMENTS_CANONICAL.find((s) => s.name === "Apoio — Todos")!;
    const nenhum = APOIO_SEGMENTS_CANONICAL.find((s) => s.name === "Apoio — Nenhum")!;
    assert.ok(todos.where.includes("EXISTS"));
    assert.ok(!todos.where.includes("NOT EXISTS"));
    assert.ok(nenhum.where.includes("NOT EXISTS"));
  });
});

describe("normalizeWhereClause (#4436) — tolerância a espaçamento/ordem", () => {
  it("ordem diferente das cláusulas AND → normaliza igual", () => {
    const a = `custom_field('id') = 'amigo' AND status = 'active'`;
    const b = `status = 'active' AND custom_field('id') = 'amigo'`;
    assert.equal(normalizeWhereClause(a), normalizeWhereClause(b));
  });

  it("espaçamento extra/irregular entre cláusulas AND → normaliza igual", () => {
    assert.equal(normalizeWhereClause("a   AND   b"), normalizeWhereClause("a AND b"));
  });

  it("espaços de sobra nas pontas de uma cláusula individual → normaliza igual", () => {
    assert.equal(normalizeWhereClause("  status = 'active'   AND   custom_field('id') = 'amigo'  "), normalizeWhereClause("status = 'active' AND custom_field('id') = 'amigo'"));
  });

  it("cláusula única (sem AND) → devolve a própria cláusula trimada", () => {
    assert.equal(normalizeWhereClause("  status = 'active'  "), "status = 'active'");
  });
});

describe("isSegmentConverged (#4436)", () => {
  it("idêntico → convergido", () => {
    assert.equal(isSegmentConverged("status = 'active' AND custom_field('x') = 'amigo'", "status = 'active' AND custom_field('x') = 'amigo'"), true);
  });

  it("mesma condição, ordem AND trocada → convergido (não é drift)", () => {
    assert.equal(
      isSegmentConverged("custom_field('x') = 'amigo' AND status = 'active'", "status = 'active' AND custom_field('x') = 'amigo'"),
      true,
    );
  });

  it("desenho antigo por tag (o bug original do #4436) → DIVERGENTE", () => {
    assert.equal(
      isSegmentConverged("subscriber_tag = '64668665-...' AND status = 'active'", "custom_field('e70e...') = 'amigo' AND status = 'active'"),
      false,
    );
  });

  it("EXISTS vs NOT EXISTS → divergente (Todos ≠ Nenhum)", () => {
    assert.equal(isSegmentConverged("status = 'active' AND custom_field('x') EXISTS", "status = 'active' AND custom_field('x') NOT EXISTS"), false);
  });
});

describe("computeSegmentDrift + allSegmentsConverged (#4436)", () => {
  it("todos os 6 já convergidos (estado pós-#4436) → nenhuma ação, allSegmentsConverged true", () => {
    const live = APOIO_SEGMENTS_CANONICAL.map((s) => ({ name: s.name, where: s.where }));
    const drift = computeSegmentDrift(live);
    assert.equal(drift.length, 6);
    assert.ok(drift.every((d) => d.converged));
    assert.equal(allSegmentsConverged(drift), true);
  });

  it("estado ORIGINAL (bug do #4436, tudo por tag) → todos os 6 divergentes", () => {
    const live = [
      { name: "Apoio — Amigo", where: "subscriber_tag = '64668665-989f-4402-8204-cb738ef69aca' AND status = 'active'" },
      { name: "Apoio — Apoiador", where: "subscriber_tag = 'a87f8989-bbf4-4a79-aad0-3a96e971b85b' AND status = 'active'" },
      { name: "Apoio — Mantenedor", where: "subscriber_tag = 'e1f96ab8-5cf9-40e7-94bb-ac2b61db0894' AND status = 'active'" },
      { name: "Apoio — Patrono", where: "subscriber_tag = '789452b5-a0d5-4461-a50d-eb51a8094c35' AND status = 'active'" },
      {
        name: "Apoio — Todos",
        where:
          "subscriber_tag IN ('64668665-989f-4402-8204-cb738ef69aca', 'e1f96ab8-5cf9-40e7-94bb-ac2b61db0894', '789452b5-a0d5-4461-a50d-eb51a8094c35', 'a87f8989-bbf4-4a79-aad0-3a96e971b85b') AND status = 'active'",
      },
      {
        name: "Apoio — Nenhum",
        where:
          "subscriber_tag != '64668665-989f-4402-8204-cb738ef69aca' AND subscriber_tag != 'a87f8989-bbf4-4a79-aad0-3a96e971b85b' AND subscriber_tag != 'e1f96ab8-5cf9-40e7-94bb-ac2b61db0894' AND subscriber_tag != '789452b5-a0d5-4461-a50d-eb51a8094c35' AND status = 'active'",
      },
    ];
    const drift = computeSegmentDrift(live);
    assert.equal(drift.length, 6);
    assert.ok(drift.every((d) => !d.converged));
    assert.equal(allSegmentsConverged(drift), false);
  });

  it("parcialmente convergido (1 corrigido manualmente, resto ainda por tag) → só o corrigido converge", () => {
    const canonicalAmigo = APOIO_SEGMENTS_CANONICAL.find((s) => s.name === "Apoio — Amigo")!;
    const live = APOIO_SEGMENTS_CANONICAL.map((s) => ({ name: s.name, where: s.where })).map((s) =>
      s.name === "Apoio — Amigo" ? s : { ...s, where: "subscriber_tag = 'stale-tag-id' AND status = 'active'" },
    );
    const drift = computeSegmentDrift(live);
    const amigoEntry = drift.find((d) => d.name === "Apoio — Amigo")!;
    assert.equal(amigoEntry.converged, true);
    assert.equal(amigoEntry.canonical, canonicalAmigo.where);
    assert.equal(
      drift.filter((d) => d.converged).length,
      1,
    );
    assert.equal(allSegmentsConverged(drift), false);
  });

  it("segmento canônico sem correspondente em liveSegments (nome não encontrado) → conta como divergente, live=null", () => {
    const drift = computeSegmentDrift([]); // nenhum segmento ao vivo
    assert.equal(drift.length, 6);
    assert.ok(drift.every((d) => d.converged === false && d.live === null));
  });
});

// ---------------------------------------------------------------------------
// evaluateSegmentCountGate (#4485 item 1 — gate do Passo 4)
// ---------------------------------------------------------------------------

describe("evaluateSegmentCountGate (#4485 item 1)", () => {
  const CONVERGED: SegmentMemberCounts = { amigo: 3, apoiador: 8, mantenedor: 4, patrono: 1, todos: 16, nenhum: 546 };

  it("estado real confirmado em 260802 (#4485): soma bate, base bate → ok", () => {
    const gate = evaluateSegmentCountGate(CONVERGED, 562);
    assert.equal(gate.ok, true);
    assert.equal(gate.sumOfTiers, 16);
    assert.equal(gate.tiersMatchTodos, true);
    assert.equal(gate.totalMatchesActiveBase, true);
  });

  it("soma das 4 faixas ≠ Todos (refresh não pegou num segmento de faixa ou no Todos) → ok:false", () => {
    // Todos ficou em 15 (refresh não pegou), mas as 4 faixas somam 16.
    const counts: SegmentMemberCounts = { ...CONVERGED, todos: 15 };
    const gate = evaluateSegmentCountGate(counts, 561);
    assert.equal(gate.ok, false);
    assert.equal(gate.tiersMatchTodos, false);
  });

  it("Todos + Nenhum ≠ base ativa (refresh não pegou no Nenhum) → ok:false", () => {
    // Nenhum ficou desatualizado (545 em vez de 546) mesmo com as faixas ok.
    const counts: SegmentMemberCounts = { ...CONVERGED, nenhum: 545 };
    const gate = evaluateSegmentCountGate(counts, 562);
    assert.equal(gate.ok, false);
    assert.equal(gate.tiersMatchTodos, true);
    assert.equal(gate.totalMatchesActiveBase, false);
  });

  it("ambos os checks falham simultaneamente → ok:false, os 2 flags reportam false", () => {
    const counts: SegmentMemberCounts = { amigo: 3, apoiador: 8, mantenedor: 4, patrono: 1, todos: 10, nenhum: 500 };
    const gate = evaluateSegmentCountGate(counts, 562);
    assert.equal(gate.ok, false);
    assert.equal(gate.tiersMatchTodos, false);
    assert.equal(gate.totalMatchesActiveBase, false);
  });

  it("todos zerados (base ativa 0) → soma bate trivialmente, ok:true", () => {
    const counts: SegmentMemberCounts = { amigo: 0, apoiador: 0, mantenedor: 0, patrono: 0, todos: 0, nenhum: 0 };
    const gate = evaluateSegmentCountGate(counts, 0);
    assert.equal(gate.ok, true);
  });
});
