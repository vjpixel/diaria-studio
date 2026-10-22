/**
 * test/google-auth-token-health.test.ts (#1973)
 *
 * Cobre os helpers PUROS do health-check de token OAuth (classificação de
 * erro, idade do refresh token, banner consolidado) e, desde o #10785, a
 * própria `checkTokenHealth` contra um `.credentials.json` em tmpdir
 * (`DIARIA_TEST_CREDENTIALS_PATH`) com `fetch` injetado.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIALS_PATH_TEST_OVERRIDE_ENV,
  checkTokenHealth,
  classifyRefreshError,
  refreshAgeDays,
  renderTokenHealthBanner,
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

describe("refreshAgeDays (#10785)", () => {
  const now = 10 * DAY;
  it("sem obtainedMs → undefined (creds legadas)", () => {
    assert.equal(refreshAgeDays(undefined, now), undefined);
  });
  it("idade em dias, só informativa", () => {
    assert.equal(refreshAgeDays(now - 6 * DAY, now), 6);
  });
});

describe("checkTokenHealth com app em produção (#10785)", () => {
  // Regressão: até o #10785 um refresh com mais de 5,5 dias virava
  // `expiring_soon` (ok: false) mesmo com o refresh funcionando — falso
  // alarme depois que o app OAuth foi publicado em produção.
  const dir = mkdtempSync(join(tmpdir(), "google-auth-health-"));
  const credsPath = join(dir, ".credentials.json");
  const prev = process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
  before(() => {
    process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = credsPath;
  });
  after(() => {
    if (prev === undefined) delete process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV];
    else process.env[CREDENTIALS_PATH_TEST_OVERRIDE_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const writeCreds = () =>
    writeFileSync(
      credsPath,
      JSON.stringify({
        client_id: "c",
        client_secret: "s",
        access_token: "a",
        refresh_token: "r",
        expiry_ms: 0,
        refresh_obtained_ms: Date.now() - 30 * DAY,
      }),
    );

  it("refresh com 30 dias que renova ok → valid (sem aviso de idade)", async () => {
    writeCreds();
    const okFetch = (async () =>
      new Response(JSON.stringify({ access_token: "novo", expires_in: 3600 }), { status: 200 })) as typeof fetch;
    const h = await checkTokenHealth(okFetch);
    assert.equal(h.status, "valid");
    assert.equal(h.ok, true);
    assert.equal(Math.round(h.refreshAgeDays!), 30);
    assert.equal(renderTokenHealthBanner(h), "");
  });

  it("refresh revogado → invalid_grant (o alarme que continua valendo)", async () => {
    writeCreds();
    const revoked = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    const h = await checkTokenHealth(revoked);
    assert.equal(h.status, "invalid_grant");
    assert.equal(h.ok, false);
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
  it("no_credentials → banner de ausente", () => {
    assert.match(renderTokenHealthBanner(base({ status: "no_credentials", detail: "ausente" })), /AUSENTE/);
  });
});
