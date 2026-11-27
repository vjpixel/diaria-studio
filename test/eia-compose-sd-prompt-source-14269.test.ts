/**
 * #14269 — prompt do É IA? usava `description.text` da Wikimedia, que às vezes
 * descreve o PREPARO da amostra e não a imagem. Regressão: com o payload do
 * caso real (edição 261127, POTD "Liquid Crystal Phase Transition"), o prompt
 * positivo tem de vir da legenda `structured.captions.en`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSdPrompt,
  chooseSdPromptText,
  looksLikePreparationText,
  pickVisualCaption,
  resolveFallbackSdPromptChoice,
  resolveSdPromptDescription,
  sdPromptOverrideIgnoredWarning,
  type WikimediaImage,
} from "../scripts/eia-compose.ts";

const PREP_PT =
  "Após ampliar a imagem 100 vezes, uma gota de cristal líquido foi colocada em uma lâmina de vidro e uma lamela foi colocada por cima.";
const CAPTION_EN =
  "Thermally induced phase transition of a liquid crystal from a transparent state to birefringent state";

// Shape do POTD em locale pt (fetchPotd primário) no caso real.
const REAL_CASE: WikimediaImage = {
  title: "File:Liquid Crystal Phase Transition.jpg",
  description: { text: PREP_PT, html: PREP_PT, lang: "pt" },
  structured: { captions: { en: CAPTION_EN } },
} as WikimediaImage;

describe("looksLikePreparationText (#14269)", () => {
  it("detecta o texto de preparo do caso real (PT)", () => {
    assert.equal(looksLikePreparationText(PREP_PT), true);
  });
  it("detecta preparo em EN", () => {
    assert.equal(
      looksLikePreparationText("A drop of liquid crystal was placed on a glass slide and covered with a coverslip."),
      true,
    );
    assert.equal(looksLikePreparationText("The sample was prepared with a stain."), true);
  });
  it("não dispara em descrição visual comum", () => {
    assert.equal(looksLikePreparationText("Dois filhotes de raposa brincando na neve ao entardecer."), false);
    assert.equal(looksLikePreparationText("A landslide on the slopes of a volcano in Iceland."), false);
    assert.equal(looksLikePreparationText(CAPTION_EN), false);
  });
});

describe("chooseSdPromptText (#14269)", () => {
  it("REGRESSÃO 261127: descrição de preparo + caption en → prompt vem da caption", () => {
    const choice = chooseSdPromptText(PREP_PT, REAL_CASE);
    assert.equal(choice.source, "caption");
    assert.equal(choice.text, CAPTION_EN);
    const prompt = buildSdPrompt(choice.text);
    assert.ok(prompt.positive.startsWith(CAPTION_EN));
    assert.ok(!/lâmina|lamela|colocada/i.test(prompt.positive), prompt.positive);
  });

  it("REGRESSÃO 261127 ponta a ponta com resolveSdPromptDescription (gemini, sem refetch)", async () => {
    const resolved = await resolveSdPromptDescription("gemini", REAL_CASE, "2026-11-26", "261127", async () => {
      throw new Error("não deveria buscar EN para gemini");
    });
    const choice = chooseSdPromptText(resolved.text, REAL_CASE);
    assert.equal(choice.source, "caption");
    assert.ok(buildSdPrompt(choice.text).positive.startsWith(CAPTION_EN));
  });

  it("override do editor vence a legenda e a descrição", () => {
    const choice = chooseSdPromptText(PREP_PT, REAL_CASE, {
      overrideText: "  Polarized light micrograph, vivid colors, black bubbles  ",
    });
    assert.deepEqual(choice, { text: "Polarized light micrograph, vivid colors, black bubbles", source: "override" });
  });

  it("override vazio/espaços é ignorado", () => {
    assert.equal(chooseSdPromptText(PREP_PT, REAL_CASE, { overrideText: "   " }).source, "caption");
  });

  it("descrição visual + caption diferente → combina, caption primeiro", () => {
    const image = {
      description: { text: "Uma raposa vermelha caminha sobre a neve.", lang: "pt" },
      structured: { captions: { en: "Red fox in snow" } },
    } as WikimediaImage;
    const choice = chooseSdPromptText("Uma raposa vermelha caminha sobre a neve.", image);
    assert.equal(choice.source, "caption+description");
    assert.equal(choice.text, "Red fox in snow. Uma raposa vermelha caminha sobre a neve.");
  });

  it("sem legenda → descrição, comportamento anterior", () => {
    const image = { description: { text: PREP_PT, lang: "pt" } } as WikimediaImage;
    assert.deepEqual(chooseSdPromptText(PREP_PT, image), { text: PREP_PT, source: "description" });
  });

  it("descrição que já é uma das legendas (sem description nativa, #8198) → não duplica", () => {
    const image = { structured: { captions: { pt: "Raposa na neve", en: "Fox in snow" } } } as WikimediaImage;
    assert.deepEqual(chooseSdPromptText("Raposa na neve", image), { text: "Raposa na neve", source: "caption" });
  });

  it("caption já contida na descrição → descrição", () => {
    const image = { structured: { captions: { en: "Red fox" } } } as WikimediaImage;
    const desc = "A red fox walking in the snow.";
    assert.deepEqual(chooseSdPromptText(desc, image), { text: desc, source: "description" });
  });

  it("englishOnly: legenda só em pt não entra no prompt de backend EN", () => {
    const image = { structured: { captions: { pt: "Micrografia em luz polarizada" } } } as WikimediaImage;
    const desc = "A drop was placed on a glass slide.";
    assert.deepEqual(chooseSdPromptText(desc, image, { englishOnly: true }), { text: desc, source: "description" });
    assert.equal(chooseSdPromptText(desc, image).source, "caption");
  });
});

describe("pickVisualCaption (#14269)", () => {
  it("prefere en, depois pt", () => {
    assert.equal(pickVisualCaption({ structured: { captions: { pt: "a", en: "b" } } }), "b");
    assert.equal(pickVisualCaption({ structured: { captions: { pt: "a" } } }), "a");
    assert.equal(pickVisualCaption({ structured: { captions: { pt: "a" } } }, true), undefined);
    assert.equal(pickVisualCaption({}), undefined);
    assert.equal(pickVisualCaption({ structured: { captions: { en: "  " } } }), undefined);
  });
});

describe("resolveFallbackSdPromptChoice (#14269, review da PR #14282)", () => {
  const PREP_EN = "A drop of liquid crystal was placed on a glass slide and covered with a coverslip.";
  // Sem legenda en: o Codex (multilíngue) usa a legenda pt; o fallback EN não pode.
  const PT_CAPTION_ONLY: WikimediaImage = {
    title: "File:x.jpg",
    description: { text: PREP_PT, html: PREP_PT, lang: "pt" },
    structured: { captions: { pt: "Micrografia de cristal líquido em luz polarizada" } },
  } as WikimediaImage;
  const fetchEnPrep = async (): Promise<WikimediaImage | null> =>
    ({ description: { text: PREP_EN, lang: "en" } }) as WikimediaImage;

  it("REGRESSÃO: fallback comfyui reescreve o prompt e a fonte reportada segue o texto reescrito", async () => {
    const primary = chooseSdPromptText(PREP_PT, PT_CAPTION_ONLY);
    assert.equal(primary.source, "caption");
    const fb = await resolveFallbackSdPromptChoice(
      "comfyui",
      primary,
      "pt",
      PT_CAPTION_ONLY,
      "2026-11-26",
      "261127",
      undefined,
      fetchEnPrep,
    );
    assert.equal(fb.reResolved, true);
    assert.equal(fb.source, "description");
    assert.equal(fb.text, PREP_EN);
  });

  it("override do editor segue como fonte no fallback", async () => {
    const fb = await resolveFallbackSdPromptChoice(
      "cloudflare",
      { text: "Polarized micrograph", source: "override" },
      "pt",
      PT_CAPTION_ONLY,
      "2026-11-26",
      "261127",
      "Polarized micrograph",
      fetchEnPrep,
    );
    assert.deepEqual(fb, { text: "Polarized micrograph", source: "override", reResolved: true });
  });

  it("fallback que não exige EN (gemini) ou prompt primário já em en: mantém a escolha primária", async () => {
    const primary = { text: CAPTION_EN, source: "caption" as const };
    const noFetch = async (): Promise<WikimediaImage | null> => {
      throw new Error("não deveria buscar EN");
    };
    assert.deepEqual(
      await resolveFallbackSdPromptChoice("gemini", primary, "pt", REAL_CASE, "2026-11-26", "261127", undefined, noFetch),
      { ...primary, reResolved: false },
    );
    assert.deepEqual(
      await resolveFallbackSdPromptChoice("comfyui", primary, "en", REAL_CASE, "2026-11-26", "261127", undefined, noFetch),
      { ...primary, reResolved: false },
    );
  });
});

describe("sdPromptOverrideIgnoredWarning (#14269, review da PR #14282)", () => {
  it("avisa quando --sd-prompt-text vem sem --force (skip resume-aware)", () => {
    const msg = sdPromptOverrideIgnoredWarning("Polarized micrograph", false);
    assert.ok(msg && /--sd-prompt-text/.test(msg) && /--force/.test(msg), String(msg));
  });
  it("sem aviso com --force, sem a flag ou com a flag vazia", () => {
    assert.equal(sdPromptOverrideIgnoredWarning("Polarized micrograph", true), null);
    assert.equal(sdPromptOverrideIgnoredWarning(undefined, false), null);
    assert.equal(sdPromptOverrideIgnoredWarning("   ", false), null);
  });
});
