/**
 * test/publish-shorts-10769.test.ts (#10769)
 *
 * Miolo puro da publicação do vídeo curto: metadados do YouTube Shorts,
 * legendas de Reels, config `publishing.shorts`, destinos, idempotência,
 * horário e o plano do `publish-shorts.ts`. Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SHORTS_CONFIG,
  buildReelsCaption,
  buildYouTubeShortMetadata,
  buildYouTubeShortTitle,
  firstSentence,
  isDestinationDone,
  listShortDestinations,
  loadShortsConfig,
  resolveReelsSchedule,
  shortVideoFileName,
  upsertShortEntry,
} from "../scripts/lib/diaria/short-video.ts";
import { planShortsPublish } from "../scripts/publish-shorts.ts";
import { matchPages } from "../scripts/facebook-page-token-setup.ts";
import { loadFacebookPagesConfig, type ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const D1 = {
  title: "Você já viu IA mentir. Já viu roubar?",
  body: "Um modelo da **OpenAI** gastou o saldo de uma [carteira](https://x.com/a) de terceiros. O caso foi descoberto depois.",
};
const EDITION_URL = "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar";

const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.

---

DESTAQUE 2 | LANÇAMENTO

[Outro destaque](https://exemplo.com/b)

Corpo do D2.

Por que isso importa: idem.
`;

function page(slug: string, missing: string[] = [], utmContent: string | null = `page-${slug}`): ResolvedFacebookPage {
  return { slug, enabled: slug === "diaria", pageId: missing.length ? "" : `id-${slug}`, token: missing.length ? "" : "tok", missing, utmContent };
}

describe("#10769 metadados e legendas", () => {
  it("nome do arquivo curto segue a convenção ao lado do longo", () => {
    assert.equal(shortVideoFileName("261022"), "diaria-comentada-261022-short.mp4");
  });

  it("firstSentence tira markdown e para na 1ª frase", () => {
    assert.equal(firstSentence(D1.body), "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros.");
    const long = `${"palavra ".repeat(60)}fim.`;
    const cut = firstSentence(long, 50);
    assert.ok(Array.from(cut).length <= 50);
    assert.ok(cut.endsWith("…"));
  });

  it("título do Short é `{D1} #Shorts` e respeita 100 caracteres", () => {
    assert.equal(buildYouTubeShortTitle(D1.title), "Você já viu IA mentir. Já viu roubar? #Shorts");
    const t = buildYouTubeShortTitle("x".repeat(200));
    assert.equal(Array.from(t).length, 100);
    assert.ok(t.endsWith("… #Shorts"));
  });

  it("Short: descrição curta com #Shorts e link da edição no comentário fixado com utm_medium=shorts", () => {
    const m = buildYouTubeShortMetadata({ aammdd: "261022", d1: D1, editionUrl: EDITION_URL });
    assert.match(m.description, /^Um modelo da OpenAI/);
    assert.match(m.description, /#Shorts/);
    assert.ok(!m.description.includes("http"), "link na descrição de Short não é clicável — vai no comentário");
    assert.equal(
      m.pinnedComment,
      `Leia a edição completa: ${EDITION_URL}?utm_source=youtube&utm_medium=shorts&utm_campaign=261022`,
    );
  });

  it("Reels Facebook: CTA do canal + link da edição com UTM da página", () => {
    const c = buildReelsCaption({ platform: "facebook", aammdd: "261022", d1: D1, editionUrl: EDITION_URL, utmContent: "page-memelab" });
    assert.match(c, /^Você já viu IA mentir/);
    assert.match(c, /youtube\.com\/@diariabr/);
    assert.match(c, /utm_source=facebook&utm_medium=reels&utm_campaign=261022&utm_content=page-memelab/);
  });

  it("Reels Facebook da página diar.ia.br (utm_content null) não ganha tag", () => {
    const c = buildReelsCaption({ platform: "facebook", aammdd: "261022", d1: D1, editionUrl: EDITION_URL, utmContent: null });
    assert.ok(!c.includes("utm_content"));
  });

  it("Reels Instagram: link da bio, sem URL da edição", () => {
    const c = buildReelsCaption({ platform: "instagram", aammdd: "261022", d1: D1, editionUrl: EDITION_URL });
    assert.match(c, /link da bio/);
    assert.ok(!c.includes("diar.ia.br/p/"));
  });
});

describe("#10769 config e destinos", () => {
  it("config ausente → decisão do editor (diar.ia.br, VJ Pixel, MemeLab + Instagram)", () => {
    assert.deepEqual(loadShortsConfig({}), DEFAULT_SHORTS_CONFIG);
  });

  it("config inválido lança (nunca vira 'publica em lugar nenhum' calado)", () => {
    const mk = (shorts: unknown) => ({ publishing: { shorts } });
    assert.throws(() => loadShortsConfig(mk({ facebook_pages: "diaria", instagram: true })));
    assert.throws(() => loadShortsConfig(mk({ facebook_pages: ["diaria", "diaria"], instagram: true })));
    assert.throws(() => loadShortsConfig(mk({ facebook_pages: ["diaria"] })));
  });

  it("o platform.config.json real é válido e todo slug de shorts existe em social.facebook.pages", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const shorts = loadShortsConfig(config);
    const slugs = loadFacebookPagesConfig(config).map((p) => p.slug);
    for (const s of shorts.facebookPages) assert.ok(slugs.includes(s), `slug ${s} sem página configurada`);
    assert.deepEqual(shorts.facebookPages, ["diaria", "vjpixel", "memelab"]);
  });

  it("páginas fora da rotina (Jandig, Teatro vs Game, Criaturas Afetivas) não entram no default", () => {
    const ids = listShortDestinations(DEFAULT_SHORTS_CONFIG).map((d) => d.id);
    assert.deepEqual(ids, ["youtube_shorts", "facebook:diaria", "facebook:vjpixel", "facebook:memelab", "instagram", "facebook_profile"]);
  });

  it("idempotência: published/scheduled contam como feito, processing não", () => {
    let f = { aammdd: "261022", entries: [] as any[] };
    f = upsertShortEntry(f, { destination: "instagram", status: "processing", id: "1", at: "x" });
    assert.equal(isDestinationDone(f, "instagram"), false);
    f = upsertShortEntry(f, { destination: "instagram", status: "published", id: "2", at: "y" });
    assert.equal(f.entries.length, 1);
    assert.equal(isDestinationDone(f, "instagram"), true);
  });

  it("horário: agenda com >10 min de folga, senão publica na hora", () => {
    const target = "2026-10-22T09:00:00.000Z";
    assert.deepEqual(resolveReelsSchedule(target, new Date("2026-10-22T03:00:00Z")), { mode: "scheduled", at: target });
    assert.deepEqual(resolveReelsSchedule(target, new Date("2026-10-22T08:55:00Z")), { mode: "immediate" });
    assert.deepEqual(resolveReelsSchedule(target, new Date("2026-10-22T12:00:00Z")), { mode: "immediate" });
  });
});

describe("#10769 plano do publish-shorts", () => {
  const base = {
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: {},
    pages: [page("diaria", [], null), page("vjpixel", ["FACEBOOK_VJPIXEL_PAGE_ACCESS_TOKEN"]), page("memelab")],
    instagramReady: true,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: EDITION_URL,
  };

  it("antes das 06:00 BRT: Facebook agenda, Instagram fica pendente, página sem token é pulada com aviso", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z") });
    const by = Object.fromEntries(plan.items.map((i) => [i.destination, i]));
    assert.equal(by["facebook:diaria"].action, "publish");
    assert.equal(by["facebook:diaria"].scheduledAt, "2026-10-22T09:00:00.000Z");
    assert.equal(by["facebook:vjpixel"].action, "skip_missing_credentials");
    assert.equal(by["facebook:memelab"].action, "publish");
    assert.equal(by["instagram"].action, "pending_schedule");
    assert.equal(by["youtube_shorts"].action, "guided");
    assert.equal(by["facebook_profile"].action, "guided");
    assert.ok(plan.warnings.some((w) => w.includes("facebook:vjpixel")));
  });

  it("depois das 06:00 (ou --now): tudo na hora, Instagram publica", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T03:00:00Z"), forceNow: true });
    const ig = plan.items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "publish");
    assert.equal(plan.items.find((i) => i.destination === "facebook:diaria")!.scheduledAt, null);
  });

  it("destino já registrado é pulado; --only restringe", () => {
    const plan = planShortsPublish({
      ...base,
      now: new Date("2026-10-22T12:00:00Z"),
      published: { aammdd: "261022", entries: [{ destination: "facebook:diaria", status: "published", id: "9", at: "z" }] },
      only: ["facebook:diaria", "instagram"],
    });
    assert.deepEqual(plan.items.map((i) => [i.destination, i.action]), [["facebook:diaria", "skip_done"], ["instagram", "publish"]]);
  });

  it("YouTube Shorts sai com os metadados guiados", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T12:00:00Z") });
    assert.equal(plan.youtube.title, "Você já viu IA mentir. Já viu roubar? #Shorts");
    assert.equal(plan.longVideo, "diaria-comentada-261022.mp4");
  });
});

describe("#10769 facebook-page-token-setup", () => {
  const configPages = loadFacebookPagesConfig({
    publishing: {
      social: {
        facebook: {
          pages: [
            { slug: "diaria", enabled: true, page_id_env: "FACEBOOK_PAGE_ID", token_env: "FACEBOOK_PAGE_ACCESS_TOKEN" },
            { slug: "vjpixel", enabled: false, page_id_env: "FACEBOOK_VJPIXEL_PAGE_ID", token_env: "FACEBOOK_VJPIXEL_PAGE_ACCESS_TOKEN" },
            { slug: "memelab", enabled: false, page_id_env: "FACEBOOK_MEMELAB_PAGE_ID", token_env: "FACEBOOK_MEMELAB_PAGE_ACCESS_TOKEN" },
          ],
        },
      },
    },
  });

  it("casa slug pelo page_id e recusa página não administrada ou sem CREATE_CONTENT", () => {
    const accounts = [
      { id: "937293496367847", name: "VJ pixel", access_token: "t1", tasks: ["CREATE_CONTENT", "MODERATE"] },
      { id: "179134132104104", name: "MemeLab", access_token: "t2", tasks: ["ANALYZE"] },
    ];
    const r = matchPages(["vjpixel", "memelab", "diaria", "jandig"], configPages, accounts, {
      vjpixel: "937293496367847",
      memelab: "179134132104104",
      diaria: "111",
    });
    assert.equal(r[0].ok, true);
    assert.equal(r[1].ok, false);
    assert.match((r[1] as any).reason, /CREATE_CONTENT/);
    assert.match((r[2] as any).reason, /não administra/);
    assert.match((r[3] as any).reason, /não existe/);
  });
});
