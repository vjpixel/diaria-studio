/**
 * test/social-post-text-no-bold-10441.test.ts (#10441)
 *
 * Regressão: nenhum texto de post que vai pra LinkedIn (página e pessoal),
 * Facebook, Instagram, Threads ou X contém `**`, e o preview social do gate
 * mostra o texto como sai publicado (sem negrito). O `**` do `## dN` existe
 * só pros cards do carrossel — que continuam lendo o texto cru.
 *
 * Antes do fix, `prep-twitter-posts.ts` (X) era o único publicador que não
 * removia o `**`, e o preview convertia `**` em <strong> (#6871), fazendo o
 * editor achar que o post ia ao ar em negrito.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { toSocialPostText } from "../scripts/lib/social-post-text.ts";
import { extractPostText as linkedinText } from "../scripts/publish-linkedin.ts";
import { extractPostText as facebookText } from "../scripts/publish-facebook.ts";
import { extractPostText as instagramText } from "../scripts/publish-instagram.ts";
import { extractPostText as threadsText } from "../scripts/publish-threads.ts";
import { extractCurtoText as xText } from "../scripts/prep-twitter-posts.ts";
import { extractPersonalPostText } from "../scripts/resolve-post-pixel.ts";
import {
  buildSocialHtml,
  cardBoldSpans,
  groupByDestaque,
  parsePlatforms,
  renderDestaqueGroup,
} from "../scripts/render-social-html.ts";
import { extractSection, extractDestaqueBlock } from "../scripts/lib/extract-section.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITION_URL = "https://diar.ia.br/p/261019";

const MD = `# Social

## d1

A OpenAI lançou um modelo novo. **O ponto é o preço por token.** Empresas pequenas entram no jogo.

O modelo roda em menos máquinas. **Isso derruba o custo de servir.** A fila de espera some.

**Quem testou viu ganho real em código.** O resto ainda é promessa.

#InteligenciaArtificial #Agentes

## d2

Um tribunal barrou o uso de reconhecimento facial. **A decisão vale pro estado inteiro.** Outros podem seguir.

A empresa recorreu. **O prazo de resposta é de 30 dias.** Até lá, nada muda.

O caso abre precedente. **A regra pode chegar a outros setores.** Vale acompanhar.

#InteligenciaArtificial

## um

1) Peça **o primeiro rascunho** de e-mails e relatórios.
2) **Resuma documentos longos** pedindo pontos principais.

#Produtividade

# Curto

## d1

A OpenAI lançou um modelo **mais barato por token**. ${EDITION_URL}

## d2

Tribunal barra **reconhecimento facial** no estado inteiro. ${EDITION_URL}

## um

**Três jeitos** de usar IA no trabalho. ${EDITION_URL}
`;

function assertNoBold(text: string | null, where: string): void {
  assert.ok(text, `${where}: texto vazio`);
  assert.ok(!text.includes("**"), `${where}: payload contém '**' — ${JSON.stringify(text)}`);
}

describe("toSocialPostText (#10441)", () => {
  it("remove pares de negrito e preserva o texto", () => {
    assert.equal(toSocialPostText("isso é **importante** mesmo"), "isso é importante mesmo");
  });

  it("remove `**` residual de par desbalanceado (edição manual no gate)", () => {
    assert.equal(toSocialPostText("trecho **sem fechar até o fim"), "trecho sem fechar até o fim");
  });

  it("é idempotente", () => {
    const once = toSocialPostText("**a** e **b** e **c");
    assert.equal(toSocialPostText(once), once);
  });
});

describe("nenhum payload social contém `**` (#10441)", () => {
  for (const d of ["d1", "d2", "um"]) {
    it(`LinkedIn página — ${d}`, () => assertNoBold(linkedinText(MD, d), `linkedin/${d}`));
    it(`Facebook — ${d}`, () => assertNoBold(facebookText(MD, "facebook", d), `facebook/${d}`));
    it(`Instagram — ${d}`, () => assertNoBold(instagramText(MD, d), `instagram/${d}`));
    it(`Threads — ${d}`, () => assertNoBold(threadsText(MD, d, EDITION_URL), `threads/${d}`));
    it(`X — ${d}`, () => assertNoBold(xText(MD, d, EDITION_URL), `x/${d}`));
  }

  it("LinkedIn pessoal (`## um`)", () => {
    const r = extractPersonalPostText(MD);
    assert.equal(r?.source, "um");
    assertNoBold(r?.text ?? null, "linkedin-pessoal/um");
  });

  it("LinkedIn pessoal legado (`## post_pixel`)", () => {
    const legacy = `# Social\n\n## d1\n\nTexto.\n\n## post_pixel\n\nPost **pessoal** antigo.\n`;
    const r = extractPersonalPostText(legacy);
    assert.equal(r?.source, "post_pixel");
    assertNoBold(r?.text ?? null, "linkedin-pessoal/post_pixel");
  });

  it("o texto publicado preserva as palavras do trecho em negrito", () => {
    assert.ok(linkedinText(MD, "d1").includes("O ponto é o preço por token."));
  });
});

describe("cards do carrossel continuam lendo o `**` (#10441)", () => {
  it("o bloco cru do `## d1` (fonte dos cards) mantém o negrito", () => {
    const block = extractDestaqueBlock(extractSection(MD, "Social") ?? "", "d1");
    assert.ok(block?.includes("**O ponto é o preço por token.**"));
  });

  it("gerador dos cards não passa pelo ponto único do texto de post", () => {
    for (const file of ["scripts/gen-carousel-cards.ts", "scripts/lib/daily-carousel-card.ts"]) {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      assert.ok(!src.includes("social-post-text") && !src.includes("toSocialPostText"), `${file} não pode remover o negrito`);
    }
  });
});

describe("preview social mostra o texto como sai publicado (#10441)", () => {
  const IMAGES = { d1_4x5: { url: "https://img.example/d1.jpg" } };

  it("corpo do post sem `**` e sem <strong>", () => {
    const groups = groupByDestaque(parsePlatforms(MD), IMAGES);
    const d1 = groups.find(g => g.key === "d1")!;
    const html = renderDestaqueGroup(d1, "#000");
    const bodies = [...html.matchAll(/<div class="post-body">([\s\S]*?)<\/div>/g)].map(m => m[1]);
    assert.ok(bodies.length > 0);
    for (const b of bodies) {
      assert.ok(!b.includes("**"), "preview não mostra asterisco literal");
      assert.ok(!b.includes("<strong>"), "preview não mostra o post em negrito");
    }
    assert.ok(bodies.join("").includes("O ponto é o preço por token."));
  });

  it("negrito dos cards aparece separado, fora do corpo do post", () => {
    const groups = groupByDestaque(parsePlatforms(MD), IMAGES);
    const d1 = groups.find(g => g.key === "d1")!;
    assert.deepEqual(cardBoldSpans(d1), [
      "O ponto é o preço por token.",
      "Isso derruba o custo de servir.",
      "Quem testou viu ganho real em código.",
    ]); // `# Curto` (X/Threads) não tem card — o negrito dele não entra

    const html = renderDestaqueGroup(d1, "#000");
    assert.ok(html.includes('class="card-bold-note"'));
    assert.ok(html.includes("<strong>O ponto é o preço por token.</strong>"));
  });

  it("HTML completo do preview não tem `**` em lugar nenhum", () => {
    const html = buildSocialHtml(parsePlatforms(MD), IMAGES);
    assert.ok(!html.includes("**"));
  });
});

describe("guard: publicadores usam o ponto único (#10441)", () => {
  const FILES = [
    "scripts/publish-linkedin.ts",
    "scripts/publish-facebook.ts",
    "scripts/publish-instagram.ts",
    "scripts/publish-threads.ts",
    "scripts/prep-twitter-posts.ts",
    "scripts/resolve-post-pixel.ts",
    "scripts/render-social-html.ts",
  ];
  for (const file of FILES) {
    it(`${file} importa social-post-text e não o strip cru`, () => {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      assert.ok(src.includes('from "./lib/social-post-text.ts"'), `${file} deveria usar toSocialPostText`);
      assert.ok(!/from "\.\/lib\/strip-markdown-emphasis\.ts"/.test(src), `${file} importa o strip cru — usar toSocialPostText`);
    });
  }
});
