/**
 * #8666: D1 de 260922 repetiu a história do D1 de 260921 (OpenAI invadida com
 * ajuda do Claude) em outro veículo/idioma. Sinal (C) do event-dedup: mesma
 * empresa + 1 conceito FORTE (invasão/hack, vazamento), só em janela curta
 * (intra-edição ou ≤2 dias). Sem distância conhecida, segue conservador.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sameEvent,
  findSameEvent,
  editionDistanceDays,
  minDistanceByTitle,
  strongEventConcepts,
  eventConcepts,
  STRONG_CONCEPT_MAX_DISTANCE_DAYS,
} from "../scripts/lib/event-dedup.ts";
import { dedup } from "../scripts/dedup.ts";
import { isIntraEditionDuplicate } from "../scripts/dedup-intra-edition.ts";
import { extractPastTitlesWithEdition } from "../scripts/lib/past-editions-extract.ts";

const D1_260921 = "Claude ajudou a invadir a OpenAI em menos de 3 dias";
const TRIO = [
  "OpenAI foi invadida por hackers que usaram rival do ChatGPT",
  "OpenAI hacked by attackers using Claude Opus 5",
  "Rival do ChatGPT ajudou a invadir contas da OpenAI",
];

test("#8666: o trio de 260922 casa contra o D1 de 260921 com distância D-1", () => {
  for (const t of TRIO) {
    const m = sameEvent(t, D1_260921, { distanceDays: 1 });
    assert.ok(m, `deveria casar: ${t}`);
    assert.equal(m.removable, true);
    assert.ok(m.shared.includes("openai"));
    assert.ok(m.signal === "strong_concept" || m.signal === "event_concepts", m.signal);
  }
});

test("#8666: o mesmo par a 10 dias NÃO casa (limite em 2 dias)", () => {
  for (const t of TRIO) {
    assert.equal(sameEvent(t, D1_260921, { distanceDays: 10 }), null, t);
    assert.equal(sameEvent(t, D1_260921, { distanceDays: STRONG_CONCEPT_MAX_DISTANCE_DAYS + 1 }), null, t);
  }
  // D-2 ainda casa (borda inclusiva); intra-edição (0) também.
  assert.ok(sameEvent(TRIO[0], D1_260921, { distanceDays: 2 }));
  assert.ok(sameEvent(TRIO[0], D1_260921, { distanceDays: 0 }));
});

test("#8666: sem distância conhecida o comportamento conservador fica igual (null)", () => {
  for (const t of TRIO) {
    assert.equal(sameEvent(t, D1_260921), null, t);
    assert.equal(sameEvent(t, D1_260921, { distanceDays: Number.NaN }), null, t);
    assert.equal(sameEvent(t, D1_260921, { distanceDays: -1 }), null, t);
  }
});

test("#8666: 'hackathon' e 'growth/life hack' não contam como invasão", () => {
  assert.equal(sameEvent("OpenAI lança hackathon para devs", D1_260921, { distanceDays: 1 }), null);
  assert.equal(sameEvent("OpenAI ensina growth hack com ChatGPT", D1_260921, { distanceDays: 1 }), null);
  assert.equal(sameEvent("Life hack: use o ChatGPT para organizar a semana", D1_260921, { distanceDays: 1 }), null);
  assert.equal(strongEventConcepts("OpenAI lança hackathon para devs").size, 0);
  assert.equal(eventConcepts("Ten growth hacks for startups using OpenAI").has("HACK"), false);
  assert.equal(strongEventConcepts("OpenAI ensina growth hack").size, 0);
});

test("#8666: hacks de empresas diferentes não casam, mesmo em D-1", () => {
  assert.equal(
    sameEvent("Microsoft é invadida por hackers chineses", D1_260921, { distanceDays: 1 }),
    null,
  );
  assert.equal(
    sameEvent("Hackers invadem a Nvidia e vazam dados de drivers", "Meta sofre vazamento de dados de 500 mil usuários", { distanceDays: 0 }),
    null,
  );
});

test("#8666: 'ataque'/'attack' sozinho é amplo demais para o sinal forte", () => {
  // Mesma empresa + "ataque" de um lado e "invadida" do outro: HACK é 1 conceito
  // compartilhado em (B), mas não forte nos dois lados → (C) não dispara.
  assert.equal(
    sameEvent("OpenAI ataca Google em nova campanha publicitária", "OpenAI foi invadida por hackers", { distanceDays: 1 }),
    null,
  );
});

test("#8666: vazamento é conceito forte (mesma empresa, D-1)", () => {
  const m = sameEvent("Meta vazou dados de usuários do Instagram", "Meta data leak exposes millions of accounts", { distanceDays: 1 });
  assert.ok(m);
  assert.equal(m.signal, "strong_concept");
});

test("#8666: findSameEvent aceita entradas com distância e mantém string legada", () => {
  assert.equal(findSameEvent(TRIO[1], [D1_260921]), null);
  const hit = findSameEvent(TRIO[1], [{ title: D1_260921, distanceDays: 1 }]);
  assert.ok(hit);
  assert.equal(hit.title, D1_260921);
  assert.equal(findSameEvent(TRIO[1], [{ title: D1_260921, distanceDays: 10 }]), null);
});

test("#8666: editionDistanceDays e minDistanceByTitle", () => {
  assert.equal(editionDistanceDays("260921", "260922"), 1);
  assert.equal(editionDistanceDays("260930", "261001"), 1);
  assert.equal(editionDistanceDays("261231", "270101"), 1);
  assert.equal(editionDistanceDays("260922", "260921"), 1);
  assert.equal(editionDistanceDays("260231", "260301"), undefined);
  assert.equal(editionDistanceDays("abc", "260301"), undefined);
  const m = minDistanceByTitle(
    [
      { title: "A", aammdd: "260912" },
      { title: "A", aammdd: "260921" },
      { title: "B", aammdd: "xx" },
    ],
    "260922",
  );
  assert.equal(m.get("A"), 1);
  assert.equal(m.has("B"), false);
  assert.equal(minDistanceByTitle([{ title: "A", aammdd: "260921" }], undefined).size, 0);
});

test("#8666: extractPastTitlesWithEdition lê o AAMMDD do cabeçalho", () => {
  const md = [
    "# Past",
    "",
    `## 2026-09-21 — "${D1_260921}"`,
    "- https://example.com/a",
    "",
    '## 2026-09-20 — "Outro título"',
  ].join("\n");
  assert.deepEqual(extractPastTitlesWithEdition(md, 3), [
    { title: D1_260921, aammdd: "260921" },
    { title: "Outro título", aammdd: "260920" },
  ]);
});

test("#8666: dedup() Pass-1f remove com distância D-1 e mantém sem ela", () => {
  const art = [{ url: "https://example.com/hack", title: TRIO[1] }];
  const withDist = dedup(art, new Set(), 0.85, [], 0.7, [D1_260921], 0.6, undefined, 0.55, new Set(), [], [], new Map([[D1_260921, 1]]));
  assert.equal(withDist.kept.length, 0);
  assert.match(withDist.removed[0].dedup_note, /strong_concept/);

  const far = dedup(art, new Set(), 0.85, [], 0.7, [D1_260921], 0.6, undefined, 0.55, new Set(), [], [], new Map([[D1_260921, 10]]));
  assert.equal(far.kept.length, 1);

  const noDist = dedup(art, new Set(), 0.85, [], 0.7, [D1_260921]);
  assert.equal(noDist.kept.length, 1);
});

test("#8666: intra-edição (distância 0) remove o item duplicado contra o destaque", () => {
  const res = isIntraEditionDuplicate(
    { url: "https://example.com/hack", title: TRIO[0] } as never,
    [{ url: "https://example.com/d1", title: D1_260921 }] as never,
  );
  assert.ok(res);
  assert.equal(res.match_type, "event");
});
