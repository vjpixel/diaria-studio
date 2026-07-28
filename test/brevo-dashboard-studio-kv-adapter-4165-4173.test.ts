/**
 * test/brevo-dashboard-studio-kv-adapter-4165-4173.test.ts (#4165, #4173)
 *
 * #4165: botão "Atualizar votos" (/painel/clarice, aba Engajamento) postava
 * pra `/api/eia/refresh` — rota que só existe no Worker `clarice-dashboard`.
 * Servida pelo Studio, essa mesma action resolve contra `studio.diar.ia.br`,
 * cai no guard read-only e dá 405 (form sem JS → o editor perde o painel).
 *
 * #4173: `buildEnv()` do Studio (`dashboard-clarice.ts`) ligava `STATS_CACHE`
 * a um `MemoryKv` em processo nunca populado — cohorts/couponUsage/
 * eiaEngagement vinham sempre `null`. A omissão era SILENCIOSA: a aba Cupons
 * (única seção que estruturalmente desaparece — radio+label+painel) sumia
 * sem nenhuma explicação, indistinguível de "essa funcionalidade não existe".
 *
 * Fix: `RenderDashboardOptions.studioMode` (mesmo padrão de
 * workers/diaria-dashboard/src/index.ts #3861) — quando `true`:
 *   - dado null vira aviso "indisponível no painel local" com link pro
 *     dashboard Cloudflare, nunca "some calada" nem instrui uma ação impossível;
 *   - o botão "Atualizar votos" vira link (nunca o form POST que 405a).
 * `dashboard-clarice.ts` também ganhou um adaptador de KV real
 * (`RemoteKvNamespace`, cloudflare-kv-upload.ts) no lugar do MemoryKv —
 * coberto em test/cloudflare-kv-upload.test.ts.
 *
 * Regressão: Worker de produção nunca passa `studioMode` — todo teste
 * "sem opts" prova que o comportamento antigo não mudou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  renderDashboardHtml,
  renderEngagementCohortsSection,
  renderEiaEngagementSection,
  normalizeEngagementCohorts,
  normalizeEiaEngagement,
} from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";
import { RemoteKvNamespace } from "../scripts/lib/cloudflare-kv-upload.ts";
import { _buildEnvForTest } from "../scripts/studio-ui/dashboard-clarice.ts";

const emptyCampaigns: [] = [];

const syntheticCoupons: CouponUsageReport = {
  NEWS50: {
    couponIds: ["cpnSYNTH50"],
    timesRedeemed: 1,
    rowCount: 1,
    totalProjectedDiscountCents: 22450,
    redemptions: [
      {
        coupon_code: "NEWS50",
        coupon_id: "cpnSYNTH50",
        percent_off: 50,
        duration: "once",
        customer: "cus_TEST1",
        customer_email: "test1@example.com",
        subscription: "sub_SYNTH1",
        status: "active",
        created: 1782383062,
        plan_amount_cents: 44900,
        currency: "brl",
        interval: "year",
        discount_value_cents: 22450,
      },
    ],
  },
};

const cohortsFixture = normalizeEngagementCohorts({
  universe: 100,
  opened2plus: 10,
  opened1: 5,
  received1_opened0: 2,
  received2_opened0: 3,
  exits: 1,
});

const eiaFixture = normalizeEiaEngagement({
  editions: [
    { edition: "260701", total_votes: 25, voted_a: 15, voted_b: 10, pct_correct: 60, correct_choice: "A" },
  ],
  updated_at: "2026-07-01T09:00:00.000Z",
});

// ---------------------------------------------------------------------------
// (a) renderEngagementCohortsSection — aviso studioMode vs. stub de produção
// ---------------------------------------------------------------------------

describe("renderEngagementCohortsSection — aviso studioMode (#4173)", () => {
  it("null + sem opts (produção) → mantém o texto antigo ('rode o script')", () => {
    const html = renderEngagementCohortsSection(null);
    assert.match(html, /Rode <code>npx tsx scripts\/clarice-engagement-cohorts\.ts/);
    assert.doesNotMatch(html, /Indisponível no painel local/);
  });

  it("null + studioMode:false explícito → idêntico ao default (regressão)", () => {
    const html = renderEngagementCohortsSection(null, new Date(), { studioMode: false });
    assert.match(html, /Rode <code>npx tsx scripts\/clarice-engagement-cohorts\.ts/);
  });

  it("null + studioMode:true → aviso 'indisponível no painel local' com link pro dashboard Cloudflare", () => {
    const html = renderEngagementCohortsSection(null, new Date(), { studioMode: true });
    assert.match(html, /Indisponível no painel local/);
    assert.match(html, /clarice-dashboard\.diaria\.workers\.dev/);
    assert.doesNotMatch(html, /Rode <code>npx tsx/, "não deve mais instruir a rodar o script no contexto Studio");
  });

  it("dado presente + studioMode:true → renderiza a tabela normalmente (sem regressão de dado real)", () => {
    const html = renderEngagementCohortsSection(cohortsFixture, new Date(), { studioMode: true });
    assert.match(html, /Abriu 2\+ e-mails/);
    assert.doesNotMatch(html, /Indisponível no painel local/);
  });
});

// ---------------------------------------------------------------------------
// (b) renderEiaEngagementSection — botão vs. link + aviso
// ---------------------------------------------------------------------------

describe("renderEiaEngagementSection — botão/aviso studioMode (#4165/#4173)", () => {
  it("null + sem opts (produção) → mantém form POST /api/eia/refresh", () => {
    const html = renderEiaEngagementSection(null);
    assert.match(html, /action="\/api\/eia\/refresh"/);
    assert.doesNotMatch(html, /Indisponível no painel local/);
  });

  it("null + studioMode:true → aviso, SEM o form que 405a no Studio", () => {
    const html = renderEiaEngagementSection(null, new Date(), { studioMode: true });
    assert.match(html, /Indisponível no painel local/);
    assert.doesNotMatch(html, /action="\/api\/eia\/refresh"/, "o form POST nunca deve aparecer em studioMode");
  });

  it("dado presente + sem opts (produção) → mantém o form POST (regressão)", () => {
    const html = renderEiaEngagementSection(eiaFixture);
    assert.match(html, /action="\/api\/eia\/refresh"/);
  });

  it("dado presente + studioMode:true → link pro dashboard Cloudflare, NUNCA o form", () => {
    const html = renderEiaEngagementSection(eiaFixture, new Date(), { studioMode: true });
    assert.doesNotMatch(html, /action="\/api\/eia\/refresh"/, "#4165: o form 405a servido pelo Studio");
    assert.match(html, /clarice-dashboard\.diaria\.workers\.dev/);
    assert.match(html, /260701/, "a tabela de votos continua renderizando normalmente");
  });
});

// ---------------------------------------------------------------------------
// (c) renderDashboardHtml — aba Cupons não some mais calada em studioMode
// ---------------------------------------------------------------------------

describe("renderDashboardHtml — aba Cupons com aviso em studioMode (#4173)", () => {
  it("couponUsage null + sem opts (produção) → aba continua OMITIDA (regressão, PII-off)", () => {
    const html = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);
    assert.ok(!html.includes('id="panel-cupons"'));
    // #2741: a regra CSS `#tab-cupons:checked ~ ...` é estática (sempre no
    // <style>) — checar o elemento (`id="tab-cupons"`), não a string crua.
    assert.ok(!html.includes('id="tab-cupons"'));
  });

  it("couponUsage null + studioMode:true → aba EXISTE (radio+label+painel) com aviso, não some calada", () => {
    const html = renderDashboardHtml(
      emptyCampaigns, [], null, null, null, null, null, null, null, null, null,
      { studioMode: true },
    );
    assert.ok(html.includes('id="panel-cupons"'), "painel deve existir mesmo com couponUsage null");
    assert.ok(html.includes('id="tab-cupons"'), "radio da aba deve existir");
    assert.ok(html.includes("tablabel-cupons"), "label da aba deve existir");
    assert.match(html, /Indisponível no painel local/);
  });

  it("couponUsage presente + studioMode:true → mostra o painel real (sem regressão de dado real)", () => {
    const html = renderDashboardHtml(
      emptyCampaigns, [], null, null, null, syntheticCoupons, null, null, null, null, null,
      { studioMode: true },
    );
    assert.ok(html.includes('id="panel-cupons"'));
    assert.ok(html.includes("test1@example.com"));
    // Escopado ao painel-cupons — cohorts/eiaEngagement (também null nesta
    // fixture) legitimamente mostram o aviso NAS SEÇÕES DELAS; o que importa
    // aqui é que o painel de CUPONS especificamente não mostra o aviso quando
    // tem dado real.
    const couponsPanel = html.match(/id="panel-cupons"[\s\S]*?\/panel-cupons -->/)?.[0] ?? "";
    assert.ok(couponsPanel.length > 0, "painel-cupons deve ser encontrável no HTML");
    assert.doesNotMatch(couponsPanel, /Indisponível no painel local/);
  });

  it("couponUsage null + studioMode:true não vaza nenhum PII (aviso não menciona email/cupom)", () => {
    const html = renderDashboardHtml(
      emptyCampaigns, [], null, null, null, null, null, null, null, null, null,
      { studioMode: true },
    );
    assert.ok(!html.includes("@example.com"));
  });
});

// ---------------------------------------------------------------------------
// (d) dashboard-clarice.ts (Studio) — invariantes de wiring, via inspeção de
// fonte (sem montar o pipeline Brevo/SQLite inteiro — ver docstring do PR).
// ---------------------------------------------------------------------------

describe("dashboard-clarice.ts — invariantes de wiring do studioMode (#4165/#4173)", () => {
  const srcPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/studio-ui/dashboard-clarice.ts",
  );
  const src = readFileSync(srcPath, "utf-8");

  it("chama renderDashboardHtml com { studioMode: true } (garante o efeito testado em (a)-(c) acima)", () => {
    assert.match(src, /\{\s*studioMode:\s*true\s*\}/, "dashboard-clarice.ts deve passar studioMode:true pro render");
  });

  it("COUPONS_TAB_ENABLED é 'true' (não mais undefined) — sem isso, getCouponUsage nunca serviria o KV real", () => {
    assert.match(src, /COUPONS_TAB_ENABLED:\s*"true"/);
  });

  it("usa createRemoteKvNamespace (adaptador real) em vez de sempre MemoryKv puro", () => {
    assert.match(src, /createRemoteKvNamespace\(/);
  });
});

describe("dashboard-clarice.ts — buildEnv() runtime: escolha KV real vs. fallback fail-soft (#4165/#4173)", () => {
  const savedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const savedToken = process.env.CLOUDFLARE_WORKERS_TOKEN;

  function restore(): void {
    if (savedAccount) process.env.CLOUDFLARE_ACCOUNT_ID = savedAccount;
    else delete process.env.CLOUDFLARE_ACCOUNT_ID;
    if (savedToken) process.env.CLOUDFLARE_WORKERS_TOKEN = savedToken;
    else delete process.env.CLOUDFLARE_WORKERS_TOKEN;
  }

  it("com CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN no env → STATS_CACHE é um RemoteKvNamespace", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-acc";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "test-tok";
    try {
      const env = _buildEnvForTest();
      assert.ok(env.STATS_CACHE instanceof RemoteKvNamespace, "deve usar o adaptador de KV real quando há credenciais");
    } finally {
      restore();
    }
  });

  it("sem credenciais Cloudflare no env → STATS_CACHE NÃO é RemoteKvNamespace (fail-soft: cai pro MemoryKv)", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      const env = _buildEnvForTest();
      assert.ok(
        !(env.STATS_CACHE instanceof RemoteKvNamespace),
        "sem credenciais, buildEnv() nunca deve tentar o adaptador real — degrada pro MemoryKv",
      );
      // MemoryKv não lança e nunca depende de rede — smoke test do fallback.
      assert.doesNotReject(async () => env.STATS_CACHE.get("qualquer-chave", "json"));
    } finally {
      restore();
    }
  });

  it("COUPONS_TAB_ENABLED é 'true' no objeto Env retornado (não mais undefined)", () => {
    const env = _buildEnvForTest();
    assert.equal(env.COUPONS_TAB_ENABLED, "true");
  });
});
