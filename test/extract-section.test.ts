/**
 * test/extract-section.test.ts
 *
 * Cobertura de `scripts/lib/extract-section.ts`: `extractSection` (nível
 * `# Título`, já usado indiretamente por vários publishers) + `extractDestaqueBlock`
 * e `assertNoScaffolding`, adicionados no #4309 pra consolidar a extração do
 * `## d{N}` compartilhada entre publish-linkedin/instagram/facebook/threads.ts
 * e prep-twitter-posts.ts.
 *
 * Regressão #4309: Facebook e Instagram publicaram `## eia`/`## post_pixel` +
 * placeholders `{edition_url}`/`{outros_count}` literais em produção
 * (260727-260729) porque o terminador do `## dN` em 4 dos 5 consumidores só
 * parava em outro `## dN` (`\n## d\d+\b`), não em qualquer sibling `## `.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSection, extractDestaqueBlock, assertNoScaffolding } from "../scripts/lib/extract-section.ts";

describe("extractSection", () => {
  const MD = "# Social\n\nCorpo A.\n\n# Curto\n\nCorpo B.\n";

  it("extrai o corpo da seção pedida", () => {
    assert.ok(extractSection(MD, "Social")?.includes("Corpo A."));
    assert.ok(!extractSection(MD, "Social")?.includes("Corpo B."));
  });

  it("retorna null quando a seção não existe", () => {
    assert.equal(extractSection(MD, "Facebook"), null);
  });

  it("normaliza CRLF para LF antes de casar", () => {
    const crlf = MD.replace(/\n/g, "\r\n");
    assert.ok(extractSection(crlf, "Social")?.includes("Corpo A."));
  });
});

describe("extractDestaqueBlock — terminador correto (#4309, mesmo já usado por publish-linkedin.ts #1690)", () => {
  // Forma REAL de `03-social.md` pós-#3991/#3471 (merge-social-md.ts): dentro
  // de `# Social`, a ordem é d1 → d2 → d3 → ## eia → ## post_pixel. O último
  // destaque (d3) é o caso que quebrou em produção — o terminador errado
  // (`\n## d\d+\b`) não para em `## eia`, então d3 absorve tudo até o fim.
  const SECTION_BODY_REAL_SHAPE =
    "\n## d1\n\nTexto d1.\n\n#tag1\n" +
    "\n## d2\n\nTexto d2.\n\n#tag2\n" +
    "\n## d3\n\nTexto d3 exclusivo.\n\n#tag3\n" +
    "\n## eia\n\n<!-- destaque: eia -->\n\nTexto do É IA? de hoje. Imagem: 01-eia-A.jpg\n" +
    "\n## post_pixel\n\nPost pessoal do Pixel. {edition_url} {outros_count}\n";

  it("extrai d3 sem vazar '## eia' (regressão #4309)", () => {
    const text = extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d3")!;
    assert.ok(text.includes("Texto d3 exclusivo."));
    assert.ok(!text.includes("## eia"));
    assert.ok(!text.includes("Texto do É IA?"));
    assert.ok(!text.includes("01-eia-A.jpg"));
  });

  it("extrai d3 sem vazar '## post_pixel' nem os placeholders não-resolvidos (regressão #4309)", () => {
    const text = extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d3")!;
    assert.ok(!text.includes("## post_pixel"));
    assert.ok(!text.includes("Post pessoal do Pixel"));
    assert.ok(!text.includes("{edition_url}"));
    assert.ok(!text.includes("{outros_count}"));
  });

  it("extrai d1/d2 normalmente, sem vazar destaques irmãos", () => {
    assert.ok(extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d1")!.includes("Texto d1."));
    assert.ok(!extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d1")!.includes("Texto d2."));
    assert.ok(extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d2")!.includes("Texto d2."));
    assert.ok(!extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d2")!.includes("Texto d3"));
  });

  it("remove comentários HTML do bloco extraído", () => {
    const text = extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d3")!;
    // '<!-- destaque: eia -->' vive dentro de '## eia', que já não deveria
    // aparecer — reforça que o corte aconteceu ANTES do comentário.
    assert.ok(!text.includes("<!--"));
  });

  it("retorna null quando o destaque não existe", () => {
    assert.equal(extractDestaqueBlock(SECTION_BODY_REAL_SHAPE, "d9"), null);
  });

  it("#725 bug #3: '\\d+\\b' evita que '## d10' bata como '## d1' + '0'", () => {
    const body = "\n## d1\nSó d1.\n\n## d10\nSó d10.\n";
    assert.equal(extractDestaqueBlock(body, "d1")!.trim(), "Só d1.");
  });
});

describe("assertNoScaffolding — guard de saída do extractor (#4309)", () => {
  it("não lança para texto limpo", () => {
    assert.doesNotThrow(() => assertNoScaffolding("Texto normal do post. #tag", "teste"));
  });

  it("lança quando o texto contém outro cabeçalho '## ' (vazamento de sibling)", () => {
    assert.throws(
      () => assertNoScaffolding("Texto.\n\n## eia\n\nOutra seção vazada.", "destaque 'd3'"),
      /destaque 'd3'.*cabeçalho de seção interno/s,
    );
  });

  it("lança quando o texto contém {edition_url} não substituído", () => {
    assert.throws(
      () => assertNoScaffolding("Confira em {edition_url}.", "destaque 'd3'"),
      /\{edition_url\}/,
    );
  });

  it("lança quando o texto contém {outros_count} não substituído", () => {
    assert.throws(
      () => assertNoScaffolding("Mais {outros_count} notícias.", "destaque 'd3'"),
      /\{outros_count\}/,
    );
  });

  it("mensagem de erro cita a issue #4309 e inclui um trecho do texto", () => {
    try {
      assertNoScaffolding("Confira em {edition_url}.", "destaque 'd3' (facebook)");
      assert.fail("deveria ter lançado");
    } catch (e: any) {
      assert.match(e.message, /#4309/);
      assert.match(e.message, /destaque 'd3' \(facebook\)/);
      assert.match(e.message, /Confira em/);
    }
  });
});

describe("extractDestaqueBlock NÃO aplica o guard (primitivo de baixo nível, #4309)", () => {
  // `extractDestaqueBlock` é reusado por `publish-linkedin.ts` pra extrair o
  // bloco `## dN` INTEIRO (incluindo `### comment_diaria`/`### comment_pixel`
  // ainda com `{edition_url}`/`{outros_count}` não resolvidos) ANTES de
  // subdividir — aplicar o guard aqui quebraria esse contrato legítimo. Cada
  // caller aplica `assertNoScaffolding` no PRÓPRIO ponto de saída do texto
  // final (ver `extractPostText` de cada publisher).
  it("não lança mesmo se o bloco cru contiver {edition_url}/{outros_count} (ex: ## post_pixel de publish-linkedin.ts)", () => {
    const body = "\n## d1\n\nTexto principal.\n\n### comment_diaria\n\nEdição em {edition_url} — {outros_count} destaques.\n";
    assert.doesNotThrow(() => extractDestaqueBlock(body, "d1"));
    assert.ok(extractDestaqueBlock(body, "d1")!.includes("{edition_url}"));
  });

  it("integração: caller que aplica assertNoScaffolding no texto final PEGA o placeholder cru (fail-fast, #4309)", () => {
    // Simula o que publish-instagram/facebook/threads fazem: extrair o bloco
    // e então validar o texto final antes de retornar/publicar.
    const body = "\n## d1\n\nTexto com {edition_url} cru (nunca deveria estar aqui num d1 simples).\n";
    const text = extractDestaqueBlock(body, "d1")!;
    assert.throws(() => assertNoScaffolding(text, "destaque 'd1' (teste de integração)"), /\{edition_url\}/);
  });
});
