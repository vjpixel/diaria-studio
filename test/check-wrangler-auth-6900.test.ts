/**
 * test/check-wrangler-auth-6900.test.ts
 *
 * Regressão do #6900 — o guard de §6h precisa validar a MESMA identidade
 * que `purge-leaderboard.ts` de fato usa (env sem `CLOUDFLARE_API_TOKEN`/
 * `CLOUDFLARE_ACCOUNT_ID`, forçando resolução via sessão OAuth do CLI),
 * nunca a auth do ambiente normal do processo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizedCloudflareOAuthEnv, CLOUDFLARE_OAUTH_STRIPPED_ENV_VARS } from "../scripts/lib/cloudflare-oauth-env.ts";
import { checkWranglerAuth, type ExecFn } from "../scripts/check-wrangler-auth.ts";

describe("#6900 sanitizedCloudflareOAuthEnv", () => {
  it("remove CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID de uma cópia — nunca muta o env original", () => {
    const original: NodeJS.ProcessEnv = {
      CLOUDFLARE_API_TOKEN: "token-secreto",
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      OUTRA_VAR: "intocada",
    };
    const sanitized = sanitizedCloudflareOAuthEnv(original);

    assert.equal(sanitized.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(sanitized.CLOUDFLARE_ACCOUNT_ID, undefined);
    assert.equal(sanitized.OUTRA_VAR, "intocada");
    // env original passado não foi mutado
    assert.equal(original.CLOUDFLARE_API_TOKEN, "token-secreto");
    assert.equal(original.CLOUDFLARE_ACCOUNT_ID, "account-123");
  });

  it("env sem as vars presentes não lança — no-op seguro", () => {
    const sanitized = sanitizedCloudflareOAuthEnv({ OUTRA_VAR: "x" });
    assert.deepEqual(sanitized, { OUTRA_VAR: "x" });
  });

  it("lista de vars removidas é exatamente a que purge-leaderboard.ts historicamente removia", () => {
    assert.deepEqual([...CLOUDFLARE_OAUTH_STRIPPED_ENV_VARS], ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  });
});

describe("#6900 checkWranglerAuth valida a MESMA auth que purge-leaderboard.ts usa", () => {
  it("passa o env SEM CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID pro wrangler — nunca a auth do ambiente normal", () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const fakeExec: ExecFn = (_cmd, _args, options) => {
      capturedEnv = options.env;
      return "you are logged in with an OAuth Token\n";
    };
    const envComToken: NodeJS.ProcessEnv = {
      CLOUDFLARE_API_TOKEN: "token-que-passaria-no-guard-cru",
      CLOUDFLARE_ACCOUNT_ID: "conta-x",
    };

    const result = checkWranglerAuth(fakeExec, envComToken);

    assert.equal(result.ok, true);
    assert.equal(
      capturedEnv?.CLOUDFLARE_API_TOKEN,
      undefined,
      "regressão #6900: se o token vazar pro child env, o guard valida a identidade ERRADA (API Token em vez de OAuth)",
    );
    assert.equal(capturedEnv?.CLOUDFLARE_ACCOUNT_ID, undefined);
  });

  it("REGRESSÃO #6900: OAuth expirado (a auth real que purge-leaderboard.ts usa) falha mesmo com API Token presente no env do pai", () => {
    // Reproduz o achado ao vivo 260901: `npx wrangler whoami` cru passava
    // (via API Token do ambiente normal), mas a sessão OAuth — que
    // `purge-leaderboard.ts` de fato usa após o env ser sanitizado — estava
    // expirada. checkWranglerAuth precisa refletir essa falha, não a do
    // token avulso.
    const authError = Object.assign(new Error("Authentication error [code: 10000]"), {
      stdout: Buffer.from(""),
      stderr: Buffer.from("Authentication error [code: 10000]"),
    });
    const fakeExec: ExecFn = () => {
      throw authError;
    };
    const envComTokenValido: NodeJS.ProcessEnv = {
      CLOUDFLARE_API_TOKEN: "token-valido-mas-irrelevante-pro-wrangler-oauth",
    };

    const result = checkWranglerAuth(fakeExec, envComTokenValido);

    assert.equal(result.ok, false);
    assert.match(result.stderr, /Authentication error/);
  });

  it("sucesso: exec retorna stdout com a identidade OAuth, resultado ok:true propaga o stdout", () => {
    const fakeExec: ExecFn = () => "you are logged in with an OAuth Token, associated with the email x@y.com\n";
    const result = checkWranglerAuth(fakeExec, {});
    assert.equal(result.ok, true);
    assert.match(result.stdout, /OAuth Token/);
  });

  it("timeout/erro sem stdout/stderr (ex: ENOENT) vira ok:false sem lançar — chamador decide o que fazer", () => {
    const err = Object.assign(new Error("spawnSync wrangler ENOENT"), { stdout: undefined, stderr: undefined });
    const fakeExec: ExecFn = () => {
      throw err;
    };
    const result = checkWranglerAuth(fakeExec, {});
    assert.equal(result.ok, false);
    assert.equal(result.stdout, "");
    // cai no fallback de err.message quando stderr também está ausente
    assert.match(result.stderr, /ENOENT/);
  });
});
