/**
 * test/sync-coverage-line.test.ts (#1097)
 *
 * Cobertura dos helpers pure de sync-coverage-line.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countEditorVsAuto,
  countForwardedEmailsFromInbox,
  countSelectedItems,
  countSubmissionsFromArchive,
  deriveResearchDateISO,
  rewriteCoverageLine,
  readSubmissionsCountFromMarker,
  parsePoolArticles,
} from "../scripts/sync-coverage-line.ts";

describe("parsePoolArticles (#1404)", () => {
  it("aceita flat array (shape legado)", () => {
    const raw = [{ url: "a" }, { url: "b" }];
    const result = parsePoolArticles(raw);
    assert.deepEqual(result, raw);
    assert.equal(result?.length, 2);
  });

  it("aceita wrapped object {articles: [...]} (shape atual pós enrich)", () => {
    // Replicar shape real de tmp-articles-raw.json em /diaria-test 260520
    const raw = {
      articles: [{ url: "a" }, { url: "b" }, { url: "c" }],
      expanded: [],
      warnings: [],
    };
    const result = parsePoolArticles(raw);
    assert.equal(result?.length, 3);
    assert.equal(result?.[0].url, "a");
  });

  it("retorna null em shape desconhecida (não fabrica array vazio)", () => {
    // Antes do fix, JSON.parse direto deixava pool.length === undefined,
    // gerando NaN silenciosamente. Agora retorna null pra abort explícito.
    assert.equal(parsePoolArticles({ foo: "bar" }), null);
    assert.equal(parsePoolArticles(null), null);
    assert.equal(parsePoolArticles("string"), null);
    assert.equal(parsePoolArticles(42), null);
  });

  it("rejeita objeto onde articles não é array", () => {
    assert.equal(parsePoolArticles({ articles: "not an array" }), null);
    assert.equal(parsePoolArticles({ articles: null }), null);
  });

  it("regressão #1404: pool.length é numérico (não NaN) com wrapped shape", () => {
    // Caso real 260520: countEditorVsAuto recebia pool com .length undefined
    // pq input era {articles:[...]} sem unwrap → Y = undefined - 9 = NaN.
    const raw = { articles: Array.from({ length: 100 }, (_, i) => ({ url: `u${i}` })) };
    const pool = parsePoolArticles(raw)!;
    const { y } = countEditorVsAuto(pool, 9);
    assert.equal(typeof y, "number");
    assert.ok(!Number.isNaN(y), `Y deve ser numérico, got ${y}`);
    assert.equal(y, 91);
  });
});

describe("countEditorVsAuto (#1323)", () => {
  it("X = forwarded emails count (não URL count)", () => {
    const pool = [
      { flag: "editor_submitted", url: "u1" },
      { flag: "editor_submitted", url: "u2" },
      { url: "u3" },
    ];
    // 2 editor emails forwardados → X=2, Y=pool-X=1
    assert.deepEqual(countEditorVsAuto(pool, 2), { x: 2, y: 1 });
  });

  it("#1323: forward de newsletter com 30 URLs = 1 submissão (não 30)", () => {
    // Replicar caso 260518: 1 newsletter forwardada com 30 URLs primárias.
    // Antes (#1280) → X=30 (cada URL contava). Agora → X=1 (cada email).
    const pool: { flag?: string; url: string }[] = [];
    for (let i = 0; i < 30; i++) pool.push({ flag: "newsletter_extracted", url: `n${i}` });
    for (let i = 0; i < 100; i++) pool.push({ url: `auto${i}` });

    // 1 newsletter encaminhada = 1 email = X=1
    const { x, y } = countEditorVsAuto(pool, 1);
    assert.equal(x, 1, "1 forward de newsletter = 1 submissão");
    assert.equal(y, 129, "29 URLs extras + 100 auto = 129 encontradas pela Diar.ia");
  });

  it("#1323: 3 forwards diretos + 1 newsletter forward = X=4", () => {
    // Editor: 3 emails com 1 URL direto + 1 email com newsletter de 30 URLs.
    const pool: { flag?: string; url: string }[] = [];
    for (let i = 0; i < 3; i++) pool.push({ flag: "editor_submitted", url: `e${i}` });
    for (let i = 0; i < 30; i++) pool.push({ flag: "newsletter_extracted", url: `n${i}` });
    for (let i = 0; i < 80; i++) pool.push({ url: `auto${i}` });

    // 4 emails forwardados → X=4
    const { x, y } = countEditorVsAuto(pool, 4);
    assert.equal(x, 4);
    assert.equal(y, 113 - 4, "pool total 113 - X 4 = 109");
  });

  it("pool vazio", () => {
    assert.deepEqual(countEditorVsAuto([], 0), { x: 0, y: 0 });
  });

  it("Y nunca fica negativo (defensive)", () => {
    // Se forwardedEmails > pool (impossível em prod mas defensive)
    assert.deepEqual(countEditorVsAuto([{ url: "u" }], 5), { x: 5, y: 0 });
  });
});

describe("countForwardedEmailsFromInbox (#1323)", () => {
  function withTmpInbox(content: string, test: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "diaria-inbox-"));
    const path = join(dir, "inbox.md");
    try {
      writeFileSync(path, content, "utf8");
      test(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("conta 3 emails distintos do editor", () => {
    const content = `## 2026-05-15T10:00:00Z
- **from:** pixel@example.com
- **subject:** Forward 1

http://example.com/1

## 2026-05-15T11:00:00Z
- **from:** pixel@example.com
- **subject:** Forward 2

http://example.com/2

## 2026-05-15T12:00:00Z
- **from:** pixel@example.com
- **subject:** Forward 3

http://example.com/3
`;
    withTmpInbox(content, (path) => {
      assert.equal(countForwardedEmailsFromInbox(path, "pixel@example.com"), 3);
    });
  });

  it("ignora emails de outros senders (newsletters subscribed)", () => {
    const content = `## 2026-05-15T10:00:00Z
- **from:** pixel@example.com
- **subject:** Forward direto

http://example.com/1

## 2026-05-15T11:00:00Z
- **from:** cyberman@feeds.io
- **subject:** Cyberman daily

http://item1.com http://item2.com http://item3.com
`;
    withTmpInbox(content, (path) => {
      // 1 forward + 1 newsletter de outro sender → conta só 1 (do editor)
      assert.equal(countForwardedEmailsFromInbox(path, "pixel@example.com"), 1);
    });
  });

  it("retorna 0 se arquivo ausente", () => {
    assert.equal(countForwardedEmailsFromInbox("/nonexistent/path.md", "pixel@example.com"), 0);
  });

  it("inbox vazio retorna 0", () => {
    withTmpInbox("", (path) => {
      assert.equal(countForwardedEmailsFromInbox(path, "pixel@example.com"), 0);
    });
  });

  it("case-insensitive match no email do editor", () => {
    const content = `## 2026-05-15T10:00:00Z
- **from:** Pixel@Example.com
- **subject:** Test

http://example.com/1
`;
    withTmpInbox(content, (path) => {
      assert.equal(countForwardedEmailsFromInbox(path, "pixel@example.com"), 1);
    });
  });
});

describe("countSelectedItems", () => {
  it("conta destaques + seções, ignora afiliados", () => {
    const md = `Para esta edição...

---

**DESTAQUE 1**

**[Título A](https://example.com/a)**

Texto.

---

**OUTRAS NOTÍCIAS**

**[Item 1](https://x.com/1)**
Frase.

**[Item 2](https://y.com/2)**
Frase.

---

**🎁 SORTEIO**

[Link afiliado](https://diaria.beehiiv.com/livros-sobre-ia)

---

**🙋🏼‍♀️ PARA ENCERRAR**

[Wispr](https://wisprflow.ai/r?X=Y)
[LinkedIn](https://www.linkedin.com/company/diaria/)
`;
    // 3 itens editoriais: 1 destaque + 2 outras notícias. Pula sorteio + encerrar.
    assert.equal(countSelectedItems(md), 3);
  });

  it("ignora É IA? (links wikipedia/wikimedia/creativecommons)", () => {
    const md = `---

**DESTAQUE 1**

**[Real](https://example.com/d1)**

---

É IA?

Vista aérea... [Takht-i-Bahi](https://pt.wikipedia.org/wiki/Takht-i-Bahi). [Autor](https://commons.wikimedia.org/wiki/User:X) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).
`;
    // Mesmo se "É IA?" não tem markdown explícito, links interno são filtrados.
    // Mas o split por --- preserva o bloco "É IA?" — SKIP_HEADERS o filtra.
    assert.equal(countSelectedItems(md), 1);
  });

  it("#1441: conta OUTRAS NOTÍCIAS mesmo sem --- antes de SORTEIO (caso 260520)", () => {
    const md = `Para esta edição...

---

**📰 OUTRAS NOTÍCIAS**

**[Item 1](https://x.com/a)**
desc

**[Item 2](https://x.com/b)**
desc

**🎁 SORTEIO**

texto sorteio

---

**ASSINE**

x`;
    // Sem --- entre OUTRAS e SORTEIO. Antes do fix retornava 0 (skip section
    // toda por conter "SORTEIO"); pós-fix conta 2 itens (sub-split por section
    // header isola OUTRAS de SORTEIO).
    assert.equal(countSelectedItems(md), 2);
  });

  it("#1441: conta destaque + OUTRAS sem --- entre LANÇAMENTOS e PESQUISAS", () => {
    const md = `---

**DESTAQUE 1**

**[Destaque A](https://example.com/d1)**

---

**🚀 LANÇAMENTOS**

**[L1](https://x.com/l1)**
desc
**[L2](https://x.com/l2)**
desc

**🔬 PESQUISAS**

**[P1](https://x.com/p1)**
desc

**📰 OUTRAS NOTÍCIAS**

**[N1](https://x.com/n1)**
desc

**🎁 SORTEIO**

texto`;
    // 1 destaque + 2 lancamentos + 1 pesquisa + 1 outra = 5
    assert.equal(countSelectedItems(md), 5);
  });

  it("#1441: PARA ENCERRAR cola com SORTEIO sem --- entre eles → skip ambos", () => {
    const md = `---

**📰 OUTRAS NOTÍCIAS**

**[N1](https://x.com/n1)**

**🎁 SORTEIO**

x

**🙋🏼‍♀️ PARA ENCERRAR**

Encerrando`;
    // 1 outra + 0 (sorteio skip) + 0 (encerrar skip) = 1
    assert.equal(countSelectedItems(md), 1);
  });

  it("#1441: ERRO INTENCIONAL cola com ASSINE → ambos skip", () => {
    const md = `---

**OUTRAS NOTÍCIAS**

**[N1](https://x.com/n1)**

**ERRO INTENCIONAL**

Nessa edição, X.

**ASSINE**

x`;
    assert.equal(countSelectedItems(md), 1);
  });

  it("deduplica URLs repetidas no mesmo destaque (3 títulos pré-poda)", () => {
    const md = `---

**DESTAQUE 1**

**[Título A](https://example.com/d1)**

**[Título B](https://example.com/d1)**

**[Título C](https://example.com/d1)**

Texto.

---

**OUTRAS NOTÍCIAS**

**[Outro](https://x.com/y)**
`;
    // 3 títulos da mesma URL = 1 item editorial + 1 outra = 2
    assert.equal(countSelectedItems(md), 2);
  });
});

describe("rewriteCoverageLine", () => {
  it("substitui números corretamente", () => {
    const md = `Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

---

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 13 submissões e a Diar\.ia encontrou outros 125 artigos\. Selecionamos os 12/);
  });

  it("também aceita 'cinco' por extenso na linha original", () => {
    const md = `Para esta edição, eu (o editor) enviei cinco submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 13 submissões/);
  });

  it("no-op quando números já corretos", () => {
    const md = `Para esta edição, eu (o editor) enviei 13 submissões e a Diar.ia encontrou outros 125 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.equal(r.changed, false);
  });

  it("retorna changed: false quando linha ausente", () => {
    const md = `Texto qualquer sem linha de cobertura.

Outro parágrafo.`;
    const r = rewriteCoverageLine(md, 1, 2, 3);
    assert.equal(r.changed, false);
    assert.equal(r.md, md);
  });

  it("#1179: tolera YAML frontmatter no topo (intentional_error declarado)", () => {
    const md = `---
intentional_error:
  description: "Mythos é atribuído à OpenAI, mas o modelo é da Anthropic."
  location: "DESTAQUE 3, parágrafo 1, segunda frase"
  category: "attribution"
  correct_value: "Anthropic"
---

Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

---

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed, "deve atualizar mesmo com frontmatter");
    assert.match(r.md, /enviei 13 submissões/);
    // Frontmatter preservado.
    assert.match(r.md, /intentional_error:/);
  });

  it("#1179: tolera vírgula após 'submissões' (Clarice às vezes adiciona)", () => {
    // Caso real edição 260513: Clarice sugeriu "submissões" → "submissões,"
    // e o regex original não tolerava — script falhava silenciosamente.
    const md = `Para esta edição, eu (o editor) enviei 8 submissões, e a Diar.ia encontrou outros 120 artigos. Selecionamos os 15 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 8, 120, 12);
    assert.ok(r.changed, "deve normalizar pra forma canônica (sem vírgula extra)");
    // Resultado canônico: sem vírgula entre "submissões" e "e".
    assert.match(r.md, /enviei 8 submissões e a Diar\.ia/);
    // Número Z atualizado de 15 → 12.
    assert.match(r.md, /Selecionamos os 12 mais relevantes/);
    // Vírgula extra removida.
    assert.doesNotMatch(r.md, /submissões, e/);
  });

  it("#1179: combina frontmatter + vírgula Clarice (caso real 260513)", () => {
    const md = `---
intentional_error:
  description: "..."
  location: "..."
  category: "attribution"
  correct_value: "Anthropic"
---

Para esta edição, eu (o editor) enviei 8 submissões, e a Diar.ia encontrou outros 120 artigos. Selecionamos os 15 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 8, 120, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 8 submissões e a Diar\.ia/);
    assert.match(r.md, /Selecionamos os 12 mais relevantes/);
  });
});

describe("readSubmissionsCountFromMarker (#1368, refined #1414)", () => {
  function makeFixtureEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-sync-coverage-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("#1414: soma editor_blocks + newsletter_blocks (caso 260520: 9 + 4 = 13)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ editor_blocks: 9, newsletter_blocks: 4 }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 13);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna só editor_blocks quando newsletter_blocks ausente (marker pre-#1095)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ editor_blocks: 4 }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna null quando marker ausente — caller faz fallback archive/inbox.md", () => {
    const dir = makeFixtureEdition();
    assert.equal(readSubmissionsCountFromMarker(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna null se editor_blocks não é número (marker corrupto)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ editor_blocks: "4" }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna null se editor_blocks ausente do marker", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ injected: 5 }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna null se marker é JSON inválido", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      "not-json-{{{",
    );
    assert.equal(readSubmissionsCountFromMarker(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna 0 quando marker explicitamente diz editor_blocks: 0, newsletter_blocks: 0", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ editor_blocks: 0, newsletter_blocks: 0 }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignora newsletter_blocks corrupto (não-número) — soma 0 ao invés de NaN", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ editor_blocks: 5, newsletter_blocks: "x" }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 5);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("deriveResearchDateISO (#1414)", () => {
  it("deriva D-1 da edição AAMMDD (260520 → 2026-05-19)", () => {
    assert.equal(deriveResearchDateISO("data/editions/260520"), "2026-05-19");
  });

  it("lida com trailing slash", () => {
    assert.equal(deriveResearchDateISO("data/editions/260520/"), "2026-05-19");
  });

  it("lida com transição de mês (260501 → 2026-04-30)", () => {
    assert.equal(deriveResearchDateISO("data/editions/260501"), "2026-04-30");
  });

  it("lida com transição de ano (260101 → 2025-12-31)", () => {
    assert.equal(deriveResearchDateISO("data/editions/260101"), "2025-12-31");
  });

  it("retorna null pra basename inválido", () => {
    assert.equal(deriveResearchDateISO("data/editions/not-a-date"), null);
    assert.equal(deriveResearchDateISO("data/editions/2605201"), null);
  });
});

describe("countSubmissionsFromArchive (#1414)", () => {
  function makeArchiveFixture(isoDate: string, content: string): { dir: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-archive-"));
    writeFileSync(join(root, `${isoDate}.md`), content, "utf8");
    return { dir: root, root };
  }

  it("conta blocos ^## no archive da data de pesquisa (caso 260520: 13)", () => {
    const content =
      "## 2026-05-19T10:00:00.000Z\n- **from:** Editor\n\n" +
      "## 2026-05-19T11:00:00.000Z\n- **from:** Newsletter A\n\n" +
      "## 2026-05-19T12:00:00.000Z\n- **from:** Newsletter B\n";
    const { root } = makeArchiveFixture("2026-05-19", content);
    assert.equal(countSubmissionsFromArchive("data/editions/260520", root), 3);
    rmSync(root, { recursive: true, force: true });
  });

  it("retorna 0 quando archive existe mas está vazio", () => {
    const { root } = makeArchiveFixture("2026-05-19", "");
    assert.equal(countSubmissionsFromArchive("data/editions/260520", root), 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("retorna null quando archive da data não existe", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-archive-empty-"));
    assert.equal(countSubmissionsFromArchive("data/editions/260520", root), null);
    rmSync(root, { recursive: true, force: true });
  });

  it("retorna null pra edition_dir inválido", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-archive-"));
    assert.equal(countSubmissionsFromArchive("data/editions/not-a-date", root), null);
    rmSync(root, { recursive: true, force: true });
  });

  it("não conta '##' inline (só linhas começando com '## ')", () => {
    const content =
      "## 2026-05-19T10:00:00.000Z\n- **subject:** ## not a heading inline\n\n" +
      "## 2026-05-19T11:00:00.000Z\n- **subject:** another\n";
    const { root } = makeArchiveFixture("2026-05-19", content);
    assert.equal(countSubmissionsFromArchive("data/editions/260520", root), 2);
    rmSync(root, { recursive: true, force: true });
  });
});
