/**
 * test/gen-social-card-4x5.test.ts (#4114, regressão #633)
 *
 * O card 4:5 é o que o Facebook e o Instagram efetivamente publicam quando a
 * edição o gera — e ele nasceu sem teste nenhum (achado do code-review da PR
 * #4114). O risco não é estético: se o título estourar a faixa, sair fora do
 * card ou o SVG quebrar, o post sai errado e nada acusa, porque os publishers
 * caem no 1:1 em silêncio.
 *
 * Cobre as funções puras (quebra de linha, clamp de font-size, escape de SVG,
 * label de data). A composição via `sharp` fica fora — depende de imagem real
 * em disco e é exercitada de ponta a ponta ao rodar o Stage 3.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wrapTitle,
  stripKickerEmoji,
  buildCardSvg,
  buildOverlaySvg,
  editionDateLabel,
} from "../scripts/gen-social-card-4x5.ts";

describe("wrapTitle (#4114)", () => {
  it("quebra só entre palavras — nunca no meio de uma", () => {
    const lines = wrapTitle("Brasil pretende investir R$ 23 bilhões em inteligência artificial", 20);
    for (const l of lines) assert.ok(l.length > 0);
    assert.equal(lines.join(" "), "Brasil pretende investir R$ 23 bilhões em inteligência artificial");
    assert.ok(lines.every((l) => !l.startsWith(" ") && !l.endsWith(" ")));
  });

  it("palavra maior que a linha não é descartada nem cortada (fica sozinha, estourando)", () => {
    // O clamp de font-size é quem resolve o estouro; perder a palavra seria pior.
    const lines = wrapTitle("Superintendência antitruste", 5);
    assert.deepEqual(lines, ["Superintendência", "antitruste"]);
  });

  it("título de uma palavra vira uma linha só", () => {
    assert.deepEqual(wrapTitle("OpenAI", 20), ["OpenAI"]);
  });

  it("string vazia ou só espaços → nenhuma linha (não gera <text> vazio)", () => {
    assert.deepEqual(wrapTitle("", 20), []);
    assert.deepEqual(wrapTitle("   ", 20), []);
  });

  it("espaço duplo não vira linha fantasma", () => {
    assert.deepEqual(wrapTitle("IA  no  Brasil", 40), ["IA no Brasil"]);
  });
});

describe("stripKickerEmoji (#4114)", () => {
  it("tira o emoji do kicker e preserva o texto", () => {
    // Emoji em SVG depende de fonte instalada — varia por plataforma.
    assert.equal(stripKickerEmoji("🚀 LANÇAMENTO"), "LANÇAMENTO");
    assert.equal(stripKickerEmoji("⚖️ REGULAÇÃO"), "REGULAÇÃO");
  });

  it("preserva acento, número e pontuação de sentença", () => {
    assert.equal(stripKickerEmoji("É IA?"), "É IA?");
    assert.equal(stripKickerEmoji("USE MELHOR"), "USE MELHOR");
  });
});

describe("buildCardSvg — clamp de font-size (#4114)", () => {
  const sizeOf = (svg: string): number => {
    const m = svg.match(/font-size="(\d+)"[^>]*font-weight="400"/);
    return m ? Number(m[1]) : NaN;
  };

  it("título curto não vira outdoor (teto de 82)", () => {
    assert.ok(sizeOf(buildCardSvg("IA", "")) <= 82);
  });

  it("título longo não afunda abaixo do piso de legibilidade (40)", () => {
    const longo =
      "Estudo mostra que 88% das empresas usam inteligência artificial mas a maioria de forma superficial e sem retorno mensurável";
    assert.ok(sizeOf(buildCardSvg(longo, "")) >= 40);
  });

  it("quanto mais longo o título, menor (ou igual) a fonte — nunca maior", () => {
    const curto = sizeOf(buildCardSvg("Google lança Gemini", ""));
    const longo = sizeOf(
      buildCardSvg("Google lança Gemini 3.6 e 3.5 Flash com contexto expandido e preço menor", ""),
    );
    assert.ok(longo <= curto, `fonte cresceu com título maior: ${curto} → ${longo}`);
  });
});

describe("buildCardSvg / buildOverlaySvg — SVG bem-formado (#4114)", () => {
  it("escapa & < > \" do título — SVG quebrado não renderiza imagem nenhuma", () => {
    const svg = buildCardSvg('Google & "IA" <script>alert(1)</script>', "");
    assert.match(svg, /&amp;/);
    assert.match(svg, /&lt;script&gt;/);
    assert.ok(!/<script>/.test(svg), "tag crua não pode sobreviver dentro do <text>");
    assert.match(svg, /&quot;/);
  });

  it("respeita as dimensões pedidas (o 9:16 do story reusa o mesmo builder)", () => {
    const svg = buildCardSvg("Título", "", "", { w: 1080, h: 1920, textH: 520 });
    assert.match(svg, /width="1080" height="1920"/);
    assert.match(svg, /viewBox="0 0 1080 1920"/);
  });

  it("o overlay cobre a base com gradiente e mantém o texto dentro do card", () => {
    const H = 1350;
    const svg = buildOverlaySvg("Título de teste do card", "", "", { w: 1080, h: H, textH: 470 });
    assert.match(svg, /linearGradient/);
    for (const y of [...svg.matchAll(/<text[^>]*y="([\d.]+)"/g)].map((m) => Number(m[1]))) {
      assert.ok(y > 0 && y < H, `linha de texto fora do card: y=${y}`);
    }
  });

  it("dateLabel vazio não deixa <text> órfão", () => {
    const semData = buildCardSvg("Título", "", "");
    const comData = buildCardSvg("Título", "", "27 JUL");
    assert.ok(comData.includes("27 JUL"));
    assert.equal((semData.match(/text-anchor="end"/g) || []).length, 0);
  });
});

describe("editionDateLabel (#4114)", () => {
  const withEdition = (name: string, fn: (dir: string) => void): void => {
    const base = mkdtempSync(join(tmpdir(), "card4x5-"));
    const dir = join(base, name);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    try {
      fn(dir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };

  it("deriva o rótulo do nome AAMMDD da pasta da edição", () => {
    withEdition("260727", (dir) => {
      const label = editionDateLabel(dir);
      assert.match(label, /27/, `rótulo não menciona o dia: ${label}`);
    });
  });

  it("pasta sem AAMMDD não quebra — devolve string (o card sai sem data)", () => {
    withEdition("replay-writer-a", (dir) => {
      assert.equal(typeof editionDateLabel(dir), "string");
    });
  });

  it("é determinística — mesma edição, mesmo rótulo", () => {
    withEdition("260727", (dir) => {
      assert.equal(editionDateLabel(dir), editionDateLabel(dir));
    });
  });
});

describe("call-site do Stage 3 (#4114 — o achado do code-review)", () => {
  // A feature inteira era no-op: nada no pipeline gerava `04-d{N}-4x5.jpg`, e
  // os publishers caem no 1:1 via `existsSync` SEM avisar. Um teste que só
  // exercitasse as funções puras continuaria verde com a feature morta.
  const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
  const stage3 = readFileSyncUtf8(join(ROOT, ".claude", "agents", "orchestrator-stage-3.md"));

  it("o Stage 3 invoca gen-social-card-4x5.ts", () => {
    assert.match(stage3, /gen-social-card-4x5\.ts/);
  });

  it("o Stage 3 gera a arte 4:5 nativa antes de compor o card", () => {
    assert.match(stage3, /--ratio 4x5/);
    const nativoIdx = stage3.indexOf("--ratio 4x5");
    const cardIdx = stage3.indexOf("gen-social-card-4x5.ts");
    assert.ok(nativoIdx < cardIdx, "a arte nativa precisa ser gerada ANTES da composição do card");
  });

  it("os publishers seguem preferindo o 4x5 e caindo no 1x1 (contrato que o call-site alimenta)", () => {
    for (const f of ["publish-facebook.ts", "publish-instagram.ts"]) {
      const src = readFileSyncUtf8(join(ROOT, "scripts", f));
      assert.match(src, /04-\$\{d\}-4x5\.jpg/, `${f} deveria preferir o card 4:5`);
      assert.match(src, /04-\$\{d\}-1x1\.jpg/, `${f} deveria manter o fallback 1:1`);
    }
  });
});

function readFileSyncUtf8(p: string): string {
  return readFileSync(p, "utf8");
}
