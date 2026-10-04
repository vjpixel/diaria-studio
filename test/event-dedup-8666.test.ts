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
  SAME_EDITION,
  editionDaysBefore,
} from "../scripts/lib/event-dedup.ts";
import { dedup } from "../scripts/dedup.ts";
import { isIntraEditionDuplicate } from "../scripts/dedup-intra-edition.ts";
import { extractPastTitles, extractPastTitlesWithEdition } from "../scripts/lib/past-editions-extract.ts";

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
    assert.equal(m.signal, "strong_concept", t);
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

test("#8666: vazamento de DADOS é conceito forte (mesma empresa, D-1)", () => {
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

// ---------------------------------------------------------------------------
// Review do PR #9560: o sinal (C) REMOVE artigo — léxico forte estreito, e
// nenhum termo novo pode mudar o (B), que vale sem limite de tempo.
// ---------------------------------------------------------------------------

/** Par que NÃO pode casar — nem sem distância, nem nas distâncias dadas. */
function assertNoMatch(a: string, b: string, days: number[] = [1, 0]): void {
  assert.equal(sameEvent(a, b), null, `sem distância: ${a} × ${b}`);
  for (const d of days) {
    assert.equal(sameEvent(a, b, { distanceDays: d }), null, `D-${d}: ${a} × ${b}`);
    assert.equal(sameEvent(b, a, { distanceDays: d }), null, `D-${d} (invertido): ${b} × ${a}`);
  }
}

test("#8666 review P1: 'violação' jurídico não vira HACK (pares processo/multa)", () => {
  assertNoMatch(
    "OpenAI é processada por violação de direitos autorais",
    "OpenAI é processada por violação de patentes",
  );
  assertNoMatch(
    "Meta recebe multa por violação da LGPD",
    "Meta é multada por violação de privacidade na Europa",
  );
  assert.equal(eventConcepts("OpenAI é processada por violação de patentes").has("HACK"), false);
  assert.equal(strongEventConcepts("OpenAI é processada por violação de patentes").size, 0);
});

test("#8666 review P1: 'breach' fora de 'data breach' não é invasão (nem em B)", () => {
  assert.equal(eventConcepts("OpenAI sued for breach of contract").has("HACK"), false);
  assert.equal(strongEventConcepts("OpenAI sued for breach of contract").size, 0);
  assert.ok(strongEventConcepts("OpenAI confirms data breach").has("HACK"));
  assert.ok(eventConcepts("OpenAI confirms data breach").has("HACK"));
});

test("#8666 review P2.1: 'hacks'/'hacking' coloquiais não casam com invasão real", () => {
  assertNoMatch("5 ChatGPT hacks para economizar horas", "OpenAI foi invadida por hackers");
  assertNoMatch("Growth hacking com ChatGPT: guia", "OpenAI hacked by state actors", [2, 1, 0]);
  assertNoMatch("Anthropic publica estudo sobre reward hacking no Claude", D1_260921);
  for (const t of ["hack", "hacks", "hacking", "hacker", "hackers"]) {
    assert.equal(strongEventConcepts(`OpenAI e o ${t} do dia`).size, 0, t);
  }
});

test("#8666 review P2.2: 'invade'/'invadem' figurativo não é forte", () => {
  assertNoMatch("Gemini invade o Android e o Chrome", "Google sofre ciberataque e dados vazam");
  assertNoMatch("ChatGPT invade as escolas", "OpenAI foi invadida por hackers");
  assert.equal(strongEventConcepts("Gemini chega para invadir o mercado").size, 0);
  // Com objeto de segurança ou "ajudou a", conta.
  assert.ok(strongEventConcepts("Hackers invadem servidores da OpenAI").has("HACK"));
  assert.ok(strongEventConcepts(D1_260921).has("HACK"));
});

test("#8666 review P2.3: vazamento de PRODUTO não é forte; de dados é", () => {
  assertNoMatch("OpenAI vaza detalhes do GPT-6", "Documento interno da OpenAI vazou");
  assert.equal(strongEventConcepts("OpenAI vaza data de lançamento do GPT-6").size, 0);
  assert.ok(strongEventConcepts("OpenAI leaked user data").has("LEAK"));
  assert.ok(strongEventConcepts("Senhas de usuários do ChatGPT vazaram").has("LEAK"));
});

test("#8666 re-review P2: menção defensiva/de risco/produto não é incidente", () => {
  assertNoMatch(
    "Microsoft ajuda empresas a evitar ciberataques com Security Copilot",
    "Microsoft sofre ciberataque russo",
  );
  assertNoMatch("How Claude helps defend against cyberattacks, says Anthropic", "Anthropic hacked by state actors");
  assertNoMatch(
    "Samsung lança Galaxy AI com proteção contra vazamento de dados",
    "Samsung proíbe ChatGPT após vazamento de dados internos",
  );
  // Título real de 260813.
  const risco = "OpenAI freia nova IA por risco de ciberataques autônomos";
  assertNoMatch(risco, "OpenAI foi invadida por hackers");
  assertNoMatch(risco, "OpenAI hacked by attackers using Claude Opus 5");
  assertNoMatch(risco, D1_260921);
  assert.equal(strongEventConcepts("OpenAI alerta para risco de ciberataque com IA").size, 0);
  assert.equal(strongEventConcepts("Google protects users against data breach").size, 0);
});

test("#8666 re-review P2: incidentes reais seguem fortes ('após' não é defensivo)", () => {
  assert.ok(strongEventConcepts("Samsung proíbe ChatGPT após vazamento de dados internos").has("LEAK"));
  assert.ok(strongEventConcepts("Google sofre ciberataque e dados vazam").has("HACK"));
  assert.ok(strongEventConcepts("Google sofre ciberataque e dados vazam").has("LEAK"));
  assert.ok(strongEventConcepts("Microsoft sofre ciberataque russo").has("HACK"));
  const m = sameEvent("Google sofre ciberataque e dados vazam", "Hackers invadem servidores do Google", { distanceDays: 1 });
  assert.ok(m);
  assert.equal(m.signal, "strong_concept");
});

test("#8666 re-review P3: 'invadir' figurativo com verbo de ajuda ou objeto ambíguo", () => {
  assertNoMatch(
    "Microsoft ajuda a invadir o mercado de PCs com Copilot",
    "Microsoft foi invadida por hackers russos",
    [0, 1],
  );
  assertNoMatch("Amazon quer invadir sistemas de saúde com IA", "Amazon sofre ciberataque", [1, 0]);
  assert.equal(strongEventConcepts("Meta quer invadir as redes sociais rivais").size, 0);
  assert.equal(strongEventConcepts("Nvidia ajudou a invadir o mercado de bancos de dados").size, 0);
  // O trio continua: "ajudou a invadir" + empresa / objeto inequívoco.
  assert.ok(strongEventConcepts("Rival do ChatGPT ajudou a invadir contas da OpenAI").has("HACK"));
  assert.ok(strongEventConcepts(D1_260921).has("HACK"));
});

test("#8666 review: SAME_EDITION é distância 0 e habilita (C)", () => {
  assert.equal(SAME_EDITION.distanceDays, 0);
  const m = sameEvent(TRIO[2], D1_260921, SAME_EDITION);
  assert.ok(m);
  assert.equal(m.signal, "strong_concept");
});

test("#8666 review P2.5: minDistanceByTitle ignora a própria edição e edições futuras", () => {
  assert.equal(editionDaysBefore("260921", "260922"), 1);
  assert.equal(editionDaysBefore("260923", "260922"), -1);
  const m = minDistanceByTitle(
    [
      { title: "self", aammdd: "260922" },
      { title: "futuro", aammdd: "260923" },
      { title: "passado", aammdd: "260920" },
      { title: "misto", aammdd: "260923" },
      { title: "misto", aammdd: "260919" },
    ],
    "260922",
  );
  assert.equal(m.has("self"), false);
  assert.equal(m.has("futuro"), false);
  assert.equal(m.get("passado"), 2);
  // #9565: distância em dias úteis — sáb 260919 → ter 260922 = seg + ter = 2.
  assert.equal(m.get("misto"), 2);
});

test("#8666 review P2.6: todo título de extractPastTitles tem entrada no mapa de distâncias", () => {
  const md = [
    "# Past",
    "",
    '## 2026-09-21 — "Título com — travessão e: dois-pontos"',
    "- https://example.com/a",
    "",
    '## 2026-09-20 (republicada) — "Outro título"',
    "",
    "## 2026-09-19 — sem aspas",
    "",
    '## 2026-09-18 — "Fora da janela"',
  ].join("\n");
  const titles = extractPastTitles(md, 3);
  assert.deepEqual(titles, extractPastTitlesWithEdition(md, 3).map((e) => e.title));
  const dist = minDistanceByTitle(extractPastTitlesWithEdition(md, 3), "260922");
  for (const t of titles) assert.ok(dist.has(t), `sem distância: ${t}`);
  assert.equal(titles.includes("Fora da janela"), false);
});
