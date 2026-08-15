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
  overlayFittingFontSize,
  editionDateLabel,
  RATIOS,
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

describe("wrapTitle — redistribuição balanceada (#4575)", () => {
  // Compara contra a versão gulosa antiga (reimplementada aqui, isolada) pra
  // provar a PROPRIEDADE que mudou — nunca uma string literal, senão um
  // ajuste futuro de limiar (maxCharsPerLine, heurística de largura) quebra
  // o teste sem existir defeito real.
  function greedyOnly(title: string, maxCharsPerLine: number): string[] {
    const words = title.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const candidate = cur ? `${cur} ${w}` : w;
      if (candidate.length > maxCharsPerLine && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = candidate;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  const maxMinDiff = (lines: string[]): number =>
    Math.max(...lines.map((l) => l.length)) - Math.min(...lines.map((l) => l.length));

  it("título que sairia com órfã na 2ª linha (guloso) sai balanceado (#4575, exemplo da issue)", () => {
    // Mesmo exemplo do corpo da issue #4575: guloso empurra tudo pra 1ª
    // linha e deixa "notar" sozinha na 2ª.
    const title = "Claude hackeou 3 empresas sem ninguém notar";
    const maxCharsPerLine = 38;
    const before = greedyOnly(title, maxCharsPerLine);
    const after = wrapTitle(title, maxCharsPerLine);

    // A propriedade que importa: a diferença entre a linha mais longa e a
    // mais curta caiu — não qual string exata saiu.
    assert.ok(
      maxMinDiff(after) < maxMinDiff(before),
      `esperava diferença menor após balancear: antes=${JSON.stringify(before)} (diff ${maxMinDiff(before)}), depois=${JSON.stringify(after)} (diff ${maxMinDiff(after)})`,
    );
    // Invariante: nunca mais linhas que o guloso original.
    assert.equal(after.length, before.length);
    // Invariante: nenhuma linha estoura o limite.
    for (const l of after) assert.ok(l.length <= maxCharsPerLine);
    // Nenhuma palavra perdida/reordenada.
    assert.equal(after.join(" "), title);
  });

  it("nunca aumenta o número de linhas nem produz linha acima do limite (várias larguras)", () => {
    const titles = [
      "Brasil pretende investir R$ 23 bilhões em inteligência artificial",
      "Google lança Gemini 3.6 e 3.5 Flash com contexto expandido e preço menor",
      "Estudo mostra que empresas adotam IA sem medir retorno real",
    ];
    for (const title of titles) {
      for (const maxCharsPerLine of [18, 24, 30, 36, 44]) {
        const before = greedyOnly(title, maxCharsPerLine);
        const after = wrapTitle(title, maxCharsPerLine);
        assert.ok(
          after.length <= before.length,
          `linhas aumentaram: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
        );
        for (const l of after) {
          assert.ok(
            l.length <= maxCharsPerLine || l.split(" ").length === 1,
            `linha estourou o limite sem ser palavra única: "${l}" (${l.length} > ${maxCharsPerLine})`,
          );
        }
        assert.equal(after.join(" "), title);
      }
    }
  });

  it("caso degenerado — palavra única maior que o limite continua sozinha (comportamento inalterado)", () => {
    assert.deepEqual(wrapTitle("Superintendência antitruste", 5), ["Superintendência", "antitruste"]);
  });

  it("caso degenerado — título de 1 linha continua de 1 linha (comportamento inalterado)", () => {
    assert.deepEqual(wrapTitle("OpenAI lança modelo novo", 40), ["OpenAI lança modelo novo"]);
  });

  it("caso de 3+ linhas também é elegível pro balanceamento (sem estourar limite nem crescer linhas)", () => {
    const title = "Empresa brasileira de inteligência artificial recebe aporte bilionário de fundo internacional";
    const maxCharsPerLine = 22;
    const before = greedyOnly(title, maxCharsPerLine);
    const after = wrapTitle(title, maxCharsPerLine);
    assert.ok(before.length >= 3, `pré-condição do teste falhou: guloso deu só ${before.length} linha(s)`);
    assert.equal(after.length, before.length);
    for (const l of after) assert.ok(l.length <= maxCharsPerLine);
    assert.equal(after.join(" "), title);
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

describe("overlayFittingFontSize (#5330 fleet review — extraída de buildOverlaySvg pra reuso sem duplicar a fórmula)", () => {
  it("mesmo tamanho que buildOverlaySvg computaria internamente pro mesmo título/largura", () => {
    const title = "Google lança Gemini 3.6";
    const available = 1080 - 72 * 2;
    const direct = overlayFittingFontSize(title, available);
    const svg = buildOverlaySvg(title, "");
    const m = svg.match(/font-size="(\d+)"[^>]*fill="#FFFFFF">/);
    assert.equal(direct, Number(m?.[1]));
  });

  it("clamp 44-88, igual ao comportamento histórico de buildOverlaySvg", () => {
    const available = 1080 - 72 * 2;
    assert.ok(overlayFittingFontSize("IA", available) <= 88);
    const longo = "Palavra ".repeat(60).trim();
    assert.ok(overlayFittingFontSize(longo, available) >= 44);
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

describe("RATIOS — dimensões por ratio (#4090 item 5)", () => {
  it("4:5 é 1080x1350 com faixa de texto 470", () => {
    assert.deepEqual(RATIOS["4x5"], { w: 1080, h: 1350, textH: 470 });
  });

  it("9:16 (Stories) é 1080x1920 com faixa de texto 620", () => {
    assert.deepEqual(RATIOS["9x16"], { w: 1080, h: 1920, textH: 620 });
  });

  it("9:16 é mais alto que 4:5 na mesma largura (Stories ocupa mais tela)", () => {
    assert.equal(RATIOS["4x5"].w, RATIOS["9x16"].w);
    assert.ok(RATIOS["9x16"].h > RATIOS["4x5"].h);
  });

  it("buildCardSvg com os dims reais de 4:5 produz SVG com essas dimensões exatas", () => {
    const { w, h, textH } = RATIOS["4x5"];
    const svg = buildCardSvg("Título de teste", "", "27 JUL 2026", { w, h, textH });
    assert.match(svg, /width="1080" height="1350"/);
    assert.match(svg, /viewBox="0 0 1080 1350"/);
  });

  it("buildOverlaySvg com os dims reais de 9:16 produz SVG com essas dimensões exatas", () => {
    const { w, h } = RATIOS["9x16"];
    const svg = buildOverlaySvg("Título de teste", "27 JUL 2026", { w, h });
    assert.match(svg, /width="1080" height="1920"/);
    assert.match(svg, /viewBox="0 0 1080 1920"/);
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

  it("os publishers usam o seletor compartilhado (#4090 item 5 — contrato que o call-site alimenta)", () => {
    // Antes do #4090 item 5 cada publisher tinha `existsSync(4x5) ? 4x5 :
    // 1x1` inline (checado aqui por regex — um teste fraco: passaria mesmo
    // com a ordem da condição invertida). Agora os 2 importam a mesma função
    // pura, testada de ponta a ponta com arquivos reais em
    // test/select-social-card-image.test.ts — este teste garante só que os
    // dois call sites de fato USAM o seletor (não regrediram pra lógica
    // inline duplicada).
    for (const f of ["publish-facebook.ts", "publish-instagram.ts"]) {
      const src = readFileSyncUtf8(join(ROOT, "scripts", f));
      assert.match(
        src,
        /import\s*\{\s*selectSocialCardImageFile\s*\}\s*from\s*"\.\/lib\/select-social-card-image\.ts"/,
        `${f} deveria importar selectSocialCardImageFile`,
      );
      assert.match(
        src,
        /selectSocialCardImageFile\(/,
        `${f} deveria chamar selectSocialCardImageFile em vez de duplicar a checagem existsSync inline`,
      );
    }
  });
});

function readFileSyncUtf8(p: string): string {
  return readFileSync(p, "utf8");
}
