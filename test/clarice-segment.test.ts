import { test } from "node:test";
import assert from "node:assert/strict";
import {
  segmentFromStore,
  priorityQueue,
  sliceIntoWaves,
  loadStoreRows,
  type StoreRow,
} from "../scripts/lib/clarice-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

function row(p: Partial<StoreRow> & { email: string }): StoreRow {
  return {
    tier: null,
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
  // veterano engajado (re-envio): seta opens/sends direto
  db.prepare(
    "INSERT INTO clarice_users (email, tier, opens_count, sends_count) VALUES (?, 2, 3, 3)",
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
