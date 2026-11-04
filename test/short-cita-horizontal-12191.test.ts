/**
 * test/short-cita-horizontal-12191.test.ts (#12191, #12077 item 4)
 *
 * A descrição do YouTube Short cita o vídeo horizontal do dia por título, só
 * texto (link em descrição de Short não é clicável, #10831; nenhum texto do
 * vertical leva link, #11617). Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORT_HORIZONTAL_CITATION_PREFIX,
  buildShortHorizontalCitation,
  buildYouTubeShortMetadata,
  resolveShortHorizontalTitle,
} from "../scripts/lib/diaria/short-video.ts";
import { planScheduledUpdates } from "../scripts/lib/diaria/short-scheduled-update.ts";
import { planShortsPublish, readHorizontalVideoForShort } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const D1 = {
  title: "Você já viu IA mentir. Já viu roubar?",
  body: "Um modelo da **OpenAI** gastou o saldo de uma [carteira](https://x.com/a) de terceiros. O caso foi descoberto depois.",
};

const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null };
}

const base = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  config: {
    publishing: {
      shorts: {
        facebook_pages: ["diaria"],
        instagram: false,
        schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" },
      },
    },
  },
  pages: [page("diaria")],
  instagramReady: false,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: "https://diar.ia.br/p/x",
  now: new Date("2026-10-22T03:00:00Z"),
};

describe("#12191 citação do horizontal na descrição do Short", () => {
  it("descrição: gancho, citação do horizontal, hashtags — sem link nem domínio", () => {
    const m = buildYouTubeShortMetadata({ d1: D1, horizontalTitle: "IA que rouba: o caso da carteira" });
    assert.equal(
      m.description,
      `Um modelo da OpenAI gastou o saldo de uma carteira de terceiros.\n\n${SHORT_HORIZONTAL_CITATION_PREFIX} “IA que rouba: o caso da carteira”\n\n#Shorts #IA #inteligênciaartificial`,
    );
    assert.ok(!m.description.includes("http"));
    assert.doesNotMatch(m.description, /diar\.ia\.br|youtu/, "#11617: nem domínio nem link");
  });

  it("sem título do horizontal, a descrição fica como antes (gancho + hashtags)", () => {
    for (const horizontalTitle of [undefined, null, "", "   "]) {
      const m = buildYouTubeShortMetadata({ d1: D1, horizontalTitle });
      assert.equal(m.description, "Um modelo da OpenAI gastou o saldo de uma carteira de terceiros.\n\n#Shorts #IA #inteligênciaartificial");
    }
  });

  it("citação sanitiza o título (sem markdown; < > trocados, a API recusa)", () => {
    assert.equal(buildShortHorizontalCitation("**Novo** <modelo>"), `${SHORT_HORIZONTAL_CITATION_PREFIX} “Novo ‹modelo›”`);
  });

  it("título: registro do upload vence; sem ele, o derivado do D1; edição sem vídeo, nada", () => {
    assert.equal(resolveShortHorizontalTitle({ d1Title: D1.title, recordTitle: "Título do --title" }), "Título do --title");
    assert.equal(resolveShortHorizontalTitle({ d1Title: D1.title, recordTitle: null }), D1.title);
    assert.equal(resolveShortHorizontalTitle({ d1Title: D1.title, recordTitle: "  " }), D1.title);
    assert.equal(resolveShortHorizontalTitle({ d1Title: D1.title, recordTitle: "x", noVideo: true }), null);
  });

  it("plano da edição: descrição do Short cita o horizontal do registro e a premissa diz a fonte", () => {
    const plan = planShortsPublish({ ...base, horizontalVideo: { recordTitle: "Horizontal do dia", noVideo: false } });
    assert.match(plan.youtube.description, /\n\nVídeo completo no canal: “Horizontal do dia”\n\n#Shorts/);
    assert.ok(plan.premises.some((p) => p.includes("cita o horizontal") && p.includes("registro do upload")));
  });

  it("plano sem registro do upload: cita o título derivado do D1", () => {
    const plan = planShortsPublish(base);
    assert.ok(plan.youtube.description.includes(`${SHORT_HORIZONTAL_CITATION_PREFIX} “${D1.title}”`));
    assert.ok(plan.premises.some((p) => p.includes("derivado do D1")));
  });

  it("plano de edição marcada sem vídeo: sem citação", () => {
    const plan = planShortsPublish({ ...base, horizontalVideo: { recordTitle: null, noVideo: true } });
    assert.ok(!plan.youtube.description.includes(SHORT_HORIZONTAL_CITATION_PREFIX));
  });

  it("--update-scheduled mantém a citação na descrição do Short", () => {
    const items = planScheduledUpdates({
      entries: [{ destination: "youtube_shorts", status: "scheduled", id: "abc", scheduled_at: "2026-10-22T15:00:00.000Z" } as any],
      d1: D1,
      now: new Date("2026-10-22T03:00:00Z"),
      coverPresent: false,
      horizontalTitle: "Horizontal do dia",
    });
    const yt = items.find((i) => i.destination === "youtube_shorts");
    assert.equal(yt?.action, "update_youtube");
    assert.ok(yt && yt.action === "update_youtube" && yt.description.includes("“Horizontal do dia”"));
  });

  it("readHorizontalVideoForShort: título do registro, ausência e arquivo ilegível (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "short-12191-"));
    try {
      assert.deepEqual(readHorizontalVideoForShort(dir), { recordTitle: null, noVideo: false });
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ videoId: "v1", title: " Do registro " }));
      assert.deepEqual(readHorizontalVideoForShort(dir), { recordTitle: "Do registro", noVideo: false });
      writeFileSync(join(dir, "_internal", "05-youtube-published.json"), "{nao-json");
      assert.deepEqual(readHorizontalVideoForShort(dir), { recordTitle: null, noVideo: false });
      writeFileSync(join(dir, "_internal", "no-video.json"), "{}");
      assert.equal(readHorizontalVideoForShort(dir).noVideo, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
