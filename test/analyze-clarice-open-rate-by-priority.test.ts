/**
 * test/analyze-clarice-open-rate-by-priority.test.ts (#4705 item 1)
 *
 * Cobre as funções puras de scripts/analyze-clarice-open-rate-by-priority.ts
 * — sem I/O real (nem arquivo, nem rede). `main()` (leitura de CLI args +
 * arquivos em disco) não é exercitado aqui, mesmo padrão dos scripts irmãos
 * (ex: postmaster-campaign-spam-report.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePrioritySnapshotCsv,
  buildBuckets,
  computeOpenRateByPriority,
  formatReport,
  DEFAULT_BUCKET_THRESHOLDS,
  type CampaignCache,
  type PriorityRow,
} from "../scripts/analyze-clarice-open-rate-by-priority.ts";

// ── parsePrioritySnapshotCsv ──

test("parsePrioritySnapshotCsv — parseia colunas email,priority_points,cohort,priority_optin", () => {
  const csv = "email,priority_points,cohort,priority_optin\na@x.com,3,leads-2022h1,0\nB@X.COM,0,,1\n";
  const rows = parsePrioritySnapshotCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { email: "a@x.com", priority_points: 3, cohort: "leads-2022h1", priority_optin: false });
  // email normalizado pra lowercase (join precisa ser case-insensitive)
  assert.equal(rows[1].email, "b@x.com");
  assert.equal(rows[1].priority_optin, true);
});

test("parsePrioritySnapshotCsv — linha sem email é descartada, priority_points ausente vira 0", () => {
  const csv = "email,priority_points,cohort,priority_optin\n,5,x,0\nc@x.com,,x,0\n";
  const rows = parsePrioritySnapshotCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "c@x.com");
  assert.equal(rows[0].priority_points, 0);
});

// ── buildBuckets ──

test("buildBuckets — thresholds default produzem 5 faixas cobrindo -inf..+inf sem buraco", () => {
  const buckets = buildBuckets(DEFAULT_BUCKET_THRESHOLDS);
  assert.equal(buckets.length, 5);
  assert.equal(buckets[0].label, "≤0");
  assert.equal(buckets[0].min, -Infinity);
  assert.equal(buckets[0].max, 0);
  assert.equal(buckets[1].label, "1-2");
  assert.equal(buckets[4].label, "11+");
  assert.equal(buckets[4].max, Infinity);
  // contíguo: max de um = min-1 do próximo
  for (let i = 1; i < buckets.length; i++) {
    assert.equal(buckets[i].min, buckets[i - 1].max + 1);
  }
});

test("buildBuckets — thresholds duplicados/desordenados são normalizados", () => {
  const buckets = buildBuckets([5, 0, 5, 2]);
  assert.deepEqual(
    buckets.map((b) => b.label),
    ["≤0", "1-2", "3-5", "6+"],
  );
});

// ── computeOpenRateByPriority ──

function snap(rows: Array<[string, number]>): PriorityRow[] {
  return rows.map(([email, priority_points]) => ({ email, priority_points, cohort: "", priority_optin: false }));
}

function campaign(
  id: number,
  recipients: Record<string, { delivered?: boolean; opened?: boolean }>,
): CampaignCache {
  return {
    campaignId: id,
    recipients: Object.fromEntries(
      Object.entries(recipients).map(([email, r]) => [
        email,
        { delivered: r.delivered ?? true, opened: r.opened ?? false, bounced: false, unsubscribed: false },
      ]),
    ),
  };
}

test("computeOpenRateByPriority — bucketiza corretamente e calcula taxa por faixa", () => {
  const snapshot = snap([
    ["cold@x.com", 0],
    ["warm@x.com", 3],
    ["hot@x.com", 12],
  ]);
  const camp = campaign(1, {
    "cold@x.com": { opened: false },
    "warm@x.com": { opened: true },
    "hot@x.com": { opened: true },
  });
  const report = computeOpenRateByPriority(snapshot, [camp], [0, 2, 5, 10]);

  const byLabel = Object.fromEntries(report.buckets.map((b) => [b.label, b]));
  assert.equal(byLabel["≤0"].delivered, 1);
  assert.equal(byLabel["≤0"].opened, 0);
  assert.equal(byLabel["≤0"].openRatePct, 0);
  assert.equal(byLabel["3-5"].delivered, 1);
  assert.equal(byLabel["3-5"].openRatePct, 100);
  assert.equal(byLabel["11+"].delivered, 1);
  assert.equal(byLabel["11+"].openRatePct, 100);
  // faixa sem nenhum contato → openRatePct null, não NaN/0 enganoso
  assert.equal(byLabel["1-2"].delivered, 0);
  assert.equal(byLabel["1-2"].openRatePct, null);

  assert.equal(report.totalSnapshotContacts, 3);
  assert.equal(report.matchedContacts, 3);
  assert.equal(report.coveragePct, 100);
});

test("computeOpenRateByPriority — recipient não-delivered não conta (bounce não é 'não abriu')", () => {
  const snapshot = snap([["a@x.com", 0]]);
  const camp = campaign(1, { "a@x.com": { delivered: false, opened: false } });
  const report = computeOpenRateByPriority(snapshot, [camp]);
  assert.equal(report.matchedContacts, 0);
  assert.equal(report.buckets.every((b) => b.delivered === 0), true);
});

test("computeOpenRateByPriority — recipient da campanha ausente do snapshot é ignorado (achado #4705: overlap pode ser 0%)", () => {
  const snapshot = snap([["in-snapshot@x.com", 5]]);
  const camp = campaign(1, {
    "in-snapshot@x.com": { opened: true },
    "not-in-snapshot@x.com": { opened: true },
  });
  const report = computeOpenRateByPriority(snapshot, [camp]);
  assert.equal(report.totalCampaignRecipients, 2);
  assert.equal(report.matchedContacts, 1); // só quem está no snapshot entra no bucket
  assert.equal(report.coveragePct, 100); // 1/1 dos contatos DO SNAPSHOT bateu
});

test("computeOpenRateByPriority — snapshot vazio não divide por zero", () => {
  const report = computeOpenRateByPriority([], [campaign(1, { "a@x.com": { opened: true } })]);
  assert.equal(report.totalSnapshotContacts, 0);
  assert.equal(report.coveragePct, 0);
});

test("computeOpenRateByPriority — merge entre 2 campanhas (mesmo email, delivered em uma só) usa union", () => {
  const snapshot = snap([["a@x.com", 0]]);
  const campA = campaign(1, { "a@x.com": { delivered: false, opened: false } });
  const campB = campaign(2, { "a@x.com": { delivered: true, opened: true } });
  const report = computeOpenRateByPriority(snapshot, [campA, campB]);
  assert.equal(report.matchedContacts, 1);
  assert.equal(report.buckets[0].opened, 1);
});

// ── formatReport ──

test("formatReport — inclui aviso de cobertura baixa quando coveragePct < 5%", () => {
  const report = computeOpenRateByPriority(
    snap(Array.from({ length: 100 }, (_, i) => [`e${i}@x.com`, 0])),
    [campaign(1, { "e0@x.com": { opened: true } })],
  );
  const text = formatReport(report, { snapshotPath: "fake.csv", campaignIds: [1] });
  assert.match(text, /Cobertura abaixo de 5%/);
});

test("formatReport — sem aviso quando cobertura é boa", () => {
  const report = computeOpenRateByPriority(
    snap([["a@x.com", 0]]),
    [campaign(1, { "a@x.com": { opened: true } })],
  );
  const text = formatReport(report, { snapshotPath: "fake.csv", campaignIds: [1] });
  assert.doesNotMatch(text, /Cobertura abaixo de/);
  assert.match(text, /100\.0%/);
});
