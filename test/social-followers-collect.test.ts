/**
 * test/social-followers-collect.test.ts (#8260)
 *
 * `collectSocialFollowers` nunca bate em rede de verdade aqui — `fetchImpl`
 * é sempre injetado. Cobre: credencial ausente (fail-soft por plataforma,
 * não aborta a outra), gravação bem-sucedida, e idempotência (não duplica
 * amostra do mesmo dia numa 2ª chamada).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSocialFollowers } from "../scripts/social-followers-collect.ts";
import { parseSocialFollowersJsonl } from "../scripts/lib/social-followers.ts";

function makeOutputPath(): string {
  return join(mkdtempSync(join(tmpdir(), "social-followers-collect-")), "social-followers.jsonl");
}

function okResponse(followersCount: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ followers_count: followersCount }),
  } as unknown as Response;
}

const FULL_ENV = {
  INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig123",
  INSTAGRAM_ACCESS_TOKEN: "ig-token",
  FACEBOOK_PAGE_ID: "fb123",
  FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token",
};

describe("collectSocialFollowers — credencial ausente (fail-soft por plataforma)", () => {
  it("sem nenhuma credencial: as 2 plataformas reportam erro, nenhuma linha gravada", async () => {
    const outputPath = makeOutputPath();
    const fetchImpl = (async () => okResponse(1)) as typeof fetch;
    const results = await collectSocialFollowers({
      now: () => new Date("2026-09-17T10:00:00Z"),
      outputPath,
      env: {},
      fetchImpl,
    });
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.ok(r.error);
      assert.equal(r.written, false);
    }
  });

  it("só credencial do Instagram presente: FB reporta erro, IG grava normalmente", async () => {
    const outputPath = makeOutputPath();
    const fetchImpl = (async () => okResponse(55)) as typeof fetch;
    const results = await collectSocialFollowers({
      now: () => new Date("2026-09-17T10:00:00Z"),
      outputPath,
      env: { INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig123", INSTAGRAM_ACCESS_TOKEN: "ig-token" },
      fetchImpl,
    });
    const ig = results.find((r) => r.platform === "instagram")!;
    const fb = results.find((r) => r.platform === "facebook")!;
    assert.equal(ig.error, null);
    assert.equal(ig.written, true);
    assert.equal(ig.followersCount, 55);
    assert.ok(fb.error);
    assert.equal(fb.written, false);
  });
});

describe("collectSocialFollowers — caminho feliz + idempotência", () => {
  it("grava 1 linha por plataforma, lida de volta pelo parser", async () => {
    const outputPath = makeOutputPath();
    const fetchImpl = (async (url: string) =>
      String(url).includes("ig123") ? okResponse(123) : okResponse(15)) as unknown as typeof fetch;
    const results = await collectSocialFollowers({
      now: () => new Date("2026-09-17T10:00:00Z"),
      outputPath,
      env: FULL_ENV,
      fetchImpl,
    });
    assert.ok(results.every((r) => r.written));
    const { samples, errors } = parseSocialFollowersJsonl(readFileSync(outputPath, "utf8"));
    assert.equal(errors.length, 0);
    assert.equal(samples.length, 2);
    const ig = samples.find((s) => s.platform === "instagram")!;
    const fb = samples.find((s) => s.platform === "facebook")!;
    assert.equal(ig.followersCount, 123);
    assert.equal(ig.date, "2026-09-17");
    assert.equal(fb.followersCount, 15);
    rmSync(outputPath, { force: true });
  });

  it("2ª chamada no mesmo dia não duplica a linha (idempotente por dia)", async () => {
    const outputPath = makeOutputPath();
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return okResponse(100);
    }) as typeof fetch;
    const opts = { now: () => new Date("2026-09-17T10:00:00Z"), outputPath, env: FULL_ENV, fetchImpl };
    await collectSocialFollowers(opts);
    const secondResults = await collectSocialFollowers(opts);
    for (const r of secondResults) {
      assert.equal(r.written, false);
      assert.equal(r.error, null);
    }
    const { samples } = parseSocialFollowersJsonl(readFileSync(outputPath, "utf8"));
    assert.equal(samples.length, 2); // 1 por plataforma, não 4
    rmSync(outputPath, { force: true });
  });

  it("erro HTTP numa plataforma não impede a outra de gravar", async () => {
    const outputPath = makeOutputPath();
    const fetchImpl = (async (url: string) =>
      String(url).includes("ig123")
        ? ({ ok: false, status: 401, json: async () => ({ error: { message: "token expirado" } }) } as unknown as Response)
        : okResponse(20)) as unknown as typeof fetch;
    const results = await collectSocialFollowers({
      now: () => new Date("2026-09-17T10:00:00Z"),
      outputPath,
      env: FULL_ENV,
      fetchImpl,
    });
    const ig = results.find((r) => r.platform === "instagram")!;
    const fb = results.find((r) => r.platform === "facebook")!;
    assert.ok(ig.error);
    assert.equal(ig.written, false);
    assert.equal(fb.error, null);
    assert.equal(fb.written, true);
    rmSync(outputPath, { force: true });
  });
});
