/**
 * test/8533-ads-exclude-microsoft-wiring.test.ts — regressão #8533
 *
 * O #8475 Parte A entregou a opção `excludeChannels` em
 * `buildCumulativeSeries` COM teste — e mesmo assim o Microsoft Ads
 * continuou no gráfico por um dia, porque nenhum chamador de produção
 * passava a opção. O teste do #8475 chamava a função de biblioteca
 * passando `excludeChannels` À MÃO, então passava igual com a produção
 * nunca passando nada.
 *
 * Este arquivo testa a LIGAÇÃO, não a opção: exercita
 * `buildAdsCampaignEconomics` (o builder real de `GET /api/ads`) e afirma
 * que o payload que chega no `ads.js` já vem sem a série da Microsoft.
 * Falha se alguém tirar `excludeChannels` do call site.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdsCampaignEconomics, clearAdsCampaignEconomicsCache } from "../scripts/studio-ui/studio-ads.ts";
import {
  MICROSOFT_ADS_TESTE_CANAL,
  META_ADS_TESTE_CANAL,
} from "../scripts/lib/ads-campaign-economics-fetch.ts";

const GOOGLE_CANAL = "Google Ads (teste 2608)";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "ads-8533-"));
}

function writeRunState(root: string): void {
  const dir = join(root, "data", "aquisicao", "teste-2608");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run-state.json"),
    JSON.stringify({
      d0: "2026-01-01",
      fim_janela: "2026-01-15",
      religar_brevo: "2026-01-22",
      coorte_madura: "2026-02-11",
      apuracao_snapshot: "2026-02-15",
      bracos: [GOOGLE_CANAL, MICROSOFT_ADS_TESTE_CANAL, META_ADS_TESTE_CANAL],
      registrado_em: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Cadastros do Kit: 1 pelo Google, 2 pela Microsoft. O canal Microsoft
 *  nasce daqui (`DEFAULT_UTM_SOURCE_TO_CANAL["microsoft-ads"]`), sem
 *  precisar stubar o SOAP da Reporting API — o que importa pro #8533 é se
 *  o canal chega ao gráfico, não de onde veio o gasto dele. */
function kitSubscribers(): unknown {
  return {
    subscribers: [
      { id: 1, email_address: "g@x.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "google-ads" } },
      { id: 2, email_address: "m1@x.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "microsoft-ads" } },
      { id: 3, email_address: "m2@x.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "microsoft-ads" } },
    ],
    pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
  };
}

async function build(root: string) {
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
    if (String(url).includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
    return jsonResponse(200, {
      results: [
        { segments: { date: "2026-01-05" }, metrics: { costMicros: "5000000", clicks: "10", impressions: "500" } },
      ],
    });
  }) as typeof fetch;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(200, kitSubscribers())) as typeof fetch;
  try {
    return await buildAdsCampaignEconomics(root, {
      now: () => new Date("2026-01-05T12:00:00Z"),
      env,
      fetchImpl,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("#8533 — o payload de /api/ads já vem sem a série da Microsoft", () => {
  it("Microsoft não recebe linha no gráfico, mas é declarada em omittedScale", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root);
      const data = await build(root);

      const canaisPlotados = data.cumulative.series.map((s) => s.canal);
      assert.ok(
        !canaisPlotados.includes(MICROSOFT_ADS_TESTE_CANAL),
        `Microsoft voltou pro gráfico — excludeChannels saiu do call site de studio-ads.ts (#8533). Plotados: ${JSON.stringify(canaisPlotados)}`,
      );
      assert.ok(
        data.cumulative.omittedScale.includes(MICROSOFT_ADS_TESTE_CANAL),
        "excluir em silêncio troca uma leitura falsa por outra — omittedScale alimenta o aviso da legenda",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Google continua plotado — a exclusão é de UM canal, não do gráfico", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root);
      const data = await build(root);
      assert.deepEqual(data.cumulative.series.map((s) => s.canal), [GOOGLE_CANAL]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Microsoft CONTINUA na tabela de canais — não é esconder o canal, é tirar do gráfico", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root);
      const data = await build(root);
      const ms = data.channels.find((c) => c.canal === MICROSOFT_ADS_TESTE_CANAL);
      assert.ok(ms, "Microsoft sumiu da tabela — a exclusão vazou do gráfico pro resto do painel");
      assert.equal(ms!.cadastrosTotal, 2, "os cadastros da Microsoft seguem contados integralmente");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
