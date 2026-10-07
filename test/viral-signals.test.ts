/**
 * #8672 — sinais crus de viralização usados só pela calibração
 * (o bônus foi descartado em 07/10/2026; ver docs/viral-score-calibration.md).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractViralSignals,
  mentionsUrl,
  urlKey,
  viralGuard,
  VIRAL_MIN_BASE_SCORE,
  VIRAL_SIGNAL_NAMES,
} from "../scripts/lib/viral-signals.ts";
import { NON_CALIBRATABLE_FEATURES } from "../scripts/lib/scoring-features.ts";

const NOW = "2026-09-21T18:00:00Z";
const ctx = { newsletterBodies: [] as string[], now: NOW };

describe("extractViralSignals", () => {
  it("atores, ganchos e recência", () => {
    const s = extractViralSignals(
      { url: "https://news.example.com/a", title: "Trump says OpenAI hack breached agency", published_at: "2026-09-21T10:00:00Z" },
      ctx,
    );
    assert.equal(s.people_gov, true);
    assert.equal(s.big_company, true);
    assert.equal(s.conflict_harm, true);
    assert.equal(s.recent_36h, true);
  });

  it("política/geopolítica casa com inicial maiúscula; UN só em maiúsculas", () => {
    assert.equal(extractViralSignals({ url: "u", title: "China Warns On Regulation" }, ctx).policy_geo, true);
    assert.equal(extractViralSignals({ url: "u", title: "UN panel" }, ctx).policy_geo, true);
    assert.equal(extractViralSignals({ url: "u", title: "un panel neutro" }, ctx).policy_geo, false);
  });

  it("falsos positivos lexicais em PT: meta/processo/lei genéricos não casam", () => {
    const s = extractViralSignals({ url: "u", title: "Bater a meta com o processo seletivo e a lei do menor esforço" }, ctx);
    assert.equal(s.big_company, false);
    assert.equal(s.conflict_harm, false);
    assert.equal(s.policy_geo, false);
    const t = extractViralSignals({ url: "u", title: "Meta é processada; projeto de lei avança" }, ctx);
    assert.equal(t.big_company, true);
    assert.equal(t.conflict_harm, true);
    assert.equal(t.policy_geo, true);
  });

  it("cobertura cruzada conta newsletters que citam a URL, sem a de origem", () => {
    assert.equal(urlKey("https://www.site.com/p/x/?utm=1#y"), "www.site.com/p/x");
    const nl = { newsletterBodies: ["... www.site.com/p/x ...", "https://www.site.com/p/x", "outra"], now: NOW };
    const a = { url: "https://www.site.com/p/x?utm=1", title: "neutro" };
    assert.equal(extractViralSignals(a, nl).newsletter_mentions, 2);
    assert.equal(extractViralSignals({ ...a, from_newsletter: true }, nl).newsletter_mentions, 1);
  });

  it("nenhum sinal viral é feature não-calibrável do feature store", () => {
    for (const k of VIRAL_SIGNAL_NAMES) assert.ok(!NON_CALIBRATABLE_FEATURES.has(k as never), k);
  });
});

describe("mentionsUrl", () => {
  it("não casa por prefixo de outra URL", () => {
    assert.ok(mentionsUrl("veja https://site.com/p/x hoje", "site.com/p/x"));
    assert.ok(mentionsUrl("(https://site.com/p/x/)", "site.com/p/x"));
    assert.ok(mentionsUrl("leia site.com/p/x.", "site.com/p/x"));
    assert.ok(!mentionsUrl("https://site.com/p/xyz", "site.com/p/x"));
    assert.ok(!mentionsUrl("https://site.com/p/x/outra", "site.com/p/x"));
    assert.ok(!mentionsUrl("https://site.com/p/x.html", "site.com/p/x"));
    assert.ok(!mentionsUrl("qualquer", ""));
  });
});

describe("viralGuard", () => {
  const ok = { url: "https://news.example.com/a", score_base: 60 };

  it("rede social, paywall/anti_bot, tutorial/vídeo e piso de score", () => {
    assert.equal(viralGuard(ok), null);
    assert.equal(viralGuard({ ...ok, url: "https://x.com/S1r1u5_/status/1" }), "social_post");
    assert.equal(viralGuard({ ...ok, url: "https://www.linkedin.com/posts/abc" }), "social_post");
    assert.equal(viralGuard({ ...ok, verify_verdict: "paywall" }), "verdict:paywall");
    assert.equal(viralGuard({ ...ok, verify_verdict: "anti_bot" }), "verdict:anti_bot");
    assert.equal(viralGuard({ ...ok, verify_verdict: "accessible" }), null);
    assert.equal(viralGuard({ ...ok, category: "tutorial" }), "category:tutorial");
    assert.equal(viralGuard({ ...ok, category: "video" }), "category:video");
    assert.equal(viralGuard({ ...ok, score_base: VIRAL_MIN_BASE_SCORE - 1 }), "below_min_base");
    assert.equal(viralGuard({ ...ok, score_base: VIRAL_MIN_BASE_SCORE }), null); // fronteira: 40 passa
  });

  it("piso de score é checado por último: guarda de tipo vence com score baixo", () => {
    const low = { ...ok, score_base: 10 };
    assert.equal(viralGuard({ ...low, url: "https://x.com/a/status/1" }), "social_post");
    assert.equal(viralGuard({ ...low, verify_verdict: "paywall" }), "verdict:paywall");
    assert.equal(viralGuard({ ...low, category: "video" }), "category:video");
    assert.equal(viralGuard(low), "below_min_base");
  });
});

describe("recência", () => {
  const at = (published_at: string) => extractViralSignals({ url: "u", published_at }, ctx).recent_36h;
  it("só [0, 36h] conta; futuro, > 36h e data inválida não", () => {
    assert.equal(at("2026-09-21T06:00:00Z"), true); // 12h
    assert.equal(at("2026-09-20T06:00:00Z"), true); // exatamente 36h
    assert.equal(at("2026-09-20T05:59:00Z"), false); // > 36h
    assert.equal(at("2026-09-22T00:00:00Z"), false); // negativa (depois do "agora")
    assert.equal(at("não é data"), false);
    assert.equal(extractViralSignals({ url: "u" }, ctx).recent_36h, false);
  });
});

describe("mentionsUrl — casos de borda", () => {
  it("casa com query string depois da URL e acha a exata depois de um prefixo", () => {
    assert.ok(mentionsUrl("https://site.com/p/x?utm_source=nl", "site.com/p/x"));
    assert.ok(mentionsUrl("https://site.com/p/x#frag", "site.com/p/x"));
    assert.ok(mentionsUrl("veja site.com/p/xyz e também site.com/p/x hoje", "site.com/p/x"));
  });
});
