/**
 * test/google-auth-token-health.test.ts (#1973)
 *
 * Cobre os helpers PUROS do health-check de token OAuth. A `checkTokenHealth`
 * em si depende de `data/.credentials.json` (gitignored, OneDrive — ausente no
 * CI), então testamos suas peças puras: classificação de erro, idade do refresh
 * token, e o banner consolidado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRefreshError,
  classifyRefreshAge,
  renderTokenHealthBanner,
  TESTING_REFRESH_TTL_DAYS,
  type TokenHealth,
} from "../scripts/google-auth.ts";

const DAY = 86_400_000;

describe("classifyRefreshError (#1973)", () => {
  it("invalid_grant → 'invalid_grant'", () => {
    assert.equal(classifyRefreshError("Token refresh falhou (400): invalid_grant"), "invalid_grant");
    assert.equal(classifyRefreshError("...Invalid_Grant..."), "invalid_grant");
  });
  it("outros erros → 'error' (transiente, não pede re-auth)", () => {
    assert.equal(classifyRefreshError("Token refresh falhou (503): backend error"), "error");
    assert.equal(classifyRefreshError("network timeout"), "error");
  });
});

describe("classifyRefreshAge (#1973)", () => {
  const now = 10 * DAY;
  it("sem obtainedMs → sem idade, nearLimit false (creds legadas)", () => {
    assert.deepEqual(classifyRefreshAge(undefined, now), { nearLimit: false });
  });
  it("refresh novo (1d) → não perto do limite", () => {
    const r = classifyRefreshAge(now - 1 * DAY, now);
    assert.equal(Math.round(r.ageDays!), 1);
    assert.equal(r.nearLimit, false);
  });
  it("refresh com 6d (limite 7d − 1.5 = 5.5) → nearLimit true", () => {
    const r = classifyRefreshAge(now - 6 * DAY, now);
    assert.equal(r.nearLimit, true);
  });
  it("exatamente no threshold 5.5d → nearLimit true", () => {
    const r = classifyRefreshAge(now - 5.5 * DAY, now);
    assert.equal(r.nearLimit, true);
  });
  it("5d (< 5.5) → nearLimit false", () => {
    assert.equal(classifyRefreshAge(now - 5 * DAY, now).nearLimit, false);
  });
});

describe("renderTokenHealthBanner (#1973)", () => {
  const base = (o: Partial<TokenHealth>): TokenHealth => ({ ok: false, status: "error", detail: "x", ...o });
  it("valid → banner vazio (não polui o Stage 0)", () => {
    assert.equal(renderTokenHealthBanner(base({ ok: true, status: "valid" })), "");
  });
  it("invalid_grant → banner com os 3 sistemas afetados + ação", () => {
    const b = renderTokenHealthBanner(base({ status: "invalid_grant", detail: "token expirado" }));
    assert.match(b, /EXPIRADO\/INVÁLIDO/);
    assert.match(b, /Drive sync · inbox-drain.*· upload de imagens sociais/);
    assert.match(b, /oauth-setup\.ts/);
    assert.match(b, /diaria-inbox/);
  });
  it("expiring_soon → menciona o limite de 7d + idade", () => {
    const b = renderTokenHealthBanner(base({ status: "expiring_soon", refreshAgeDays: 6.2 }));
    assert.match(b, new RegExp(`${TESTING_REFRESH_TTL_DAYS}d`));
    assert.match(b, /EXPIRANDO/);
    assert.match(b, /6\.2d/);
  });
  it("no_credentials → banner de ausente", () => {
    assert.match(renderTokenHealthBanner(base({ status: "no_credentials", detail: "ausente" })), /AUSENTE/);
  });
});
