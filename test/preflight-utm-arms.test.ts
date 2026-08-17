/**
 * preflight-utm-arms.test.ts (#5545)
 *
 * Cobre a fonte única dos 3 braços do preflight de UTM — build de e-mail
 * plus-addressed, build de URL, e o plano combinado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PREFLIGHT_UTM_ARMS,
  buildPreflightEmail,
  buildPreflightUrl,
  buildPreflightPlan,
  DEFAULT_PREFLIGHT_BASE_EMAIL,
  DEFAULT_HOME_URL,
} from "../scripts/lib/preflight-utm-arms.ts";

describe("PREFLIGHT_UTM_ARMS (#5545)", () => {
  it("tem exatamente os 3 braços descritos na #5522", () => {
    assert.equal(PREFLIGHT_UTM_ARMS.length, 3);
    const keys = PREFLIGHT_UTM_ARMS.map((a) => a.key);
    assert.deepEqual(keys, ["google-ads", "microsoft-ads", "meta-ads"]);
  });

  it("google-ads e microsoft-ads usam utm_medium=cpc; meta-ads usa paid_social", () => {
    const bySource = Object.fromEntries(PREFLIGHT_UTM_ARMS.map((a) => [a.key, a]));
    assert.equal(bySource["google-ads"].utm_medium, "cpc");
    assert.equal(bySource["microsoft-ads"].utm_medium, "cpc");
    assert.equal(bySource["meta-ads"].utm_medium, "paid_social");
  });
});

describe("buildPreflightEmail (#5545)", () => {
  it("monta plus-addressing com prefixo test-preflight (bate com TEST_ACCOUNT_PATTERNS)", () => {
    const email = buildPreflightEmail("google-ads", "preflight-2608");
    assert.equal(email, "vjpixel+test-preflight-google-ads-preflight-2608@gmail.com");
  });

  it("respeita baseEmail customizado", () => {
    const email = buildPreflightEmail("meta-ads", "c1", "outro@exemplo.com");
    assert.equal(email, "outro+test-preflight-meta-ads-c1@exemplo.com");
  });

  it("lança se baseEmail não tem @", () => {
    assert.throws(() => buildPreflightEmail("google-ads", "c1", "sem-arroba"));
  });

  it("emails de braços diferentes na mesma campanha nunca colidem", () => {
    const emails = PREFLIGHT_UTM_ARMS.map((a) => buildPreflightEmail(a.key, "c1"));
    assert.equal(new Set(emails).size, 3);
  });
});

describe("buildPreflightUrl (#5545)", () => {
  it("monta a URL da home (não /subscribe) com os 3 params UTM", () => {
    const arm = PREFLIGHT_UTM_ARMS[0];
    const url = buildPreflightUrl(arm, "preflight-2608");
    assert.equal(
      url,
      "https://diar.ia.br/?utm_source=google-ads&utm_medium=cpc&utm_campaign=preflight-2608",
    );
  });

  it("respeita homeUrl customizada", () => {
    const arm = PREFLIGHT_UTM_ARMS[2];
    const url = buildPreflightUrl(arm, "c1", "https://staging.example.com/");
    assert.match(url, /^https:\/\/staging\.example\.com\/\?/);
    assert.match(url, /utm_source=meta-ads/);
    assert.match(url, /utm_medium=paid_social/);
  });
});

describe("buildPreflightPlan (#5545)", () => {
  it("monta 1 entrada por braço, cada uma com url + email consistentes", () => {
    const plans = buildPreflightPlan("preflight-2608");
    assert.equal(plans.length, 3);
    for (const p of plans) {
      assert.equal(p.email, buildPreflightEmail(p.arm.key, "preflight-2608"));
      assert.equal(p.url, buildPreflightUrl(p.arm, "preflight-2608"));
    }
  });

  it("usa os defaults documentados quando baseEmail/homeUrl omitidos", () => {
    const [plan] = buildPreflightPlan("c1");
    assert.match(plan.email, new RegExp(`^${DEFAULT_PREFLIGHT_BASE_EMAIL.split("@")[0]}\\+`));
    assert.ok(plan.url.startsWith(DEFAULT_HOME_URL));
  });
});
