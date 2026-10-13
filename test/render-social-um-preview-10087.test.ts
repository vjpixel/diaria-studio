/**
 * test/render-social-um-preview-10087.test.ts (#10087)
 *
 * O preview social do gate 4 (`render-social-html.ts`) mostrava o `## um`
 * (4º post, USE MELHOR) cru, num bloco único pra LinkedIn/Facebook/Instagram:
 * itens colados em pares e `{quebra}` literal. O publish de LinkedIn/Facebook
 * separa cada item por linha em branco (#9999) e todos os canais trocam
 * `{quebra}` por linha em branco (#9866). Este teste trava o PAR preview x
 * publish a partir do MESMO `03-social.md`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import type { UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import { stripMarkdownEmphasis } from "../scripts/lib/strip-markdown-emphasis.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorInstagramPost } from "../scripts/publish-instagram.ts";
import {
  buildSocialHtml,
  groupByDestaque,
  parsePlatforms,
  useMelhorBlocksForSection,
  type GroupedBlock,
} from "../scripts/render-social-html.ts";

const UM = [
  "1) **Peça o primeiro rascunho** de e-mails.\n2) **Resuma documentos longos** pedindo os pontos.",
  "3) **Prepare reuniões** pedindo a pauta.\n4) **Analise e-mails** perguntando a solicitação.",
  "5) **Aprenda mais rápido** contando o seu nível.\n{quebra}\n6) **Peça exemplos** antes. Mais em https://diar.ia.br/p/x",
  "#Produtividade",
].join("\n\n");
const MD = [
  "# Social", "", "## d1", "", "Texto do destaque.", "", "#Tag", "",
  "## um", "", UM, "",
  "# Curto", "", "## d1", "", "Curto. Mais em https://diar.ia.br/p/x #Tag", "",
].join("\n");

const slots = buildUseMelhorSlides(UM, "Seis usos").map((s) => s.slot);
const plan: UseMelhorReadyPlan = {
  status: "ready",
  time: "08:00",
  item: { url: "https://example.com/guia", title: "Seis usos", summary: "S", score: 80 },
  slots,
};
const images: Record<string, { url?: string }> = {};
for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };

function umBlocks(): GroupedBlock[] {
  const g = groupByDestaque(parsePlatforms(MD), {}).find((x) => x.key === "um");
  assert.ok(g, "grupo do 4º post existe");
  return g.blocks;
}
function blockFor(label: string): GroupedBlock {
  const b = umBlocks().find((x) => x.channels.includes(label));
  assert.ok(b, `bloco com ${label}`);
  return b;
}
/** Texto publicado começa pelo corpo exibido no preview (o publish ainda
 * acrescenta CTA do canal e hashtags depois, e remove o `**` de ênfase que o
 * preview mostra como negrito). */
function assertPreviewMatchesPublish(previewMain: string, published: string): void {
  const body = stripMarkdownEmphasis(previewMain);
  assert.ok(
    published === body || published.startsWith(`${body}\n\n`),
    `preview diverge do publicado:\n--- preview\n${body}\n--- publicado\n${published}`,
  );
}

describe("#10087 — preview do ## um = texto que cada canal publica", () => {
  it("LinkedIn e Facebook num bloco, Instagram em outro (textos finais diferem)", () => {
    const labels = umBlocks().map((b) => b.channels);
    assert.equal(labels.length, 2, JSON.stringify(labels));
    assert.match(labels[0], /LinkedIn/);
    assert.match(labels[0], /Facebook/);
    assert.doesNotMatch(labels[0], /Instagram/);
    assert.match(labels[1], /Instagram/);
  });

  it("LinkedIn: preview bate com buildUseMelhorLinkedInPost", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: MD, plan, images });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assertPreviewMatchesPublish(blockFor("LinkedIn").post.main, r.text);
  });

  it("Facebook: preview bate com buildUseMelhorFacebookPost", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: MD, plan, images, editionDir: "x", fileExists: () => false });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assertPreviewMatchesPublish(blockFor("Facebook").post.main, r.caption);
  });

  it("Instagram: preview bate com buildUseMelhorInstagramPost (itens em pares, sem separar)", () => {
    const r = buildUseMelhorInstagramPost({ socialMd: MD, plan, images, editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    const main = blockFor("Instagram").post.main;
    assertPreviewMatchesPublish(main, r.caption);
    assert.match(main, /primeiro rascunho\*\* de e-mails\.\n2\)/, "Instagram mantém o par 1+2 no mesmo parágrafo");
  });

  it("HTML do preview: sem {quebra} literal, itens 1 e 2 em parágrafos separados no bloco LinkedIn/Facebook", () => {
    const html = buildSocialHtml(parsePlatforms(MD), {});
    assert.doesNotMatch(html, /\{quebra\}/);
    assert.match(html, /<p>1\) <strong>Peça o primeiro rascunho<\/strong> de e-mails\.<\/p>/);
  });

  it("# Curto e lista sem nada a separar: um bloco só, com {quebra} resolvido", () => {
    const curto = useMelhorBlocksForSection("Curto", { destaque: "UM", main: "a\n{quebra}\nb", hashtags: "" });
    assert.equal(curto.length, 1);
    assert.equal(curto[0].post.main, "a\n\nb");
    const social = useMelhorBlocksForSection("Social", { destaque: "UM", main: "1) a\n\n2) b", hashtags: "" });
    assert.equal(social.length, 1, "textos finais iguais — sem desdobrar o bloco");
    assert.match(social[0].channels, /Instagram/);
  });
});
