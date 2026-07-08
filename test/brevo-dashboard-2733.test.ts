/**
 * test/brevo-dashboard-2733.test.ts (#2733)
 *
 * Regressão: durante rate-limit do Brevo, as abas KV-independentes (Cupons,
 * Contatos) NÃO congelam junto com o fallback — devem renderizar FRESCAS do KV.
 *
 * O bug original (#2733): o fallback #2280 servia o HTML inteiro do último render
 * bom (que podia ser pré-deploy, sem a aba de Cupons). Enquanto o Brevo estivesse
 * em rate-limit, dado KV recém-publicado ficava escondido por até 1h.
 *
 * O fix re-renderiza no 429 com campanhas cruas do KV (stale) + `readKvTabs`
 * (fresco). Testamos as peças unitárias que compõem esse caminho:
 *   (a) readKvTabs lê Cupons/Contatos do KV independente do Brevo.
 *   (b) renderDashboardHtml com campanhas STALE ([] ou do cache) + cupons frescos
 *       produz a aba de Cupons.
 *   (c) buildStaleResponse preserva a aba de Cupons + injeta o banner de rate-limit.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readKvTabs,
  renderDashboardHtml,
  buildStaleResponse,
  buildRateLimitFallback,
  normalizeContactsSummary,
  normalizeEngagementCohorts,
  normalizeMvStatus,
  normalizeEiaEngagement,
  renderEngagementCohortsSection,
  renderMvStatusSection,
  renderEiaEngagementSection,
  COUPONS_KV_KEY,
  COHORTS_KV_KEY,
  MV_STATUS_KV_KEY,
  CONTACTS_SUMMARY_KV_KEY,
  EIA_ENGAGEMENT_KV_KEY,
  LASTGOOD_CAMPAIGNS_KEY,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

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

const syntheticContacts: ContactsSummary = {
  generated_at: "2026-06-30T23:00:00.000Z",
  total: 100,
  brevo: { synced_rows: 40, has_signal: true },
  eligibility: { eligible: 95, ineligible: 5, by_reason: { mv_rejected: 5 } },
  priority_points: { lt0: 3, eq0: 90, p1_40: 6, p41_80: 1, gt80: 0, optin: 0 },
  mv: { verified: 40, none: 60 },
  engagement: { with_opens: 12, with_clicks: 3 },
};

// KV mock que honra `.get(key, "json")` → objeto parseado; `.get(key)` → string.
function makeKv(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (val == null) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("#2733 — abas KV não congelam no rate-limit do Brevo", () => {
  it("readKvTabs lê as 5 seções KV (Cupons/Contatos/coortes/MV/É IA?) independente do Brevo", async () => {
    const kv = makeKv({
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
      // #3077: precisa do shape mínimo (universe/groups) — os normalizadores
      // dedicados agora rejeitam payload sem o campo mínimo, então um fixture
      // `{ marker: ... }` puro passaria a normalizar pra null (quebrando este
      // teste, que só quer verificar que o dado VEM do KV).
      [COHORTS_KV_KEY]: JSON.stringify({ marker: "cohorts-fixture", universe: 10, opened2plus: 3, opened1: 2, received1_opened0: 1, received2_opened0: 1, exits: 3, exitsBreakdown: { bounced: 1, optedOut: 2 } }),
      [MV_STATUS_KV_KEY]: JSON.stringify({ marker: "mv-fixture", groups: [{ group: "t01-assinantes-ativos", cycle: "2606-07", status: "pending", verifiedAt: null, verified: 0, rejected: 0, unknown: 0 }] }),
      [EIA_ENGAGEMENT_KV_KEY]: JSON.stringify({ editions: [{ edition: "260418", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A" }], updated_at: "2026-07-01T09:00:00.000Z" }),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { couponUsage, contactsSummary, cohorts, mvStatus, eiaEngagement } = await readKvTabs(env as any, "cached");
    assert.notEqual(couponUsage, null, "Cupons deve vir do KV");
    assert.deepEqual(couponUsage, syntheticCoupons);
    assert.notEqual(contactsSummary, null, "Contatos deve vir do KV");
    assert.equal(contactsSummary?.total, 100);
    assert.notEqual(cohorts, null, "coortes devem vir do KV");
    assert.notEqual(mvStatus, null, "status MV deve vir do KV");
    assert.notEqual(eiaEngagement, null, "engajamento do É IA? deve vir do KV (#2738)");
    assert.equal(eiaEngagement?.editions[0]?.edition, "260418");
  });

  it("readKvTabs retorna null para seções ausentes no KV (sem crashar)", async () => {
    const kv = makeKv({ [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons) });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { cohorts, mvStatus, contactsSummary, eiaEngagement } = await readKvTabs(env as any, "cached");
    assert.equal(cohorts, null);
    assert.equal(mvStatus, null);
    assert.equal(contactsSummary, null);
    assert.equal(eiaEngagement, null, "#2738: também deve degradar pra null sem quebrar");
  });

  it("readKvTabs normaliza contactsSummary NO BOUNDARY antes de devolver (#2875 item 1)", async () => {
    // Payload malformado: cohort_stats com linha sem `contacts`/`opened` (KV
    // parcial/antigo), subobjetos `brevo`/`priority_points` ausentes.
    const malformed = {
      total: 50,
      cohort_stats: {
        "assinantes-ativos": { received: 10, unsub_bounce: 3 }, // legado + campos ausentes
      },
    };
    const kv = makeKv({ [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(malformed) });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contactsSummary } = await readKvTabs(env as any, "cached");
    assert.notEqual(contactsSummary, null, "total válido → não degrada pra null");
    assert.equal(contactsSummary?.total, 50);
    assert.deepEqual(contactsSummary?.brevo, { synced_rows: 0, has_signal: false }, "subobjeto ausente → default");
    const row = contactsSummary?.cohort_stats?.["assinantes-ativos"];
    assert.ok(row, "linha do cohort presente e normalizada");
    assert.equal(row?.received, 10, "campo presente preservado");
    assert.equal(row?.contacts, 0, "campo ausente → 0, não undefined (não pode lançar no render)");
    assert.equal(row?.unsub, 3, "legado unsub_bounce vira unsub quando unsub ausente");
  });

  it("render com campanhas STALE vazias + cupons frescos → aba de Cupons presente", () => {
    // Simula o caminho do catch: staleCampaigns=[] (cache miss) mas cupons do KV.
    const html = renderDashboardHtml([], [], null, null, syntheticContacts, syntheticCoupons);
    assert.ok(html.includes("tablabel-cupons"), "label da aba Cupons presente mesmo sem campanhas");
    assert.ok(html.includes("panel-cupons"), "painel de Cupons presente");
    assert.ok(html.includes("panel-contatos"), "painel de Contatos presente");
    assert.ok(html.includes("test1@example.com"), "dado de cupom renderizado");
  });

  it("buildStaleResponse preserva a aba de Cupons + injeta banner de rate-limit", async () => {
    const html = renderDashboardHtml([], [], null, null, syntheticContacts, syntheticCoupons);
    const resp = buildStaleResponse(html, 120);
    assert.strictEqual(resp.status, 200, "fallback é 200, não 503");
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "rate-limit");
    const body = await resp.text();
    assert.ok(body.includes("tablabel-cupons"), "aba Cupons sobrevive ao fallback de rate-limit");
    assert.ok(body.includes("panel-contatos"), "aba Contatos sobrevive ao fallback");
    assert.ok(body.includes("rate-limit"), "banner de rate-limit injetado");
    assert.ok(body.includes("Cupons e Contatos estão atualizados"), "banner deixa claro que KV está fresco");
  });

  it("cache de campanhas cruas (LASTGOOD_CAMPAIGNS_KEY) tem o shape { campaigns, scheduled }", async () => {
    // Documenta/verifica o contrato lido pelo catch: as campanhas stale vêm desse
    // envelope. Sem cache → catch usa [] (coberto pelo teste de render acima).
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: [{ id: 1 }], scheduled: [{ id: 2 }] }),
    });
    const raw = (await kv.get(LASTGOOD_CAMPAIGNS_KEY, "json")) as {
      campaigns?: unknown[];
      scheduled?: unknown[];
    };
    assert.ok(Array.isArray(raw.campaigns) && raw.campaigns.length === 1, "campaigns no envelope");
    assert.ok(Array.isArray(raw.scheduled) && raw.scheduled.length === 1, "scheduled no envelope");
  });

  it("COUPONS_TAB_ENABLED != true → readKvTabs não expõe cupons (PII gate mantido)", async () => {
    const kv = makeKv({ [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons) });
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { couponUsage } = await readKvTabs(env as any, "cached");
    assert.equal(couponUsage, null, "flag OFF → cupons null mesmo com KV populado");
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitFallback — o CAMINHO que tinha o bug (#2733 + #633).
// Exercita a lógica real do catch de 429: lê campanhas stale + readKvTabs FRESCO
// + render + banner, com guardas de shape e throw-safety. Se alguém reverter o
// fallback pra servir HTML congelado, estes testes falham.
// ---------------------------------------------------------------------------

describe("buildRateLimitFallback (#2733 — fallback de 429 não congela abas KV)", () => {
  it("serve Cupons FRESCOS do KV + banner de rate-limit (o fix do #2733)", async () => {
    // Cache de campanhas ausente → staleCampaigns=[]; cupons vêm do KV FRESCO.
    const kv = makeKv({
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 120);
    assert.strictEqual(resp.status, 200, "fallback é 200 (stale), não 503");
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "rate-limit");
    const body = await resp.text();
    assert.ok(body.includes("tablabel-cupons"), "aba Cupons FRESCA sobrevive ao 429");
    assert.ok(body.includes("test1@example.com"), "dado de cupom do KV renderizado");
    assert.ok(body.includes("panel-contatos"), "aba Contatos presente");
    assert.ok(body.includes("rate-limit"), "banner de rate-limit injetado");
  });

  it("planCreditsOverride numérico → denominador mostrado, nunca 'indisponível' nem kv-only (regressão: campanhas 429 antes de popular o KV de créditos)", async () => {
    // KV SEM brevo:plan-credits (o bug: nunca era populado — o fetch que o populava
    // rodava DEPOIS das campanhas e o 429 o pulava). Agora o render principal busca
    // /v3/account ANTES das campanhas e passa o valor em memória aqui.
    const kv = makeKv({
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    await withFetchSpy(async (externalCalls) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await buildRateLimitFallback(env as any, 120, 34708);
      const body = await resp.text();
      assert.ok(body.includes("34.708"), "usa o override numérico como denominador do plano");
      assert.ok(
        !body.includes("créditos do plano Brevo indisponíveis"),
        "NÃO degrada pra 'indisponível' quando o override existe",
      );
      assert.deepEqual(externalCalls, [], "override em memória → zero fetch (nem o kv-only de créditos)");
    });
  });

  it("KV miss de cupons + STRIPE_API_KEY configurada → ZERO chamada externa (#2779)", async () => {
    // Regressão #2779: o fallback de rate-limit é desenhado pra não depender de
    // NENHUMA chamada externa — mas um KV miss em `coupons:usage` com
    // STRIPE_API_KEY setada caía no fetchCouponUsage ao vivo (isFresh=false não
    // cobria o miss). Cenário real: 429 do Brevo + TTL de 300s dos cupons
    // expirado no mesmo instante (cold start / primeiro deploy).
    const kv = makeKv({
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
      // sem COUPONS_KV_KEY → miss
    });
    const env = { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: "sk_test_synthetic", STATS_CACHE: kv };
    await withFetchSpy(async (externalCalls) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await buildRateLimitFallback(env as any, 120);
      assert.strictEqual(resp.status, 200, "fallback continua servindo o stale 200");
      const body = await resp.text();
      assert.ok(body.includes("panel-contatos"), "abas de KV presentes normalmente");
      assert.deepEqual(externalCalls, [], "o caminho de erro NUNCA faz chamada externa (Stripe incluso)");
    });
  });

  it("STATS_CACHE ausente → 503 amigável (nunca crasha)", async () => {
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 90);
    assert.strictEqual(resp.status, 503, "sem KV → rateLimitResponse 503");
  });

  it("KV corrompido (campaigns não-array) → guard Array.isArray, NUNCA 500/throw", async () => {
    const kv = makeKv({
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
      // valor corrompido: campaigns como string em vez de array
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: "corrompido", scheduled: 0 }),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject(() => buildRateLimitFallback(env as any, 60), "não deve lançar");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 60);
    assert.ok(resp.status === 200 || resp.status === 503, "degrada graciosamente (200 stale ou 503)");
    const body = await resp.text();
    assert.ok(body.includes("tablabel-cupons") || resp.status === 503, "cupons ainda frescos no 200");
  });

  // #3080: o payload stale (LASTGOOD_CAMPAIGNS_KEY) agora carrega `campaignsLimit`
  // self-describing — o fallback de rate-limit deve repassar esse sinal pro render,
  // igual ao caminho saudável ("/"), pra que o aviso de janela parcial não desapareça
  // justamente durante uma janela de rate-limit (quando o editor mais precisa de
  // contexto sobre a confiabilidade do dado).
  it("#3080 payload stale com campaignsLimit === campaigns.length → aviso de janela parcial sobrevive ao fallback de 429", async () => {
    const staleCampaign = {
      id: 1,
      name: "Clarice News 2605 d01-A (qua)",
      subject: "Assunto",
      status: "sent",
      sentDate: "2026-06-10T09:00:00Z",
      scheduledAt: null,
      createdAt: "2026-06-10T09:00:00Z",
      recipients: { lists: [] as number[] },
      statistics: {
        globalStats: {
          sent: 100, delivered: 98, hardBounces: 1, softBounces: 1,
          uniqueViews: 25, viewed: 30, trackableViews: 18,
          uniqueClicks: 3, clickers: 3, unsubscriptions: 0, complaints: 0,
          appleMppOpens: 5,
        },
      },
    };
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({
        campaigns: [staleCampaign],
        scheduled: [],
        generatedAt: "2026-06-10T10:00:00.000Z",
        campaignsLimit: 1, // janela "pedida" era 1 — bateu o length ⇒ cheia
      }),
    });
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 60);
    assert.strictEqual(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /\(parcial — janela de 1 campanhas?\)/, "aviso de janela parcial deve sobreviver ao fallback de rate-limit");
  });
});

describe("normalizeContactsSummary (#2875 item 1 — validação única no boundary do KV)", () => {
  it("raw não-objeto (null/string/number) → null", () => {
    assert.equal(normalizeContactsSummary(null), null);
    assert.equal(normalizeContactsSummary(undefined), null);
    assert.equal(normalizeContactsSummary("garbage"), null);
    assert.equal(normalizeContactsSummary(42), null);
  });

  it("total ausente/não-number → null (mesmo critério que os renders usavam antes)", () => {
    assert.equal(normalizeContactsSummary({}), null);
    assert.equal(normalizeContactsSummary({ total: "100" }), null);
  });

  it("total=0 (store legitimamente vazio) NÃO é tratado como ausência de dado", () => {
    const s = normalizeContactsSummary({ total: 0 });
    assert.notEqual(s, null);
    assert.equal(s?.total, 0);
  });

  it("payload bem-formado passa por praticamente inalterado", () => {
    const s = normalizeContactsSummary(syntheticContacts);
    assert.deepEqual(s, syntheticContacts);
  });

  it("subobjetos ausentes (brevo/eligibility/priority_points/engagement) → defaults, sem lançar", () => {
    const s = normalizeContactsSummary({ total: 10 });
    assert.deepEqual(s?.brevo, { synced_rows: 0, has_signal: false });
    assert.deepEqual(s?.eligibility, { eligible: 0, ineligible: 0, by_reason: {} });
    assert.deepEqual(s?.priority_points, { lt0: 0, eq0: 0, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 });
    assert.deepEqual(s?.engagement, { with_opens: 0, with_clicks: 0 });
    assert.deepEqual(s?.mv, {});
  });

  // #3081 (review): normalizeContactsSummary reconstruía `priority_points`
  // como literal fixo de 6 chaves e descartava `internal_excluded` do KV cru
  // — o campo nunca chegava ao render em produção (só o passthrough direto
  // via renderContactsSummarySection, sem passar pelo normalizador, era
  // testado). Cobertura pelo boundary real.
  it("priority_points.internal_excluded ausente → chave OMITIDA em priority_points (#3081)", () => {
    const s = normalizeContactsSummary({ total: 10, priority_points: { lt0: 1, eq0: 9, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 } });
    assert.ok(s);
    assert.equal(Object.prototype.hasOwnProperty.call(s!.priority_points, "internal_excluded"), false);
  });

  it("priority_points.internal_excluded presente no KV cru → passthrough até o payload normalizado (#3081)", () => {
    const s = normalizeContactsSummary({
      total: 10,
      priority_points: { lt0: 1, eq0: 9, p1_40: 0, p41_80: 0, gt80: 0, optin: 0, internal_excluded: 4 },
    });
    assert.equal(s?.priority_points.internal_excluded, 4);
  });

  it("histogramas opcionais ausentes → chave OMITIDA (não `undefined` explícito) — schema evolution, não corrupção", () => {
    const s = normalizeContactsSummary({ total: 10 });
    assert.ok(s);
    assert.equal(Object.prototype.hasOwnProperty.call(s, "priority_points_histogram"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(s, "cohort_stats"), false);
  });

  it("histogramas opcionais presentes → passthrough", () => {
    const s = normalizeContactsSummary({
      total: 10,
      priority_points_histogram: { "40": 3 },
      priority_points_histogram_verified: { "40": 1 },
    });
    assert.deepEqual(s?.priority_points_histogram, { "40": 3 });
    assert.deepEqual(s?.priority_points_histogram_verified, { "40": 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(s, "priority_points_histogram_brevo"), false);
  });

  it("cohort_stats com linha corrompida (não-objeto) → linha descartada, resto do payload sobrevive", () => {
    const s = normalizeContactsSummary({
      total: 10,
      cohort_stats: {
        "assinantes-ativos": { contacts: 5, received: 3, opened: 1, clicked: 0, unsub: 0, hard_bounce: 0, mv_verified: 1, brevo: 2, eligible: 5, sends_sum: 3 },
        corrompido: "não é um objeto",
      },
    });
    assert.ok(s?.cohort_stats?.["assinantes-ativos"]);
    assert.equal(s?.cohort_stats?.["assinantes-ativos"]?.contacts, 5);
    assert.equal(s?.cohort_stats?.["corrompido"], undefined, "linha corrompida descartada, não propagada");
  });

  it("cohort_stats: unsub presente tem PRIORIDADE sobre o legado unsub_bounce", () => {
    const s = normalizeContactsSummary({
      total: 10,
      cohort_stats: {
        x: { unsub: 5, unsub_bounce: 99 },
      },
    });
    assert.equal(s?.cohort_stats?.x?.unsub, 5, "unsub explícito vence o par legado");
  });

  it("generated_at ausente/malformado → string vazia, nunca undefined/throw", () => {
    const s1 = normalizeContactsSummary({ total: 10 });
    assert.equal(s1?.generated_at, "");
    const s2 = normalizeContactsSummary({ total: 10, generated_at: 12345 });
    assert.equal(s2?.generated_at, "");
  });

  // #2919: fmtCount perdeu o `?? 0` no #2907 na premissa de que este
  // normalizador já garante todo número definido — mas antes do fix ele só
  // validava que `by_reason`/`mv`/histogramas ERAM objetos, não que os
  // VALORES internos eram numbers finitos. Um KV parcial/legado com um valor
  // `null`/string/NaN interno passava direto e quebrava o render
  // (`n.toLocaleString()` em `null` → TypeError → 502 no dashboard inteiro).
  it("valores internos malformados (null/string/NaN) em mv/by_reason/histogramas → sanitizados pra 0, nunca propagados crus", () => {
    const s = normalizeContactsSummary({
      total: 10,
      eligibility: { eligible: 5, ineligible: 5, by_reason: { paywall: null, spam: "3", bounced: 2, weird: NaN } },
      mv: { ok: 120, invalid: null, catch_all: "5" },
      priority_points_histogram: { "40": 3, "80": null },
      priority_points_histogram_verified: { "40": undefined },
      priority_points_histogram_eligible: { "40": Infinity },
      priority_points_histogram_brevo: { "40": -Infinity },
    });
    assert.ok(s);
    assert.deepEqual(s?.eligibility.by_reason, { paywall: 0, spam: 0, bounced: 2, weird: 0 });
    assert.deepEqual(s?.mv, { ok: 120, invalid: 0, catch_all: 0 });
    assert.deepEqual(s?.priority_points_histogram, { "40": 3, "80": 0 });
    assert.deepEqual(s?.priority_points_histogram_verified, { "40": 0 });
    assert.deepEqual(s?.priority_points_histogram_eligible, { "40": 0 });
    assert.deepEqual(s?.priority_points_histogram_brevo, { "40": 0 });
    // Todo valor sobrevivente é finito — nunca lança em `.toLocaleString()`.
    for (const v of Object.values(s?.mv ?? {})) assert.equal(Number.isFinite(v), true);
    for (const v of Object.values(s?.eligibility.by_reason ?? {})) assert.equal(Number.isFinite(v), true);
  });
});

// ---------------------------------------------------------------------------
// #3077: a normalização anti-502 do #2919/#2875 cobria só `contacts:summary`.
// As outras 3 chaves de KV (`cohorts:engagement`, `mv:status`, `eia:engagement`)
// eram castadas sem validação em readKvTabs — payload parcial/corrompido
// chegava direto nos renders, que acessam `.toLocaleString`/`.length`/`.filter`
// sem guard. Cada bloco abaixo cobre: (a) o cenário real que quebraria o
// acesso downstream específico, com o RENDER de fato chamado (não só o
// normalizador isoladamente) pra provar que nunca lança; (b) payload válido
// continuando a passar normalmente (não regredir o caminho feliz).
// ---------------------------------------------------------------------------

describe("normalizeEngagementCohorts (#3077 — cohorts:engagement)", () => {
  it("raw não-objeto (null/string/number) → null", () => {
    assert.equal(normalizeEngagementCohorts(null), null);
    assert.equal(normalizeEngagementCohorts(undefined), null);
    assert.equal(normalizeEngagementCohorts("garbage"), null);
    assert.equal(normalizeEngagementCohorts(42), null);
  });

  it("payload {} (universe ausente) → null, e o RENDER cai no stub gracioso sem lançar", () => {
    assert.equal(normalizeEngagementCohorts({}), null);
    // Antes do #3077: `cohorts.universe.toLocaleString` num objeto sem
    // `universe` lançava TypeError → 502. Agora normalizeEngagementCohorts({})
    // já é null, e o render recebe null (nunca o payload cru).
    const html = renderEngagementCohortsSection(normalizeEngagementCohorts({}));
    assert.ok(html.includes("Dados ainda não gerados"), "stub gracioso, não throw");
  });

  it("universe presente mas exitsBreakdown ausente → normaliza pra {bounced:0,optedOut:0}, render não lança", () => {
    // Cenário real que quebraria `cohorts.exitsBreakdown.bounced.toLocaleString`
    // (sections-kv.ts:566) se o payload cru fosse repassado direto.
    const s = normalizeEngagementCohorts({ universe: 10, opened2plus: 4, exits: 2 });
    assert.ok(s);
    assert.deepEqual(s?.exitsBreakdown, { bounced: 0, optedOut: 0 });
    const html = renderEngagementCohortsSection(s);
    assert.ok(html.includes("Coortes de engajamento"));
    assert.ok(!html.includes("Dados ainda não gerados"), "payload minimamente válido → seção real, não stub");
  });

  it("valores internos malformados (null/string/NaN) → sanitizados pra 0, nunca propagados crus", () => {
    const s = normalizeEngagementCohorts({
      universe: 100,
      opened2plus: null,
      opened1: "30",
      received1_opened0: NaN,
      received2_opened0: 10,
      exits: 5,
      exitsBreakdown: { bounced: "3", optedOut: undefined },
      maxReceived: Infinity,
    });
    assert.ok(s);
    assert.equal(s?.opened2plus, 0);
    assert.equal(s?.opened1, 0);
    assert.equal(s?.received1_opened0, 0);
    assert.equal(s?.received2_opened0, 10);
    assert.deepEqual(s?.exitsBreakdown, { bounced: 0, optedOut: 0 });
    assert.equal(s?.maxReceived, 0);
    // Não lança ao renderizar.
    assert.doesNotThrow(() => renderEngagementCohortsSection(s));
  });

  it("payload bem-formado passa por praticamente inalterado (caminho feliz preservado)", () => {
    const raw = {
      generatedAt: "2026-07-01T00:00:00.000Z",
      universe: 100,
      opened2plus: 40,
      opened1: 30,
      received1_opened0: 15,
      received2_opened0: 10,
      exits: 5,
      exitsBreakdown: { bounced: 3, optedOut: 2 },
      maxReceived: 12,
    };
    const s = normalizeEngagementCohorts(raw);
    assert.deepEqual(s, raw);
    const html = renderEngagementCohortsSection(s);
    assert.ok(html.includes("100"), "universo renderizado");
  });
});

describe("normalizeMvStatus (#3077 — mv:status)", () => {
  it("raw não-objeto (null/string/number) → null", () => {
    assert.equal(normalizeMvStatus(null), null);
    assert.equal(normalizeMvStatus(undefined), null);
    assert.equal(normalizeMvStatus("garbage"), null);
    assert.equal(normalizeMvStatus(42), null);
  });

  it("payload {} (groups ausente) → null, render cai no stub sem lançar", () => {
    // Antes do #3077: `mvStatus.groups.length` num objeto sem `groups` lançava
    // TypeError → 502.
    assert.equal(normalizeMvStatus({}), null);
    const html = renderMvStatusSection(normalizeMvStatus({}));
    assert.ok(html.includes("Dados ainda não gerados"), "stub gracioso, não throw");
  });

  it("groups não-array (corrompido) → null, nunca propagado cru", () => {
    assert.equal(normalizeMvStatus({ groups: "corrompido" }), null);
    assert.equal(normalizeMvStatus({ groups: { foo: "bar" } }), null);
  });

  it("grupo malformado dentro do array → descartado; grupo válido sobrevive; render não lança", () => {
    const s = normalizeMvStatus({
      groups: [
        "não é um objeto",
        null,
        { group: "t02-ex-assinantes", cycle: "2606-07", status: "bogus-status", verifiedAt: 12345, verified: "40", rejected: null, unknown: NaN },
      ],
    });
    assert.ok(s);
    assert.equal(s?.groups.length, 1, "entradas não-objeto descartadas");
    assert.equal(s?.groups[0]?.status, "pending", "status inválido degrada pro default seguro");
    assert.equal(s?.groups[0]?.verifiedAt, null, "verifiedAt não-string vira null");
    assert.equal(s?.groups[0]?.verified, 0);
    assert.equal(s?.groups[0]?.rejected, 0);
    assert.equal(s?.groups[0]?.unknown, 0);
    assert.doesNotThrow(() => renderMvStatusSection(s));
  });

  it("payload bem-formado passa por praticamente inalterado (caminho feliz preservado)", () => {
    const raw = {
      generatedAt: "2026-07-01T00:00:00.000Z",
      groups: [
        { group: "t01-assinantes-ativos", cycle: "2606-07", status: "t01" as const, verifiedAt: null, verified: 0, rejected: 0, unknown: 0 },
        { group: "t02-ex-assinantes", cycle: "2606-07", status: "verified" as const, verifiedAt: "2026-06-30T00:00:00.000Z", verified: 40, rejected: 5, unknown: 1 },
      ],
    };
    const s = normalizeMvStatus(raw);
    assert.deepEqual(s, raw);
    const html = renderMvStatusSection(s);
    assert.ok(html.includes("t02-ex-assinantes"), "grupo renderizado");
    assert.ok(!html.includes("Dados ainda não gerados"));
  });
});

describe("normalizeEiaEngagement (#3077 — eia:engagement)", () => {
  it("raw não-objeto (null/string/number) → null", () => {
    assert.equal(normalizeEiaEngagement(null), null);
    assert.equal(normalizeEiaEngagement(undefined), null);
    assert.equal(normalizeEiaEngagement("garbage"), null);
    assert.equal(normalizeEiaEngagement(42), null);
  });

  it("payload {} (editions ausente) → null, render cai no stub sem lançar", () => {
    // Antes do #3077: `eiaEngagement.editions.length`/`.filter(...)` num objeto
    // sem `editions` lançava TypeError → 502.
    assert.equal(normalizeEiaEngagement({}), null);
    const html = renderEiaEngagementSection(normalizeEiaEngagement({}));
    assert.ok(html.includes("Dados ainda não gerados"), "stub gracioso, não throw");
  });

  it("editions não-array (corrompido) → null, nunca propagado cru", () => {
    assert.equal(normalizeEiaEngagement({ editions: "corrompido" }), null);
    assert.equal(normalizeEiaEngagement({ editions: { foo: "bar" } }), null);
  });

  it("entrada sem `edition` (string) é descartada; entrada válida sobrevive; render não lança", () => {
    const s = normalizeEiaEngagement({
      editions: [
        { total_votes: 10 }, // sem `edition` — descartada (quebraria o regex .test() no render)
        null,
        { edition: "260418", total_votes: "5", voted_a: null, voted_b: 3, pct_correct: "80", correct_choice: 42 },
      ],
    });
    assert.ok(s);
    assert.equal(s?.editions.length, 1, "entrada sem edition descartada");
    assert.equal(s?.editions[0]?.edition, "260418");
    assert.equal(s?.editions[0]?.total_votes, 0, "string não-number → 0");
    assert.equal(s?.editions[0]?.voted_a, 0);
    assert.equal(s?.editions[0]?.voted_b, 3);
    assert.equal(s?.editions[0]?.pct_correct, null, "string não-number → null (não 0 — é uma taxa, não contagem)");
    assert.equal(s?.editions[0]?.correct_choice, null, "number onde esperava string → null");
    assert.doesNotThrow(() => renderEiaEngagementSection(s));
  });

  it("payload bem-formado passa por praticamente inalterado (caminho feliz preservado)", () => {
    const raw = {
      editions: [
        { edition: "260418", total_votes: 10, voted_a: 6, voted_b: 4, pct_correct: 60, correct_choice: "A" },
      ],
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    const s = normalizeEiaEngagement(raw);
    assert.deepEqual(s, raw);
    const html = renderEiaEngagementSection(s);
    assert.ok(html.includes("260418"), "edição renderizada");
    assert.ok(!html.includes("Dados ainda não gerados"));
  });
});
