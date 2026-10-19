/**
 * #10479 — snapshot da fila completa de elegíveis por onda (`clarice-build-segment
 * --daily`) e o verificador de ordem do #9824 sobre ele.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main as buildSegmentMain } from "../scripts/clarice-build-segment.ts";
import { main as verifyMain, pickLastSnapshots } from "../scripts/clarice-verify-daily-queue-order.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { buildDailySendQueue } from "../scripts/lib/clarice-segment.ts";
import {
  DAILY_QUEUE_SNAPSHOT_DIR,
  buildDailyQueueSnapshotCsv,
  buildDailyQueueSnapshotGz,
  dailyQueueSnapshotFileName,
  parseDailyQueueSnapshotCsv,
  parseDailyQueueSnapshotGz,
  verifyDailyQueueOrder,
  type DailyQueueSnapshotRow,
} from "../scripts/lib/clarice-daily-queue-snapshot.ts";

type R = { email: string; priority_points: number; created: string };
const r = (email: string, priority_points: number, created: string): R => ({ email, priority_points, created });

/** Linhas do snapshot a partir de uma fila e de quais emails foram incluídos
 *  (não precisa ser prefixo: serve para montar ondas montadas com a regra errada). */
function rows(queue: R[], included: string[]): DailyQueueSnapshotRow[] {
  return queue.map((q, i) => ({ rank: i + 1, ...q, included: included.includes(q.email) }));
}

async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

async function comBrevoFake<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.BREVO_CLARICE_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.BREVO_CLARICE_API_KEY = "test-fake-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ campaigns: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey !== undefined) process.env.BREVO_CLARICE_API_KEY = prevKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
  }
}

// ---------------------------------------------------------------------------
// verificador puro
// ---------------------------------------------------------------------------

test("verifyDailyQueueOrder: onda montada por buildDailySendQueue + corte de budget passa", () => {
  const store = [
    { email: "a@x.com", priority_points: 30, created: "2025-01-01T00:00:00Z" },
    { email: "b@x.com", priority_points: 0, created: "2021-03-01T00:00:00Z" },
    { email: "c@x.com", priority_points: 0, created: "2024-06-01T00:00:00Z" },
    { email: "d@x.com", priority_points: -10, created: "2026-09-01T00:00:00Z" },
    { email: "e@x.com", priority_points: -20, created: "2026-10-01T00:00:00Z" },
  ].map((s) => ({ ...s, send_eligible: 1, sends_count: 1, mv_bucket: null, cohort: null, brevo_list_ids: null }));
  const ordered = buildDailySendQueue(store, { queuedListIds: new Set(), committedListIds: new Set() }, null);
  for (let budget = 0; budget <= ordered.length; budget++) {
    const parsed = parseDailyQueueSnapshotCsv(buildDailyQueueSnapshotCsv(ordered, budget));
    const rep = verifyDailyQueueOrder(parsed);
    assert.ok(rep.ok, `budget ${budget}: ${JSON.stringify(rep.violations)}`);
    assert.equal(rep.included, budget);
    assert.equal(rep.excluded, ordered.length - budget);
  }
});

test("verifyDailyQueueOrder: caso real do #9824 (score 0 antigo fora, -10 novo dentro) é violação de score", () => {
  // Regra antiga (#7876): bloco score<=0 ordenado só por safra.
  const queue = [r("novo-menos10@x.com", -10, "2026-05-01T00:00:00Z"), r("antigo-zero@x.com", 0, "2022-01-01T00:00:00Z")];
  const rep = verifyDailyQueueOrder(rows(queue, ["novo-menos10@x.com"]));
  assert.equal(rep.ok, false);
  assert.equal(rep.violations.length, 1);
  const v = rep.violations[0];
  assert.equal(v.kind, "score");
  assert.equal(v.count, 1);
  assert.deepEqual(v.included, { email: "novo-menos10@x.com", priority_points: -10 });
  assert.deepEqual(v.excluded, { email: "antigo-zero@x.com", priority_points: 0 });
});

test("verifyDailyQueueOrder: empate de score com incluído mais antigo que excluído é violação de desempate", () => {
  const queue = [
    r("velho@x.com", -10, "2023-01-01T00:00:00Z"),
    r("novo@x.com", -10, "2026-01-01T00:00:00Z"),
    r("igual@x.com", -10, "2026-01-01T00:00:00Z"),
  ];
  const rep = verifyDailyQueueOrder(rows(queue, ["velho@x.com", "igual@x.com"]));
  assert.equal(rep.ok, false);
  assert.equal(rep.violations.length, 1);
  const v = rep.violations[0];
  assert.equal(v.kind, "tie-created");
  assert.equal(v.count, 1, "cadastro IGUAL ao do excluído não conta como violação");
  assert.equal(v.included.email, "velho@x.com");
  assert.equal(v.excluded.email, "novo@x.com");
});

test("verifyDailyQueueOrder: cadastro ausente conta como o mais antigo (mesma regra de compareContactRecency)", () => {
  const sem = [r("com-data@x.com", 0, "2020-01-01T00:00:00Z"), r("sem-data@x.com", 0, "")];
  assert.ok(verifyDailyQueueOrder(rows(sem, ["com-data@x.com"])).ok);
  const invertido = verifyDailyQueueOrder(rows(sem, ["sem-data@x.com"]));
  assert.equal(invertido.ok, false);
  assert.equal(invertido.violations[0].kind, "tie-created");
  // Dois sem data: empate, não é violação.
  const ambos = [r("s1@x.com", 0, ""), r("s2@x.com", 0, "")];
  assert.ok(verifyDailyQueueOrder(rows(ambos, ["s2@x.com"])).ok);
});

test("verifyDailyQueueOrder: onda sem excluídos (fila inteira coube) passa", () => {
  const queue = [r("a@x.com", -20, ""), r("b@x.com", 5, "2026-01-01T00:00:00Z")];
  const rep = verifyDailyQueueOrder(rows(queue, ["a@x.com", "b@x.com"]));
  assert.ok(rep.ok);
  assert.equal(rep.excluded, 0);
});

test("snapshot gz: ida e volta preserva as linhas; CSV sem coluna obrigatória é rejeitado", () => {
  const queue = [r("a@x.com", 10, "2026-01-01T00:00:00Z"), r("b@x.com", -10, "")];
  const back = parseDailyQueueSnapshotGz(buildDailyQueueSnapshotGz(queue, 1));
  assert.deepEqual(back, [
    { rank: 1, email: "a@x.com", priority_points: 10, created: "2026-01-01T00:00:00Z", included: true },
    { rank: 2, email: "b@x.com", priority_points: -10, created: "", included: false },
  ]);
  assert.throws(() => parseDailyQueueSnapshotCsv("rank,email,priority_points,created\n1,a@x.com,1,"), /included/);
  assert.throws(() => parseDailyQueueSnapshotCsv("rank,email,priority_points,created,included\n1,a@x.com,abc,,1"), /inválida/);
});

test("dailyQueueSnapshotFileName: ordem lexicográfica é a cronológica e o nome não tem ':'", () => {
  const a = dailyQueueSnapshotFileName(new Date("2026-10-07T09:05:00.123Z"), "2026-10-07");
  const b = dailyQueueSnapshotFileName(new Date("2026-10-08T09:05:00.000Z"), null);
  assert.equal(a, "2026-10-07T09-05-00-123Z_send-2026-10-07.csv.gz");
  assert.ok(!a.includes(":"));
  assert.ok(b.endsWith("_send-sem-data.csv.gz"));
  assert.deepEqual(pickLastSnapshots(["/x/" + b, "/y/" + a], 1), ["/x/" + b]);
  assert.deepEqual(pickLastSnapshots(["/x/" + b, "/y/" + a], 5), ["/y/" + a, "/x/" + b]);
});

// ---------------------------------------------------------------------------
// integração: build-segment --daily grava, verificador lê
// ---------------------------------------------------------------------------

function storeDaily(dir: string): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    `INSERT INTO clarice_users
       (email, name, cohort, priority_points, sends_count, send_eligible, mv_bucket, created)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run("alto@gmail.com", "Alto", null, 80, 3, 1, null, "2026-01-01T00:00:00Z");
  ins.run("zero-antigo@gmail.com", "ZeroAntigo", null, 0, 2, 1, null, "2021-05-01T00:00:00Z");
  ins.run("menos10-novo@gmail.com", "Menos10", null, -10, 2, 1, null, "2026-08-01T00:00:00Z");
  ins.run("menos20-novo@gmail.com", "Menos20", null, -20, 2, 1, null, "2026-09-01T00:00:00Z");
  ins.run("inelegivel@gmail.com", "Inelegivel", null, 50, 3, 0, null, "2026-01-01T00:00:00Z");
  db.close();
  return dbPath;
}

test("build-segment --daily grava a fila completa de elegíveis por onda, com incluídos = daily.csv", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-queue-10479-"));
  const dbPath = storeDaily(dir);
  const segDir = clariceSegmentsDir("2610-11", dir);

  await quiet(() =>
    comBrevoFake(() =>
      buildSegmentMain([
        "--cycle", "2610-11", "--db", dbPath, "--data-root", dir,
        "--daily", "--send-date", "2026-11-03", "--budget", "2",
      ]),
    ),
  );

  const queueDir = resolve(segDir, DAILY_QUEUE_SNAPSHOT_DIR);
  const files = readdirSync(queueDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /_send-2026-11-03\.csv\.gz$/);
  const snap = parseDailyQueueSnapshotGz(readFileSync(resolve(queueDir, files[0])));
  assert.deepEqual(
    snap.map((s) => [s.email, s.priority_points, s.included]),
    [
      ["alto@gmail.com", 80, true],
      ["zero-antigo@gmail.com", 0, true],
      ["menos10-novo@gmail.com", -10, false],
      ["menos20-novo@gmail.com", -20, false],
    ],
    "fila inteira de elegíveis (inelegível fora), score DESC, só o budget incluído",
  );
  assert.equal(snap[1].created, "2021-05-01T00:00:00Z");
  const dailyEmails = readFileSync(resolve(segDir, "daily.csv"), "utf8").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")[0]);
  assert.deepEqual(dailyEmails, snap.filter((s) => s.included).map((s) => s.email));

  // Uma onda só: ordem ok, mas evidência insuficiente para as 3 exigidas.
  assert.equal(await quiet(() => verifyMain(["--cycle", "2610-11", "--data-root", dir])), 2);
  assert.equal(await quiet(() => verifyMain(["--cycle", "2610-11", "--data-root", dir, "--last", "1"])), 0);
});

test("build-segment --daily --dry-run não grava snapshot da fila", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-queue-dry-10479-"));
  const dbPath = storeDaily(dir);
  await quiet(() =>
    comBrevoFake(() =>
      buildSegmentMain([
        "--cycle", "2610-11", "--db", dbPath, "--data-root", dir,
        "--daily", "--send-date", "2026-11-03", "--budget", "2", "--dry-run",
      ]),
    ),
  );
  assert.equal(existsSync(resolve(clariceSegmentsDir("2610-11", dir), DAILY_QUEUE_SNAPSHOT_DIR)), false);
});

test("verificador: 3 ondas entre 2 ciclos, uma violando, sai 1; só as N últimas contam", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-queue-verify-10479-"));
  const write = (cycle: string, stamp: string, gz: Buffer) => {
    const d = resolve(clariceSegmentsDir(cycle, dir), DAILY_QUEUE_SNAPSHOT_DIR);
    mkdirSync(d, { recursive: true });
    writeFileSync(resolve(d, dailyQueueSnapshotFileName(new Date(stamp), stamp.slice(0, 10))), gz);
  };
  const boa = buildDailyQueueSnapshotGz([r("a@x.com", 5, ""), r("b@x.com", 0, "")], 1);
  // Onda com a regra antiga: -10 incluído, 0 deixado de fora.
  const ruim = buildDailyQueueSnapshotGz([r("n@x.com", -10, "2026-01-01T00:00:00Z"), r("z@x.com", 0, "2021-01-01T00:00:00Z")], 1);

  write("2609-10", "2026-10-06T09:00:00.000Z", ruim);
  write("2609-10", "2026-10-30T09:00:00.000Z", boa);
  write("2610-11", "2026-11-02T09:00:00.000Z", boa);
  write("2610-11", "2026-11-03T09:00:00.000Z", boa);

  // As 3 últimas (cruzando ciclos) estão boas: a ruim é a 4ª mais recente.
  assert.equal(await quiet(() => verifyMain(["--cycle", "2610-11", "--cycle-extra", "2609-10", "--data-root", dir])), 0);
  // Com --last 4 a onda ruim entra.
  assert.equal(
    await quiet(() => verifyMain(["--cycle", "2610-11", "--cycle-extra", "2609-10", "--data-root", dir, "--last", "4"])),
    1,
  );
  // Só o ciclo novo: 2 ondas, evidência insuficiente.
  assert.equal(await quiet(() => verifyMain(["--cycle", "2610-11", "--data-root", dir])), 2);
  // Sem --cycle nem --files: erro de argumento.
  assert.equal(await quiet(() => verifyMain([])), 1);
});

// ---------------------------------------------------------------------------
// #10489: vários snapshots do mesmo send-date (rerun do build) são UMA onda
// ---------------------------------------------------------------------------

test("#10489 pickLastSnapshots: dois snapshots da mesma data de envio contam como uma onda (vale o mais recente)", () => {
  const cedo = dailyQueueSnapshotFileName(new Date("2026-10-07T08:00:00.000Z"), "2026-10-07");
  const rerun = dailyQueueSnapshotFileName(new Date("2026-10-07T09:30:00.000Z"), "2026-10-07");
  const outra = dailyQueueSnapshotFileName(new Date("2026-10-08T09:00:00.000Z"), "2026-10-08");
  const semData1 = dailyQueueSnapshotFileName(new Date("2026-10-09T09:00:00.000Z"), null);
  const semData2 = dailyQueueSnapshotFileName(new Date("2026-10-09T10:00:00.000Z"), null);
  const paths = [outra, rerun, cedo].map((f) => "/q/" + f);
  assert.deepEqual(pickLastSnapshots(paths, 3), ["/q/" + rerun, "/q/" + outra]);
  assert.deepEqual(pickLastSnapshots(paths, 1), ["/q/" + outra]);
  // Sem data de envio não há como agrupar: cada um segue contando.
  assert.deepEqual(pickLastSnapshots(["/q/" + semData1, "/q/" + semData2], 5), ["/q/" + semData1, "/q/" + semData2]);
});

test("#10489 verificador: 3 builds da mesma onda não provam 3 ondas (sai 2); a fila que vale é a do último rerun", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-queue-verify-10489-"));
  const d = resolve(clariceSegmentsDir("2610-11", dir), DAILY_QUEUE_SNAPSHOT_DIR);
  mkdirSync(d, { recursive: true });
  const boa = buildDailyQueueSnapshotGz([r("a@x.com", 5, ""), r("b@x.com", 0, "")], 1);
  const ruim = buildDailyQueueSnapshotGz([r("n@x.com", -10, "2026-01-01T00:00:00Z"), r("z@x.com", 0, "2021-01-01T00:00:00Z")], 1);
  // 1º build da onda violava a ordem; os 2 reruns do mesmo dia saíram certos.
  writeFileSync(resolve(d, dailyQueueSnapshotFileName(new Date("2026-11-02T08:00:00.000Z"), "2026-11-02")), ruim);
  writeFileSync(resolve(d, dailyQueueSnapshotFileName(new Date("2026-11-02T08:30:00.000Z"), "2026-11-02")), boa);
  writeFileSync(resolve(d, dailyQueueSnapshotFileName(new Date("2026-11-02T09:00:00.000Z"), "2026-11-02")), boa);
  // Antes do #10489 isto saía 1 (a onda descartada contava) ou 0 com 3 builds bons, afirmando 3 ondas.
  assert.equal(await quiet(() => verifyMain(["--cycle", "2610-11", "--data-root", dir])), 2);
});
