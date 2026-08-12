/**
 * test/related-editions-5122.test.ts (#5122 item 3)
 *
 * Regressão pro bloco "Edições relacionadas" — a aresta edição->edição que
 * substitui, na prática, o mecanismo do #4907 (que exige match único
 * edição-wide e por isso quase nunca dispara, ver comentário registrado no
 * próprio #4907 a partir desta issue).
 *
 * Cobre: `selectRelatedEditions`/`renderRelatedEditionsMarkdown` (puros,
 * `scripts/lib/related-editions.ts`), a integração em `buildParaEncerrar`/
 * `stitchNewsletter` (`scripts/stitch-newsletter.ts`), e — critério de
 * pronto explícito da issue — que o bloco sobrevive ao render HTML como
 * `<a href>` de verdade (`renderEncerrar`, `scripts/lib/newsletter-render-html.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectRelatedEditions,
  renderRelatedEditionsMarkdown,
} from "../scripts/lib/related-editions.ts";
import { stitchNewsletter, buildParaEncerrar } from "../scripts/stitch-newsletter.ts";
import { renderEncerrar } from "../scripts/lib/newsletter-render-html.ts";
import { extractTemplateBlock } from "../scripts/lib/newsletter-parse.ts";

describe("selectRelatedEditions (#5122) — pura", () => {
  it("nenhuma manchete casa nenhum hub -> array vazio", () => {
    const out = selectRelatedEditions([
      ["Notícia qualquer sem tema de hub"],
      ["Outra notícia genérica"],
    ]);
    assert.deepEqual(out, []);
  });

  it("manchete claramente de um hub (OpenAI) -> retorna candidatos reais desse hub, urls de edição diar.ia.br", () => {
    const out = selectRelatedEditions([
      ["OpenAI lança GPT-Live para voz natural"],
      ["Notícia qualquer sem tema de hub"],
    ]);
    assert.ok(out.length > 0, "deveria achar pelo menos 1 edição relacionada do hub openai-chatgpt");
    for (const r of out) {
      assert.equal(r.hubSlug, "openai-chatgpt");
      assert.match(r.url, /^https:\/\/diar\.ia\.br\/p\//);
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(r.title.length > 0);
    }
  });

  it("respeita maxCount", () => {
    const out = selectRelatedEditions(
      [["OpenAI lança GPT-Live para voz natural"]],
      { maxCount: 1 },
    );
    assert.ok(out.length <= 1);
  });

  it("excludeUrls remove candidatos específicos (não repete a mesma URL 2x mesmo pedindo maxCount alto)", () => {
    const first = selectRelatedEditions([["OpenAI lança GPT-Live para voz natural"]], { maxCount: 1 });
    assert.ok(first.length === 1, "sanity: precisa achar 1 candidato pro teste fazer sentido");
    const excluded = selectRelatedEditions(
      [["OpenAI lança GPT-Live para voz natural"]],
      { maxCount: 1, excludeUrls: [first[0].url] },
    );
    assert.ok(excluded.length <= 1);
    if (excluded.length === 1) {
      assert.notEqual(excluded[0].url, first[0].url, "excludeUrls deveria pular o candidato já visto");
    }
  });

  it("2 destaques casando hubs DIFERENTES -> diversifica (não fica preso a 1 hub só), diferente da regra de ambiguidade do #4907", () => {
    const out = selectRelatedEditions(
      [
        ["Anthropic lança novo modelo Claude"],
        ["Google atualiza o Gemini com nova versão"],
      ],
      { maxCount: 3 },
    );
    assert.ok(out.length > 0, "ao contrário de matchEditionHub (#4907), ambiguidade NÃO suprime o resultado aqui");
    const slugs = new Set(out.map((r) => r.hubSlug));
    assert.ok(
      slugs.has("anthropic-claude") || slugs.has("google-gemini"),
      "pelo menos 1 dos 2 hubs casados deveria contribuir candidatos",
    );
  });

  it("nunca retorna URLs duplicadas mesmo com múltiplos hubs casados", () => {
    const out = selectRelatedEditions(
      [
        ["Anthropic lança novo modelo Claude"],
        ["Google atualiza o Gemini com nova versão"],
        ["OpenAI lança GPT-Live para voz natural"],
      ],
      { maxCount: 3 },
    );
    const urls = out.map((r) => r.url);
    assert.equal(new Set(urls).size, urls.length, "sem URL duplicada entre candidatos");
  });
});

describe("renderRelatedEditionsMarkdown (#5122) — pura", () => {
  it("array vazio -> null (grupo inteiro omitido)", () => {
    assert.equal(renderRelatedEditionsMarkdown([]), null);
  });

  it("formata como label 'Edições relacionadas:' + bullets, MESMO padrão de CURADORIA_PILLS (label sem blank line antes da lista)", () => {
    const out = renderRelatedEditionsMarkdown([
      { title: "Título A", url: "https://diar.ia.br/p/a", date: "2026-08-01", hubSlug: "openai-chatgpt" },
      { title: "Título B", url: "https://diar.ia.br/p/b", date: "2026-07-01", hubSlug: "openai-chatgpt" },
    ]);
    assert.equal(
      out,
      "Edições relacionadas:\n- [Título A](https://diar.ia.br/p/a)\n- [Título B](https://diar.ia.br/p/b)",
    );
  });
});

describe("buildParaEncerrar — grupo 'Edições relacionadas' (#5122)", () => {
  it("relatedEditionsMarkdown ausente/null -> comportamento idêntico a antes do #5122 (sem grupo novo)", () => {
    const out = buildParaEncerrar({ slotA: "Texto A." }, null);
    assert.doesNotMatch(out, /Edições relacionadas:/);
  });

  it("relatedEditionsMarkdown presente -> injetado ENTRE as pills de curadoria e o convite social", () => {
    const related = "Edições relacionadas:\n- [Outra edição](https://diar.ia.br/p/outra)";
    const out = buildParaEncerrar({ slotA: "Texto A." }, related);
    assert.match(out, /Edições relacionadas:\n- \[Outra edição\]\(https:\/\/diar\.ia\.br\/p\/outra\)/);
    const curadoriasPos = out.indexOf("Curadorias:");
    const relatedPos = out.indexOf("Edições relacionadas:");
    const socialInvitePos = out.indexOf("Para acompanhar as 3 principais notícias");
    assert.ok(curadoriasPos !== -1 && relatedPos !== -1 && socialInvitePos !== -1);
    assert.ok(curadoriasPos < relatedPos && relatedPos < socialInvitePos);
  });
});

describe("stitchNewsletter — 'Edições relacionadas' end-to-end (#5122)", () => {
  function setupEdition() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-related-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("D1 casa um hub -> PARA ENCERRAR ganha o grupo 'Edições relacionadas' com pelo menos 1 link real de outra edição", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n**[OpenAI lança GPT-Live para voz natural](https://example.com/d1)**\n\nbody1",
      );
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | 🔬 PESQUISA**\n\n**[Notícia qualquer sem tema de hub](https://example.com/d2)**\n\nbody2",
      );
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "Coverage." } }),
      );
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.match(out, /Edições relacionadas:/);
      assert.match(out, /- \[[^\]]+\]\(https:\/\/diar\.ia\.br\/p\/[^)]+\)/);

      // #5122 critério de pronto: o bloco emite <a href> pra outra edição no
      // HTML final — não só no markdown intermediário. Extrai o corpo de
      // PARA ENCERRAR (mesmo helper que a Etapa 4 usa) e roda pelo MESMO
      // renderer.
      const body = extractTemplateBlock(out, "🙋🏼‍♀️ PARA ENCERRAR");
      assert.ok(body, "PARA ENCERRAR deveria estar presente no output stitchado");
      const html = renderEncerrar(body!);
      assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/[^"]+"[^>]*>[^<]+<\/a>/);
    } finally {
      cleanup();
    }
  });

  it("2 destaques casando hubs DIFERENTES (Anthropic + Google) -> ainda ganha 'Edições relacionadas' (diferente de 'Saiba mais:', que fica ambíguo e sai vazio, #4907)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n**[Anthropic lança novo modelo Claude](https://example.com/d1)**\n\nbody1",
      );
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | 🌐 PRODUTO**\n\n**[Google atualiza o Gemini com nova versão](https://example.com/d2)**\n\nbody2",
      );
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "Coverage." } }),
      );
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.doesNotMatch(out, /Saiba mais:/, "sanity: #4907 continua ambíguo aqui, sem link contextual no destaque");
      assert.match(out, /Edições relacionadas:/, "mas 'Edições relacionadas' (#5122) não herda essa restrição");
    } finally {
      cleanup();
    }
  });

  it("nenhum destaque casa hub nenhum -> sem grupo 'Edições relacionadas' (comportamento preservado)", () => {
    const { dir, internalDir, cleanup } = setupEdition();
    try {
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n**[Notícia qualquer sem tema de hub](https://example.com/d1)**\n\nbody1",
      );
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | 🔬 PESQUISA**\n\n**[Outra notícia genérica sem tema](https://example.com/d2)**\n\nbody2",
      );
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "Coverage." } }),
      );
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        sponsor: false,
      });

      assert.doesNotMatch(out, /Edições relacionadas:/);
    } finally {
      cleanup();
    }
  });
});
