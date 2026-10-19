/**
 * test/retrospectiva-facebook-pages-10458.test.ts (#10458)
 *
 * Resíduo do #10458: a Retrospectiva mensal (`publish-retrospectiva-social.ts`)
 * percorre a lista de páginas do Facebook (`publishing.social.facebook.pages`),
 * igual ao weekly e ao "É IA?" (decisão do editor, 19/10/2026). Cobre o estado
 * por (post × página): chave de state (`facebook:dN` pra `diaria`, compat;
 * `facebook@{página}:dN` pras outras), store com `page`, `--skip`/`--force`/
 * `--old-cancelled` por página, falha isolada de credencial e a tag
 * `utm_content` da página no texto.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRetrospectivaStateKey,
  normalizeRetrospectivaStateKey,
  parseRetrospectivaSkip,
  readRetrospectivaDivulgacaoState,
  retrospectivaDivulgacaoStatePath,
  retrospectivaFacebookStateKey,
  writeRetrospectivaDivulgacaoState,
  type RetrospectivaHistoria,
  type RetrospectivaPostKey,
  type RetrospectivaStateKey,
} from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import { RETROSPECTIVA_PUBLIC_CTA_CURTO } from "../scripts/lib/mensal/retrospectiva-social.ts";
import { resolveRetrospectivaPostScheduledAts } from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { buildDoneChannelState, withChannelState } from "../scripts/lib/artigo-especial-state.ts";
import {
  RETROSPECTIVA_SOCIAL_DESTAQUE,
  findLiveSocialDispatch,
  parseSocialForce,
  parseSocialListArgs,
  retrospectivaSocialPublishedPath,
  runRetrospectivaSocialDispatch,
  unknownFacebookPageSlugs,
  type HistoriaImages,
  type RetrospectivaFacebookPage,
  type RunRetrospectivaSocialOptions,
  type SocialDispatchInput,
} from "../scripts/publish-retrospectiva-social.ts";
import { runMarkRetrospectivaChannel } from "../scripts/mark-retrospectiva-channel.ts";
import { readSocialPublished } from "../scripts/lib/social-published-store.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const CONFIG = {
  publishing: {
    social: {
      timezone: "America/Sao_Paulo",
      fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
    },
  },
};
const NOW = Date.parse("2026-10-02T12:00:00Z");
const H: RetrospectivaHistoria[] = ["d1", "d2", "d3"];
const SCHEDULE = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-10-10", now: NOW });

const P1 = "Em setembro, pesquisadores acharam mais de 15 mil edições feitas por agentes num site alemão.";
const P2 = "Em parte das mensagens, os próprios bots combinavam como contornar as regras da empresa que os criou.";
const P3 = "A Retrospectiva de Setembro conta o resto. Arquivo em https://diar.ia.br/p/arquivo agora.";
const CORPO = `${P1}\n\n${P2}\n\n${P3}\n`;
const CURTO = `Agentes fizeram 15 mil edições num site alemão. A retrospectiva conta o resto.\n\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}\n`;
const TEXTS = Object.fromEntries(H.map((h) => [h, { corpo: CORPO, curto: CURTO }])) as Record<RetrospectivaHistoria, { corpo: string; curto: string }>;
const TITLES = { d1: "Agentes saem do teste e invadem governos", d2: "Modelos mais capazes, com risco e preço menor", d3: "Empresas brasileiras põem agentes para trabalhar" };
const FB_ALL: RetrospectivaPostKey[] = H.map((h) => `facebook:${h}` as RetrospectivaPostKey);
const TWO_PAGES: RetrospectivaFacebookPage[] = [
  { slug: "diaria", utmContent: null, missing: null },
  { slug: "memelab", utmContent: "page-memelab", missing: null },
];

const cardsFor = (h: string) => ({
  cover: `https://img/${h}-cover.jpg`,
  p1: `https://img/${h}-p1.jpg`,
  p2: `https://img/${h}-p2.jpg`,
  p3: `https://img/${h}-p3.jpg`,
  cta: `https://img/${h}-cta.jpg`,
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retro-10458-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function opts(over: Partial<RunRetrospectivaSocialOptions> = {}) {
  const calls: Array<{ page: string; input: SocialDispatchInput }> = [];
  const o: RunRetrospectivaSocialOptions = {
    cycle: "2609-10",
    cycleDir: tmp,
    posts: FB_ALL,
    texts: TEXTS,
    titles: TITLES,
    resolveScheduledAts: () => SCHEDULE,
    prepareImages: async (hs) => Object.fromEntries(hs.map((h) => [h, { cards: cardsFor(h), pendingUpload: false } satisfies HistoriaImages])),
    force: new Set(),
    dryRun: false,
    disabled: {},
    xChannelId: "buffer-x",
    missingCredentials: {},
    facebookPages: TWO_PAGES,
    dispatchers: {
      linkedin: async () => {
        throw new Error("não usado");
      },
      facebook: async (input, page) => {
        calls.push({ page, input });
        return {
          platform: "facebook",
          destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
          url: `https://www.facebook.com/${page}/posts/${input.historia}`,
          status: "scheduled",
          scheduled_at: input.scheduledAt,
          fb_post_id: `${page}-${input.historia}`,
        };
      },
      worker: async () => {
        throw new Error("não usado");
      },
      cancelWorker: async () => ({ alreadyGone: false }),
    },
    now: NOW,
    ...over,
  };
  return { o, calls };
}
const state = () => readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels;
const liveFb = (h: RetrospectivaHistoria, page: string | undefined) => {
  mkdirSync(join(tmp, "_internal"), { recursive: true });
  writeFileSync(
    retrospectivaSocialPublishedPath(tmp, h),
    JSON.stringify({
      posts: [
        {
          platform: "facebook",
          ...(page ? { page } : {}),
          destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
          url: null,
          status: "scheduled",
          scheduled_at: "2026-10-11T09:45:00-03:00",
          fb_post_id: `old-${page ?? "diaria"}`,
        },
      ],
    }),
  );
};

describe("#10458 — chaves de state e alvos de CLI por página", () => {
  it("diaria grava em facebook:dN (compat); as outras em facebook@{página}:dN, que fazem round-trip no state", () => {
    assert.equal(retrospectivaFacebookStateKey("diaria", "d2"), "facebook:d2");
    assert.equal(retrospectivaFacebookStateKey("memelab", "d2"), "facebook@memelab:d2");
    assert.equal(normalizeRetrospectivaStateKey("facebook@diaria:d1"), "facebook:d1");
    assert.equal(normalizeRetrospectivaStateKey("facebook@memelab:d1"), "facebook@memelab:d1");
    assert.ok(isRetrospectivaStateKey("facebook@memelab:d3"));
    assert.ok(!isRetrospectivaStateKey("facebook@Meme Lab:d3"));
    const p = retrospectivaDivulgacaoStatePath(tmp);
    const memelabD2: RetrospectivaStateKey = "facebook@memelab:d2";
    writeRetrospectivaDivulgacaoState(
      p,
      withChannelState(readRetrospectivaDivulgacaoState(p, "2609-10"), memelabD2, buildDoneChannelState("2026-10-02T00:00:00Z", "u")),
    );
    assert.equal(readRetrospectivaDivulgacaoState(p, "2609-10").channels["facebook@memelab:d2"]?.status, "done");
  });

  it("--skip/--force aceitam facebook@{página}[:dN]; o token sem página segue cobrindo todas", () => {
    assert.deepEqual([...parseRetrospectivaSkip("facebook@memelab")].sort(), ["facebook@memelab:d1", "facebook@memelab:d2", "facebook@memelab:d3"]);
    assert.deepEqual([...parseRetrospectivaSkip("facebook@memelab:d2")], ["facebook@memelab:d2"]);
    assert.throws(() => parseRetrospectivaSkip("facebook@meme_lab"), /não reconhecido/);
    const f = parseSocialForce("facebook:d1,facebook@memelab:d2");
    assert.ok(f.has("facebook:d1") && f.has("facebook@memelab:d2"));
    const a = parseSocialListArgs(["--skip", "facebook@memelab:d3", "--old-cancelled", "facebook@memelab:d1"]);
    assert.ok(a.skip.has("facebook@memelab:d3"));
    assert.ok(a.oldCancelled.has("facebook@memelab:d1"));
    assert.deepEqual(unknownFacebookPageSlugs(["facebook@memelab:d1", "facebook@memlab:d2", "facebook:d1"], ["diaria", "memelab"]), ["memlab"]);
  });

  it("mark-retrospectiva-channel: facebook@diaria:dN grava na chave que o publisher lê (facebook:dN)", () => {
    runMarkRetrospectivaChannel({ cycle: "2609-10", cycleDir: tmp, channel: "facebook@diaria:d1", status: "done", url: "u1" });
    runMarkRetrospectivaChannel({ cycle: "2609-10", cycleDir: tmp, channel: "facebook@memelab:d1", status: "done", url: "u2" });
    const st = state();
    assert.equal(st["facebook:d1"]?.url, "u1");
    assert.equal(st["facebook@memelab:d1"]?.url, "u2");
    assert.equal(st["facebook@diaria:d1"], undefined);
  });

  it("findLiveSocialDispatch por página: entrada sem `page` é da diaria, não da memelab", () => {
    const pub = { posts: [{ platform: "facebook", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled" as const, scheduled_at: null }] };
    assert.ok(findLiveSocialDispatch(pub, "facebook", "diaria"));
    assert.equal(findLiveSocialDispatch(pub, "facebook", "memelab"), null);
    assert.ok(findLiveSocialDispatch(pub, "facebook"), "sem página = qualquer uma (legado)");
  });
});

describe("#10458 — dispatch da Retrospectiva em cada página habilitada", () => {
  it("2 páginas: cada história sai nas duas, state e store por página, tag utm_content só na memelab", async () => {
    const { o, calls } = opts();
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(
      calls.map((c) => `${c.page}:${c.input.historia}`),
      ["diaria:d1", "memelab:d1", "diaria:d2", "memelab:d2", "diaria:d3", "memelab:d3"],
    );
    const d1 = calls.filter((c) => c.input.historia === "d1");
    assert.match(d1[0].input.text, /https:\/\/diar\.ia\.br\/p\/arquivo(?!\?)/, "diaria sai sem tag (utm_content null)");
    assert.match(d1[1].input.text, /https:\/\/diar\.ia\.br\/p\/arquivo\?utm_content=page-memelab/);
    assert.equal(d1[0].input.scheduledAt, d1[1].input.scheduledAt, "mesmo horário nas duas páginas");

    const st = state();
    for (const h of H) {
      assert.equal(st[`facebook:${h}`]?.url, `https://www.facebook.com/diaria/posts/${h}`);
      assert.equal(st[`facebook@memelab:${h}`]?.url, `https://www.facebook.com/memelab/posts/${h}`);
      const posts = readSocialPublished(retrospectivaSocialPublishedPath(tmp, h)).posts;
      assert.deepEqual(posts.map((p) => p.page).sort(), ["diaria", "memelab"], "store guarda os dois posts (chave inclui a página)");
    }
    assert.deepEqual(
      r.results.filter((x) => x.historia === "d1").map((x) => `${x.page}:${x.action}`),
      ["diaria:dispatched", "memelab:dispatched"],
    );

    // Reexecução: as duas páginas já `done` → nada sai.
    const again = opts();
    const r2 = await runRetrospectivaSocialDispatch(again.o);
    assert.equal(again.calls.length, 0);
    assert.ok(r2.results.every((x) => x.action === "skipped"));
  });

  it("state do ciclo anterior ao #10458 (facebook:dN done) não reenvia na diaria; a memelab recém-ligada sai", async () => {
    const p = retrospectivaDivulgacaoStatePath(tmp);
    let s = readRetrospectivaDivulgacaoState(p, "2609-10");
    for (const h of H) s = withChannelState(s, `facebook:${h}` as RetrospectivaPostKey, buildDoneChannelState("2026-10-02T00:00:00Z", null));
    writeRetrospectivaDivulgacaoState(p, s);
    const { o, calls } = opts();
    await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(calls.map((c) => c.page), ["memelab", "memelab", "memelab"]);
  });

  it("--skip facebook@memelab:d2 pula só aquela página naquela história", async () => {
    const { o, calls } = opts({ skipFacebookPages: new Set(["facebook@memelab:d2"]) });
    await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(
      calls.map((c) => `${c.page}:${c.input.historia}`),
      ["diaria:d1", "memelab:d1", "diaria:d2", "diaria:d3", "memelab:d3"],
    );
    assert.equal(state()["facebook@memelab:d2"], undefined);
  });

  it("página não-default sem credencial falha só ela (failed no state, retentável); a diaria segue", async () => {
    const pages: RetrospectivaFacebookPage[] = [TWO_PAGES[0], { ...TWO_PAGES[1], missing: "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN ausentes" }];
    const { o, calls } = opts({ facebookPages: pages });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(calls.map((c) => c.page), ["diaria", "diaria", "diaria"]);
    const failed = r.results.filter((x) => x.action === "failed");
    assert.equal(failed.length, 3);
    assert.ok(failed.every((x) => x.page === "memelab" && x.action === "failed" && /MEMELAB/.test(x.reason)));
    assert.equal(state()["facebook@memelab:d1"]?.status, "failed");
    assert.equal(state()["facebook:d1"]?.status, "done");
  });

  it("credencial da diaria ausente segue barrando o pré-voo inteiro (comportamento pré-#10458)", async () => {
    const { o, calls } = opts({ missingCredentials: { facebook: "FACEBOOK_PAGE_ACCESS_TOKEN ausentes" } });
    await assert.rejects(runRetrospectivaSocialDispatch(o), /ANTES de qualquer dispatch[\s\S]*facebook:d1: FACEBOOK_PAGE_ACCESS_TOKEN/);
    assert.equal(calls.length, 0);
  });

  it("nenhuma página habilitada: Facebook pulado com motivo, nada despachado", async () => {
    const { o, calls } = opts({ facebookPages: [] });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(calls.length, 0);
    assert.ok(r.results.every((x) => x.action === "skipped" && /nenhuma página Facebook/.test(x.reason)));
  });

  it("--force sobre post vivo é por página: só a página do --old-cancelled destrava", async () => {
    liveFb("d1", "memelab");
    // Sem --force: a memelab:d1 viva pula; a diaria:d1 (sem post vivo) sai.
    const plain = opts({ posts: ["facebook:d1"] });
    const r0 = await runRetrospectivaSocialDispatch(plain.o);
    assert.deepEqual(plain.calls.map((c) => c.page), ["diaria"]);
    const memSkip = r0.results.find((x) => x.page === "memelab");
    assert.ok(memSkip?.action === "skipped" && /--force facebook@memelab:d1/.test(memSkip.reason), JSON.stringify(memSkip));

    liveFb("d1", "memelab");
    const a = opts({ posts: ["facebook:d1"], force: new Set(["facebook@memelab:d1"]) });
    await assert.rejects(runRetrospectivaSocialDispatch(a.o), /--old-cancelled facebook@memelab:d1/);
    const b = opts({ posts: ["facebook:d1"], force: new Set(["facebook@memelab:d1"]), oldCancelled: new Set(["facebook@memelab:d1"]) });
    await runRetrospectivaSocialDispatch(b.o);
    assert.deepEqual(b.calls.map((c) => c.page), ["memelab"], "a diaria já está done; o --force por página não a refaz");
  });

  it("post vivo LEGADO sem `page` conta como da diaria: --old-cancelled facebook:d1 destrava só ela", async () => {
    liveFb("d1", undefined);
    const a = opts({ posts: ["facebook:d1"], force: new Set(["facebook:d1"]), oldCancelled: new Set(["facebook:d1"]) });
    await runRetrospectivaSocialDispatch(a.o);
    assert.deepEqual(a.calls.map((c) => c.page), ["diaria", "memelab"]);
    const posts = JSON.parse(readFileSync(retrospectivaSocialPublishedPath(tmp, "d1"), "utf8")).posts as Array<{ page?: string; fb_post_id?: string }>;
    assert.deepEqual(posts.map((p) => p.fb_post_id).sort(), ["diaria-d1", "memelab-d1"], "o upsert substituiu a entrada legada sem `page`");
  });

  it("dry-run lista um resultado por página, com o texto já marcado", async () => {
    const { o, calls } = opts({ dryRun: true, posts: ["facebook:d2"] });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(calls.length, 0);
    assert.deepEqual(r.results.map((x) => `${x.page}:${x.action}`), ["diaria:dry-run", "memelab:dry-run"]);
    const mem = r.results.find((x) => x.page === "memelab");
    assert.ok(mem?.action === "dry-run" && mem.text.includes("utm_content=page-memelab"));
  });
});
