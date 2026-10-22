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
  FACEBOOK_REELS_API_MAX_SECONDS,
  facebookUploadRoute,
  isDestinationDone,
  listShortDestinations,
  loadShortsConfig,
  mp4DurationSeconds,
  parseShortsPublishedFile,
  resolveReelsSchedule,
  shortVideoFileName,
  upsertShortEntry,
} from "../scripts/lib/diaria/short-video.ts";
import { parseMarkArg, planShortsPublish, publishFacebookReel, publishInstagramReel, type GraphDeps } from "../scripts/publish-shorts.ts";
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

  it("Short nunca cita a fonte individual na descrição nem no comentário (#10799)", () => {
    const m = buildYouTubeShortMetadata({ aammdd: "261022", d1: D1, editionUrl: EDITION_URL });
    assert.doesNotMatch(m.description, /^Fonte:/m);
    assert.ok(!m.description.includes(D1.url));
    assert.ok(!m.pinnedComment.includes(D1.url));
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

  it("idempotência: destino registrado conta como feito; upsert mantém 1 entrada por destino", () => {
    let f = { aammdd: "261022", entries: [] as any[] };
    assert.equal(isDestinationDone(f, "instagram"), false);
    f = upsertShortEntry(f, { destination: "instagram", status: "scheduled", id: "1", at: "x" });
    f = upsertShortEntry(f, { destination: "instagram", status: "published", id: "2", at: "y" });
    assert.equal(f.entries.length, 1);
    assert.equal(isDestinationDone(f, "instagram"), true);
  });

  it("registro ilegível ABORTA em vez de virar 'nada publicado' (evita Reels duplicados)", () => {
    const ok = JSON.stringify({ aammdd: "261022", entries: [{ destination: "instagram", status: "published", id: "1", at: "x" }] });
    assert.equal(parseShortsPublishedFile(ok, "261022").entries.length, 1);
    assert.throws(() => parseShortsPublishedFile("{", "261022"), /JSON inválido/);
    assert.throws(() => parseShortsPublishedFile(JSON.stringify({ aammdd: "261022" }), "261022"), /entries/);
    assert.throws(() => parseShortsPublishedFile(JSON.stringify({ aammdd: "261022", entries: {} }), "261022"), /entries/);
    assert.throws(() => parseShortsPublishedFile(ok, "261023"), /edição 261022/);
    assert.throws(
      () => parseShortsPublishedFile(JSON.stringify({ aammdd: "261022", entries: [{ destination: "instagram", status: "processing", id: "1" }] }), "261022"),
      /status inválido/,
    );
  });

  it("publishing.shorts null/não-objeto lança com mensagem clara", () => {
    assert.throws(() => loadShortsConfig({ publishing: { shorts: null } }), /precisa ser um objeto/);
    assert.throws(() => loadShortsConfig({ publishing: { shorts: 5 } }), /precisa ser um objeto/);
  });

  it("instagram: false tira o Instagram dos destinos", () => {
    const ids = listShortDestinations({ facebookPages: ["diaria"], instagram: false }).map((d) => d.id);
    assert.deepEqual(ids, ["youtube_shorts", "facebook:diaria", "facebook_profile"]);
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
    assert.equal((plan.items.find((i) => i.destination === "facebook:diaria") as { scheduledAt: string | null }).scheduledAt, null);
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

  it("slug de shorts sem página configurada LANÇA (typo nunca vira 'publica em lugar nenhum')", () => {
    assert.throws(
      () => planShortsPublish({ ...base, now: new Date(), config: { publishing: { shorts: { facebook_pages: ["diaria", "memlab"], instagram: true } } } }),
      /memlab/,
    );
  });

  it("--only com destino desconhecido LANÇA em vez de publicar nada com exit 0", () => {
    assert.throws(() => planShortsPublish({ ...base, now: new Date(), only: ["facebook:vjpxel"] }), /desconhecido: facebook:vjpxel/);
  });

  it("sem --edition-url, o link derivado do título vira AVISO (não premissa silenciosa)", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T12:00:00Z"), editionUrl: undefined });
    assert.equal(plan.editionUrl, EDITION_URL);
    assert.ok(plan.warnings.some((w) => w.includes("derivado do slug")));
  });

  it("instagramReady false → skip com aviso; perfil pessoal sai com utm_content=perfil", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T12:00:00Z"), instagramReady: false });
    const by = Object.fromEntries(plan.items.map((i) => [i.destination, i])) as any;
    assert.equal(by.instagram.action, "skip_missing_credentials");
    assert.match(by.facebook_profile.caption, /utm_content=perfil/);
  });

  it("YouTube Shorts sai com os metadados guiados", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T12:00:00Z") });
    assert.equal(plan.youtube.title, "Você já viu IA mentir. Já viu roubar? #Shorts");
    assert.equal(plan.longVideo, "diaria-comentada-261022.mp4");
  });
});

describe("#10769 duração e rota do Facebook", () => {
  function box(type: string, payload: Buffer): Buffer {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, "latin1");
    return Buffer.concat([h, payload]);
  }
  function mvhdV0(timescale: number, duration: number): Buffer {
    const p = Buffer.alloc(100);
    p.writeUInt8(0, 0);
    p.writeUInt32BE(timescale, 12);
    p.writeUInt32BE(duration, 16);
    return box("mvhd", p);
  }

  it("lê a duração do moov/mvhd (v0), pulando caixas antes do moov", () => {
    const mp4 = Buffer.concat([box("ftyp", Buffer.alloc(16)), box("mdat", Buffer.alloc(32)), box("moov", mvhdV0(1000, 120_500))]);
    assert.equal(mp4DurationSeconds(mp4), 120.5);
  });

  it("lê mvhd v1 (64 bits)", () => {
    const p = Buffer.alloc(112);
    p.writeUInt8(1, 0);
    p.writeUInt32BE(600, 20);
    p.writeBigUInt64BE(BigInt(600 * 45), 24);
    assert.equal(mp4DurationSeconds(box("moov", box("mvhd", p))), 45);
  });

  it("arquivo sem moov ou truncado → null, sem lançar", () => {
    assert.equal(mp4DurationSeconds(box("ftyp", Buffer.alloc(8))), null);
    assert.equal(mp4DurationSeconds(Buffer.from([0, 0, 0, 99, 0x6d, 0x6f, 0x6f, 0x76])), null);
  });

  it(`até ${FACEBOOK_REELS_API_MAX_SECONDS} s vai por video_reels; acima, ou desconhecida, por /videos`, () => {
    assert.equal(facebookUploadRoute(90), "video_reels");
    assert.equal(facebookUploadRoute(120), "videos");
    assert.equal(facebookUploadRoute(null), "videos");
  });
});

describe("#10769 --mark", () => {
  it("só destinos guiados e só URL http(s)", () => {
    assert.deepEqual(parseMarkArg("youtube_shorts=https://youtube.com/shorts/x"), { destination: "youtube_shorts", url: "https://youtube.com/shorts/x" });
    assert.throws(() => parseMarkArg("instagram=https://x"), /destinos guiados/);
    assert.throws(() => parseMarkArg("youtube_short=https://x"), /destinos guiados/);
    assert.throws(() => parseMarkArg("youtube_shorts=nao-e-url"), /http/);
  });
});

describe("#10769 fluxos da Graph API (fetch falso)", () => {
  type Call = { url: string; body: any; headers: any };
  function fakeDeps(responses: Array<(c: Call) => any>, now = new Date("2026-10-22T12:00:00Z")): { deps: GraphDeps; calls: Call[] } {
    const calls: Call[] = [];
    let i = 0;
    const deps: GraphDeps = {
      fetch: async (url, init) => {
        let body: any = null;
        if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
        else if (init?.body instanceof FormData) body = Object.fromEntries([...init.body].filter(([, v]) => typeof v === "string"));
        else if (init?.body) body = "<binary>";
        const call = { url, body, headers: init?.headers ?? {} };
        calls.push(call);
        const r = responses[i++];
        if (!r) throw new Error(`chamada inesperada: ${url}`);
        const out = r(call);
        const { __http, ...json } = out;
        return new Response(JSON.stringify(json), { status: __http ?? 200 });
      },
      sleep: async () => {},
      now: () => now,
      log: () => {},
    };
    return { deps, calls };
  }
  const page = { slug: "memelab", enabled: false, pageId: "179", token: "tok", missing: [] as string[], utmContent: "page-memelab" };
  function shortMp4(seconds: number): Buffer {
    const p = Buffer.alloc(100);
    p.writeUInt32BE(1000, 12);
    p.writeUInt32BE(seconds * 1000, 16);
    const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 108, 0x6d, 0x76, 0x68, 0x64]), p]);
    return Buffer.concat([Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), Buffer.from([0, 0, 0, 116, 0x6d, 0x6f, 0x6f, 0x76]), mvhd]);
  }
  const short = shortMp4(60);

  it("Facebook ≤90 s agendado: start → rupload → finish SCHEDULED com epoch em segundos → status pronto", async () => {
    const { deps, calls } = fakeDeps([
      () => ({ video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v25.0/v1" }),
      () => ({ success: true }),
      () => ({ success: true }),
      () => ({ status: { video_status: "ready" } }),
    ]);
    const out = await publishFacebookReel(deps, page, "v25.0", short, "legenda", "2026-10-23T09:00:00.000Z");
    assert.match(calls[0].url, /\/179\/video_reels$/);
    assert.equal(calls[1].headers.Authorization, "OAuth tok");
    assert.equal(calls[2].body.video_state, "SCHEDULED");
    assert.equal(calls[2].body.scheduled_publish_time, String(Date.parse("2026-10-23T09:00:00.000Z") / 1000));
    assert.equal(out.entry.destination, "facebook:memelab");
    assert.equal(out.entry.status, "scheduled");
    assert.equal(out.unconfirmed, false);
  });

  it("Facebook: horário a menos de 10 min na hora do finish → publica na hora", async () => {
    const { deps, calls } = fakeDeps(
      [() => ({ video_id: "v1" }), () => ({ success: true }), () => ({ success: true }), () => ({ status: { video_status: "ready" } })],
      new Date("2026-10-23T08:55:00Z"),
    );
    const out = await publishFacebookReel(deps, page, "v25.0", short, "legenda", "2026-10-23T09:00:00.000Z");
    assert.equal(calls[2].body.video_state, "PUBLISHED");
    assert.equal(out.entry.status, "published");
  });

  it("Facebook: rupload sem success:true e erro de processamento LANÇAM", async () => {
    const a = fakeDeps([() => ({ video_id: "v1" }), () => ({})]);
    await assert.rejects(publishFacebookReel(a.deps, page, "v25.0", short, "x", null), /rupload/);
    const b = fakeDeps([() => ({ video_id: "v1" }), () => ({ success: true }), () => ({ success: true }), () => ({ status: { video_status: "error" } })]);
    await assert.rejects(publishFacebookReel(b.deps, page, "v25.0", short, "x", null), /recusou o vídeo/);
  });

  it("Facebook >90 s vai por /videos multipart (agendado com published=false)", async () => {
    const { deps, calls } = fakeDeps([() => ({ id: "v9" }), () => ({ status: { video_status: "ready" } })]);
    const out = await publishFacebookReel(deps, page, "v25.0", shortMp4(120), "legenda", "2026-10-23T09:00:00.000Z");
    assert.match(calls[0].url, /graph-video\.facebook\.com\/v25\.0\/179\/videos$/);
    assert.equal(calls[0].body.description, "legenda");
    assert.equal(calls[0].body.published, "false");
    assert.equal(out.entry.id, "v9");
    assert.equal(out.entry.status, "scheduled");
  });

  it("Instagram: container → rupload → poll tolera falha transitória → FINISHED → publish → permalink", async () => {
    const { deps, calls } = fakeDeps([
      () => ({ id: "c1", uri: "https://rupload.facebook.com/ig-api-upload/v25.0/c1" }),
      () => ({ success: true }),
      () => ({ __http: 500, error: { message: "tmp" } }),
      () => ({ status_code: "IN_PROGRESS" }),
      () => ({ status_code: "FINISHED" }),
      () => ({ id: "m1" }),
      () => ({ permalink: "https://instagram.com/reel/m1" }),
    ]);
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", short, "legenda");
    assert.equal(calls[0].body.media_type, "REELS");
    assert.equal(calls[0].body.upload_type, "resumable");
    assert.equal(out.entry.url, "https://instagram.com/reel/m1");
  });

  it("Instagram: container ERROR e media_publish sem id LANÇAM", async () => {
    const a = fakeDeps([() => ({ id: "c1" }), () => ({ success: true }), () => ({ status_code: "ERROR", status: "codec" })]);
    await assert.rejects(publishInstagramReel(a.deps, "ig", "tok", "v25.0", short, "x"), /ERROR/);
    const b = fakeDeps([() => ({ id: "c1" }), () => ({ success: true }), () => ({ status_code: "FINISHED" }), () => ({})]);
    await assert.rejects(publishInstagramReel(b.deps, "ig", "tok", "v25.0", short, "x"), /media_publish sem id/);
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
    assert.equal((r[0] as any).page.access_token, "t1");
    assert.equal(r[1].ok, false);
    assert.match((r[1] as any).reason, /CREATE_CONTENT/);
    assert.match((r[2] as any).reason, /não administra/);
    assert.match((r[3] as any).reason, /não existe/);
  });

  it("resposta sem `tasks` falha FECHADA (não persiste token sem prova de permissão)", () => {
    const r = matchPages(["vjpixel"], configPages, [{ id: "937293496367847", name: "VJ pixel", access_token: "t1" }], { vjpixel: "937293496367847" });
    assert.equal(r[0].ok, false);
  });
});
