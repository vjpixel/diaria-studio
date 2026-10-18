/**
 * test/render-social-publish-additions-10451.test.ts (#10451)
 *
 * O preview social do gate 4 não mostrava as linhas que o publish acrescenta
 * (CTA de canal + linha de engajamento, `injectChannelLine`) nem o título da
 * 1ª linha da legenda do `## um` (#10201). O editor viu a legenda do
 * Instagram do USE MELHOR sem "Manda pra quem precisa disso." e leu como bug.
 *
 * Trava o PAR preview × publish: corpo do preview + acréscimos do canal +
 * hashtags = texto que o publicador monta, a partir do MESMO `03-social.md`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import type { UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import { toSocialPostText } from "../scripts/lib/social-post-text.ts";
import {
  CHANNEL_CTA_LINES,
  FACEBOOK_CTA_LINE,
  INSTAGRAM_CTA_LINE,
  INSTAGRAM_ENGAGEMENT_LINE,
  INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE,
  channelPublishLines,
  injectChannelLine,
} from "../scripts/lib/social-cta-lines.ts";
import { extractPostText as extractInstagram, buildUseMelhorInstagramPost } from "../scripts/publish-instagram.ts";
import { extractPostText as extractFacebook, buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import {
  buildSocialHtml,
  groupByDestaque,
  parsePlatforms,
  publishAdditionsFor,
  type GroupedBlock,
} from "../scripts/render-social-html.ts";

const TITLE = "Seis usos do assistente no trabalho";
const UM = [
  "1) **Peça o primeiro rascunho** de e-mails.\n2) **Resuma documentos longos** pedindo os pontos.",
  "3) **Prepare reuniões** pedindo a pauta.",
  "#Produtividade #IA",
].join("\n\n");
const MD = [
  "# Social", "", "## d1", "", "Texto do **destaque** um.", "", "Segundo parágrafo.", "", "#Tag #Outra", "",
  "## um", "", UM, "",
  "# Curto", "", "## d1", "", "Curto. #Tag", "", "## um", "", "Curto do um.", "",
].join("\n");

const slots = buildUseMelhorSlides(UM, TITLE).map((s) => s.slot);
const plan: UseMelhorReadyPlan = {
  status: "ready",
  time: "08:00",
  item: { url: "https://example.com/guia", title: TITLE, summary: "S", score: 80 },
  slots,
  captionTitle: TITLE,
};
const images: Record<string, { url?: string }> = {};
for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };

function blocks(key: string, title?: string): GroupedBlock[] {
  const g = groupByDestaque(parsePlatforms(MD), {}, "1", title).find((x) => x.key === key);
  assert.ok(g, `grupo ${key} existe`);
  return g.blocks;
}
function blockFor(key: string, label: string, title?: string): GroupedBlock {
  const b = blocks(key, title).find((x) => x.channels.includes(label));
  assert.ok(b, `bloco ${key} com ${label}`);
  return b;
}
/** O que o preview diz que vai ao ar no canal: corpo + acréscimos + hashtags. */
function previewPublished(block: GroupedBlock, channelLabel: string): string {
  const added = block.publishAdditions?.find((a) => a.channel.includes(channelLabel))?.lines ?? [];
  return [toSocialPostText(block.post.main), ...added, block.post.hashtags].filter(Boolean).join("\n\n");
}

describe("#10451 — preview mostra o que o publish acrescenta", () => {
  it("d1 no Instagram: preview reconstrói o texto de extractPostText (CTA + engajamento de notícia)", () => {
    const b = blockFor("d1", "Instagram");
    assert.equal(previewPublished(b, "Instagram"), extractInstagram(MD, "d1"));
    const ig = b.publishAdditions?.find((a) => a.channel.includes("Instagram"));
    assert.deepEqual(ig?.lines, [INSTAGRAM_CTA_LINE, INSTAGRAM_ENGAGEMENT_LINE]);
  });

  it("d1 no Facebook: preview reconstrói o texto publicado (CTA de assinatura)", () => {
    const b = blockFor("d1", "Facebook");
    assert.equal(previewPublished(b, "Facebook"), extractFacebook(MD, "facebook", "d1"));
  });

  it("LinkedIn não recebe acréscimo nenhum", () => {
    for (const key of ["d1", "um"]) {
      for (const b of blocks(key, TITLE)) {
        assert.ok(!b.publishAdditions?.some((a) => a.channel.includes("LinkedIn")), `${key}: ${b.channels}`);
      }
    }
  });

  it("um no Instagram: título + linha de engajamento PRÓPRIA, igual a buildUseMelhorInstagramPost", () => {
    const b = blockFor("um", "Instagram", TITLE);
    const r = buildUseMelhorInstagramPost({ socialMd: MD, plan, images, editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(previewPublished(b, "Instagram"), r.caption);
    const lines = b.publishAdditions?.find((a) => a.channel.includes("Instagram"))?.lines ?? [];
    assert.ok(lines.includes(INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE));
    assert.ok(!lines.includes(INSTAGRAM_ENGAGEMENT_LINE), "linha de notícia não vai no 4º post");
  });

  it("um no Facebook e no LinkedIn: título no topo, igual aos publicadores", () => {
    const fb = buildUseMelhorFacebookPost({ socialMd: MD, plan, images, editionDir: "x", fileExists: () => false });
    assert.ok(fb.ok, JSON.stringify(fb));
    if (fb.ok) assert.equal(previewPublished(blockFor("um", "Facebook", TITLE), "Facebook"), fb.caption);
    const li = buildUseMelhorLinkedInPost({ socialMd: MD, plan, images });
    assert.ok(li.ok, JSON.stringify(li));
    if (li.ok) assert.equal(previewPublished(blockFor("um", "LinkedIn", TITLE), "LinkedIn"), li.text);
  });

  it("sem título resolvido, o preview do um não inventa título", () => {
    assert.doesNotMatch(blockFor("um", "Instagram").post.main, new RegExp(TITLE));
  });

  it("# Curto (X/Threads) não recebe título nem acréscimo", () => {
    for (const b of blocks("um", TITLE).filter((x) => x.channels.includes("Threads"))) {
      assert.equal(b.publishAdditions, undefined);
      assert.doesNotMatch(b.post.main, new RegExp(TITLE));
    }
    assert.deepEqual(publishAdditionsFor("Curto", "d1"), []);
  });

  it("injectChannelLine usa as mesmas linhas de channelPublishLines (fonte única)", () => {
    for (const ch of Object.keys(CHANNEL_CTA_LINES) as (keyof typeof CHANNEL_CTA_LINES)[]) {
      for (const useMelhor of [false, true]) {
        const expected = ["corpo", ...channelPublishLines(ch, { useMelhor }), "#t"].join("\n\n");
        assert.equal(injectChannelLine("corpo\n\n#t", ch, { useMelhor }), expected);
      }
    }
  });

  it("HTML mostra os acréscimos à parte, marcados como vindos da publicação", () => {
    const html = buildSocialHtml(parsePlatforms(MD), {}, "1", undefined, undefined, TITLE);
    assert.match(html, /Acrescentado na publicação/);
    assert.ok(html.includes(INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE));
    assert.ok(html.includes(FACEBOOK_CTA_LINE.replace(/&/g, "&amp;")));
    assert.ok(html.includes(`<p>${TITLE}</p>`));
  });
});
