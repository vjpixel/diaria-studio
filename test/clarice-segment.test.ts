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
  isNovos,
  segmentNovos,
  isNamedGroupKey,
  NAMED_GROUPS,
  parseBrevoListIds,
  excludeCommittedToQueuedCampaigns,
  assertRecencySelectionMonotonic,
  isDailyQueueEligible,
  compareDailyQueueOrder,
  buildDailySendQueue,
  type StoreRow,
} from "../scripts/lib/clarice-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { cohortFromTier, INTERNAL_EMAILS, COHORT_ASSINANTES_ATIVOS } from "../scripts/lib/cohorts.ts";

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
    // #4688: default "já sincronizado pela Brevo" — testes que exercitam
    // especificamente `hasMeasuredOpens`/o gap de "nunca sincronizado"
    // sobrescrevem com `brevo_modified_at: null` explicitamente.
    brevo_modified_at: "2026-06-01T00:00:00Z",
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

test("loadStoreRows + segmentFromStore: mv_result=unknown fica FORA de toda wave pra cohort NÃO isento (#2735)", () => {
  const db = openClariceDb(":memory:");
  // mv_result="unknown" (linha de um mv-export-*-unknown.csv ingerida no store)
  // tier 3 (lead, cohort NÃO isento de MV) — #3819 isenta só assinantes-ativos.
  db.prepare(
    "INSERT INTO clarice_users (email, tier, mv_result, mv_bucket) VALUES (?, 3, 'unknown', 'unknown')",
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
// #5041 — SUNSET de não-abridor reincidente, caminho COMPLETO: INSERT no
// SQLite real → recomputeDerived (classifyEligibility + shouldSunsetNonOpener,
// clarice-db.ts) → loadStoreRows → segmentFromStore/priorityQueue. O predicado
// puro (shouldSunsetNonOpener) e o wiring isolado (classifyEligibility) já
// têm cobertura própria — este teste é o "de ponta a ponta" pedido pela issue:
// prova que um não-abridor reincidente sai da FILA DE ELEGÍVEIS de fato, não
// só que uma coluna do store mudou de valor.
// ---------------------------------------------------------------------------

test("#5041 end-to-end: não-abridor reincidente (≥2 envios, 0 aberturas, já sincronizado) sai da fila de elegíveis na próxima rodada", () => {
  const db = openClariceDb(":memory:");
  // não-abridor reincidente: 3 envios, 0 aberturas, JÁ sincronizado pela
  // Brevo (brevo_modified_at não-null) — satisfaz o guard hasMeasuredOpens.
  db.prepare(
    `INSERT INTO clarice_users (email, tier, sends_count, opens_count, mv_bucket, brevo_modified_at)
     VALUES (?, 4, 3, 0, 'verified', '2026-08-01T09:00:00Z')`,
  ).run("nunca.abre@x.com");
  // controle A: mesmo perfil, mas AINDA NÃO sincronizado (brevo_modified_at
  // NULL) — não pode ser rotulado "confirmado não-abridor" por acidente de
  // dado (#4688). Continua elegível (re-envio).
  db.prepare(
    `INSERT INTO clarice_users (email, tier, sends_count, opens_count, mv_bucket)
     VALUES (?, 4, 3, 0, 'verified')`,
  ).run("ainda.nao.sincronizado@x.com");
  // controle B: mesmo perfil de sends/opens, mas é assinante-ativo (tier 1) —
  // isento (mesma isenção de #3819). Continua elegível.
  db.prepare(
    `INSERT INTO clarice_users (email, tier, sends_count, opens_count, mv_bucket, brevo_modified_at)
     VALUES (?, 1, 3, 0, 'verified', '2026-08-01T09:00:00Z')`,
  ).run("pagante.nao.abre@x.com");
  // controle C: engajado de verdade (abriu) — nunca deveria sunsetar.
  db.prepare(
    `INSERT INTO clarice_users (email, tier, sends_count, opens_count, mv_bucket, brevo_modified_at)
     VALUES (?, 4, 3, 2, 'verified', '2026-08-01T09:00:00Z')`,
  ).run("engajado@x.com");

  recomputeDerived(db);

  const rows = loadStoreRows(db);
  const sunsetado = rows.find((r) => r.email === "nunca.abre@x.com")!;
  assert.equal(sunsetado.send_eligible, 0);
  assert.equal(sunsetado.ineligible_reason, "sunset_non_opener");

  const s = segmentFromStore(rows);
  // saiu de fato da fila — não aparece nem em reSend nem em firstSend.
  assert.ok(!s.reSend.some((r) => r.email === "nunca.abre@x.com"));
  assert.ok(!s.firstSend.some((r) => r.email === "nunca.abre@x.com"));
  assert.ok(
    s.excluded.some((e) => e.email === "nunca.abre@x.com" && e.reason === "sunset_non_opener"),
  );

  // a mesma checagem, na fila de prioridade que a wave real fatia de fato.
  const queue = priorityQueue(s);
  assert.ok(!queue.some((r) => r.email === "nunca.abre@x.com"), "não-abridor sunsetado nunca aparece na fila de envio");

  // os 3 controles continuam elegíveis e presentes na fila (re-envio).
  for (const email of ["ainda.nao.sincronizado@x.com", "pagante.nao.abre@x.com", "engajado@x.com"]) {
    const row = rows.find((r) => r.email === email)!;
    assert.equal(row.send_eligible, 1, `${email} deveria continuar elegível`);
    assert.ok(queue.some((r) => r.email === email), `${email} deveria continuar na fila`);
  }

  db.close();
});

test("loadStoreRows + segmentFromStore #3819: mv_bucket=unknown NÃO exclui assinante-ativo (tier 1 → cohort isento de MV)", () => {
  const db = openClariceDb(":memory:");
  // tier 1 (assinante ativo) com mv_bucket='unknown' herdado de vida anterior
  // como lead → ELEGÍVEL desde #3819 (pagante nunca é cortado por MV) e entra
  // em firstSend normalmente (nunca enviado, sends_count=0).
  db.prepare(
    "INSERT INTO clarice_users (email, tier, mv_result, mv_bucket) VALUES (?, 1, 'unknown', 'unknown')",
  ).run("assinante-mv-unknown@x.com");
  recomputeDerived(db);

  const rows = loadStoreRows(db);
  const assinante = rows.find((r) => r.email === "assinante-mv-unknown@x.com")!;
  assert.equal(assinante.send_eligible, 1);
  assert.equal(assinante.ineligible_reason, null);

  const s = segmentFromStore(rows);
  assert.deepEqual(s.firstSend.map((r) => r.email), ["assinante-mv-unknown@x.com"]);
  assert.deepEqual(s.excluded, []);

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

test("#2857 fase B equivalência (a), REVISADA pelo #5169 (260812): leads (T04-T09) mantêm ordem byte-idêntica ao oráculo de tier; T01/T02 (estrutural) NÃO MAIS — recência real agora compete direto com lead", () => {
  const db = openClariceDb(":memory:");
  const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);

  // Histórico (#2857 fase B, pré-#5169): esta fixture provava que a ordem
  // por cohort era byte-idêntica à ordem antiga por tier — INCLUSIVE T01/T02
  // (pagante), porque `created` era IRRELEVANTE pra eles (cohortSendRank
  // sempre dava rank fixo 0/1, na frente de qualquer lead). O #5169 (revisão
  // 260812, pedido do editor: "independente do cohort") tornou essa premissa
  // FALSA de propósito — `compareContactRecency` agora usa `created` real
  // pra TODO mundo, cohort estrutural incluso. T01/T02 usam
  // created="2020-01-01", mais ANTIGO que qualquer lead da fixture (todos em
  // 2023-2025) — sob a regra nova, eles saem do INÍCIO da fila e vão pro
  // MEIO, atrás de todos os leads com created mais recente. A claim de
  // equivalência abaixo foi restrita a T04-T09 (só leads, onde continua
  // valendo — ver docstring de `compareContactRecency`, cohorts.ts).
  //   T01/T02 (pagante): created ANTIGO de propósito (2020) — prova que NÃO
  //     mais "vence sempre", ao contrário da versão histórica desta fixture.
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

  // Só T04-T09 (leads, created consistente com o semestre do tier) mantêm
  // ordem byte-idêntica ao oráculo antigo — cortando os dois pra essa faixa.
  const leadsOnlyCohort = cohortOrder.filter((e) => /^t0[4-9]/.test(e));
  const leadsOnlyOracle = tierOracleOrder.filter((e) => /^t0[4-9]/.test(e));
  assert.deepEqual(
    leadsOnlyCohort,
    leadsOnlyOracle,
    "entre LEADS (T04-T09), created consistente com o tier → ordem byte-idêntica ao oráculo antigo",
  );

  // #5169: T01/T02 NÃO ficam mais no início — created=2020 é mais antigo que
  // qualquer lead da fixture (2023-2025), então saem pro meio da fila,
  // atrás de TODOS os leads com created válido e mais recente.
  assert.deepEqual(
    cohortOrder,
    [
      "t04a@x.com", "t04b@x.com", "t05a@x.com", "t05b@x.com",
      "t06a@x.com", "t06b@x.com", "t07a@x.com", "t07b@x.com",
      "t08a@x.com", "t08b@x.com", "t09a@x.com", "t09b@x.com",
      // estruturais: created (2020) mais antigo que os leads acima, mas
      // ainda "conhecido" — bate quem não tem created nenhum (T03/T10/null).
      "t01a@x.com", "t01b@x.com", "t02a@x.com", "t02b@x.com",
      // sem created (fallback pro rank de bucket): T03 (leads-2026-jan-abr)
      // antes de T10 (leads-caudao, rank mais frio) antes de null (desconhecido).
      "t03a@x.com", "t03b@x.com", "t10a@x.com", "t10b@x.com",
      "nulla@x.com", "nullb@x.com",
    ],
    "T01/T02 competem por created real igual qualquer lead — não são mais rank fixo 0/1",
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

test("isEngajados: send_eligible=1 AND sends_count>0 AND priority_points>0; NÃO exclui internos (#4434, reverte #2809)", () => {
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
  // #4434: decisão do editor (260801, opção (a)) — interno com histórico de
  // envio e priority_points>0 volta a ENTRAR em engajados. Comportamento
  // anterior (#2809) excluía e deixava `felipe@clarice.ai` (top 0,04% da base)
  // inalcançável por qualquer grupo nomeado. `isInternalEmail` segue existindo
  // pras agregações de exibição (`clarice-db-summary.ts`), não pra elegibilidade.
  assert.equal(
    isEngajados({ email: "VJPIXEL@GMAIL.COM", send_eligible: 1, sends_count: 3, priority_points: 20 }),
    true,
    "interno (#4434) → ENTRA normalmente, satisfazendo as outras 3 condições",
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
  ];
  assert.deepEqual(
    segmentEngajados(rows).map((r) => r.email),
    ["a@x.com", "b@x.com", "c@x.com"], // 60 > 20 > 20; empate b/c por email
  );
});

test("#4434: segmentEngajados inclui interno com priority_points alto — entra no TOPO da fila por ordenação normal", () => {
  const rows: StoreRow[] = [
    row({ email: "a@x.com", sends_count: 5, priority_points: 20 }),
    row({ email: "vjpixel@gmail.com", sends_count: 4, priority_points: 999 }), // interno, ex-excluído (#2809)
  ];
  assert.deepEqual(
    segmentEngajados(rows).map((r) => r.email),
    ["vjpixel@gmail.com", "a@x.com"], // 999 > 20 — interno não é mais descartado nem reordenado à parte
  );
});

test("isReativacao: send_eligible=1 AND sends_count>0 AND opens_count=0; NÃO exclui internos (#4434, reverte #2809)", () => {
  const measured = "2026-06-01T00:00:00Z"; // #4688: hasMeasuredOpens exige brevo_modified_at != null
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 1, sends_count: 3, opens_count: 0, brevo_modified_at: measured }),
    true,
  );
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 0, sends_count: 3, opens_count: 0, brevo_modified_at: measured }),
    false,
    "send_eligible=0 → fora",
  );
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 1, sends_count: 0, opens_count: 0, brevo_modified_at: measured }),
    false,
    "sends_count=0 (nunca enviado) → fora",
  );
  assert.equal(
    isReativacao({ email: "a@x.com", send_eligible: 1, sends_count: 3, opens_count: 1, brevo_modified_at: measured }),
    false,
    "opens_count>0 (abriu ao menos 1×) → fora, isso não é reativação",
  );
  assert.equal(
    isReativacao({ email: "pixel@memelab.com.br", send_eligible: 1, sends_count: 3, opens_count: 0, brevo_modified_at: measured }),
    true,
    "interno (#4434) → ENTRA normalmente",
  );
});

test("#4688: isReativacao exige hasMeasuredOpens — contato NUNCA sincronizado pela Brevo (brevo_modified_at null) fica FORA mesmo com opens_count=0/sends_count>0", () => {
  assert.equal(
    isReativacao({
      email: "nunca-sincronizado@x.com",
      send_eligible: 1,
      sends_count: 3,
      opens_count: 0,
      brevo_modified_at: null,
    }),
    false,
    "opens_count=0 aqui é só o DEFAULT 0 do schema, nunca medido de fato — não é prova de 'nunca abriu'",
  );
  assert.equal(
    isReativacao({
      email: "sem-campo@x.com",
      send_eligible: 1,
      sends_count: 3,
      opens_count: 0,
      // brevo_modified_at omitido (undefined) — mesmo tratamento de null
    }),
    false,
    "brevo_modified_at ausente (undefined) degrada igual a null — fail-safe",
  );
});

test("segmentReativacao: ordem last_sent_at DESC (não-abridor mais recente primeiro); email ASC desempata; ausente vai pro fim", () => {
  const measured = "2026-06-01T00:00:00Z";
  const rows: StoreRow[] = [
    row({ email: "old@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2026-01-01T00:00:00Z", brevo_modified_at: measured }),
    row({ email: "new@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z", brevo_modified_at: measured }),
    row({ email: "mid@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2026-03-01T00:00:00Z", brevo_modified_at: measured }),
    row({ email: "sem-data@x.com", sends_count: 2, opens_count: 0, last_sent_at: null, brevo_modified_at: measured }),
    row({ email: "b-tie@x.com", sends_count: 1, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z", brevo_modified_at: measured }), // empata com new@
    row({ email: "abridor@x.com", sends_count: 2, opens_count: 1, last_sent_at: "2026-12-01T00:00:00Z", brevo_modified_at: measured }), // opens>0, fora
    row({ email: "nunca-sincronizado@x.com", sends_count: 2, opens_count: 0, last_sent_at: "2027-01-01T00:00:00Z", brevo_modified_at: null }), // #4688: sem medição, fora
  ];
  assert.deepEqual(
    segmentReativacao(rows).map((r) => r.email),
    ["b-tie@x.com", "new@x.com", "mid@x.com", "old@x.com", "sem-data@x.com"],
  );
});

test("isRampWarm: reusa isFirstSend (elegível + nunca enviado) restrito a mv_bucket='verified'; NÃO exclui internos", () => {
  assert.equal(
    isRampWarm({ email: "a@x.com", send_eligible: 1, sends_count: 0, mv_bucket: "verified" }),
    true,
  );
  assert.equal(
    isRampWarm({ email: "a@x.com", send_eligible: 1, sends_count: 0, mv_bucket: "unknown" }),
    false,
    "mv_bucket != verified e cohort NÃO isento → fora",
  );
  assert.equal(
    isRampWarm({ email: "a@x.com", send_eligible: 1, sends_count: 3, mv_bucket: "verified" }),
    false,
    "sends_count>0 (já enviado) → fora, isso é engajados/reativacao",
  );
  assert.equal(
    isRampWarm({ email: "a@x.com", send_eligible: 0, sends_count: 0, mv_bucket: "verified" }),
    false,
    "send_eligible=0 → fora",
  );
  assert.equal(
    isRampWarm({ email: "vjpixel@gmail.com", send_eligible: 1, sends_count: 0, mv_bucket: "verified" }),
    true,
    "interno (#2809) → dentro, ramp-warm não exclui internos",
  );
});

// ---------------------------------------------------------------------------
// #3826 — pagante novo (assinantes-ativos), sem mv_bucket, dispensa
// mv_bucket='verified' via isMvExemptCohort (mesmo predicado de #3819).
// ---------------------------------------------------------------------------

test("#3826: isRampWarm dispensa mv_bucket='verified' pra cohort MV-isento (assinantes-ativos) — reusa isMvExemptCohort", () => {
  assert.equal(
    isRampWarm({
      email: "pagante-novo@x.com",
      send_eligible: 1,
      sends_count: 0,
      mv_bucket: null,
      cohort: "assinantes-ativos",
    }),
    true,
    "cenário real da issue: assinantes-ativos + send_eligible=1 + sends_count=0 + mv_bucket=null → dentro do ramp-warm",
  );
  assert.equal(
    isRampWarm({
      email: "pagante-novo2@x.com",
      send_eligible: 1,
      sends_count: 0,
      mv_bucket: "unknown",
      cohort: "assinantes-ativos",
    }),
    true,
    "assinantes-ativos com mv_bucket presente mas != verified também dispensa (isento, não só ausente)",
  );
});

test("#3826: sem regressão — cohort NÃO isento continua exigindo mv_bucket='verified' (comportamento original preservado)", () => {
  assert.equal(
    isRampWarm({
      email: "lead-nao-verificado@x.com",
      send_eligible: 1,
      sends_count: 0,
      mv_bucket: null,
      cohort: "leads-2026-06",
    }),
    false,
    "cohort não-isento + sends_count=0 + sem mv_bucket='verified' → continua FORA de ramp-warm",
  );
  assert.equal(
    isRampWarm({
      email: "sem-cohort@x.com",
      send_eligible: 1,
      sends_count: 0,
      mv_bucket: undefined,
      cohort: null,
    }),
    false,
    "cohort ausente/desconhecido não é tratado como isento (isMvExemptCohort(null) === false)",
  );
});

test("#3826: pagante com histórico de envio (sends_count>0) continua fora de ramp-warm — sem duplicar com engajados/reativacao", () => {
  const veterano = {
    email: "assinante-veterano@x.com",
    send_eligible: 1,
    sends_count: 3,
    priority_points: 10,
    opens_count: 2,
    mv_bucket: null,
    cohort: "assinantes-ativos",
  };
  assert.equal(
    isRampWarm(veterano),
    false,
    "sends_count>0 já reprova isFirstSend, independente da isenção de MV — ramp-warm é só pra 1º envio",
  );
  assert.equal(
    isEngajados(veterano),
    true,
    "continua elegível pra engajados normalmente (priority_points>0), sem conflito com ramp-warm",
  );
});

// ---------------------------------------------------------------------------
// Regressão #2920 — named-groups (#2885) devem respeitar isTestAccount (#2895/#2911),
// mesmo guard de defesa em profundidade que segmentFromStore já aplica.
// ---------------------------------------------------------------------------

test("#2920: isEngajados/isReativacao/isRampWarm excluem contas de teste do editor (vjpixel+test*@gmail.com), mesmo satisfazendo as demais condições", () => {
  const testEmail = "vjpixel+test2@gmail.com";
  assert.equal(
    isEngajados({ email: testEmail, send_eligible: 1, sends_count: 3, priority_points: 999 }),
    false,
    "test account não deve vazar pra engajados mesmo com priority_points alto",
  );
  assert.equal(
    isReativacao({ email: testEmail, send_eligible: 1, sends_count: 3, opens_count: 0 }),
    false,
    "test account não deve vazar pra reativacao",
  );
  assert.equal(
    isRampWarm({ email: testEmail, send_eligible: 1, sends_count: 0, mv_bucket: "verified" }),
    false,
    "test account não deve vazar pra ramp-warm, mesmo este grupo não excluindo internos",
  );
});

test("#2920: segmentEngajados/segmentReativacao/segmentRampWarm filtram contas de teste do editor no fluxo real (linha completa do store)", () => {
  const testEngajadoRow = row({
    email: "vjpixel+test3@gmail.com",
    sends_count: 5,
    priority_points: 999,
    opens_count: 0,
    last_sent_at: "2026-06-01T00:00:00Z",
  });
  const testRampWarmRow = row({
    email: "vjpixel+test4@gmail.com",
    sends_count: 0,
    tier: 1,
    mv_bucket: "verified",
  });
  const realRow = row({ email: "leitor@x.com", sends_count: 3, priority_points: 50 });

  assert.deepEqual(
    segmentEngajados([testEngajadoRow, realRow]).map((r) => r.email),
    ["leitor@x.com"],
    "engajados: só o contato real, test account fora mesmo com priority_points=999",
  );
  assert.deepEqual(
    segmentReativacao([testEngajadoRow]).map((r) => r.email),
    [],
    "reativacao: test account nunca aparece (sends_count>0, opens_count=0 satisfariam o predicado)",
  );
  assert.deepEqual(
    segmentRampWarm([testRampWarmRow]).map((r) => r.email),
    [],
    "ramp-warm: test account nunca aparece, mesmo elegível+verified+nunca-enviado",
  );
});

test("segmentRampWarm: ordem cohortSendRank (morno→frio); NÃO exclui internos", () => {
  const rows: StoreRow[] = [
    row({ email: "lead@x.com", sends_count: 0, tier: 5, mv_bucket: "verified" }),
    row({ email: "ativo@x.com", sends_count: 0, tier: 1, mv_bucket: "verified" }),
    // #3826: tier 1 → cohort assinantes-ativos → MV-isento (isMvExemptCohort)
    // → mv_bucket='unknown' já NÃO barra mais (antes ficava "fora", ver
    // histórico do teste no git blame — era exatamente o ponto cego da issue).
    row({ email: "unverified@x.com", sends_count: 0, tier: 1, mv_bucket: "unknown" }),
    row({ email: "vjpixel@gmail.com", sends_count: 0, tier: 1, mv_bucket: "verified" }), // interno, mas ramp-warm não exclui
    // lead SEM mv_bucket verified e cohort NÃO isento continua fora (sem regressão).
    row({ email: "lead-unverified@x.com", sends_count: 0, tier: 5, mv_bucket: "unknown" }),
  ];
  assert.deepEqual(
    segmentRampWarm(rows).map((r) => r.email),
    // ativo/unverified/vjpixel empatam por cohort (T01, rank 0) → email ASC.
    // lead (T05, rank>0) por último; lead-unverified fica de fora (cohort não isento, mv_bucket≠verified).
    ["ativo@x.com", "unverified@x.com", "vjpixel@gmail.com", "lead@x.com"],
  );
});

// ---------------------------------------------------------------------------
// #5410 — isRampWarm/segmentRampWarm excluem a janela `novos` por construção
// (cutoffNovosIso), particionando com isNovos em vez de conter.
// ---------------------------------------------------------------------------

test("#5410: isRampWarm exclui contato DENTRO da janela novos (created >= cutoff)", () => {
  const dentro = row({ email: "novo@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-08-15T10:00:00Z" });
  // Sem cutoff (2º arg omitido) — comportamento pré-#5410, inclui.
  assert.equal(isRampWarm(dentro), true);
  // Com cutoff — dentro da janela `novos`, EXCLUÍDO da rampa.
  assert.equal(isRampWarm(dentro, "2026-08-14"), false);
});

test("#5410: isRampWarm NÃO exclui contato FORA da janela novos (created < cutoff) — sem buraco pelo outro lado", () => {
  const fora = row({ email: "antigo@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-07-01T10:00:00Z" });
  assert.equal(isRampWarm(fora, "2026-08-14"), true);
});

test("#5410: isRampWarm sem `created` (dado ausente) não é excluído por cutoff — fail-safe pré-existente preservado", () => {
  const semCreated = row({ email: "sem-created@x.com", sends_count: 0, mv_bucket: "verified" });
  assert.equal(isRampWarm(semCreated, "2026-08-14"), true);
});

test("#5410: segmentRampWarm com cutoffNovosIso — onda de rampa NUNCA inclui contato pendente na janela novos; contato fora da janela continua normal", () => {
  const rows: StoreRow[] = [
    row({ email: "pendente-novos@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-08-16T09:00:00Z" }),
    row({ email: "fila-fria@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-01-01T09:00:00Z" }),
  ];
  const seg = segmentRampWarm(rows, { cutoffNovosIso: "2026-08-14" });
  assert.deepEqual(
    seg.map((r) => r.email),
    ["fila-fria@x.com"],
  );
});

test("#5410: isRampWarm e isNovos particionam (nunca ambos true pro mesmo contato) — mesmo cutoff nos dois lados", () => {
  const cutoff = "2026-08-14";
  const dentro = row({ email: "dentro@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-08-15T00:00:00Z" });
  const fora = row({ email: "fora@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-08-01T00:00:00Z" });
  assert.equal(isNovos(dentro, cutoff), true);
  assert.equal(isRampWarm(dentro, cutoff), false);
  assert.equal(isNovos(fora, cutoff), false);
  assert.equal(isRampWarm(fora, cutoff), true);
});

test("NAMED_GROUPS / isNamedGroupKey: os 3 grupos da #2885 + 'novos' (#4347) estão registrados", () => {
  assert.deepEqual(Object.keys(NAMED_GROUPS).sort(), ["engajados", "novos", "ramp-warm", "reativacao"]);
  assert.equal(isNamedGroupKey("engajados"), true);
  assert.equal(isNamedGroupKey("reativacao"), true);
  assert.equal(isNamedGroupKey("ramp-warm"), true);
  assert.equal(isNamedGroupKey("novos"), true);
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

// ---------------------------------------------------------------------------
// #2994 (P0): excludeCommittedToQueuedCampaigns — evita envio duplicado a
// contatos já comprometidos com uma campanha AGENDADA (queued) mas ainda não
// enviada. sends_count=0 sozinho não distingue "nunca agendado" de
// "agendado, ainda não disparado" — ver comentário no fonte.
// ---------------------------------------------------------------------------

test("parseBrevoListIds: parseia JSON array válido, tolera ausente/vazio/inválido/não-array", () => {
  assert.deepEqual(parseBrevoListIds('["68","70"]'), ["68", "70"]);
  assert.deepEqual(parseBrevoListIds(null), []);
  assert.deepEqual(parseBrevoListIds(undefined), []);
  assert.deepEqual(parseBrevoListIds(""), []);
  assert.deepEqual(parseBrevoListIds("not json"), []);
  assert.deepEqual(parseBrevoListIds('{"not":"array"}'), []);
  assert.deepEqual(parseBrevoListIds("[68, 70]"), ["68", "70"]); // números viram string
});

test("excludeCommittedToQueuedCampaigns: contato em lista com campanha queued é EXCLUÍDO mesmo com sends_count=0 (#2994 cenário real)", () => {
  // Réplica do incidente 260706: campanha 87 agendada pra lista 68, contatos
  // ainda com sends_count=0 (não dispararam) — precisam sumir da PRÓXIMA
  // seleção antes da campanha 87 sair, senão duplica.
  const rows = [
    row({ email: "committed@x.com", sends_count: 0, brevo_list_ids: '["68"]' }),
    row({ email: "fresh@x.com", sends_count: 0, brevo_list_ids: '["99"]' }),
  ];
  const queuedListIds = new Set(["68"]);
  const result = excludeCommittedToQueuedCampaigns(rows, queuedListIds);
  assert.deepEqual(
    result.map((r) => r.email),
    ["fresh@x.com"],
  );
});

test("excludeCommittedToQueuedCampaigns: a função só enxerga o Set que recebe — lista de campanha SENT fora do Set passa batido (função pura, não busca sozinha)", () => {
  // #3682 CORRIGIU a suposição original deste teste ("já coberto por
  // sends_count" — falsa, ver incidente 260716-260721: sync incremental do
  // store tem lag e sends_count=0 não distingue "nunca recebeu" de "recebeu,
  // mas o store ainda não propagou"). A função em si continua PURA e cega ao
  // status da campanha — só filtra pelo Set que o CALLER decide passar. Em
  // produção (weekly-send-plan-audience.ts/clarice-schedule-ramp.ts/
  // cohort-order-dryrun.ts) esse Set agora vem de
  // `fetchCommittedCampaignListIds` (queued+sent, #3682), não mais só
  // `fetchQueuedCampaignListIds` — ver test/brevo-committed-campaigns-3682.test.ts
  // pro cenário completo (fetch real → união → exclusão).
  const rows = [
    row({ email: "already-sent@x.com", sends_count: 1, brevo_list_ids: '["50"]' }),
  ];
  const queuedListIds = new Set(["68"]); // lista 50 (da campanha sent) não está aqui NESTE Set
  const result = excludeCommittedToQueuedCampaigns(rows, queuedListIds);
  assert.deepEqual(result.map((r) => r.email), ["already-sent@x.com"]);
});

test("excludeCommittedToQueuedCampaigns: contato sem envio pendente permanece elegível normalmente", () => {
  const rows = [
    row({ email: "no-pending@x.com", sends_count: 0, brevo_list_ids: '["10","20"]' }),
  ];
  const result = excludeCommittedToQueuedCampaigns(rows, new Set(["68", "70"]));
  assert.deepEqual(result.map((r) => r.email), ["no-pending@x.com"]);
});

test("excludeCommittedToQueuedCampaigns: queuedListIds vazio é no-op (retorna cópia, não muta)", () => {
  const rows = [row({ email: "a@x.com", brevo_list_ids: '["1"]' })];
  const result = excludeCommittedToQueuedCampaigns(rows, new Set());
  assert.deepEqual(result, rows);
  assert.notEqual(result, rows); // cópia, não a mesma referência
});

test("excludeCommittedToQueuedCampaigns: brevo_list_ids ausente/corrompido nunca exclui por engano (fail-safe)", () => {
  const rows = [
    row({ email: "no-lists@x.com" }), // brevo_list_ids ausente
    row({ email: "bad-json@x.com", brevo_list_ids: "not json" }),
  ];
  const result = excludeCommittedToQueuedCampaigns(rows, new Set(["68"]));
  assert.deepEqual(
    result.map((r) => r.email).sort(),
    ["bad-json@x.com", "no-lists@x.com"],
  );
});

test("excludeCommittedToQueuedCampaigns: aplica sobre segmentRampWarm real (integração com o gate de produção)", () => {
  const rows: StoreRow[] = [
    row({ email: "warm-committed@x.com", sends_count: 0, mv_bucket: "verified", brevo_list_ids: '["68"]' }),
    row({ email: "warm-fresh@x.com", sends_count: 0, mv_bucket: "verified", brevo_list_ids: '["99"]' }),
    row({ email: "not-verified@x.com", sends_count: 0, mv_bucket: "unknown", brevo_list_ids: '["99"]' }),
  ];
  const rampWarm = segmentRampWarm(rows);
  assert.deepEqual(rampWarm.map((r) => r.email).sort(), ["warm-committed@x.com", "warm-fresh@x.com"]);
  const filtered = excludeCommittedToQueuedCampaigns(rampWarm, new Set(["68"]));
  assert.deepEqual(filtered.map((r) => r.email), ["warm-fresh@x.com"]);
});

// ---------------------------------------------------------------------------
// isNovos / segmentNovos (#4347) — grupo `novos`, laço Stripe→MV→envio imediato
// ---------------------------------------------------------------------------

const SINCE = "2026-07-01";

test("isNovos: pagante novo (cohort MV-isento) sem mv_bucket ENTRA", () => {
  const r = row({
    email: "payer@x.com",
    sends_count: 0,
    cohort: COHORT_ASSINANTES_ATIVOS,
    created: "2026-07-15T00:00:00Z",
    mv_bucket: null,
  });
  assert.equal(isNovos(r, SINCE), true);
});

test("isNovos: mv_bucket='rejected' FICA FORA (não é isento nem verified)", () => {
  const r = row({
    email: "lead-rejected@x.com",
    sends_count: 0,
    cohort: "leads-2026-07",
    created: "2026-07-15T00:00:00Z",
    mv_bucket: "rejected",
  });
  assert.equal(isNovos(r, SINCE), false);
});

test("isNovos: mv_bucket='unknown' FICA FORA (D9 — sem flag de opt-in)", () => {
  const r = row({
    email: "lead-unknown@x.com",
    sends_count: 0,
    cohort: "leads-2026-07",
    created: "2026-07-15T00:00:00Z",
    mv_bucket: "unknown",
  });
  assert.equal(isNovos(r, SINCE), false);
});

test("isNovos: lead novo (não isento) SEM verificação MV fica fora", () => {
  const r = row({
    email: "lead-nomv@x.com",
    sends_count: 0,
    cohort: "leads-2026-07",
    created: "2026-07-15T00:00:00Z",
    mv_bucket: null,
  });
  assert.equal(isNovos(r, SINCE), false);
});

test("isNovos: lead novo verificado (mv_bucket='verified') ENTRA", () => {
  const r = row({
    email: "lead-verified@x.com",
    sends_count: 0,
    cohort: "leads-2026-07",
    created: "2026-07-15T00:00:00Z",
    mv_bucket: "verified",
  });
  assert.equal(isNovos(r, SINCE), true);
});

test("isNovos: created < since FICA FORA", () => {
  const r = row({
    email: "old@x.com",
    sends_count: 0,
    cohort: COHORT_ASSINANTES_ATIVOS,
    created: "2026-06-15T00:00:00Z", // antes de SINCE
    mv_bucket: null,
  });
  assert.equal(isNovos(r, SINCE), false);
});

test("isNovos: created ausente/inválido FICA FORA (fail-safe)", () => {
  const semData = row({
    email: "sem-created@x.com",
    sends_count: 0,
    cohort: COHORT_ASSINANTES_ATIVOS,
    created: null,
    mv_bucket: null,
  });
  const dataInvalida = row({
    email: "created-invalido@x.com",
    sends_count: 0,
    cohort: COHORT_ASSINANTES_ATIVOS,
    created: "não-é-uma-data",
    mv_bucket: null,
  });
  assert.equal(isNovos(semData, SINCE), false);
  assert.equal(isNovos(dataInvalida, SINCE), false);
});

test("isNovos: sends_count > 0 FICA FORA (já recebeu — ciclo de vida sem reentrada)", () => {
  const r = row({
    email: "ja-recebeu@x.com",
    sends_count: 1,
    cohort: COHORT_ASSINANTES_ATIVOS,
    created: "2026-07-15T00:00:00Z",
    mv_bucket: null,
  });
  assert.equal(isNovos(r, SINCE), false);
});

test("isNovos: send_eligible=0 FICA FORA", () => {
  const r = row({
    email: "inelegivel@x.com",
    send_eligible: 0,
    ineligible_reason: "hard_bounce",
    sends_count: 0,
    cohort: COHORT_ASSINANTES_ATIVOS,
    created: "2026-07-15T00:00:00Z",
    mv_bucket: null,
  });
  assert.equal(isNovos(r, SINCE), false);
});

test("segmentNovos: ordem = recência pura, created DESC — cohort não entra (#5169, revisão 260812: assinante-ativo NÃO tem mais prioridade automática sobre lead mais recente)", () => {
  const rows: StoreRow[] = [
    row({
      email: "lead-antigo@x.com",
      sends_count: 0,
      cohort: "leads-2026-07",
      created: "2026-07-02T00:00:00Z",
      mv_bucket: "verified",
    }),
    row({
      email: "payer-recente@x.com",
      sends_count: 0,
      cohort: COHORT_ASSINANTES_ATIVOS,
      created: "2026-07-20T00:00:00Z",
      mv_bucket: null,
    }),
    row({
      email: "payer-antigo@x.com",
      sends_count: 0,
      cohort: COHORT_ASSINANTES_ATIVOS,
      created: "2026-07-05T00:00:00Z",
      mv_bucket: null,
    }),
    row({
      email: "lead-recente@x.com",
      sends_count: 0,
      cohort: "leads-2026-07",
      created: "2026-07-25T00:00:00Z",
      mv_bucket: "verified",
    }),
  ];
  const out = segmentNovos(rows, { sinceIso: SINCE });
  assert.deepEqual(out.map((r) => r.email), [
    "lead-recente@x.com",  // 25/07 — mais recente de todos, cohort não importa
    "payer-recente@x.com", // 20/07 — assinante-ativo, mas fica atrás do lead mais novo
    "payer-antigo@x.com",  // 05/07
    "lead-antigo@x.com",   // 02/07 — mais antigo de todos
  ]);
});

test("segmentNovos: filtra o universo inteiro (exclusão/inclusão combinadas)", () => {
  const rows: StoreRow[] = [
    row({ email: "in@x.com", sends_count: 0, cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-07-10T00:00:00Z", mv_bucket: null }),
    row({ email: "out-old@x.com", sends_count: 0, cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-06-01T00:00:00Z", mv_bucket: null }),
    row({ email: "out-unknown@x.com", sends_count: 0, cohort: "leads-2026-07", created: "2026-07-10T00:00:00Z", mv_bucket: "unknown" }),
    row({ email: "out-sent@x.com", sends_count: 3, cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-07-10T00:00:00Z", mv_bucket: null }),
  ];
  const out = segmentNovos(rows, { sinceIso: SINCE });
  assert.deepEqual(out.map((r) => r.email), ["in@x.com"]);
});

test("NAMED_GROUPS.novos: reconhecido por isNamedGroupKey, exige ctx.sinceIso (lança sem ele)", () => {
  assert.equal(isNamedGroupKey("novos"), true);
  const rows: StoreRow[] = [
    row({ email: "a@x.com", sends_count: 0, cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-07-10T00:00:00Z", mv_bucket: null }),
  ];
  assert.throws(() => NAMED_GROUPS.novos.segment(rows));
  assert.deepEqual(
    NAMED_GROUPS.novos.segment(rows, { sinceIso: SINCE }).map((r) => r.email),
    ["a@x.com"],
  );
});

// ---------------------------------------------------------------------------
// assertRecencySelectionMonotonic — guard de recência antes do upload (#5169)
// ---------------------------------------------------------------------------

test("assertRecencySelectionMonotonic — REGRESSÃO #5169 (caso concreto da issue): contato de leads-2022h1 selecionado enquanto contato de leads-2023h2 fica de fora, ainda elegível ⇒ violação", () => {
  const selected = [row({ email: "antigo@x.com", cohort: "leads-2022h1", created: "2022-01-15T00:00:00Z" })];
  const stillEligibleElsewhere = [
    row({ email: "novo@x.com", cohort: "leads-2023h2", created: "2023-08-01T00:00:00Z" }),
  ];
  const violations = assertRecencySelectionMonotonic(selected, stillEligibleElsewhere);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].selectedEmail, "antigo@x.com");
  assert.equal(violations[0].selectedCohort, "leads-2022h1");
  assert.equal(violations[0].excludedEmail, "novo@x.com");
  assert.equal(violations[0].excludedCohort, "leads-2023h2");
});

test("assertRecencySelectionMonotonic — seleção correta (prefixo de uma fila ordenada por compareContactRecency) nunca produz violação", () => {
  const universe = [
    row({ email: "novo@x.com", cohort: "leads-2023h2", created: "2023-08-01T00:00:00Z" }),
    row({ email: "meio@x.com", cohort: "leads-2022h2", created: "2022-09-01T00:00:00Z" }),
    row({ email: "antigo@x.com", cohort: "leads-2022h1", created: "2022-01-15T00:00:00Z" }),
  ];
  const ordered = segmentRampWarm(universe.map((r) => ({ ...r, mv_bucket: "verified" })));
  const selected = ordered.slice(0, 2);
  const stillEligibleElsewhere = ordered.slice(2);
  assert.deepEqual(assertRecencySelectionMonotonic(selected, stillEligibleElsewhere), []);
});

test("assertRecencySelectionMonotonic — vários contatos antigos selecionados contra o mesmo contato mais novo excluído ⇒ 1 violação por selecionado, todas apontando pro mesmo excluído mais quente", () => {
  const selected = [
    row({ email: "a1@x.com", cohort: "leads-2022h1", created: "2022-01-01T00:00:00Z" }),
    row({ email: "a2@x.com", cohort: "leads-2022h2", created: "2022-09-01T00:00:00Z" }),
  ];
  const stillEligibleElsewhere = [
    row({ email: "novo@x.com", cohort: "leads-2023h2", created: "2023-08-01T00:00:00Z" }),
    row({ email: "menos-novo@x.com", cohort: "leads-2023h1", created: "2023-02-01T00:00:00Z" }),
  ];
  const violations = assertRecencySelectionMonotonic(selected, stillEligibleElsewhere);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.excludedEmail === "novo@x.com"), "sempre pareia com o excluído MAIS quente, não qualquer um");
});

test("assertRecencySelectionMonotonic — #5169 revisão 260812: cohort estrutural (assinantes-ativos) ANTIGO selecionado enquanto lead mais NOVO fica de fora AGORA conta como violação (cohort não é mais exceção)", () => {
  const selected = [row({ email: "payer@x.com", cohort: COHORT_ASSINANTES_ATIVOS, created: "2020-01-01T00:00:00Z" })];
  const stillEligibleElsewhere = [row({ email: "lead@x.com", cohort: "leads-2026h1", created: "2026-07-01T00:00:00Z" })];
  const violations = assertRecencySelectionMonotonic(selected, stillEligibleElsewhere);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].selectedEmail, "payer@x.com");
  assert.equal(violations[0].excludedEmail, "lead@x.com");
});

test("assertRecencySelectionMonotonic — cohort estrutural RECENTE selecionado enquanto lead mais ANTIGO fica de fora NÃO é violação (recência real, não cohort, decide)", () => {
  const selected = [row({ email: "payer-novo@x.com", cohort: COHORT_ASSINANTES_ATIVOS, created: "2026-08-01T00:00:00Z" })];
  const stillEligibleElsewhere = [row({ email: "lead-antigo@x.com", cohort: "leads-2022h1", created: "2022-01-01T00:00:00Z" })];
  assert.deepEqual(assertRecencySelectionMonotonic(selected, stillEligibleElsewhere), []);
});

test("assertRecencySelectionMonotonic — listas vazias (de qualquer lado) devolvem [] sem lançar", () => {
  const someRow = [row({ email: "a@x.com", cohort: "leads-2023h1", created: "2023-01-01T00:00:00Z" })];
  assert.deepEqual(assertRecencySelectionMonotonic([], someRow), []);
  assert.deepEqual(assertRecencySelectionMonotonic(someRow, []), []);
  assert.deepEqual(assertRecencySelectionMonotonic([], []), []);
});

// ---------------------------------------------------------------------------
// Fila única do envio diário (#7406) — substitui engajados/ramp-warm
// ---------------------------------------------------------------------------

test("isDailyQueueEligible: equivale a isEngajados quando sends_count>0", () => {
  const engajado = row({ email: "e@x.com", sends_count: 5, priority_points: 40 });
  const decaido = row({ email: "d@x.com", sends_count: 5, priority_points: 0 });
  const negativo = row({ email: "n@x.com", sends_count: 5, priority_points: -10 });
  assert.equal(isDailyQueueEligible(engajado), isEngajados(engajado));
  assert.equal(isDailyQueueEligible(engajado), true);
  assert.equal(isDailyQueueEligible(decaido), isEngajados(decaido));
  assert.equal(isDailyQueueEligible(decaido), false, "score decaído a 0 continua fora — território de reativação, não desta fila");
  assert.equal(isDailyQueueEligible(negativo), isEngajados(negativo));
});

test("isDailyQueueEligible: equivale a isRampWarm quando sends_count=0", () => {
  const verificado = row({ email: "v@x.com", sends_count: 0, mv_bucket: "verified" });
  const naoVerificado = row({ email: "nv@x.com", sends_count: 0, mv_bucket: "unknown" });
  assert.equal(isDailyQueueEligible(verificado), isRampWarm(verificado));
  assert.equal(isDailyQueueEligible(verificado), true);
  assert.equal(isDailyQueueEligible(naoVerificado), isRampWarm(naoVerificado));
  assert.equal(isDailyQueueEligible(naoVerificado), false);
});

test("isDailyQueueEligible: respeita cutoffNovosIso pro ramo de 1º envio (#5410, mesmo corte de isRampWarm)", () => {
  const dentroDaJanela = row({ email: "novo@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-09-01T00:00:00Z" });
  assert.equal(isDailyQueueEligible(dentroDaJanela, "2026-08-15T00:00:00Z"), false);
  assert.equal(isDailyQueueEligible(dentroDaJanela, null), true);
});

test("isDailyQueueEligible: send_eligible=0 exclui em qualquer ramo", () => {
  assert.equal(isDailyQueueEligible(row({ email: "a@x.com", send_eligible: 0, sends_count: 5, priority_points: 40 })), false);
  assert.equal(isDailyQueueEligible(row({ email: "b@x.com", send_eligible: 0, sends_count: 0, mv_bucket: "verified" })), false);
});

test("isDailyQueueEligible: conta de teste do editor exclui em qualquer ramo", () => {
  assert.equal(isDailyQueueEligible(row({ email: "vjpixel+test@gmail.com", sends_count: 5, priority_points: 40 })), false);
  assert.equal(isDailyQueueEligible(row({ email: "vjpixel+test@gmail.com", sends_count: 0, mv_bucket: "verified" })), false);
});

test("compareDailyQueueOrder: priority_points DESC — score alto sempre antes de score 0, sem lógica de tier", () => {
  const alto = row({ email: "alto@x.com", priority_points: 80 });
  const zero = row({ email: "zero@x.com", priority_points: 0 });
  assert.ok(compareDailyQueueOrder(alto, zero) < 0);
  assert.ok(compareDailyQueueOrder(zero, alto) > 0);
});

test("compareDailyQueueOrder: empate em score>0 desempata por email ASC (mesmo que segmentEngajados)", () => {
  const b = row({ email: "b@x.com", priority_points: 50 });
  const a = row({ email: "a@x.com", priority_points: 50 });
  assert.ok(compareDailyQueueOrder(a, b) < 0);
});

test("compareDailyQueueOrder: empate em score=0 desempata por compareContactRecency (mesmo que segmentRampWarm)", () => {
  const recente = row({ email: "recente@x.com", priority_points: 0, cohort: "leads-2026h2", created: "2026-08-01T00:00:00Z" });
  const antigo = row({ email: "antigo@x.com", priority_points: 0, cohort: "leads-2022h1", created: "2022-01-01T00:00:00Z" });
  assert.ok(compareDailyQueueOrder(recente, antigo) < 0, "cadastro mais recente primeiro, não email ASC");
});

test("buildDailySendQueue: união de quem hoje é engajados+ramp-warm, na ordem certa (score DESC), sem grupo escolhido", () => {
  const engajadoAlto = row({ email: "z-engajado-alto@x.com", sends_count: 3, priority_points: 90 });
  const engajadoBaixo = row({ email: "a-engajado-baixo@x.com", sends_count: 3, priority_points: 10 });
  const rampWarmRecente = row({ email: "b-ramp-recente@x.com", sends_count: 0, mv_bucket: "verified", cohort: "leads-2026h2", created: "2026-08-01T00:00:00Z" });
  const rampWarmAntigo = row({ email: "y-ramp-antigo@x.com", sends_count: 0, mv_bucket: "verified", cohort: "leads-2022h1", created: "2022-01-01T00:00:00Z" });
  const foraDaFila = row({ email: "decaido@x.com", sends_count: 3, priority_points: 0 }); // território reativação

  const noGuard = { queuedListIds: new Set<string>(), committedListIds: new Set<string>() };
  const queue = buildDailySendQueue(
    [rampWarmAntigo, engajadoBaixo, foraDaFila, rampWarmRecente, engajadoAlto],
    noGuard,
  );

  assert.deepEqual(
    queue.map((r) => r.email),
    [engajadoAlto.email, engajadoBaixo.email, rampWarmRecente.email, rampWarmAntigo.email],
    "todo score>0 antes de todo score=0, cada bloco na ordem do grupo original — sem tier explícito",
  );

  // Equivale à UNIÃO de segmentEngajados + segmentRampWarm sobre o mesmo universo.
  const universe = [rampWarmAntigo, engajadoBaixo, foraDaFila, rampWarmRecente, engajadoAlto];
  const uniaoEsperada = new Set([...segmentEngajados(universe), ...segmentRampWarm(universe)].map((r) => r.email));
  assert.deepEqual(new Set(queue.map((r) => r.email)), uniaoEsperada);
});

test("buildDailySendQueue: guard POR CONTATO — quem já recebeu (queued) NUNCA usa o guard committed que zeraria o grupo (achado 260731, #7236)", () => {
  const engajado = row({ email: "engajado@x.com", sends_count: 3, priority_points: 50, brevo_list_ids: JSON.stringify(["list-sent-antiga"]) });
  // "list-sent-antiga" está em committedListIds (queued∪sent) mas NÃO em queuedListIds — reproduz o bug que #6051/#7236 mediu: 15.123 de 15.123 engajados excluídos se o guard errado for aplicado.
  const guards = { queuedListIds: new Set<string>(), committedListIds: new Set(["list-sent-antiga"]) };
  const queue = buildDailySendQueue([engajado], guards);
  assert.deepEqual(queue.map((r) => r.email), [engajado.email], "guard committed nunca se aplica a quem já tem sends_count>0");
});

test("buildDailySendQueue: guard POR CONTATO — quem já recebeu É excluído se estiver numa lista AGENDADA (queued)", () => {
  const engajado = row({ email: "engajado@x.com", sends_count: 3, priority_points: 50, brevo_list_ids: JSON.stringify(["list-queued"]) });
  const guards = { queuedListIds: new Set(["list-queued"]), committedListIds: new Set<string>() };
  assert.deepEqual(buildDailySendQueue([engajado], guards), []);
});

test("buildDailySendQueue: guard POR CONTATO — quem nunca recebeu usa committed (protege contra lag de sync do Brevo, #3682)", () => {
  const rampWarm = row({ email: "novo@x.com", sends_count: 0, mv_bucket: "verified", brevo_list_ids: JSON.stringify(["list-sent-recem"]) });
  // Só em committedListIds (sent), não em queuedListIds — se o guard fosse só "queued" pra este contato, ele voltaria a ser selecionado apesar de já ter recebido (sync ainda não propagou sends_count).
  const guards = { queuedListIds: new Set<string>(), committedListIds: new Set(["list-sent-recem"]) };
  assert.deepEqual(buildDailySendQueue([rampWarm], guards), []);
});

test("buildDailySendQueue: guard POR CONTATO — quem nunca recebeu NÃO é excluído por uma lista só-queued de outro contato (isolamento por linha, não por batch)", () => {
  const rampWarmA = row({ email: "a@x.com", sends_count: 0, mv_bucket: "verified", brevo_list_ids: JSON.stringify(["list-queued-de-outro"]) });
  const guards = { queuedListIds: new Set(["list-queued-de-outro"]), committedListIds: new Set<string>() };
  // "list-queued-de-outro" só está em queuedListIds — rampWarmA usa guard COMMITTED (sends_count=0), que está vazio aqui, então não é excluído por essa lista.
  assert.deepEqual(buildDailySendQueue([rampWarmA], guards).map((r) => r.email), [rampWarmA.email]);
});

test("buildDailySendQueue: respeita cutoffNovosIso (repassa pro ramo de 1º envio)", () => {
  const dentroDaJanela = row({ email: "novo@x.com", sends_count: 0, mv_bucket: "verified", created: "2026-09-01T00:00:00Z" });
  const noGuard = { queuedListIds: new Set<string>(), committedListIds: new Set<string>() };
  assert.deepEqual(buildDailySendQueue([dentroDaJanela], noGuard, "2026-08-15T00:00:00Z"), []);
  assert.deepEqual(buildDailySendQueue([dentroDaJanela], noGuard, null).map((r) => r.email), [dentroDaJanela.email]);
});
