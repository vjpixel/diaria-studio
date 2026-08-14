/**
 * test/studio-ads.test.ts (#5236 Parte 3)
 *
 * Cobertura de `scripts/studio-ui/studio-ads.ts`: sessão cloud (`data/`
 * ausente) nunca lança, fail-soft por camada (spend/snapshot/origem),
 * cache com TTL/forceRefresh, e o caminho feliz com fixtures em tmpdir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdsData, clearAdsCache } from "../scripts/studio-ui/studio-ads.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "studio-ads-"));
}

function subscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "leitor@example.com",
    status: "active",
    created: 1755000000,
    utm_source: "android.googlequicksearchbox",
    utm_medium: "cpc",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 },
    ...overrides,
  });
}

function writeSpendCsv(root: string, content?: string): void {
  const dir = join(root, "data", "aquisicao");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "spend.csv"),
    content ?? "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\nLinkedIn,2026-08,BRL,0,teste\n",
    "utf8",
  );
}

function writeSnapshot(root: string, date: string, lines: string[]): void {
  const dir = join(root, "data", "beehiiv-backup", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subscribers.jsonl"), lines.join("\n") + "\n", "utf8");
}

describe("buildAdsData — sessão cloud (data/ ausente) nunca lança", () => {
  it("hasDataDir=false, spend/snapshot com error, report null — sem exceção", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      // NUNCA cria data/ — simula clone fresco em cloud.
      const data = buildAdsData(root, { now: () => new Date("2026-08-14T12:00:00Z") });
      assert.equal(data.hasDataDir, false);
      assert.equal(data.execMode, "cloud");
      assert.ok(data.spend.error);
      assert.ok(data.snapshot.error);
      assert.equal(data.report, null);
      assert.equal(data.budget, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — fail-soft por camada", () => {
  it("spend.csv ausente mas snapshot presente: spend.error preenchido, report null", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.ok(data.spend.error);
      assert.equal(data.spend.rows.length, 0);
      assert.equal(data.snapshot.date, "2026-08-14");
      assert.equal(data.report, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snapshot ausente mas spend.csv presente: snapshot.error preenchido, report null", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.equal(data.spend.error, null);
      assert.equal(data.spend.rows.length, 2);
      assert.ok(data.snapshot.error);
      assert.equal(data.report, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("linha inválida em spend.csv aparece em spend.rowErrors sem derrubar as válidas", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\n,2026-02,BRL,1,quebrada\n");
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.equal(data.spend.rows.length, 1);
      assert.equal(data.spend.rowErrors.length, 1);
      assert.ok(data.report, "1 linha válida ainda deveria produzir um report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — caminho feliz", () => {
  it("monta report + budget com spend.csv + snapshot presentes", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine({ email: "a@example.com" }), subscriberLine({ email: "b@example.com", utm_source: "direct" })]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.ok(data.report);
      assert.equal(data.report!.rows.length, 2);
      assert.ok(data.budget);
      assert.equal(data.monthKey, "2026-08");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("usa o snapshot anterior quando existem 2+ datas (sinal de degradação)", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-07-01", [subscriberLine({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 60 } })]);
      writeSnapshot(root, "2026-08-14", [subscriberLine({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 20 } })]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.equal(data.snapshot.date, "2026-08-14");
      assert.equal(data.snapshot.previousDate, "2026-07-01");
      const googleRow = data.report!.rows.find((r) => r.canal === "Google Ads");
      assert.equal((googleRow as any).degradado, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — cache + forceRefresh", () => {
  it("retorna cached=true dentro do TTL sem forceRefresh", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      const first = buildAdsData(root, { now: () => new Date("2026-08-14T10:00:00Z") });
      assert.equal(first.cached, false);
      const second = buildAdsData(root, { now: () => new Date("2026-08-14T10:01:00Z") });
      assert.equal(second.cached, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forceRefresh bypassa o cache mesmo dentro do TTL", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      buildAdsData(root, { now: () => new Date("2026-08-14T10:00:00Z") });
      const refreshed = buildAdsData(root, { now: () => new Date("2026-08-14T10:01:00Z"), forceRefresh: true });
      assert.equal(refreshed.cached, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TTL expirado recomputa (cached=false)", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      buildAdsData(root, { now: () => new Date("2026-08-14T10:00:00Z"), cacheTtlMs: 1000 });
      const after = buildAdsData(root, { now: () => new Date("2026-08-14T10:00:02Z"), cacheTtlMs: 1000 });
      assert.equal(after.cached, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
