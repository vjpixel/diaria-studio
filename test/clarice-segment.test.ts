import { test } from "node:test";
import assert from "node:assert/strict";
import {
  segmentFromStore,
  priorityQueue,
  sliceIntoWaves,
  loadStoreRows,
  isFirstSend,
  isSendEligible,
  FIRST_SEND_SQL_PREDICATE,
  deriveCohort,
  cohortLabel,
  resolveCohortArg,
  isInternalEmail,
  isEngajados,
  segmentEngajados,
  isReativacao,
  segmentReativacao,
  isRampWarm,
  segmentRampWarm,
  isNamedGroupKey,
  NAMED_GROUPS,
  type StoreRow,
} from "../scripts/lib/clarice-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { cohortFromTier, INTERNAL_EMAILS } from "../scripts/lib/cohorts.ts";

// Oráculo LOCAL de `tierRank` (#2857 fase C — a função viveu exportada em
// clarice-segment.ts até a fase B, removida no cutover; ver
// scripts/cohort-order-dryrun.ts, que ganhou a própria cópia inline pro único
// consumidor de produção restante). Réplica idêntica só pro oráculo
// `firstSendOrderByTierOracle` abaixo — não reimporta nada de produção.
function tierRank(t: number | null): number {
  return t == null ? Number.POSITIVE_INFINITY : t;
}

// #2857 fase B: `cohort` (não mais `tier`) governa a ordem de 1º envio em
// segmentFromStore — default derivado de `tier` (mesma regra que
// recomputeDerived aplica no store real, ver clarice-db.ts), sobrescrevível
// via `p.cohort` explícito quando um teste quer simular um cohort divergente
// do tier (ex: safra mensal, que não tem tier residual real na prática mas é
// útil pra exercitar o caminho isoladamente).
function row(p: Partial<StoreRow> & { email: string }): StoreRow {
  const tier = p.tier ?? null;
  return {
    tier,
    cohort: cohortFromTier(tier),
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    ...p,
  };
}

// ---------------------------------------------------------------------------
// segmentFromStore — partição nos 3 grupos
// ---------------------------------------------------------------------------

test("segmentFromStore: send_eligible=0 vai pra excluded com a razão", () => {
  const s = segmentFromStore([
    row({ email: "a@x.com", send_eligible: 0, ineligible_reason: "hard_bounce" }),
    row({ email: "b@x.com", send_eligible: 0, ineligible_reason: null }),
  ]);
  assert.equal(s.reSend.length, 0);
  assert.equal(s.firstSend.length, 0);
  assert.deepEqual(s.excluded, [
    { email: "a@x.com", reason: "hard_bounce" },
    { email: "b@x.com", reason: "unknown" }, // razão nula → "unknown"
  ]);
});

test("segmentFromStore: conta de teste do editor (vjpixel+test*@gmail.com) é cortada pra excluded MESMO se send_eligible=1 (#2895, defesa em profundidade)", () => {
  const s = segmentFromStore([
    row({ email: "vjpixel+test2@gmail.com", send_eligible: 1, priority_points: 999 }),
    row({ email: "leitora@x.com", send_eligible: 1 }),
  ]);
  assert.equal(s.reSend.length, 0);
  assert.deepEqual(s.firstSend.map((r) => r.email), ["leitora@x.com"]);
  assert.deepEqual(s.excluded, [
    { email: "vjpixel+test2@gmail.com", reason: "test_account" },
  ]);
});

test("segmentFromStore: re-envio ordenado por priority_points DESC (email desempata)", () => {
  const s = segmentFromStore([
    row({ email: "c@x.com", sends_count: 3, priority_points: 20 }),
    row({ email: "a@x.com", sends_count: 5, priority_points: 60 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 20 }),
  ]);
  assert.deepEqual(
    s.reSend.map((r) => r.email),
    ["a@x.com", "b@x.com", "c@x.com"], // 60 > 20; entre os 20, email asc
  );
  assert.equal(s.firstSend.length, 0);
});

test("segmentFromStore: 1º envio ordenado por tier ASC; tier nulo por último", () => {
  const s = segmentFromStore([
    row({ email: "lead@x.com", sends_count: 0, tier: 5 }),
    row({ email: "ativo@x.com", sends_count: 0, tier: 1 }),
    row({ email: "orfao@x.com", sends_count: 0, tier: null }),
    row({ email: "ex@x.com", sends_count: 0, tier: 2 }),
  ]);
  assert.deepEqual(
    s.firstSend.map((r) => r.email),
    ["ativo@x.com", "ex@x.com", "lead@x.com", "orfao@x.com"],
  );
  assert.equal(s.reSend.length, 0);
});

test("segmentFromStore: separa re-envio de 1º envio por sends_count", () => {
  const s = segmentFromStore([
    row({ email: "novo@x.com", sends_count: 0, tier: 1 }),
    row({ email: "veterano@x.com", sends_count: 4, priority_points: 80 }),
  ]);
  assert.deepEqual(s.reSend.map((r) => r.email), ["veterano@x.com"]);
  assert.deepEqual(s.firstSend.map((r) => r.email), ["novo@x.com"]);
});

test("segmentFromStore: contato já-enviado NUNCA cai em firstSend, mesmo com tier T01 válido (#2732)", () => {
  // Finding do #2732: nenhum atributo estático prediz abertura — o preditor
  // real é o histórico de envio. Uma vez que o contato tem sends_count>0, o
  // eixo de segmentação correto é priority_points (reSend), nunca mais tier
  // (firstSend) — mesmo que o tier seja o "melhor" possível (T01, ativo).
  const s = segmentFromStore([
    row({ email: "ja-enviado@x.com", tier: 1, sends_count: 1, priority_points: -20 }),
  ]);
  assert.equal(s.firstSend.length, 0);
  assert.deepEqual(s.reSend.map((r) => r.email), ["ja-enviado@x.com"]);
});

// ---------------------------------------------------------------------------
// sliceIntoWaves
// ---------------------------------------------------------------------------

test("priorityQueue: engajado (points>0) → 1º envio (tier) → re-envio decaído (points<=0)", () => {
  const seg = segmentFromStore([
    row({ email: "eng@x.com", sends_count: 3, priority_points: 60 }),
    row({ email: "decay@x.com", sends_count: 2, priority_points: -20 }),
    row({ email: "fresh@x.com", sends_count: 0, tier: 1 }),
  ]);
  assert.deepEqual(
    priorityQueue(seg).map((r) => r.email),
    ["eng@x.com", "fresh@x.com", "decay@x.com"],
  );
});

test("priorityQueue: reSend com priority_points null NÃO some (vai pra decaído)", () => {
  const seg = segmentFromStore([
    row({ email: "nullpts@x.com", sends_count: 2, priority_points: null as any }),
    row({ email: "eng@x.com", sends_count: 1, priority_points: 30 }),
  ]);
  const q = priorityQueue(seg).map((r) => r.email);
  assert.ok(q.includes("nullpts@x.com"), "linha com points null não pode sumir da fila");
  assert.deepEqual(q, ["eng@x.com", "nullpts@x.com"]); // eng (>0) antes; null→0→decaído
});

test("sliceIntoWaves: fatia em tamanhos de maxSize, última menor", () => {
  assert.deepEqual(sliceIntoWaves([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("sliceIntoWaves: maxSize<=0 → 1 wave com tudo; vazio → []", () => {
  assert.deepEqual(sliceIntoWaves([1, 2, 3], 0), [[1, 2, 3]]);
  assert.deepEqual(sliceIntoWaves([], 100), []);
});

test("sliceIntoWaves: tamanho múltiplo exato de maxSize → sem wave final menor", () => {
  assert.deepEqual(sliceIntoWaves([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("sliceIntoWaves: maxSize=1 → cada elemento numa wave", () => {
  assert.deepEqual(sliceIntoWaves([1, 2, 3], 1), [[1], [2], [3]]);
});

test("segmentFromStore: não muta o array de entrada", () => {
  const input = [
    row({ email: "b@x.com", sends_count: 1, priority_points: 10 }),
    row({ email: "a@x.com", sends_count: 1, priority_points: 90 }),
  ];
  const snapshot = input.map((r) => r.email);
  segmentFromStore(input);
  assert.deepEqual(
    input.map((r) => r.email),
    snapshot,
    "a ordem do input original deve permanecer intacta",
  );
});

test("segmentFromStore: send_eligible null cai no corte (fail-safe)", () => {
  const s = segmentFromStore([
    { email: "x@x.com", tier: 1, priority_points: 0, send_eligible: null as any, ineligible_reason: null, sends_count: 0 },
  ]);
  assert.equal(s.firstSend.length, 0);
  assert.equal(s.reSend.length, 0);
  assert.deepEqual(s.excluded, [{ email: "x@x.com", reason: "unknown" }]);
});

// ---------------------------------------------------------------------------
// loadStoreRows — integração com o store SQLite
// ---------------------------------------------------------------------------

test("loadStoreRows + segmentFromStore: ponta-a-ponta sobre o store", () => {
  const db = openClariceDb(":memory:");
  // ativo, 1º envio
  db.prepare("INSERT INTO clarice_users (email, status, tier) VALUES (?, 'active', 1)").run("novo@x.com");
  // veterano engajado (re-envio): seta opens/sends direto (mv_bucket verified;
  // desde #2804 o MV não é mais exigido pra tier != 1 ser elegível, mas
  // manter o dado explícito aqui documenta o caso "verificado" também)
  db.prepare(
    "INSERT INTO clarice_users (email, tier, opens_count, sends_count, mv_bucket) VALUES (?, 2, 3, 3, 'verified')",
  ).run("vet@x.com");
  // descadastrado → cortado
  db.prepare(
    "INSERT INTO clarice_users (email, unsubscribed, sends_count) VALUES (?, 1, 2)",
  ).run("unsub@x.com");
  recomputeDerived(db);

  const s = segmentFromStore(loadStoreRows(db));
  assert.deepEqual(s.reSend.map((r) => r.email), ["vet@x.com"]);
  assert.deepEqual(s.firstSend.map((r) => r.email), ["novo@x.com"]);
  assert.deepEqual(s.excluded, [{ email: "unsub@x.com", reason: "unsubscribed" }]);
  db.close();
});

test("loadStoreRows + segmentFromStore: mv_result=unknown fica FORA de toda wave (#2735)", () => {
  const db = openClariceDb(":memory:");
  // mv_result="unknown" (linha de um mv-export-*-unknown.csv ingerida no store)
  db.prepare(
    "INSERT INTO clarice_users (email, tier, mv_result, mv_bucket) VALUES (?, 1, 'unknown', 'unknown')",
  ).run("inconclusivo@x.com");
  // controle: mv_result="ok" (verified) continua elegível e entra em firstSend
  db.prepare(
    "INSERT INTO clarice_users (email, tier, mv_result, mv_bucket) VALUES (?, 1, 'ok', 'verified')",
  ).run("ok@x.com");
  recomputeDerived(db);

  const rows = loadStoreRows(db);
  const inconclusivo = rows.find((r) => r.email === "inconclusivo@x.com")!;
  assert.equal(inconclusivo.send_eligible, 0);
  assert.equal(inconclusivo.ineligible_reason, "mv_unknown");

  const s = segmentFromStore(rows);
  // não entra em reSend nem firstSend — logo não pode ser fatiado em nenhuma wave.
  assert.ok(!s.reSend.some((r) => r.email === "inconclusivo@x.com"));
  assert.ok(!s.firstSend.some((r) => r.email === "inconclusivo@x.com"));
  assert.deepEqual(s.excluded, [
    { email: "inconclusivo@x.com", reason: "mv_unknown" },
  ]);

  // sem regressão: mv_result="ok" continua elegível e vai pra 1º envio (firstSend).
  assert.deepEqual(s.firstSend.map((r) => r.email), ["ok@x.com"]);

  db.close();
});

// ---------------------------------------------------------------------------
// #2782 — predicado firstSend: fonte única JS ⇄ SQL
// ---------------------------------------------------------------------------

test("isFirstSend / isSendEligible: edges de NULL espelham segmentFromStore (#2782)", () => {
  // send_eligible NULL (linha nunca-recomputada) → corte fail-safe, nunca firstSend.
  assert.equal(isSendEligible({ send_eligible: null as unknown as number }), false);
  assert.equal(isFirstSend({ send_eligible: null as unknown as number, sends_count: 0 }), false);
  // sends_count NULL ⇄ 0 (coalesce): elegível nunca-enviado É firstSend.
  assert.equal(isFirstSend({ send_eligible: 1, sends_count: null as unknown as number }), true);
  assert.equal(isFirstSend({ send_eligible: 1, sends_count: 0 }), true);
  assert.equal(isFirstSend({ send_eligible: 1, sends_count: 2 }), false);
});

test("isFirstSend: sends_count negativo/NaN (dado patológico) cai em firstSend, não reSend (#2812 item 5)", () => {
  // Inalcançável hoje com o writer real (MAX de um array.length, sempre >= 0),
  // mas o invariante "sends_count >= 0" é só implícito — um `=== 0` estrito
  // mandaria esses valores pra reSend (partição errada) em vez de tratá-los
  // como "sem histórico confiável de envio", que é a leitura mais segura.
  assert.equal(isFirstSend({ send_eligible: 1, sends_count: -1 }), true, "negativo → firstSend");
  assert.equal(isFirstSend({ send_eligible: 1, sends_count: -5 }), true, "negativo (mais extremo) → firstSend");
  assert.equal(isFirstSend({ send_eligible: 1, sends_count: NaN }), true, "NaN → firstSend (NaN > 0 é false)");
  // controle: elegibilidade continua sendo checada primeiro (fail-safe não muda).
  assert.equal(isFirstSend({ send_eligible: 0, sends_count: -1 }), false, "inelegível + patológico continua false");
});

test("FIRST_SEND_SQL_PREDICATE ⇄ segmentFromStore: mesmo by_tier sobre um store real (#2782)", () => {
  // Regressão do padrão "2 cópias que divergem silenciosamente": o by_tier do
  // clarice-db-summary (SQL) tem que contar EXATAMENTE o universo firstSend de
  // segmentFromStore (JS). Se a regra de elegibilidade mudar num lado só (como
  // #2732/#2735 quase fizeram), este teste quebra.
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // firstSend: elegível, nunca enviado — tiers variados (incl. null)
  ins("INSERT INTO clarice_users (email, status, tier) VALUES ('a@x.com','active',1)");
  ins("INSERT INTO clarice_users (email, status, tier) VALUES ('b@x.com','active',1)");
  ins("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES ('c@x.com',3,'verified')");
  ins("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES ('d@x.com',NULL,'verified')");
  // reSend: elegível mas já enviado — NÃO conta no by_tier
  ins("INSERT INTO clarice_users (email, tier, opens_count, sends_count, mv_bucket) VALUES ('vet@x.com',2,3,3,'verified')");
  // excluded: nunca enviado mas inelegível (dispute / unsub) — NÃO conta
  ins("INSERT INTO clarice_users (email, tier, dispute_losses) VALUES ('disputa@x.com',3,10)");
  ins("INSERT INTO clarice_users (email, tier, unsubscribed, sends_count) VALUES ('unsub@x.com',1,1,2)");
  recomputeDerived(db);
  // edge pós-recompute: linha crua com send_eligible NULL + sends_count NULL
  // (nunca recomputada) — JS corta (falsy) e SQL corta (=1 falha em NULL).
  ins("INSERT INTO clarice_users (email, tier, send_eligible, sends_count) VALUES ('cru@x.com',1,NULL,NULL)");

  // Lado SQL — a MESMA cláusula que clarice-db-summary.ts usa no by_tier.
  // #2812 item 7: este loop reimplementa a agregação MANUALMENTE (não importa
  // `groupCounts`/`groupCountsWithVerified` de clarice-db-summary.ts) DE
  // PROPÓSITO — um oráculo independente do código de produção pega bug que um
  // teste que reusa a mesma função de agregação não pegaria (ex: um bug na
  // própria groupCounts passaria despercebido, pois "comparando com si mesma").
  const sqlByTier: Record<string, number> = {};
  for (const r of db
    .prepare(`SELECT tier AS k, COUNT(*) n FROM clarice_users WHERE ${FIRST_SEND_SQL_PREDICATE} GROUP BY tier`)
    .all() as Array<{ k: unknown; n: number }>) {
    sqlByTier[r.k == null ? "null" : String(r.k)] = r.n;
  }

  // Lado JS — o universo firstSend real da segmentação de wave.
  const jsByTier: Record<string, number> = {};
  for (const r of segmentFromStore(loadStoreRows(db)).firstSend) {
    const k = r.tier == null ? "null" : String(r.tier);
    jsByTier[k] = (jsByTier[k] ?? 0) + 1;
  }

  assert.deepEqual(sqlByTier, jsByTier, "SQL e JS devem contar o mesmo universo firstSend");
  assert.deepEqual(sqlByTier, { "1": 2, "3": 1, null: 1 }, "sanidade: a,b (T1), c (T3), d (sem tier)");
  db.close();
});

// ---------------------------------------------------------------------------
// #2817 — cohort: derivação, rótulo de exibição, resolução de --cohort
// ---------------------------------------------------------------------------

test("deriveCohort: mês de `created` >= 2026-05 vira 'YYYY-MM'", () => {
  assert.equal(deriveCohort("2026-05-15T00:00:00.000Z"), "2026-05");
  assert.equal(deriveCohort("2026-06-01T00:00:00.000Z"), "2026-06");
  assert.equal(deriveCohort("2026-07-30T23:59:59.999Z"), "2026-07");
});

test("deriveCohort: anterior a 2026-05 vira NULL (sem safra rotulada)", () => {
  assert.equal(deriveCohort("2025-12-31T00:00:00.000Z"), null);
  assert.equal(deriveCohort("2026-04-30T23:59:59.999Z"), null);
});

test("deriveCohort: created ausente/inválido vira NULL", () => {
  assert.equal(deriveCohort(null), null);
  assert.equal(deriveCohort(undefined), null);
  assert.equal(deriveCohort(""), null);
  assert.equal(deriveCohort("não-é-uma-data"), null);
});

test("deriveCohort: aceita data-only (sem horário) — 'created' vem como ISO date puro", () => {
  assert.equal(deriveCohort("2026-06-15"), "2026-06");
});

// #2857 fase A: a coluna `cohort` agora guarda o slug da taxonomia unificada
// (`leads-YYYY-MM`, não mais a safra crua 'YYYY-MM') — cohortLabel/
// resolveCohortArg foram atualizados de acordo (delegam a scripts/lib/
// cohorts.ts, ver test/cohorts.test.ts pra cobertura de cohortDisplayLabel
// nos demais slugs — assinantes-ativos, leads-2025h2, leads-caudao...).

test("cohortLabel: traduz slug de safra 'leads-YYYY-MM' de 2026 pro mês/ano em pt-BR (#2880: sem prefixo 'Leads')", () => {
  assert.equal(cohortLabel("leads-2026-05"), "mai/2026");
  assert.equal(cohortLabel("leads-2026-06"), "jun/2026");
  assert.equal(cohortLabel("leads-2026-07"), "jul/2026");
});

test("cohortLabel: null vira 'sem cohort'", () => {
  assert.equal(cohortLabel(null), "sem cohort");
});

test("cohortLabel: forma corrompida/inesperada devolve a chave crua (nunca lança)", () => {
  assert.equal(cohortLabel("lixo"), "lixo");
  assert.equal(cohortLabel("leads-2026-13"), "leads-2026-13"); // mês inválido
});

test("resolveCohortArg: forma canônica 'YYYY-MM' vira o slug 'leads-YYYY-MM' (coluna guarda o slug, #2857)", () => {
  assert.equal(resolveCohortArg("2026-06"), "leads-2026-06");
  assert.equal(resolveCohortArg("2027-01"), "leads-2027-01");
});

test("resolveCohortArg: rótulo pt-BR (case-insensitive) resolve pro slug do ano-epoch (2026)", () => {
  assert.equal(resolveCohortArg("junho"), "leads-2026-06");
  assert.equal(resolveCohortArg("Junho"), "leads-2026-06");
  assert.equal(resolveCohortArg("MAIO"), "leads-2026-05");
});

test("resolveCohortArg: input não reconhecido lança erro claro", () => {
  assert.throws(() => resolveCohortArg("fevereiro-de-2099"), /não reconhecido/);
  assert.throws(() => resolveCohortArg(""), /não reconhecido/);
});

// ---------------------------------------------------------------------------
// #2857 fase B — resolveCohortArg: slug canônico direto
// (alias de tier legado, introduzido na fase B como ponte de migração, foi
// REMOVIDO no cutover da fase C — ver testes logo abaixo.)
// ---------------------------------------------------------------------------

test("resolveCohortArg: slug canônico da taxonomia é aceito diretamente (#2857 fase B)", () => {
  assert.equal(resolveCohortArg("assinantes-ativos"), "assinantes-ativos");
  assert.equal(resolveCohortArg("ex-assinantes"), "ex-assinantes");
  assert.equal(resolveCohortArg("leads-2025h2"), "leads-2025h2");
  assert.equal(resolveCohortArg("leads-2026-jan-abr"), "leads-2026-jan-abr");
  assert.equal(resolveCohortArg("leads-caudao"), "leads-caudao");
  // forma canônica de safra passada DIRETO (já com prefixo leads-), sem passar
  // pelo caminho pt-BR/YYYY-MM cru.
  assert.equal(resolveCohortArg("leads-2026-06"), "leads-2026-06");
});

test("resolveCohortArg: slug inventado (não reconhecido) continua lançando erro", () => {
  assert.throws(() => resolveCohortArg("cohort-que-nao-existe"), /não reconhecido/);
  // "leads-9999-99" TEM a forma sintática de safra mensal (\d{4}-\d{2}) — mesma
  // leniência de cohortDisplayLabel/cohortSendRank (não validam mês 1-12, ver
  // test/cohorts.test.ts "forma corrompida/desconhecida"), então É aceito por
  // isKnownCohortSlug. "leads-lixo", sem a forma numérica, não é reconhecido.
  assert.doesNotThrow(() => resolveCohortArg("leads-9999-99"));
  assert.throws(() => resolveCohortArg("leads-lixo"), /não reconhecido/);
});

test("resolveCohortArg: alias de tier legado ('t04'/'T4'/'t01'/'t02'/'t10') NÃO é mais aceito (#2857 fase C — cutover remove o alias introduzido na fase B)", () => {
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  try {
    assert.throws(() => resolveCohortArg("t04"), /não reconhecido/);
    assert.throws(() => resolveCohortArg("T4"), /não reconhecido/);
    assert.throws(() => resolveCohortArg("t01"), /não reconhecido/);
    assert.throws(() => resolveCohortArg("t02"), /não reconhecido/);
    assert.throws(() => resolveCohortArg("t10"), /não reconhecido/);
  } finally {
    console.error = orig;
  }
  assert.equal(warnings.length, 0, "nenhum warning de deprecação — o caminho do alias foi removido, não só desativado");
});

test("resolveCohortArg: formas 't{NN}' fora do mapa (t00/t11) lançam o mesmo erro genérico que qualquer 't{NN}' (nunca mais um alias válido)", () => {
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  try {
    assert.throws(() => resolveCohortArg("t00"), /não reconhecido/);
    assert.throws(() => resolveCohortArg("t11"), /não reconhecido/);
  } finally {
    console.error = orig;
  }
  assert.equal(warnings.length, 0, "tier fora do mapa não deve emitir warning (o alias nunca foi válido)");
});

// ---------------------------------------------------------------------------
// #2857 fase B — equivalência tier-order ⇄ cohort-order (gate da migração,
// Refs #2857 fase B item 1: "ordenação de 1º envio passa de tierRank(tier)
// pra cohortSendRank(cohort)")
// ---------------------------------------------------------------------------

/** Réplica PURA e independente da ordenação de 1º envio PRÉ-fase-B (tierRank
 * ASC + email ASC) — oráculo que NÃO reusa segmentFromStore/cohortSendRank,
 * pra um bug introduzido na migração não escapar por "comparar consigo mesma". */
function firstSendOrderByTierOracle(rows: StoreRow[]): string[] {
  return rows
    .filter((r) => isFirstSend(r))
    .slice()
    .sort((a, b) => {
      const ra = tierRank(a.tier);
      const rb = tierRank(b.tier);
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.email.localeCompare(b.email);
    })
    .map((r) => r.email);
}

test("#2857 fase B equivalência (a): byte-idêntica QUANDO created é consistente com o tier (#2857 fase B.1: a semântica mudou — desde a B.1 quem manda é o período do created, não mais o tier)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // #2857 fase B.1: a ordem só é byte-idêntica à ordem antiga por tier QUANDO
  // o `created` de cada contato é CONSISTENTE com o rótulo estático que
  // `TIER_TO_COHORT` atribuiria àquele tier — porque a derivação primária do
  // cohort de um lead (tier != 1/2) passou a ser o período REAL do `created`
  // (`deriveLeadCohort`), não mais o tier residual do merge (ver teste
  // "equivalência (b)" abaixo pra o caso em que created DIVERGE do tier).
  //   T01/T02 (pagante): created é IRRELEVANTE (regra 1) — usamos uma data
  //     qualquer pra provar isso.
  //   T03 ('leads-2026-jan-abr', o único slug "range"): só alcançável pelo
  //     FALLBACK de tier (created ausente) — a derivação primária NUNCA emite
  //     esse range (created 2026-01..04 viraria 'leads-2026h1', ver teste (b)).
  //   T04-T09 (semestrais): created dentro do semestre REAL que o slug estático
  //     nomeia (ex: T04='leads-2025h2' → created em jul-dez/2025).
  //   T10 ('leads-caudao'): created ausente (mesma invariante de `tierOf` —
  //     "sem data → fóssil" — é o único caminho realista pro fallback).
  //   sem tier: created TAMBÉM ausente — só assim cai em cohort NULL (fim da
  //     fila) nos dois esquemas; com created presente, a regra 3c (tier NULL +
  //     created presente → deriva por created) tiraria esses contatos do fim.
  const createdByTier: Record<number, string | null> = {
    1: "2020-01-01T00:00:00Z", // irrelevante (regra 1)
    2: "2020-01-01T00:00:00Z", // irrelevante (regra 1)
    3: null,                   // fallback (único jeito de emitir o range)
    4: "2025-08-15T00:00:00Z", // H2 2025
    5: "2025-03-15T00:00:00Z", // H1 2025
    6: "2024-08-15T00:00:00Z", // H2 2024
    7: "2024-03-15T00:00:00Z", // H1 2024
    8: "2023-08-15T00:00:00Z", // H2 2023
    9: "2023-03-15T00:00:00Z", // H1 2023
    10: null,                  // fallback (fóssil sem data)
  };
  // #2888: mv_bucket='verified' em todos — este teste é sobre ORDEM de fila
  // (cohort vs tier), não elegibilidade; sem MV, os leads (tier != 1) cairiam
  // como mv_unverified e sumiriam do firstSend, esvaziando a comparação.
  for (let t = 1; t <= 10; t++) {
    const created = createdByTier[t];
    if (created) {
      ins("INSERT INTO clarice_users (email, tier, created, mv_bucket) VALUES (?, ?, ?, 'verified')", `t${String(t).padStart(2, "0")}b@x.com`, t, created);
      ins("INSERT INTO clarice_users (email, tier, created, mv_bucket) VALUES (?, ?, ?, 'verified')", `t${String(t).padStart(2, "0")}a@x.com`, t, created);
    } else {
      ins("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES (?, ?, 'verified')", `t${String(t).padStart(2, "0")}b@x.com`, t);
      ins("INSERT INTO clarice_users (email, tier, mv_bucket) VALUES (?, ?, 'verified')", `t${String(t).padStart(2, "0")}a@x.com`, t);
    }
  }
  ins("INSERT INTO clarice_users (email, mv_bucket) VALUES ('nullb@x.com', 'verified')");
  ins("INSERT INTO clarice_users (email, mv_bucket) VALUES ('nulla@x.com', 'verified')");
  recomputeDerived(db);

  const rows = loadStoreRows(db);
  const byEmail = new Map(rows.map((r) => [r.email, r]));
  // sanidade: cada cohort derivado bate EXATAMENTE com o slug estático do
  // tier (é isso que torna a ordem byte-idêntica possível).
  assert.equal(byEmail.get("t01a@x.com")!.cohort, "assinantes-ativos");
  assert.equal(byEmail.get("t02a@x.com")!.cohort, "ex-assinantes");
  assert.equal(byEmail.get("t03a@x.com")!.cohort, "leads-2026-jan-abr");
  assert.equal(byEmail.get("t04a@x.com")!.cohort, "leads-2025h2");
  assert.equal(byEmail.get("t10a@x.com")!.cohort, "leads-caudao");
  assert.equal(byEmail.get("nulla@x.com")!.cohort, null);

  const cohortOrder = segmentFromStore(rows).firstSend.map((r) => r.email);
  const tierOracleOrder = firstSendOrderByTierOracle(rows);

  assert.deepEqual(
    cohortOrder,
    tierOracleOrder,
    "created consistente com o tier em todos os contatos → cohort-order (novo) byte-idêntica a tier-order (antigo)",
  );
  // sanidade: não é um empate degenerado (22 linhas elegíveis nunca-enviadas).
  assert.equal(cohortOrder.length, 22);
  db.close();
});

test("#2857 fase B.1: quando created DIVERGE do rótulo estático do tier, o created MANDA (não é um no-op disfarçado)", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // Os 3 contatos têm o MESMO tier=3 (o "semestre corrente" que o merge
  // atribuiria a qualquer lead de jan-jun/2026, via tierOf em
  // merge-clarice-subscribers.ts) — sob a ordenação ANTIGA (tier), eles
  // empatam e desempatam só por email ASC, cegos à recência real.
  // #2888: mv_bucket='verified' — teste de ORDEM (recência do cohort), não de
  // elegibilidade; sem MV os 3 leads sumiriam do firstSend (mv_unverified).
  ins("INSERT INTO clarice_users (email, tier, created, mv_bucket) VALUES ('a-janabr@x.com', 3, '2026-03-01T00:00:00Z', 'verified')"); // pré-epoch → semestre REAL do created
  ins("INSERT INTO clarice_users (email, tier, created, mv_bucket) VALUES ('b-mai@x.com', 3, '2026-05-10T00:00:00Z', 'verified')");     // safra maio
  ins("INSERT INTO clarice_users (email, tier, created, mv_bucket) VALUES ('c-jun@x.com', 3, '2026-06-10T00:00:00Z', 'verified')");     // safra junho
  recomputeDerived(db);

  const rows = loadStoreRows(db);
  const byEmail = new Map(rows.map((r) => [r.email, r]));
  // #2857 fase B.1: o created MANDA sobre o rótulo estático do tier —
  // a-janabr (created 2026-03, pré-epoch) deriva o semestre REAL
  // 'leads-2026h1', NUNCA o range estático 'leads-2026-jan-abr' que
  // TIER_TO_COHORT[3] atribuiria (esse range só sai pelo fallback de tier,
  // created ausente — ver teste "equivalência (a)" acima).
  assert.equal(byEmail.get("a-janabr@x.com")!.cohort, "leads-2026h1", "created MANDA — não mais o range estático do tier");
  assert.equal(byEmail.get("b-mai@x.com")!.cohort, "leads-2026-05");
  assert.equal(byEmail.get("c-jun@x.com")!.cohort, "leads-2026-06");

  const cohortOrder = segmentFromStore(rows).firstSend.map((r) => r.email);
  const tierOracleOrder = firstSendOrderByTierOracle(rows);

  // ANTES (tier, oráculo independente): mesmo tier(3) pros 3 → desempate só
  // por email ASC (cego à recência).
  assert.deepEqual(tierOracleOrder, ["a-janabr@x.com", "b-mai@x.com", "c-jun@x.com"]);
  // DEPOIS (cohort, #2857 fase B/B.1): por recência DECRESCENTE do início do
  // período REAL — junho (mais novo) primeiro, depois maio, depois o
  // semestre 2026-H1 (início jan/2026, o mais antigo dos 3).
  assert.deepEqual(cohortOrder, ["c-jun@x.com", "b-mai@x.com", "a-janabr@x.com"]);
  // a diferença documentada precisa ser OBSERVÁVEL (não um no-op disfarçado).
  assert.notDeepEqual(cohortOrder, tierOracleOrder);

  db.close();
});

// ---------------------------------------------------------------------------
// #2885 — grupos de envio NOMEADOS (engajados / reativacao / ramp-warm)
// ---------------------------------------------------------------------------

test("isInternalEmail: reconhece os 4 internos (#2809), case/trim-insensível; qualquer outro é falso", () => {
  for (const e of INTERNAL_EMAILS) {
    assert.equal(isInternalEmail(e), true, e);
    assert.equal(isInternalEmail(e.toUpperCase()), true, `${e} (upper)`);
    assert.equal(isInternalEmail(`  ${e}  `), true, `${e} (com espaço)`);
  }
  assert.equal(isInternalEmail("audiencia@x.com"), false);
});

test("isEngajados: send_eligible=1 AND sends_count>0 AND priority_points>0; exclui internos (#2809)", () => {
  assert.equal(
    isEngajados({ email: "a@x.com", send_eligible: 1, sends_count: 3, priority_points: 20 }),
    true,
  );
  // entra/sai por CADA condição:
  assert.equal(
    isEngajados({ email: "a@x.com", send_eligible: 0, sends_count: 3, priority_points: 20 }),
    false,
    "send_eligible=0 → fora",
  );
  assert.equal(
    isEngajados({ email: "a@x.com", send_eligible: 1, sends_count: 0, priority_points: 20 }),
    false,
    "sends_count=0 (nunca enviado) → fora, isso é firstSend/ramp-warm",
  );
  assert.equal(
    isEngajados({ email: "a@x.com", send_eligible: 1, sends_count: 3, priority_points: 0 }),
    false,
    "priority_points<=0 → fora (decaído, não engajado)",
  );
  assert.equal(
    isEngajados({ email: "VJPIXEL@GMAIL.COM", send_eligible: 1, sends_count: 3, priority_points: 20 }),
    false,
    "interno (#2809) → fora mesmo satisfazendo as outras 3 condições",
  );
});

test("segmentEngajados: ordem priority_points DESC, email ASC desempata", () => {
  const rows: StoreRow[] = [
    row({ email: "c@x.com", sends_count: 3, priority_points: 20 }),
    row({ email: "a@x.com", sends_count: 5, priority_points: 60 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 20 }),
    row({ email: "fresh@x.com", sends_count: 0, priority_points: 999 }), // firstSend, não engajados
    row({ email: "decay@x.com", sends_count: 2, priority_points: -10 }), // decaído, não engajados
    row({ email: "cut@x.com", sends_count: 2, priority_points: 50, send_eligible: 0 }), // inelegível
    row({ email: "vjpixel@gmail.com", sends_count: 4, priority_points: 999 }), // interno
  ];
  assert.deepEqual(
    segmentEngajados(rows).map((r) => r.email),
    ["a@x.com", "b@x.com", "c@x.com"], // 60 > 20 > 20; empate b/c por email
  );
});

test("isReativacao: send_eligible=1 AND sends_count>0 AND opens_count=0; exclui internos (#2809)", () => {
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 1, sends_count: 3, opens_count: 0 }),
    true,
  );
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 0, sends_count: 3, opens_count: 0 }),
    false,
    "send_eligible=0 → fora",
  );
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 1, sends_count: 0, opens_count: 0 }),
    false,
    "sends_count=0 (nunca enviado) → fora",
  );
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 1, sends_count: 3, opens_count: 1 }),
    false,
    "opens_count>0 (abriu ao menos 1×) → fora, isso não é reativação",
  );
  assert.equal(
    isReativacao({ email: "pixel@memelab.com.br", send_eligible: 1, sends_count: 3, opens_count: 0 }),
    false,
    "interno (#2809) → fora",
  );
});

test("segmentReativacao: ordem last_sent_at DESC (não-abridor mais recente primeiro); email ASC desempata; ausente vai pro fim", () => {
  const rows: StoreRow[] = [
    row({ email: "old@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2026-01-01T00:00:00Z" }),
    row({ email: "new@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z" }),
    row({ email: "mid@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2026-03-01T00:00:00Z" }),
    row({ email: "sem-data@x.com", sends_count: 2, opens_count: 0, last_sent_at: null }),
    row({ email: "b-tie@x.com", sends_count: 1, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z" }), // empata com new@
    row({ email: "abridor@x.com", sends_count: 2, opens_count: 1, last_sent_at: "2026-12-01T00:00:00Z" }), // opens>0, fora
  ];
  assert.deepEqual(
    segmentReativacao(rows).map((r) => r.email),
    ["b-tie@x.com", "new@x.com", "mid@x.com", "old@x.com", "sem-data@x.com"],
  );
});

test("isRampWarm: reusa isFirstSend (elegível + nunca enviado) restrito a mv_bucket='verified'; NÃO exclui internos", () => {
  assert.equal(
    isRampWarm({ send_eligible: 1, sends_count: 0, mv_bucket: "verified" }),
    true,
  );
  assert.equal(
    isRampWarm({ send_eligible: 1, sends_count: 0, mv_bucket: "unknown" }),
    false,
    "mv_bucket != verified → fora",
  );
  assert.equal(
    isRampWarm({ send_eligible: 1, sends_count: 3, mv_bucket: "verified" }),
    false,
    "sends_count>0 (já enviado) → fora, isso é engajados/reativacao",
  );
  assert.equal(
    isRampWarm({ send_eligible: 0, sends_count: 0, mv_bucket: "verified" }),
    false,
    "send_eligible=0 → fora",
  );
});

test("segmentRampWarm: ordem cohortSendRank (morno→frio); NÃO exclui internos", () => {
  const rows: StoreRow[] = [
    row({ email: "lead@x.com", sends_count: 0, tier: 5, mv_bucket: "verified" }),
    row({ email: "ativo@x.com", sends_count: 0, tier: 1, mv_bucket: "verified" }),
    row({ email: "unverified@x.com", sends_count: 0, tier: 1, mv_bucket: "unknown" }), // fora
    row({ email: "vjpixel@gmail.com", sends_count: 0, tier: 1, mv_bucket: "verified" }), // interno, mas ramp-warm não exclui
  ];
  assert.deepEqual(
    segmentRampWarm(rows).map((r) => r.email),
    ["ativo@x.com", "vjpixel@gmail.com", "lead@x.com"], // ativo/vjpixel empatam por cohort (T01) → email ASC
  );
});

test("NAMED_GROUPS / isNamedGroupKey: os 3 grupos da #2885 estão registrados", () => {
  assert.deepEqual(Object.keys(NAMED_GROUPS).sort(), ["engajados", "ramp-warm", "reativacao"]);
  assert.equal(isNamedGroupKey("engajados"), true);
  assert.equal(isNamedGroupKey("reativacao"), true);
  assert.equal(isNamedGroupKey("ramp-warm"), true);
  assert.equal(isNamedGroupKey("inventado"), false);
});

test("#2885 grupos nomeados: --budget-like corte pega o TOPO pós-ordenação (não uma fatia arbitrária)", () => {
  const rows: StoreRow[] = [
    row({ email: "c@x.com", sends_count: 3, priority_points: 20 }),
    row({ email: "a@x.com", sends_count: 5, priority_points: 60 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 40 }),
  ];
  const ordered = segmentEngajados(rows).map((r) => r.email);
  assert.deepEqual(ordered, ["a@x.com", "b@x.com", "c@x.com"]);
  // simula o corte de --budget=2 do CLI: sempre os 2 primeiros da ordem certa.
  assert.deepEqual(ordered.slice(0, 2), ["a@x.com", "b@x.com"]);
});
