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
import { buildAdsData, clearAdsCache, buildAdsCampaignEconomics, clearAdsCampaignEconomicsCache } from "../scripts/studio-ui/studio-ads.ts";

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

// ─── #7536: buildAdsCampaignEconomics ("Economia da campanha ao vivo") ────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function writeRunState(root: string): void {
  const dir = join(root, "data", "aquisicao", "teste-2608");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run-state.json"),
    JSON.stringify(
      {
        d0: "2026-01-01",
        fim_janela: "2026-01-15",
        religar_brevo: "2026-01-22",
        coorte_madura: "2026-02-11",
        apuracao_snapshot: "2026-02-15",
        bracos: ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"],
        registrado_em: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("buildAdsCampaignEconomics — sem run-state.json e sem credenciais (nunca lança)", () => {
  it("runState null, testState com totais zerados, freshness reporta erro por fonte ausente", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
      const data = await buildAdsCampaignEconomics(root, {
        now: () => new Date("2026-01-10T12:00:00Z"),
        env: {},
        fetchImpl,
      });
      assert.equal(data.runState, null);
      assert.equal(data.runStateError, null);
      assert.equal(data.testState.emAndamento, false);
      assert.equal(data.cumulative.series.length, 0);
      const google = data.freshness.find((f) => f.source === "Google Ads")!;
      assert.equal(google.status, "error");
      assert.match(google.error ?? "", /GOOGLE_ADS_/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsCampaignEconomics — run-state.json presente + fontes respondendo", () => {
  it("cruza gasto (Google Ads GAQL) com cadastros (Kit) e monta série acumulada + tabela por canal", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root);
      const env = {
        GOOGLE_ADS_DEVELOPER_TOKEN: "dt",
        GOOGLE_ADS_CLIENT_ID: "ci",
        GOOGLE_ADS_CLIENT_SECRET: "cs",
        GOOGLE_ADS_REFRESH_TOKEN: "rt",
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1",
        GOOGLE_ADS_CUSTOMER_ID: "2",
        KIT_API_KEY: "kit_test_key",
      };
      const fetchImpl = (async (url: string) => {
        if (url.includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
        return jsonResponse(200, {
          results: [{ segments: { date: "2026-01-05" }, metrics: { costMicros: "5000000", clicks: "10", impressions: "500" } }],
        });
      }) as typeof fetch;

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        jsonResponse(200, {
          subscribers: [
            { id: 1, email_address: "a@b.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "google-ads" } },
          ],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        })) as typeof fetch;

      let data;
      try {
        data = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:00:00Z"), env, fetchImpl });
      } finally {
        globalThis.fetch = origFetch;
      }

      assert.ok(data.runState);
      assert.equal(data.testState.emAndamento, true);
      assert.equal(data.cumulative.series.length, 1);
      assert.equal(data.cumulative.series[0].canal, "Google Ads (teste 2608)");
      const googleRow = data.channels.find((c) => c.canal === "Google Ads (teste 2608)")!;
      assert.equal(googleRow.gastoTotalBrl, 5);
      assert.equal(googleRow.cadastrosTotal, 1);
      assert.equal(googleRow.custoPorCadastroBrl, 5);
      const googleFreshness = data.freshness.find((f) => f.source === "Google Ads")!;
      assert.equal(googleFreshness.status, "ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsCampaignEconomics — lookback cobre D0..hoje, nunca um fixo 30 dias (self-review #7536)", () => {
  it("mais de 30 dias após o D0: a query GAQL enviada ainda começa em run-state.d0, não recorta os primeiros dias", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root); // d0: 2026-01-01
      const env = {
        GOOGLE_ADS_DEVELOPER_TOKEN: "dt",
        GOOGLE_ADS_CLIENT_ID: "ci",
        GOOGLE_ADS_CLIENT_SECRET: "cs",
        GOOGLE_ADS_REFRESH_TOKEN: "rt",
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1",
        GOOGLE_ADS_CUSTOMER_ID: "2",
      };
      let capturedQuery = "";
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url.includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
        if (init?.body) {
          const parsed = JSON.parse(String(init.body));
          if (parsed.query) capturedQuery = parsed.query;
        }
        return jsonResponse(200, { results: [] });
      }) as typeof fetch;

      // 45 dias depois do D0 — mais que o antigo lookback fixo de 30 dias.
      await buildAdsCampaignEconomics(root, { now: () => new Date("2026-02-15T12:00:00Z"), env, fetchImpl });

      assert.match(capturedQuery, /BETWEEN '2026-01-01'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsCampaignEconomics — cache com TTL/forceRefresh", () => {
  it("2ª chamada dentro do TTL vem do cache (cached=true)", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
      const first = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:00:00Z"), env: {}, fetchImpl });
      assert.equal(first.cached, false);
      const second = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:01:00Z"), env: {}, fetchImpl });
      assert.equal(second.cached, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
