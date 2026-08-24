/**
 * test/carousel-freshness-invariants.test.ts (#6064 itens 1 e 2, regressão #633)
 *
 * O carrossel diário (#6005 Parte B) rasteriza o texto do `## d{N}` de
 * `03-social.md` em 4 cards durante o Stage 3 — e o editor edita esse MESMO
 * arquivo depois, no painel Revisão do Stage 4. Os dois buracos cobertos aqui:
 *
 *   - item 1: a idempotência de `gen-carousel-cards.ts` era por EXISTÊNCIA de
 *     arquivo, então texto editado pós-Stage 3 publicava legenda nova com arte
 *     velha, sem sinal. Agora é por CONTEÚDO (carimbo
 *     `_internal/.carousel-source-hash.json`) + invariante `carousel-cards-stale`
 *     (error) no gate.
 *   - item 2: `resolveCarouselImageUrls` é tudo-ou-nada e cai pro post
 *     single-image em silêncio; `carousel-upload-incomplete` (warning) é a
 *     contraparte do `card-4x5-upload-missing` pro carrossel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  hashCarouselSlideTexts,
  readCarouselSourceHashes,
  writeCarouselSourceHashes,
  carouselSourceHashPath,
  shouldRenderCarouselSlides,
} from "../scripts/lib/daily-carousel-card.ts";
import {
  checkCarouselCardsStale,
  checkCarouselUploadIncomplete,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { genCarouselCards } from "../scripts/gen-carousel-cards.ts";

const TEXTO_D1 = [
  "Primeiro parágrafo do destaque um.",
  "Segundo parágrafo, com a virada.",
  "Terceiro parágrafo, o fecho.",
].join("\n\n");

const KEYS_D1_COMPLETO = [
  "d1_4x5",
  "d1_carousel_p1",
  "d1_carousel_p2",
  "d1_carousel_p3",
  "d1_carousel_cta",
];

function makeEdition(destaqueCount: 2 | 3 = 3): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-carousel-fresh-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({ highlights: Array.from({ length: destaqueCount }, () => ({})) }),
  );
  return dir;
}

function writeSocial(dir: string, textoD1: string): void {
  writeFileSync(
    join(dir, "03-social.md"),
    ["# Social", "", "## d1", "", textoD1, "", "## d2", "", "Texto d2.", "", "## d3", "", "Texto d3.", ""].join("\n"),
    "utf8",
  );
}

function writeSlides(dir: string, destaque: string): void {
  for (const slot of CAROUSEL_SLIDE_SLOTS) {
    writeFileSync(join(dir, carouselSlideFilename(destaque, slot)), Buffer.from("jpg"));
  }
}

function writeImages(dir: string, keys: string[]): void {
  const images = Object.fromEntries(keys.map((k) => [k, { url: "https://kv.example/" + k + ".jpg" }]));
  writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images }));
}

describe("registry (#6064)", () => {
  it("carousel-cards-stale e carousel-upload-incomplete estão registradas no stage 4", () => {
    const ids = getRulesForStage(4).map((r) => r.id);
    assert.ok(ids.includes("carousel-cards-stale"));
    assert.ok(ids.includes("carousel-upload-incomplete"));
  });
});

describe("hashCarouselSlideTexts (#6064, pure)", () => {
  it("determinístico pro mesmo texto", () => {
    assert.equal(hashCarouselSlideTexts(TEXTO_D1), hashCarouselSlideTexts(TEXTO_D1));
  });

  it("muda quando o texto que aparece no card muda", () => {
    const outro = TEXTO_D1.replace("a virada", "OUTRA virada");
    assert.notEqual(hashCarouselSlideTexts(TEXTO_D1), hashCarouselSlideTexts(outro));
  });

  it("NÃO muda quando só as hashtags mudam — elas não vão pro card", () => {
    const comTags = TEXTO_D1 + "\n\n#InteligenciaArtificial #IA";
    const outrasTags = TEXTO_D1 + "\n\n#InteligenciaArtificial #Tecnologia #Outra";
    assert.equal(hashCarouselSlideTexts(comTags), hashCarouselSlideTexts(outrasTags));
  });
});

describe("carimbo .carousel-source-hash.json (#6064)", () => {
  it("read de arquivo ausente devolve vazio (nunca lança)", () => {
    const dir = makeEdition();
    try {
      assert.deepEqual(readCarouselSourceHashes(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("read de arquivo corrompido devolve vazio (nunca lança)", () => {
    const dir = makeEdition();
    try {
      writeFileSync(carouselSourceHashPath(dir), "{ nao json", "utf8");
      assert.deepEqual(readCarouselSourceHashes(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write mescla com o que já existe — destaque pulado não perde a entrada", () => {
    const dir = makeEdition();
    try {
      writeCarouselSourceHashes(dir, { d1: "aaa", d2: "bbb" });
      writeCarouselSourceHashes(dir, { d2: "ccc" });
      const hashes = readCarouselSourceHashes(dir);
      assert.equal(hashes.d1, "aaa", "d1 não foi regerado nesta rodada, mas não pode sumir do carimbo");
      assert.equal(hashes.d2, "ccc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkCarouselCardsStale (#6064 item 1)", () => {
  it("ERROR quando o social foi editado depois dos slides (o bug: legenda nova + arte velha)", () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      writeCarouselSourceHashes(dir, { d1: hashCarouselSlideTexts(TEXTO_D1) });

      // editor mexe no social no Stage 4, DEPOIS do Stage 3 ter rasterizado
      writeSocial(dir, TEXTO_D1.replace("o fecho", "OUTRO fecho"));

      const violations = checkCarouselCardsStale(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0].rule, "carousel-cards-stale");
      assert.equal(violations[0].severity, "error");
      assert.match(violations[0].message, /gen-carousel-cards/);
      assert.match(violations[0].message, /upload-images-public/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo quando o carimbo bate com o texto atual", () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      writeCarouselSourceHashes(dir, { d1: hashCarouselSlideTexts(TEXTO_D1) });
      assert.deepEqual(checkCarouselCardsStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("destaque SEM slides no disco não vira violação — publica single-image, não há arte pra ficar velha", () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      assert.deepEqual(checkCarouselCardsStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("slides sem entrada no carimbo viram WARNING (não dá pra afirmar divergência), nunca error", () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      const violations = checkCarouselCardsStale(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem 03-social.md não há violação (nada a comparar)", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      assert.deepEqual(checkCarouselCardsStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkCarouselUploadIncomplete (#6064 item 2)", () => {
  it("WARNING quando falta 1 das 5 chaves — o post cairia pro single-image em silêncio", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeImages(dir, KEYS_D1_COMPLETO.filter((k) => k !== "d1_carousel_cta"));
      const violations = checkCarouselUploadIncomplete(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0].rule, "carousel-upload-incomplete");
      assert.equal(violations[0].severity, "warning");
      assert.match(violations[0].message, /d1_carousel_cta/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("também cobre a CAPA (d1_4x5) — sem ela resolveCarouselImageUrls devolve null", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeImages(dir, KEYS_D1_COMPLETO.filter((k) => k !== "d1_4x5"));
      const violations = checkCarouselUploadIncomplete(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /d1_4x5/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo com as 5 chaves presentes", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeImages(dir, KEYS_D1_COMPLETO);
      assert.deepEqual(checkCarouselUploadIncomplete(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem slides no disco não cobra upload nenhum", () => {
    const dir = makeEdition();
    try {
      writeImages(dir, []);
      assert.deepEqual(checkCarouselUploadIncomplete(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("06-public-images.json ausente com slides no disco vira warning (upload nunca rodou)", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      assert.equal(existsSync(join(dir, "06-public-images.json")), false);
      const violations = checkCarouselUploadIncomplete(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shouldRenderCarouselSlides (#6064 item 1, pure)", () => {
  it("pula quando os 4 arquivos existem E o carimbo bate — idempotência normal", () => {
    assert.equal(
      shouldRenderCarouselSlides({ allSlidesExist: true, storedHash: "abc", currentHash: "abc" }),
      false,
    );
  });

  it("REGERA quando o texto mudou desde o carimbo — o bug do #6064", () => {
    assert.equal(
      shouldRenderCarouselSlides({ allSlidesExist: true, storedHash: "abc", currentHash: "xyz" }),
      true,
    );
  });

  it("REGERA quando não há carimbo (edição anterior ao #6064) — não confia no que não dá pra verificar", () => {
    assert.equal(shouldRenderCarouselSlides({ allSlidesExist: true, currentHash: "abc" }), true);
  });

  it("REGERA quando falta slide, mesmo com carimbo batendo", () => {
    assert.equal(
      shouldRenderCarouselSlides({ allSlidesExist: false, storedHash: "abc", currentHash: "abc" }),
      true,
    );
  });

  it("--force ignora o carimbo", () => {
    assert.equal(
      shouldRenderCarouselSlides({ allSlidesExist: true, storedHash: "abc", currentHash: "abc", force: true }),
      true,
    );
  });
});

describe("genCarouselCards — skip por conteúdo (#6064 item 1)", () => {
  it("não toca os arquivos quando o carimbo bate (e reporta refreshed vazio)", async () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      writeSlides(dir, "d2");
      writeSlides(dir, "d3");
      // carimbo de TODOS os destaques batendo com o social escrito acima
      writeCarouselSourceHashes(dir, {
        d1: hashCarouselSlideTexts(TEXTO_D1),
        d2: hashCarouselSlideTexts("Texto d2."),
        d3: hashCarouselSlideTexts("Texto d3."),
      });

      const result = await genCarouselCards(dir);

      assert.deepEqual(result.refreshed, [], "nada mudou — nenhum destaque deveria ser regerado");
      assert.equal(result.generated.length, 12, "3 destaques x 4 slides continuam reportados");
      // conteúdo placeholder intacto = renderFlatCard nunca rodou
      assert.equal(readFileSync(join(dir, carouselSlideFilename("d1", "p1")), "utf8"), "jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
