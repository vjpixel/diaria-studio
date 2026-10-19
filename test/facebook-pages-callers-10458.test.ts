/**
 * #10458 (follow-up do núcleo fa524eef) — os pontos que ainda liam
 * `FACEBOOK_PAGE_ID`/`FACEBOOK_PAGE_ACCESS_TOKEN` direto, ou casavam entries
 * só por (platform, destaque), passam a respeitar a página:
 *
 *   - invariante do Stage 5 (credencial por página habilitada, severidade da
 *     falha isolada);
 *   - verify-stage-4-dispatch (/scheduled_posts e token POR PÁGINA);
 *   - delete-test-schedules (deletar a memelab não marca a diaria);
 *   - verify-facebook-posts (token da página de cada entry);
 *   - publish-eia-social (um plano por página, idempotência por página);
 *   - social-followers(-collect) (uma série por página);
 *   - studio-integrations (status de credencial por página).
 *
 * O weekly tem o cenário real (2 páginas + skip-existing por página) em
 * `test/publish-weekly-social.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enabledFacebookPages,
  facebookPageLabel,
  resolveFacebookPageForEntry,
  resolveFacebookPages,
  loadFacebookPagesConfig,
  socialEntryKey,
  type ResolvedFacebookPage,
} from "../scripts/lib/facebook-pages.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";
import { checkFbPageIdSet, checkFbTokenSet } from "../scripts/lib/invariant-checks/stage-5.ts";
import { verifyFacebookEntries } from "../scripts/verify-stage-4-dispatch.ts";
import { markDeletedEntries } from "../scripts/delete-test-schedules.ts";
import { verifyPublished } from "../scripts/verify-facebook-posts.ts";
import { eiaPlanKey, expandFacebookPlans, pendingChannels, type EiaDispatchPlan } from "../scripts/publish-eia-social.ts";
import {
  computeDailyBalances,
  parseSocialFollowersJsonl,
  serializeSocialFollowerSample,
} from "../scripts/lib/social-followers.ts";
import { collectSocialFollowers } from "../scripts/social-followers-collect.ts";
import { facebookIntegrationDefs, INTEGRATIONS } from "../scripts/studio-ui/studio-integrations.ts";

const TWO_PAGES = (memelabEnabled: boolean) => ({
  publishing: {
    social: {
      facebook: {
        pages: [
          { slug: "diaria", enabled: true, page_id_env: "FACEBOOK_PAGE_ID", token_env: "FACEBOOK_PAGE_ACCESS_TOKEN", utm_content: null },
          { slug: "memelab", enabled: memelabEnabled, page_id_env: "FACEBOOK_MEMELAB_PAGE_ID", token_env: "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN" },
        ],
      },
    },
  },
});

const FULL_ENV = {
  FACEBOOK_PAGE_ID: "111",
  FACEBOOK_PAGE_ACCESS_TOKEN: "tok-diaria",
  FACEBOOK_MEMELAB_PAGE_ID: "222",
  FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN: "tok-meme",
};

function pages(env: Record<string, string | undefined>, memelabEnabled = true): ResolvedFacebookPage[] {
  return resolveFacebookPages(loadFacebookPagesConfig(TWO_PAGES(memelabEnabled)), env);
}

function fbEntry(destaque: string, page: string | undefined, extra: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "facebook",
    destaque,
    url: null,
    status: "scheduled",
    scheduled_at: "2099-01-01T12:00:00Z",
    ...(page ? { page } : {}),
    ...extra,
  } as PostEntry;
}

describe("#10458 helpers de entry", () => {
  it("resolveFacebookPageForEntry: sem page = diaria; página fora do config; página sem credencial", () => {
    const ps = pages({ ...FULL_ENV, FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN: "" });
    const d = resolveFacebookPageForEntry({}, ps);
    assert.equal(d.ok && d.page.token, "tok-diaria");
    const m = resolveFacebookPageForEntry({ page: "memelab" }, ps);
    assert.deepEqual(m, { ok: false, slug: "memelab", reason: "missing_fb_credentials", missing: ["FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN"] });
    assert.deepEqual(resolveFacebookPageForEntry({ page: "outra" }, ps), { ok: false, slug: "outra", reason: "unknown_fb_page" });
  });

  it("resolveFacebookPageForEntry ignora `enabled` — post já existente continua alcançável com a página desligada", () => {
    const r = resolveFacebookPageForEntry({ page: "memelab" }, pages(FULL_ENV, false));
    assert.equal(r.ok && r.page.token, "tok-meme");
  });

  it("socialEntryKey separa as páginas e trata entry sem page como diaria", () => {
    assert.notEqual(socialEntryKey(fbEntry("d1", "memelab")), socialEntryKey(fbEntry("d1", undefined)));
    assert.equal(socialEntryKey(fbEntry("d1", "diaria")), socialEntryKey(fbEntry("d1", undefined)));
  });

  it("enabledFacebookPages / facebookPageLabel", () => {
    assert.deepEqual(enabledFacebookPages(pages(FULL_ENV, false)).map((p) => p.slug), ["diaria"]);
    assert.equal(facebookPageLabel("diaria", "d1"), "facebook/d1");
    assert.equal(facebookPageLabel("memelab", "d1"), "facebook[memelab]/d1");
  });
});

describe("#10458 invariante do Stage 5 — credencial por página habilitada", () => {
  it("só diaria ligada (config de hoje): env da diaria ausente → error (comportamento de sempre)", () => {
    const v = checkFbTokenSet(TWO_PAGES(false), { FACEBOOK_PAGE_ID: "111" }, {});
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "facebook-token-set");
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /FACEBOOK_PAGE_ACCESS_TOKEN/);
  });

  it("memelab desligada sem credencial não gera violation", () => {
    const env = { FACEBOOK_PAGE_ID: "111", FACEBOOK_PAGE_ACCESS_TOKEN: "t" };
    assert.deepEqual(checkFbPageIdSet(TWO_PAGES(false), env, {}), []);
    assert.deepEqual(checkFbTokenSet(TWO_PAGES(false), env, {}), []);
  });

  it("memelab ligada sem credencial, diaria completa → WARNING só da memelab (falha isolada)", () => {
    const env = { FACEBOOK_PAGE_ID: "111", FACEBOOK_PAGE_ACCESS_TOKEN: "t" };
    const v = checkFbPageIdSet(TWO_PAGES(true), env, {});
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /FACEBOOK_MEMELAB_PAGE_ID/);
    assert.match(v[0].message, /memelab/);
  });

  it("nenhuma página habilitada com credencial completa → error em cada uma", () => {
    const v = checkFbTokenSet(TWO_PAGES(true), { FACEBOOK_PAGE_ID: "111", FACEBOOK_MEMELAB_PAGE_ID: "222" }, {});
    assert.equal(v.length, 2);
    assert.ok(v.every((x) => x.severity === "error"));
  });

  it("#10542 item 3: credencial da diaria só no data/.fb-credentials.json conta como presente (igual ao publisher)", () => {
    const file = { page_id: "111", page_access_token: "t" };
    assert.deepEqual(checkFbPageIdSet(TWO_PAGES(false), {}, file), []);
    assert.deepEqual(checkFbTokenSet(TWO_PAGES(false), {}, file), []);
    // Com a memelab ligada sem env: a diaria (via arquivo) está completa → warning só da memelab.
    const v = checkFbTokenSet(TWO_PAGES(true), { FACEBOOK_MEMELAB_PAGE_ID: "222" }, file);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN/);
  });

  it("#10542 item 3: o arquivo legado nunca cobre página que não é a default", () => {
    const file = { page_id: "111", page_access_token: "t" };
    const v = checkFbPageIdSet(TWO_PAGES(true), {}, file);
    assert.deepEqual(v.map((x) => x.message.match(/^\S+/)?.[0]), ["FACEBOOK_MEMELAB_PAGE_ID"]);
  });

  it("config de páginas inválido → error (não vira 'publica em lugar nenhum' em silêncio)", () => {
    const v = checkFbPageIdSet({ publishing: { social: { facebook: { pages: [] } } } }, FULL_ENV, {});
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
  });
});

describe("#10458 verify-stage-4-dispatch — /scheduled_posts e token por página", () => {
  it("consulta cada página com o próprio token e casa a entry contra a lista DELA", async () => {
    const calls: Array<{ pageId: string; token: string }> = [];
    const fetchScheduled = async (pageId: string, token: string) => {
      calls.push({ pageId, token });
      return { data: pageId === "111" ? [{ id: "111_a", scheduled_publish_time: 4102444800 }] : [{ id: "222_b", scheduled_publish_time: 4102444800 }] };
    };
    const fetchPost = async () => {
      throw new Error("não deveria cair no GET direto");
    };
    const entries = [fbEntry("d1", undefined, { fb_post_id: "a" }), fbEntry("d1", "memelab", { fb_post_id: "b" })];
    const r = await verifyFacebookEntries(entries, pages(FULL_ENV), "v25.0", { fetchScheduled, fetchPost });
    assert.deepEqual(calls, [
      { pageId: "111", token: "tok-diaria" },
      { pageId: "222", token: "tok-meme" },
    ]);
    assert.equal(r.results.length, 2);
    assert.ok(r.results.every((x) => x.verified), JSON.stringify(r.results));
    assert.deepEqual(r.results.map((x) => x.page), ["diaria", "memelab"]);
  });

  it("página sem credencial marca SÓ as entries dela; a outra segue verificada", async () => {
    const fetchScheduled = async () => ({ data: [{ id: "111_a", scheduled_publish_time: 4102444800 }] });
    const entries = [fbEntry("d1", undefined, { fb_post_id: "a" }), fbEntry("d1", "memelab", { fb_post_id: "b" })];
    const env = { ...FULL_ENV, FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN: "" };
    const r = await verifyFacebookEntries(entries, pages(env), "v25.0", { fetchScheduled });
    const diaria = r.results.find((x) => x.page === "diaria")!;
    const meme = r.results.find((x) => x.page === "memelab")!;
    assert.equal(diaria.verified, true);
    assert.equal(meme.verified, false);
    assert.equal(meme.reason, "missing_fb_token");
    assert.ok(r.warnings.some((w) => /memelab/.test(w)));
  });

  it("entry de página fora do config → unknown_fb_page (sem chamar a Graph API)", async () => {
    let called = false;
    const fetchScheduled = async () => {
      called = true;
      return { data: [] };
    };
    const r = await verifyFacebookEntries([fbEntry("d1", "sumiu", { fb_post_id: "x" })], pages(FULL_ENV), "v25.0", { fetchScheduled });
    assert.equal(called, false);
    assert.equal(r.results[0].reason, "unknown_fb_page");
  });
});

describe("#10458 delete-test-schedules — marca deleted por página", () => {
  it("deletar o post da memelab NÃO marca a entry da diaria do mesmo destaque", () => {
    const posts = [fbEntry("d1", undefined, { fb_post_id: "a" }), fbEntry("d1", "memelab", { fb_post_id: "b" })];
    const out = markDeletedEntries(
      posts,
      [{ platform: "facebook", destaque: "d1", subtype: "main", page: "memelab", status: "deleted" }],
      "2026-10-19T00:00:00Z",
    );
    assert.equal(out[0].status, "scheduled", "diaria intocada");
    assert.equal(out[1].status, "deleted");
  });

  it("resultado da diaria (page 'diaria') casa a entry legada sem page", () => {
    const out = markDeletedEntries(
      [fbEntry("d2", undefined)],
      [{ platform: "facebook", destaque: "d2", subtype: "main", page: "diaria", status: "deleted" }],
      "now",
    );
    assert.equal(out[0].status, "deleted");
  });
});

describe("#10458 verify-facebook-posts — token da página de cada entry", () => {
  it("credentialsFor decide o token por entry; null deixa a entry intocada", async () => {
    const tokensSeen: string[] = [];
    const fetchPost = async (_id: string, token: string) => {
      tokensSeen.push(token);
      return { id: "x", is_published: true, created_time: "2026-01-01T00:00:00Z", permalink_url: "https://fb/x" };
    };
    const published = {
      posts: [
        fbEntry("d1", undefined, { fb_post_id: "111_a", scheduled_at: "2020-01-01T00:00:00Z" }),
        fbEntry("d1", "memelab", { fb_post_id: "222_b", scheduled_at: "2020-01-01T00:00:00Z" }),
        fbEntry("d2", "sem-cred", { fb_post_id: "333_c", scheduled_at: "2020-01-01T00:00:00Z" }),
      ],
    };
    const ps = pages(FULL_ENV);
    const { updated } = await verifyPublished(published, "", "v25.0", fetchPost as never, new Date("2026-10-19T00:00:00Z"), undefined, (e) => {
      const r = resolveFacebookPageForEntry(e, ps);
      return r.ok ? { token: r.page.token, pageId: r.page.pageId } : null;
    });
    assert.deepEqual(tokensSeen, ["tok-diaria", "tok-meme"]);
    assert.equal(updated.posts[2].status, "scheduled", "página sem credencial: entry intocada, nunca 'failed' inventado");
  });
});

describe("#10458 publish-eia-social — um plano por página", () => {
  const base: EiaDispatchPlan[] = [
    { channel: "linkedin", text: "li", images: ["a"] },
    { channel: "facebook", text: "Vote em https://diar.ia.br/?utm_source=facebook&utm_medium=social", images: ["a"] },
  ];

  it("expande o Facebook em uma entrada por página habilitada, com a UTM da página", () => {
    const out = expandFacebookPlans(base, pages(FULL_ENV));
    assert.deepEqual(out.map(eiaPlanKey), ["linkedin", "facebook", "facebook[memelab]"]);
    assert.doesNotMatch(out[1].text, /utm_content/, "diaria (utm_content null) sai idêntica");
    assert.match(out[2].text, /utm_content=page-memelab/);
  });

  it("memelab desligada → só a diaria, com a chave de estado de sempre", () => {
    const out = expandFacebookPlans(base, pages(FULL_ENV, false));
    assert.deepEqual(out.map(eiaPlanKey), ["linkedin", "facebook"]);
  });

  it("idempotência por página: diaria já agendada (estado legado 'facebook') não bloqueia a memelab", () => {
    const plans = expandFacebookPlans(base, pages(FULL_ENV));
    const state = { edition: "261019", scheduled_at: "x", channels: { facebook: { ref: "1", scheduled_at: "x" } } };
    const { todo, alreadyDone } = pendingChannels(plans, state, false);
    assert.deepEqual(alreadyDone, ["facebook"]);
    assert.deepEqual(todo.map(eiaPlanKey), ["linkedin", "facebook[memelab]"]);
  });
});

describe("#10458 seguidores — uma série por página", () => {
  it("computeDailyBalances separa diaria (sem page) de memelab", () => {
    const samples = [
      { date: "2026-10-18", platform: "facebook" as const, followersCount: 31 },
      { date: "2026-10-18", platform: "facebook" as const, followersCount: 2800, page: "memelab" },
      { date: "2026-10-19", platform: "facebook" as const, followersCount: 32 },
      { date: "2026-10-19", platform: "facebook" as const, followersCount: 2810, page: "memelab" },
    ];
    assert.equal(computeDailyBalances(samples, "facebook").totalDelta, 1, "série default = diaria, sem misturar com ~2,8 mil");
    assert.equal(computeDailyBalances(samples, "facebook", "memelab").totalDelta, 10);
  });

  it("parse lê o campo page e rejeita page malformado", () => {
    const line = serializeSocialFollowerSample({ date: "2026-10-19", platform: "facebook", followersCount: 5, page: "memelab" });
    const { samples, errors } = parseSocialFollowersJsonl(`${line}\n{"date":"2026-10-19","platform":"facebook","followersCount":1,"page":""}\n`);
    assert.equal(samples[0].page, "memelab");
    assert.equal(errors.length, 1);
  });

  it("coletor grava uma linha por página habilitada; a diaria sai sem page (série histórica igual)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-followers-10458-"));
    const outputPath = join(dir, "f.jsonl");
    try {
      const fetchImpl = (async (url: string) => {
        const count = url.includes("/222?") ? 2800 : url.includes("/111?") ? 31 : 500;
        return new Response(JSON.stringify({ followers_count: count }), { status: 200 });
      }) as unknown as typeof fetch;
      const env = { ...FULL_ENV, INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig", INSTAGRAM_ACCESS_TOKEN: "igt" };
      const opts = { now: () => new Date("2026-10-19T10:00:00Z"), outputPath, env, fetchImpl, config: TWO_PAGES(true) };
      const results = await collectSocialFollowers(opts);
      assert.deepEqual(
        results.map((r) => [r.platform, r.page ?? null, r.written]),
        [
          ["instagram", null, true],
          ["facebook", "diaria", true],
          ["facebook", "memelab", true],
        ],
      );
      const lines = readFileSync(outputPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines[1].page, undefined, "diaria sem page");
      assert.equal(lines[2].page, "memelab");
      // 2ª rodada no mesmo dia: idempotente POR PÁGINA (nenhuma linha nova).
      const again = await collectSocialFollowers(opts);
      assert.ok(again.every((r) => !r.written && !r.error));
      assert.equal(readFileSync(outputPath, "utf8").trim().split("\n").length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memelab ligada sem credencial falha só ela", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-followers-10458-"));
    try {
      const fetchImpl = (async () => new Response(JSON.stringify({ followers_count: 31 }), { status: 200 })) as unknown as typeof fetch;
      const env = { FACEBOOK_PAGE_ID: "111", FACEBOOK_PAGE_ACCESS_TOKEN: "t" };
      const results = await collectSocialFollowers({ outputPath: join(dir, "f.jsonl"), env, fetchImpl, config: TWO_PAGES(true) });
      const meme = results.find((r) => r.page === "memelab")!;
      const diaria = results.find((r) => r.page === "diaria")!;
      assert.match(meme.error ?? "", /FACEBOOK_MEMELAB_PAGE_ID/);
      assert.equal(diaria.written, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#10458 Studio — integração por página", () => {
  const base = INTEGRATIONS.find((d) => d.id === "facebook")!;

  it("diaria mantém o id `facebook`; memelab ganha `facebook_memelab` com as env vars dela", () => {
    const defs = facebookIntegrationDefs(TWO_PAGES(false), base);
    assert.deepEqual(defs.map((d) => d.id), ["facebook", "facebook_memelab"]);
    assert.deepEqual(defs[1].graphNode, { idEnv: "FACEBOOK_MEMELAB_PAGE_ID", tokenEnv: "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN" });
    assert.match(defs[1].note ?? "", /Desligada/);
  });

  it("config sem a lista ou inválido → só a integração de sempre", () => {
    assert.deepEqual(facebookIntegrationDefs({}, base).map((d) => d.id), ["facebook"]);
    assert.deepEqual(facebookIntegrationDefs({ publishing: { social: { facebook: { pages: 3 } } } }, base), [base]);
  });
});
