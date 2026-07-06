// Regressão para #2987: garante que a linha de crédito de `01-eia.md` e o
// `wikimedia.credit`/`artist_url`/`subject_wikipedia_url` de
// `_internal/01-eia-meta.json` NUNCA ficam stale de uma imagem POTD anterior
// quando `eia-compose.ts` é re-rodado (ex: `--force`) com uma imagem
// diferente.
//
// Caso real (#2987, edição 260706): `--force` trocou a foto ("Louis Armstrong
// in Color (restored)") mas o crédito publicado continuou referindo a foto
// ANTERIOR ("Harry Warnecke e Gus Schoenbaechler, 1947"). Investigação nesta
// PR: leitura completa de `eia-compose.ts` main() mostra que `buildCreditLine`
// (usado no `01-eia.md`) e o objeto `wikimedia` gravado em
// `01-eia-meta.json` são derivados, na MESMA execução síncrona, do MESMO
// objeto `image` recém-buscado via `findEligiblePotd` — não há leitura de
// estado anterior nem cache entre re-runs. Não foi possível reproduzir o
// bug no código atual (não há branch condicional a `--force` que pule a
// escrita do md, e ambos os `writeFileSync` — md e meta — acontecem
// incondicionalmente perto do fim de `main()`).
//
// Este teste simula exatamente os passos de `main()` que produzem
// `01-eia.md` e `01-eia-meta.json` (linhas ~1034-1070 do script) para DUAS
// imagens POTD diferentes em sequência — como dois `--force` consecutivos
// pegando fotos distintas — e trava a invariante: após a 2ª rodada, tanto o
// md quanto o meta devem refletir SOMENTE a 2ª imagem, nunca resíduo da 1ª.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseSides,
  buildCreditLine,
  buildEiaMd,
  extractFirstWikipediaUrl,
  extractCommonsUserUrl,
  extractFirstHref,
} from "../scripts/eia-compose.ts";

interface FakeImage {
  title: string;
  description: { text: string; html: string };
  artist: { text: string; html: string };
  license: { type: string; url: string };
}

const IMAGE_1: FakeImage = {
  title: "File:Harry_Warnecke_photo.jpg",
  description: {
    text: "A 1947 studio portrait taken for a magazine feature.",
    html:
      'A 1947 studio portrait taken for a <a href="https://en.wikipedia.org/wiki/Magazine">magazine</a> feature.',
  },
  artist: {
    text: "Harry Warnecke and Gus Schoenbaechler",
    html:
      '<a href="//commons.wikimedia.org/wiki/User:HarryWarnecke">Harry Warnecke and Gus Schoenbaechler</a>',
  },
  license: { type: "Public domain", url: "https://en.wikipedia.org/wiki/Public_domain" },
};

const IMAGE_2: FakeImage = {
  title: "File:Louis_Armstrong_in_Color_restored.jpg",
  description: {
    text: "A colorized restoration of a portrait of the jazz musician.",
    html:
      'A colorized restoration of a portrait of the jazz musician ' +
      '<a href="https://en.wikipedia.org/wiki/Louis_Armstrong">Louis Armstrong</a>.',
  },
  artist: {
    text: "National Portrait Gallery",
    html:
      '<a href="//commons.wikimedia.org/wiki/User:NPG">National Portrait Gallery</a>',
  },
  license: { type: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0" },
};

/**
 * Simula exatamente os passos de `main()` (eia-compose.ts, ~L1034-L1070)
 * que escrevem `01-eia.md` e `_internal/01-eia-meta.json` a partir de um
 * `image` recém-buscado. Sem I/O de rede, sem geração de imagem — só a
 * montagem de crédito + escrita dos 2 arquivos, que é exatamente a parte
 * apontada pela issue como potencialmente stale.
 */
function composeAndWrite(outDir: string, image: FakeImage, rand: number): void {
  const internalDir = join(outDir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  const sides = chooseSides(rand);
  const creditLine = buildCreditLine(image as never);
  const mdPath = join(outDir, "01-eia.md");
  writeFileSync(mdPath, buildEiaMd(sides, creditLine, null));

  const credit = image.artist?.text ?? "";
  const artistUrl =
    extractCommonsUserUrl(image.artist?.html) ??
    extractFirstHref(image.artist?.html) ??
    null;
  const subjectWikipediaUrl = extractFirstWikipediaUrl(image.description?.html, image.title);
  const meta = {
    edition: "260706",
    ai_side: sides.aiSide,
    wikimedia: {
      title: image.title,
      credit,
      artist_url: artistUrl,
      subject_wikipedia_url: subjectWikipediaUrl,
      license_url: image.license?.url ?? null,
    },
  };
  writeFileSync(join(internalDir, "01-eia-meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

describe("eia-compose credit line — sem staleness entre re-runs (#2987)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-eia-credit-regr-"));
  }

  it("2 runs sucessivos (--force) com imagens diferentes: md + meta refletem SÓ a 2ª imagem", () => {
    const dir = makeDir();
    try {
      // Run 1: imagem antiga (Harry Warnecke).
      composeAndWrite(dir, IMAGE_1, 0.1);
      const mdAfterRun1 = readFileSync(join(dir, "01-eia.md"), "utf8");
      assert.match(mdAfterRun1, /Harry Warnecke/);

      // Run 2 (--force): imagem nova (Louis Armstrong). Sobrescreve os
      // mesmos paths — como o eia-compose real faz em qualquer re-run.
      composeAndWrite(dir, IMAGE_2, 0.9);

      const mdAfterRun2 = readFileSync(join(dir, "01-eia.md"), "utf8");
      const metaAfterRun2 = JSON.parse(
        readFileSync(join(dir, "_internal/01-eia-meta.json"), "utf8"),
      );

      // md deve refletir SÓ a imagem nova.
      assert.match(mdAfterRun2, /National Portrait Gallery/);
      assert.ok(
        !mdAfterRun2.includes("Harry Warnecke"),
        `01-eia.md não deve reter crédito da imagem anterior: ${mdAfterRun2}`,
      );

      // meta deve refletir SÓ a imagem nova, e bater com o md (mesmo artista/acervo).
      assert.equal(metaAfterRun2.wikimedia.title, IMAGE_2.title);
      assert.equal(metaAfterRun2.wikimedia.credit, "National Portrait Gallery");
      assert.ok(
        !JSON.stringify(metaAfterRun2).includes("Harry Warnecke"),
        "01-eia-meta.json não deve reter crédito da imagem anterior",
      );
      assert.ok(
        mdAfterRun2.includes(metaAfterRun2.wikimedia.credit),
        "crédito do md e do meta devem bater (mesmo artista) após o 2º run",
      );

      // Sanity extra: nenhum arquivo de run1 vazou pro run2 via caminho distinto.
      assert.ok(!mdAfterRun2.includes(IMAGE_1.title));
      assert.notEqual(metaAfterRun2.wikimedia.subject_wikipedia_url, undefined);
      assert.match(
        metaAfterRun2.wikimedia.subject_wikipedia_url ?? "",
        /Louis_Armstrong/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("3 runs (idempotência de --force): sempre reflete a ÚLTIMA imagem, nunca uma intermediária", () => {
    const dir = makeDir();
    const IMAGE_3: FakeImage = {
      ...IMAGE_1,
      title: "File:Third_photo.jpg",
      artist: { text: "Third Photographer", html: '<a href="//commons.wikimedia.org/wiki/User:Third">Third Photographer</a>' },
    };
    try {
      composeAndWrite(dir, IMAGE_1, 0.1);
      composeAndWrite(dir, IMAGE_2, 0.5);
      composeAndWrite(dir, IMAGE_3, 0.9);

      const md = readFileSync(join(dir, "01-eia.md"), "utf8");
      const meta = JSON.parse(readFileSync(join(dir, "_internal/01-eia-meta.json"), "utf8"));

      assert.match(md, /Third Photographer/);
      assert.ok(!md.includes("Harry Warnecke") && !md.includes("National Portrait Gallery"));
      assert.equal(meta.wikimedia.credit, "Third Photographer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
