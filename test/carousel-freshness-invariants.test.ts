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
  checkCarouselUploadStale,
  checkCarouselTextOverflow,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { md5OfFile } from "../scripts/lib/shared/file-md5.ts";
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

/** Entries com md5 — o que `upload-images-public.ts` de fato grava (#1418). */
function writeImagesComMd5(dir: string, entries: Array<{ key: string; file?: string; md5?: string }>): void {
  const images = Object.fromEntries(
    entries.map((e) => [
      e.key,
      {
        url: "https://kv.example/" + e.key + ".jpg",
        ...(e.md5 !== undefined ? { md5: e.md5 } : e.file ? { md5: md5OfFile(join(dir, e.file)) } : {}),
      },
    ]),
  );
  writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images }));
}

const PARES_D1 = [
  { key: "d1_4x5", file: "04-d1-4x5.jpg" },
  { key: "d1_carousel_p1", file: carouselSlideFilename("d1", "p1") },
  { key: "d1_carousel_p2", file: carouselSlideFilename("d1", "p2") },
  { key: "d1_carousel_p3", file: carouselSlideFilename("d1", "p3") },
  { key: "d1_carousel_cta", file: carouselSlideFilename("d1", "cta") },
];

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

describe("checkCarouselUploadStale (#6068 — arte já subida ficou pra trás)", () => {
  it("ERROR quando o md5 local diverge do gravado na entry (regenerou e esqueceu o upload)", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      writeImagesComMd5(dir, PARES_D1);

      // editor roda gen-carousel-cards.ts (bytes novos) e NÃO roda o upload
      writeFileSync(join(dir, carouselSlideFilename("d1", "p2")), Buffer.from("arte-regerada"));

      const violations = checkCarouselUploadStale(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0].rule, "carousel-upload-stale");
      assert.equal(violations[0].severity, "error");
      assert.match(violations[0].message, /d1_carousel_p2/);
      assert.match(violations[0].message, /upload-images-public/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("limpo quando todos os md5 batem", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      writeImagesComMd5(dir, PARES_D1);
      assert.deepEqual(checkCarouselUploadStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entry sem md5 (pré-#1418) vira WARNING — não dá pra verificar, não dá pra afirmar", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      writeImagesComMd5(dir, PARES_D1.map((e) => ({ key: e.key })));
      const violations = checkCarouselUploadStale(dir);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave AUSENTE é assunto do carousel-upload-incomplete, não deste check", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      writeImagesComMd5(dir, PARES_D1.filter((e) => e.key !== "d1_carousel_cta"));
      assert.deepEqual(checkCarouselUploadStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem 06-public-images.json não acusa nada (upload nunca rodou)", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      assert.deepEqual(checkCarouselUploadStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#6068 — bordas dos dois checks de upload", () => {
  it("capa AUSENTE no disco: a remediação aponta pro gen-social-card-4x5, não pro upload", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1"); // só os 4 slides sem foto; capa nunca gerada
      writeImages(dir, KEYS_D1_COMPLETO.filter((k) => k !== "d1_4x5"));
      const violations = checkCarouselUploadIncomplete(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /gen-social-card-4x5/);
      assert.ok(
        !/os 5 slides/.test(violations[0].message),
        "a mensagem não pode afirmar que 5 arquivos existem no disco checando só 4",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição de 2 destaques: d3 nunca é cobrado por nenhum dos checks", () => {
    const dir = makeEdition(2);
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      writeSlides(dir, "d2");
      writeCarouselSourceHashes(dir, {
        d1: hashCarouselSlideTexts(TEXTO_D1),
        d2: hashCarouselSlideTexts("Texto d2."),
      });
      assert.deepEqual(checkCarouselCardsStale(dir), [], "d3 não existe nesta edição");

      // sem 06-public-images.json o upload-incomplete acusa d1 e d2 (correto),
      // mas NUNCA d3 — que é o ponto do teste.
      const upload = checkCarouselUploadIncomplete(dir);
      assert.equal(upload.length, 2, JSON.stringify(upload));
      assert.ok(
        upload.every((v) => !/d3/.test(v.message)),
        "nenhuma violação pode citar d3 numa edição de 2 destaques",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("03-social.md sem a seção '# Social' com slides no disco vira WARNING, não silêncio", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), "## d1\n\nsem cabecalho de secao\n", "utf8");
      writeSlides(dir, "d1");
      const violations = checkCarouselCardsStale(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0].severity, "warning");
      assert.match(violations[0].message, /# Social/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem seção '# Social' E sem slides no disco continua calado (nada a proteger)", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), "texto solto\n", "utf8");
      assert.deepEqual(checkCarouselCardsStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("genCarouselCards — caminho de REGENERAÇÃO (#6068, seam de render)", () => {
  function stubRender() {
    const chamadas: string[] = [];
    const render = async (
      texto: string,
      outPaths: Record<string, string>,
    ): Promise<Record<string, string>> => {
      chamadas.push(texto);
      for (const path of Object.values(outPaths)) writeFileSync(path, Buffer.from("render:" + texto.slice(0, 12)));
      return outPaths as Record<never, string>;
    };
    return { chamadas, render: render as never };
  }

  it("texto editado depois do carimbo REGERA aquele destaque e o reporta em refreshed", async () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      writeSlides(dir, "d2");
      writeSlides(dir, "d3");
      writeCarouselSourceHashes(dir, {
        d1: hashCarouselSlideTexts(TEXTO_D1),
        d2: hashCarouselSlideTexts("Texto d2."),
        d3: hashCarouselSlideTexts("Texto d3."),
      });

      const textoNovo = TEXTO_D1.replace("o fecho", "OUTRO fecho");
      writeSocial(dir, textoNovo);

      const { chamadas, render } = stubRender();
      const result = await genCarouselCards(dir, { render });

      assert.deepEqual(result.refreshed, ["d1"], "só d1 mudou");
      assert.equal(chamadas.length, 1, "d2/d3 não podem ser re-renderizados à toa");
      assert.match(chamadas[0], /OUTRO fecho/);
      // carimbo atualizado → o invariante de Stage 4 fica limpo
      assert.equal(readCarouselSourceHashes(dir).d1, hashCarouselSlideTexts(textoNovo));
      assert.deepEqual(checkCarouselCardsStale(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force re-renderiza mesmo com carimbo batendo, e NÃO conta como refreshed", async () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      writeSlides(dir, "d1");
      writeCarouselSourceHashes(dir, {
        d1: hashCarouselSlideTexts(TEXTO_D1),
        d2: hashCarouselSlideTexts("Texto d2."),
        d3: hashCarouselSlideTexts("Texto d3."),
      });

      const { chamadas, render } = stubRender();
      const result = await genCarouselCards(dir, { force: true, render });

      assert.equal(chamadas.length, 3, "--force re-renderiza os 3 destaques");
      assert.deepEqual(result.refreshed, [], "force não é 'texto mudou' — sinais distintos");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha de render no MEIO do lote preserva o carimbo dos destaques já concluídos", async () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);

      let n = 0;
      const render = (async (texto: string, outPaths: Record<string, string>) => {
        n += 1;
        if (n === 2) throw new Error("sharp explodiu no d2");
        for (const path of Object.values(outPaths)) writeFileSync(path, Buffer.from("ok"));
        return outPaths;
      }) as never;

      await assert.rejects(() => genCarouselCards(dir, { render }), /sharp explodiu/);

      const hashes = readCarouselSourceHashes(dir);
      assert.equal(
        hashes.d1,
        hashCarouselSlideTexts(TEXTO_D1),
        "d1 renderizou certo antes do erro — perder o carimbo dele daria ERROR falso de carousel-cards-stale",
      );
      assert.equal(hashes.d2, undefined, "d2 falhou: não pode ficar carimbado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#6068 — bordas endereçadas no 2º round de review", () => {
  it("URL publicada + arquivo local sumido vira WARNING (não era coberto por check nenhum)", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      writeImagesComMd5(dir, PARES_D1);
      rmSync(join(dir, "04-d1-4x5.jpg")); // capa apagada DEPOIS do upload

      const violations = checkCarouselUploadStale(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.equal(violations[0].severity, "warning");
      assert.match(violations[0].message, /d1_4x5/);
      assert.match(violations[0].message, /não existe mais/);

      // e o incomplete continua limpo — a URL está lá, é outro assunto
      assert.deepEqual(checkCarouselUploadIncomplete(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("URL só com espaços conta como ausente nos DOIS checks (critério unificado)", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      const images = Object.fromEntries(
        PARES_D1.map((e) => [
          e.key,
          e.key === "d1_carousel_p1"
            ? { url: "   " }
            : { url: "https://kv.example/" + e.key + ".jpg", md5: md5OfFile(join(dir, e.file)) },
        ]),
      );
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images }));

      const incomplete = checkCarouselUploadIncomplete(dir);
      assert.equal(incomplete.length, 1);
      assert.match(incomplete[0].message, /d1_carousel_p1/);
      assert.deepEqual(checkCarouselUploadStale(dir), [], "entry sem URL utilizável não é assunto do stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capa presente no disco: remediação NÃO manda gerar card 4:5 quando falta é slide", () => {
    const dir = makeEdition();
    try {
      writeSlides(dir, "d1");
      writeFileSync(join(dir, "04-d1-4x5.jpg"), Buffer.from("capa"));
      writeImages(dir, KEYS_D1_COMPLETO.filter((k) => k !== "d1_carousel_p3"));

      const violations = checkCarouselUploadIncomplete(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /upload-images-public/);
      assert.ok(
        !/gen-social-card-4x5/.test(violations[0].message),
        "a capa existe e nem está faltando — não é ela que precisa ser gerada",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aviso de '# Social' ausente nomeia os destaques com slides órfãos", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), "sem cabecalho\n", "utf8");
      writeSlides(dir, "d1");
      writeSlides(dir, "d3");
      const violations = checkCarouselCardsStale(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /d1, d3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * (#6078 item 2) `carousel-text-overflow` — o guard que torna a política
 * "parágrafo que não cabe é REESCRITO" observável. Sem ele, o tamanho fixo
 * degradaria em silêncio na arte publicada, que é exatamente a classe de
 * falha que o #6064 consertou na direção oposta.
 */
describe("carousel-text-overflow (#6078)", () => {
  const paraDe = (n: number) => {
    let s = "";
    while (s.length < n) s += (s ? " " : "") + "palavra";
    return s.slice(0, n).trim();
  };

  it("texto dentro do limite: nenhuma violação", () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, TEXTO_D1);
      assert.deepEqual(checkCarouselTextOverflow(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parágrafo grande demais: ERROR nomeando o destaque e mandando reescrever", () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, [paraDe(80), paraDe(800), paraDe(90)].join("\n\n"));
      const v = checkCarouselTextOverflow(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "carousel-text-overflow");
      assert.equal(v[0].severity, "error", "conteúdo que não pode ser rasterizado bloqueia, não avisa");
      assert.match(v[0].message, /## d1/);
      assert.match(v[0].message, /REESCREVER/i);
      assert.match(v[0].message, /p2/, "diz QUAL parágrafo encurtar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("03-social.md ausente: silencioso (não é este check que cobre)", () => {
    const dir = makeEdition();
    try {
      assert.deepEqual(checkCarouselTextOverflow(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a regra está registrada no Stage 4", () => {
    const ids = getRulesForStage(4).map((r) => r.id);
    assert.ok(ids.includes("carousel-text-overflow"), "sem registro, o gate nunca roda o check");
  });

  it("genCarouselCards ABORTA em vez de rasterizar transbordando", async () => {
    const dir = makeEdition();
    try {
      writeSocial(dir, [paraDe(80), paraDe(800), paraDe(90)].join("\n\n"));
      let chamou = false;
      await assert.rejects(
        () =>
          genCarouselCards(dir, {
            render: async (_t, outPaths) => {
              chamou = true;
              return outPaths;
            },
          }),
        /não cabem no card|REESCREVER/i,
      );
      assert.equal(chamou, false, "o render nunca pode ser chamado com texto que transborda");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
