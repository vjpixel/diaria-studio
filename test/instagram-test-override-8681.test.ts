/**
 * #8681 — override de TESTE do Instagram por edição (`_internal/instagram-test.json`),
 * sem alterar as constantes globais de legenda/slide CTA.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseInstagramTestOverride,
  readInstagramTestOverride,
  instagramTestOverridePath,
} from "../scripts/lib/instagram-test-override.ts";
import {
  buildCarouselSlideTexts,
  hashCarouselSlideTexts,
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  readCarouselSourceHashes,
  DAILY_CAROUSEL_CTA_KICKER,
} from "../scripts/lib/daily-carousel-card.ts";
import { checkCarouselCardsStale } from "../scripts/lib/invariant-checks/stage-4.ts";
import { genCarouselCards } from "../scripts/gen-carousel-cards.ts";

const TEXTO = ["Primeiro parágrafo.", "Segundo parágrafo.", "Terceiro parágrafo."].join("\n\n");

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-8681-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}] }));
  writeFileSync(join(dir, "03-social.md"), ["# Social", "", "## d1", "", TEXTO, "", "## d2", "", TEXTO, ""].join("\n"));
  return dir;
}

describe("parseInstagramTestOverride (#8681)", () => {
  it("aceita caption e cta_slide, com kicker vazio pra remover a faixa", () => {
    const o = parseInstagramTestOverride({ caption: " Comente quero ", cta_slide: { title: "Siga", kicker: "" } });
    assert.deepEqual(o, { caption: "Comente quero", cta_slide: { title: "Siga", kicker: "" } });
  });

  it("recusa formato inválido com mensagem acionável", () => {
    assert.throws(() => parseInstagramTestOverride([]), /objeto JSON/);
    assert.throws(() => parseInstagramTestOverride({ caption: "" }), /caption/);
    assert.throws(() => parseInstagramTestOverride({ cta_slide: { kicker: 3 } }), /kicker/);
  });

  it("arquivo ausente → null; JSON quebrado → lança", () => {
    const dir = makeEdition();
    try {
      assert.equal(readInstagramTestOverride(dir), null);
      writeFileSync(instagramTestOverridePath(dir), "{nope");
      assert.throws(() => readInstagramTestOverride(dir), /não é JSON válido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("slide CTA com override (#8681)", () => {
  it("sem override mantém a constante global; com override troca título e kicker", () => {
    assert.equal(buildCarouselSlideTexts(TEXTO).cta.kicker, DAILY_CAROUSEL_CTA_KICKER);
    const cta = buildCarouselSlideTexts(TEXTO, { title: "Siga @diar.ia.br", kicker: "" }).cta;
    assert.equal(cta.kicker, "");
    assert.match(cta.title, /Siga @diar\.ia\.br/);
    // slides de parágrafo não mudam
    assert.deepEqual(buildCarouselSlideTexts(TEXTO, { kicker: "" }).p1, buildCarouselSlideTexts(TEXTO).p1);
  });

  it("override entra no carimbo: muda o hash", () => {
    assert.notEqual(hashCarouselSlideTexts(TEXTO), hashCarouselSlideTexts(TEXTO, { kicker: "" }));
    assert.equal(hashCarouselSlideTexts(TEXTO, null), hashCarouselSlideTexts(TEXTO));
  });

  it("gen-carousel-cards renderiza com o override e o invariant não acusa stale", async () => {
    const dir = makeEdition();
    try {
      writeFileSync(instagramTestOverridePath(dir), JSON.stringify({ cta_slide: { kicker: "" } }));
      const seen: Array<unknown> = [];
      await genCarouselCards(dir, {
        render: async (_text, outPaths, ctaOverride) => {
          seen.push(ctaOverride);
          for (const slot of CAROUSEL_SLIDE_SLOTS) writeFileSync(outPaths[slot], "jpg");
          return outPaths;
        },
      });
      assert.deepEqual(seen, [{ kicker: "" }, { kicker: "" }], "o render recebe o override");
      assert.equal(readCarouselSourceHashes(dir).d1, hashCarouselSlideTexts(TEXTO, { kicker: "" }));
      assert.deepEqual(checkCarouselCardsStale(dir), [], "carimbo com override bate com o invariant");

      // Mudar o override depois deixa a arte velha → stale.
      writeFileSync(instagramTestOverridePath(dir), JSON.stringify({ cta_slide: { kicker: "Outro" } }));
      assert.ok(checkCarouselCardsStale(dir).length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("override malformado vira violação no invariant em vez de derrubar o check", () => {
    const dir = makeEdition();
    try {
      for (const slot of CAROUSEL_SLIDE_SLOTS) writeFileSync(join(dir, carouselSlideFilename("d1", slot)), "jpg");
      writeFileSync(instagramTestOverridePath(dir), "{nope");
      const v = checkCarouselCardsStale(dir);
      assert.ok(v.some((x) => x.source_issue === "#8681" && x.severity === "error"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
