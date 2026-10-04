/**
 * #9565: o sinal (C) do event-dedup (#8666) contava a distância em dias de
 * CALENDÁRIO — a diar.ia.br sai seg–sex, então a história de sexta repetida na
 * segunda (3 dias) escapava. A distância passou a ser em dias ÚTEIS (seg–sex),
 * mantendo o teto "edição anterior e a de antes dela" (≤2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editionBusinessDaysBefore,
  minDistanceByTitle,
  findSameEvent,
  STRONG_CONCEPT_MAX_DISTANCE_DAYS,
} from "../scripts/lib/event-dedup.ts";
import { dedup } from "../scripts/dedup.ts";

// 261002 = sexta, 261005 = segunda, 261001 = quinta, 260930 = quarta,
// 261006 = terça, 261009 = sexta.
const FRIDAY_D1 = "Claude ajudou a invadir a OpenAI em menos de 3 dias";
const MONDAY_REPEAT = "OpenAI hacked by attackers using Claude Opus 5";

test("#9565: editionBusinessDaysBefore conta seg–sex em (past, current]", () => {
  assert.equal(editionBusinessDaysBefore("261002", "261005"), 1); // sex → seg
  assert.equal(editionBusinessDaysBefore("261001", "261005"), 2); // qui → seg
  assert.equal(editionBusinessDaysBefore("260930", "261005"), 3); // qua → seg
  assert.equal(editionBusinessDaysBefore("261005", "261006"), 1); // seg → ter
  assert.equal(editionBusinessDaysBefore("261002", "261009"), 5); // sex → sex
  assert.equal(editionBusinessDaysBefore("260918", "261009"), 15); // 3 semanas
  assert.equal(editionBusinessDaysBefore("261003", "261004"), 1); // sáb → dom: piso 1, nunca "intra-edição"
  assert.equal(editionBusinessDaysBefore("261005", "261005"), 0);
  assert.ok((editionBusinessDaysBefore("261006", "261005") ?? 0) < 0);
  assert.equal(editionBusinessDaysBefore("260231", "261005"), undefined);
  // virada de ano: qui 261231 → seg 270104 = sex + seg = 2
  assert.equal(editionBusinessDaysBefore("261231", "270104"), 2);
});

test("#9565: história de sexta repetida na segunda casa como strong_concept", () => {
  const dist = minDistanceByTitle([{ title: FRIDAY_D1, aammdd: "261002" }], "261005");
  assert.equal(dist.get(FRIDAY_D1), 1);
  const hit = findSameEvent(MONDAY_REPEAT, [{ title: FRIDAY_D1, distanceDays: dist.get(FRIDAY_D1) }]);
  assert.ok(hit);
  assert.equal(hit.match.signal, "strong_concept");

  // Fim-a-fim pelo Pass-1f do dedup().
  const art = [{ url: "https://example.com/hack", title: MONDAY_REPEAT }];
  const r = dedup(art, new Set(), 0.85, [], 0.7, [FRIDAY_D1], 0.6, undefined, 0.55, new Set(), [], [], dist);
  assert.equal(r.kept.length, 0);
  assert.match(r.removed[0].dedup_note, /strong_concept/);
});

test("#9565: a edição de antes da anterior (qui → seg) ainda casa; 3+ edições não", () => {
  const thu = minDistanceByTitle([{ title: FRIDAY_D1, aammdd: "261001" }], "261005");
  assert.equal(thu.get(FRIDAY_D1), STRONG_CONCEPT_MAX_DISTANCE_DAYS);
  assert.ok(findSameEvent(MONDAY_REPEAT, [{ title: FRIDAY_D1, distanceDays: thu.get(FRIDAY_D1) }]));

  const wed = minDistanceByTitle([{ title: FRIDAY_D1, aammdd: "260930" }], "261005");
  assert.equal(wed.get(FRIDAY_D1), 3);
  assert.equal(findSameEvent(MONDAY_REPEAT, [{ title: FRIDAY_D1, distanceDays: wed.get(FRIDAY_D1) }]), null);
  const art = [{ url: "https://example.com/hack", title: MONDAY_REPEAT }];
  const r = dedup(art, new Set(), 0.85, [], 0.7, [FRIDAY_D1], 0.6, undefined, 0.55, new Set(), [], [], wed);
  assert.equal(r.kept.length, 1);
});

test("#9565: feriado não é descontado — janela encolhe em 1 edição (conservador)", () => {
  // Segunda 261012 feriado (Nossa Senhora Aparecida): sex 261009 → ter 261013
  // = seg + ter = 2 → ainda casa (edição anterior publicada).
  assert.equal(editionBusinessDaysBefore("261009", "261013"), 2);
  assert.ok(findSameEvent(MONDAY_REPEAT, [{ title: FRIDAY_D1, distanceDays: 2 }]));
  // qui 261008 → ter 261013 = 3 (era a edição de antes da anterior) → não casa.
  assert.equal(editionBusinessDaysBefore("261008", "261013"), 3);
  assert.equal(findSameEvent(MONDAY_REPEAT, [{ title: FRIDAY_D1, distanceDays: 3 }]), null);
});
