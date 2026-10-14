/**
 * test/use-melhor-caption-title-10201.test.ts (#10201)
 *
 * Post USE MELHOR (`## um`), achado na edição 261014:
 *   1. a legenda começava no "1)" sem dizer do que se tratava — os
 *      publicadores (Instagram, LinkedIn página, LinkedIn pessoal, Facebook)
 *      agora põem o título do item como 1ª linha, determinístico, sem mexer
 *      no `## um` que alimenta os cards;
 *   2. a linha de engajamento dos destaques ("…que ainda subestima isso") não
 *      encaixava num tutorial — o `## um` tem linha própria no Instagram.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  planUseMelhorDispatchFrom,
  prependUseMelhorCaptionTitle,
  type UseMelhorReadyPlan,
} from "../scripts/lib/use-melhor-dispatch.ts";
import {
  CHANNEL_ENGAGEMENT_LINES,
  INSTAGRAM_ENGAGEMENT_LINE,
  INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE,
  USE_MELHOR_ENGAGEMENT_LINES,
  injectChannelLine,
} from "../scripts/lib/social-cta-lines.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorInstagramPost, extractPostText as extractInstagramPostText } from "../scripts/publish-instagram.ts";
import { extractPersonalPostText, resolvePersonalPost } from "../scripts/resolve-post-pixel.ts";
import { buildUseMelhorSlides, hashUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";

const TITLE = "Como saber se a assinatura de IA se paga";
const ITEM = { url: "https://exemplo.com/roi-assinatura", title: TITLE, summary: "Resumo.", score: 90 };
const APPROVED = { use_melhor: [{ url: ITEM.url, title: ITEM.title, summary: ITEM.summary, score: ITEM.score }] };
const REVIEWED = `**USE MELHOR**\n\n[${ITEM.title}](${ITEM.url})\nResumo.\n`;
const UM_SOCIAL = [
  "1) Some o custo total da assinatura: plano principal, extras e add-ons.",
  "2) Estime as horas poupadas por semana nas tarefas que você já faz.",
  "3) Compare o valor dessas horas com o custo mensal.",
  "#Produtividade #IA",
].join("\n\n");
const SOCIAL_MD = ["# Social", "", "## d1", "", "Notícia do dia.", "", "#Tag", "", "## um", "", UM_SOCIAL, ""].join("\n");

const SLIDES = buildUseMelhorSlides(UM_SOCIAL, TITLE);
const SLOTS = SLIDES.map((s) => s.slot);
const IMAGES: Record<string, { url?: string }> = Object.fromEntries(
  SLOTS.map((s) => [useMelhorSlideImageKey(s), { url: `https://cdn/um-${s}.jpg` }]),
);

function plan(captionTitle: string | undefined = TITLE): UseMelhorReadyPlan {
  return { status: "ready", time: "07:45", item: ITEM, slots: SLOTS, ...(captionTitle !== undefined && { captionTitle }) };
}

describe("#10201 item 1 — título do item como 1ª linha da legenda", () => {
  it("planUseMelhorDispatchFrom preenche captionTitle com o título da capa", () => {
    const p = planUseMelhorDispatchFrom({
      config: { publishing: { social: { use_melhor_time: "07:45" } } },
      state: { enabled: true, time: "07:45", item: ITEM, generated_at: "x" },
      reviewedMd: REVIEWED,
      approved: APPROVED,
      socialUm: UM_SOCIAL,
      stamp: { hash: hashUseMelhorSlides(SLIDES), slots: SLOTS },
      ctaOverride: null,
    });
    assert.equal(p.status, "ready");
    if (p.status === "ready") assert.equal(p.captionTitle, TITLE);
  });

  it("prependUseMelhorCaptionTitle: título + linha em branco + corpo; sem título não mexe; não duplica", () => {
    assert.equal(prependUseMelhorCaptionTitle("1) Passo.", TITLE), `${TITLE}\n\n1) Passo.`);
    assert.equal(prependUseMelhorCaptionTitle("1) Passo.", undefined), "1) Passo.");
    assert.equal(prependUseMelhorCaptionTitle("1) Passo.", "  "), "1) Passo.");
    const already = `${TITLE}\n\n1) Passo.`;
    assert.equal(prependUseMelhorCaptionTitle(already, TITLE), already);
    assert.equal(prependUseMelhorCaptionTitle("1) Passo.", `**${TITLE}**`), `${TITLE}\n\n1) Passo.`);
  });

  it("Instagram: legenda abre com o título, não com o '1)'", () => {
    const r = buildUseMelhorInstagramPost({ socialMd: SOCIAL_MD, plan: plan(), images: IMAGES, editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.ok(r.caption.startsWith(`${TITLE}\n\n1) Some o custo`), r.caption);
  });

  it("LinkedIn página: texto abre com o título", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: SOCIAL_MD, plan: plan(), images: IMAGES });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assert.ok(r.text.startsWith(`${TITLE}\n\n1) Some o custo`), r.text);
  });

  it("Facebook: legenda abre com o título", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: SOCIAL_MD, plan: plan(), images: IMAGES, editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assert.ok(r.caption.startsWith(`${TITLE}\n\n1) Some o custo`), r.caption);
  });

  it("LinkedIn pessoal (06-linkedin-personal.json): texto abre com o título", () => {
    const personal = extractPersonalPostText(SOCIAL_MD);
    const r = resolvePersonalPost({ personal, plan: plan(), fileExists: () => true, scheduledAt: "2026-10-15T07:45:00-03:00" });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assert.ok(r.text.startsWith(`${TITLE}\n\n1) Some o custo`), r.text);
  });
});

describe("#10201 item 2 — linha de engajamento própria do ## um", () => {
  it("Instagram ## um usa a linha do USE MELHOR, não a dos destaques", () => {
    const caption = extractInstagramPostText(SOCIAL_MD, "um");
    assert.ok(caption.includes(INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE), caption);
    assert.ok(!caption.includes(INSTAGRAM_ENGAGEMENT_LINE), caption);
  });

  it("destaques de notícia continuam com a linha atual", () => {
    const caption = extractInstagramPostText(SOCIAL_MD, "d1");
    assert.ok(caption.includes(INSTAGRAM_ENGAGEMENT_LINE), caption);
    assert.ok(!caption.includes(INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE), caption);
  });

  it("linha nova é não-interrogativa, sem seta, e só existe no Instagram", () => {
    assert.ok(!INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE.includes("?"));
    assert.ok(!/[→←]/.test(INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE));
    assert.notEqual(INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE, INSTAGRAM_ENGAGEMENT_LINE);
    assert.equal(USE_MELHOR_ENGAGEMENT_LINES.linkedin, null);
    assert.equal(USE_MELHOR_ENGAGEMENT_LINES.facebook, null);
    assert.equal(CHANNEL_ENGAGEMENT_LINES.instagram, INSTAGRAM_ENGAGEMENT_LINE);
  });

  it("injectChannelLine: ordem corpo → CTA → engajamento → tags preservada com useMelhor", () => {
    const parts = injectChannelLine("Corpo.\n\n#Tag", "instagram", { useMelhor: true }).split("\n\n");
    assert.equal(parts[0], "Corpo.");
    assert.equal(parts[2], INSTAGRAM_USE_MELHOR_ENGAGEMENT_LINE);
    assert.equal(parts[3], "#Tag");
  });
});
