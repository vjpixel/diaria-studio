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
