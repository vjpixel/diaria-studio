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
  rewriteCoverageLineAsCaptureFailed,
  renderCaptureFailedLine,
  readSubmissionsCountFromMarker,
  readCaptureFailedFromMarker,
  readCapturedNewsletterCount,
  parsePoolArticles,
  WELCOME_COVERAGE_SENTENCE_RE,
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

  it("#1864: Y subtrai os LINKS do editor (não os e-mails) quando inboxLinkCount é passado", () => {
    // X = e-mails, Y = links Diar.ia encontrou. Caso 260605: pool 350 links,
    // editor enviou 12 e-mails que trouxeram 157 links (3 editor + 154 newsletter).
    const pool = Array.from({ length: 350 }, (_, i) => ({ url: `u${i}` }));
    const { x, y } = countEditorVsAuto(pool, 12, 157);
    assert.equal(x, 12, "X = nº de e-mails (submissões)");
    assert.equal(y, 193, "Y = 350 links − 157 links do canal do editor (NÃO 350 − 12 e-mails = 338)");
  });

  it("#1864: sem inboxLinkCount → fallback legado (pool − e-mails)", () => {
    const pool = Array.from({ length: 350 }, (_, i) => ({ url: `u${i}` }));
    assert.equal(countEditorVsAuto(pool, 12).y, 338); // comportamento antigo preservado
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
[LinkedIn](https://www.linkedin.com/company/diar.ia.br/)
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

  // #2695: FOOTER_DOMAINS foi consolidado numa fonte única (canonical-urls.ts),
  // agora incluindo as variantes amplas de wikipedia/wikimedia (não só pt/commons)
  // + wikidata.org + os Workers de template (cursos/livros/poll). O bloco É IA?
  // é sempre pulado por header (não exercita FOOTER_DOMAINS) — pra testar a
  // lista de fato, a citação precisa estar DENTRO de um bucket contado
  // (RADAR aqui), junto do link real do item, e o total não pode inflar.
  it("#2695: citação com domínio amplo (wikipedia/wikimedia/wikidata/Workers) dentro de um bucket contado não infla o total", () => {
    const md = `---

**DESTAQUE 1**

**[Real](https://example.com/d1)**

---

**RADAR**

**[Item 1](https://x.com/1)**
Fonte: [Wiki EN](https://en.wikipedia.org/wiki/X), [Upload](https://upload.wikimedia.org/wikipedia/commons/x.jpg), [Wikidata](https://www.wikidata.org/wiki/Q1), [Cursos](https://cursos.diaria.workers.dev), [Livros](https://livros.diaria.workers.dev), [Poll](https://poll.diaria.workers.dev/vote).
`;
    // 1 destaque + 1 item RADAR = 2. As 6 citações de domínio footer não contam.
    assert.equal(countSelectedItems(md), 2);
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

describe("rewriteCoverageLine — bloco de boas-vindas #3461 (regressão #3696)", () => {
  // Fixture no formato ATUAL (#3461, padrão desde 260715) — 4 parágrafos,
  // gerado pelo mesmo template de `formatCoverageLine` (lib/inbox-stats.ts).
  // Antes do fix #3696, COVERAGE_LINE_RE (só formato legado) nunca casava
  // aqui — rewriteCoverageLine saía silenciosamente com changed:false em
  // TODA edição publicada desde 260715 (o mecanismo de correção do X ficava
  // desativado de fato).
  function welcomeBlockMd(x: number, y: number, z: number): string {
    const selPhrase = z === 1 ? "selecionei o artigo mais relevante" : `selecionei os ${z} mais relevantes`;
    return [
      "Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor dessa newsletter.",
      "",
      "Todos os dias, junto com a IA da diar.ia.br, seleciono e resumo as notícias mais importantes para economizar o seu tempo.",
      "",
      `Nesta edição, a IA analisou ${x + y} artigos (${x} enviados por mim e ${y} encontrados automaticamente) e ${selPhrase}.`,
      "",
      "Se esse trabalho faz diferença para você, [considere apoiar o projeto](https://apoia.se/diaria).",
      "",
      "---",
      "",
      "**DESTAQUE 1**",
      "",
      "Resto.",
    ].join("\n");
  }

  it("caso real 260720: reescreve X=3→12 preservando saudação/CTA ao redor", () => {
    const md = welcomeBlockMd(3, 164, 12);
    const r = rewriteCoverageLine(md, 12, 164, 12);
    assert.ok(r.changed);
    assert.match(
      r.md,
      /Nesta edição, a IA analisou 176 artigos \(12 enviados por mim e 164 encontrados automaticamente\) e selecionei os 12 mais relevantes\./,
    );
    // Saudação e CTA de apoio preservados intactos.
    assert.match(r.md, /^Olá! Eu sou o \[Pixel\]\(https:\/\/www\.linkedin\.com\/in\/vjpixel\/\), editor dessa newsletter\./);
    assert.match(r.md, /\[considere apoiar o projeto\]\(https:\/\/apoia\.se\/diaria\)\./);
  });

  it("no-op quando números já corretos (idempotente)", () => {
    const md = welcomeBlockMd(12, 164, 12);
    const r = rewriteCoverageLine(md, 12, 164, 12);
    assert.equal(r.changed, false);
  });

  it("concordância singular quando z=1 (selecionei o artigo mais relevante)", () => {
    const md = welcomeBlockMd(5, 10, 3);
    const r = rewriteCoverageLine(md, 5, 10, 1);
    assert.ok(r.changed);
    assert.match(r.md, /e selecionei o artigo mais relevante\./);
  });

  it("main() não sai com exit 1 pro formato de boas-vindas — WELCOME_COVERAGE_SENTENCE_RE reconhece a sentença", () => {
    // Regressão direta do bug: antes, nem COVERAGE_LINE_RE nem
    // CAPTURE_FAILED_LINE_RE casavam este MD — main() abortava com "MD não
    // tem linha de cobertura" em toda edição desde 260715.
    const md = welcomeBlockMd(12, 164, 12);
    assert.ok(WELCOME_COVERAGE_SENTENCE_RE.test(md));
  });

  it("rewriteCoverageLineAsCaptureFailed também reconhece o bloco de boas-vindas", () => {
    const md = welcomeBlockMd(3, 164, 12);
    const r = rewriteCoverageLineAsCaptureFailed(md, "invalid_client");
    assert.ok(r.changed);
    assert.doesNotMatch(r.md, /Nesta edição, a IA analisou/);
    assert.match(r.md, /contagem de submissões indisponível \(captura de newsletters falhou: invalid_client\)/);
    // Saudação preservada.
    assert.match(r.md, /^Olá! Eu sou o \[Pixel\]/);
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

  it("#1476: lê editor_blocks de dentro de details (formato atual do marker)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        completed_at: "2026-05-24T19:31:04.759Z",
        details: { injected: 4, total_editor_urls: 4, total_newsletter_urls: 0, total_pool_size: 147, editor_blocks: 4, newsletter_blocks: 0 },
      }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("#1476: lê editor_blocks+newsletter_blocks de details (caso misto)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        details: { editor_blocks: 9, newsletter_blocks: 4 },
      }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 13);
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

  it("#1541: captured-articles path usa captured_newsletter_count do marker (não newsletter_blocks)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        details: {
          editor_blocks: 0,
          newsletter_blocks: 0,
          newsletter_source: "captured-articles",
          captured_newsletter_count: 9,
        },
      }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 9);
    rmSync(dir, { recursive: true, force: true });
  });

  it("#1756: newsletters SÃO submissões — captured_newsletter_count soma com editor_blocks (E+N)", () => {
    // Trava o contrato editorial: o editor conta os e-mails de newsletter como
    // submissões dele. X = editor_blocks + captured_newsletter_count, ambos > 0.
    // (O bug 260603 foi 0b-bis pulado → captured_newsletter_count: 0 → X subcontou;
    //  a fórmula em si — testada aqui — sempre soma os dois.)
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        details: {
          editor_blocks: 3,
          newsletter_blocks: 0,
          newsletter_source: "captured-articles",
          captured_newsletter_count: 11,
        },
      }),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 14); // 3 + 11
    rmSync(dir, { recursive: true, force: true });
  });

  it("#1541: captured-articles sem captured_newsletter_count faz fallback pra captured-newsletters.json", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        details: {
          editor_blocks: 0,
          newsletter_blocks: 0,
          newsletter_source: "captured-articles",
        },
      }),
    );
    // Simulate captured-newsletters.json with 9 newsletter threads
    writeFileSync(
      join(dir, "_internal", "captured-newsletters.json"),
      JSON.stringify(Array.from({ length: 9 }, (_, i) => ({
        thread_id: `t${i}`,
        sender: `sender${i}@example.com`,
        subject: `Newsletter ${i}`,
      }))),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 9);
    rmSync(dir, { recursive: true, force: true });
  });

  it("#1541: captured-articles sem captured_newsletter_count nem captured-newsletters.json → 0", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        details: {
          editor_blocks: 2,
          newsletter_blocks: 0,
          newsletter_source: "captured-articles",
        },
      }),
    );
    // No captured-newsletters.json → newsletter count falls back to 0
    assert.equal(readSubmissionsCountFromMarker(dir), 2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("#1541: caso real 260528 — editor_blocks:0 + 9 captured newsletters = 9", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        completed_at: "2026-05-27T19:42:51.255Z",
        details: {
          injected: 79,
          total_editor_urls: 0,
          total_newsletter_urls: 80,
          total_pool_size: 246,
          editor_blocks: 0,
          newsletter_blocks: 0,
          newsletter_source: "captured-articles",
        },
      }),
    );
    writeFileSync(
      join(dir, "_internal", "captured-newsletters.json"),
      JSON.stringify(Array.from({ length: 9 }, (_, i) => ({
        thread_id: `t${i}`,
        sender: `sender${i}@mail.beehiiv.com`,
        subject: `Newsletter ${i}`,
      }))),
    );
    assert.equal(readSubmissionsCountFromMarker(dir), 9);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readCapturedNewsletterCount (#1541)", () => {
  function makeFixtureEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-sync-coverage-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("counts entries in captured-newsletters.json", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", "captured-newsletters.json"),
      JSON.stringify([{ thread_id: "a" }, { thread_id: "b" }, { thread_id: "c" }]),
    );
    assert.equal(readCapturedNewsletterCount(dir), 3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 when file missing", () => {
    const dir = makeFixtureEdition();
    assert.equal(readCapturedNewsletterCount(dir), 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 when file is not an array", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", "captured-newsletters.json"),
      JSON.stringify({ threads: [] }),
    );
    assert.equal(readCapturedNewsletterCount(dir), 0);
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

// ---------------------------------------------------------------------------
// #2878: coverage line "0 submissões" quando 0b-bis falha por auth — a
// distinção entre "0 real" e "captura falhou" tem que sobreviver a partir
// do marker até o texto renderizado no 02-reviewed.md.
// ---------------------------------------------------------------------------

describe("readCaptureFailedFromMarker (#2878)", () => {
  function makeFixtureEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-capture-failed-marker-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("retorna failed:true + error quando marker sinaliza capture_failed (top-level)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ capture_failed: true, capture_error: "invalid_client" }),
    );
    assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: true, error: "invalid_client" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna failed:true + error quando o marker usa o shape details (atual)", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        name: "inject-inbox-urls",
        details: { editor_blocks: 0, newsletter_blocks: 0, capture_failed: true, capture_error: "invalid_client" },
      }),
    );
    assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: true, error: "invalid_client" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("caso 260703: marker legítimo com 0 (sem capture_failed) → failed:false", () => {
    // (a) marker legítimo com 0 → NÃO deve reportar capture_failed.
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        total_editor_urls: 0,
        total_newsletter_urls: 0,
        total_pool_size: 261,
        editor_blocks: 0,
        newsletter_blocks: 0,
        captured_newsletter_count: 0,
        newsletter_source: "inbox-md",
      }),
    );
    assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna failed:false quando marker ausente", () => {
    const dir = makeFixtureEdition();
    assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("retorna failed:false quando marker é JSON inválido", () => {
    const dir = makeFixtureEdition();
    writeFileSync(join(dir, "_internal", ".marker-inject-inbox-urls.json"), "not-json-{{{");
    assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("usa 'motivo desconhecido' quando capture_failed:true mas capture_error ausente", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({ capture_failed: true }),
    );
    assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: true, error: "motivo desconhecido" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderCaptureFailedLine / rewriteCoverageLineAsCaptureFailed (#2878)", () => {
  it("renderCaptureFailedLine embute o motivo e não menciona '0 submissões'", () => {
    const line = renderCaptureFailedLine("invalid_client");
    assert.match(line, /contagem de submissões indisponível/);
    assert.match(line, /captura de newsletters falhou: invalid_client/);
    assert.match(line, /recompute após reautenticar/);
    assert.doesNotMatch(line, /0 submissões/);
  });

  it("(a) substitui a linha de cobertura normal pelo aviso quando a captura falhou", () => {
    const md = `Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLineAsCaptureFailed(md, "invalid_client");
    assert.ok(r.changed);
    assert.doesNotMatch(r.md, /enviei \d+ submissões/);
    assert.match(r.md, /contagem de submissões indisponível \(captura de newsletters falhou: invalid_client\)/);
  });

  it("é idempotente — reaplica sem mudar quando o aviso já está presente", () => {
    const md = `⚠️ contagem de submissões indisponível (captura de newsletters falhou: invalid_client) — recompute após reautenticar.

Resto.`;
    const r = rewriteCoverageLineAsCaptureFailed(md, "invalid_client");
    assert.equal(r.changed, false);
  });

  it("changed:false quando nem a linha normal nem o aviso estão presentes", () => {
    const md = "Texto qualquer sem linha de cobertura.";
    const r = rewriteCoverageLineAsCaptureFailed(md, "invalid_client");
    assert.equal(r.changed, false);
    assert.equal(r.md, md);
  });
});

describe("rewriteCoverageLine — recuperação do aviso capture_failed (#2878)", () => {
  it("substitui o aviso pela linha de cobertura real quando a captura se recupera", () => {
    // Rerun anterior deixou o aviso; captura foi corrigida (reautenticado) e
    // agora X/Y/Z são de novo confiáveis — a linha real deve voltar.
    const md = `⚠️ contagem de submissões indisponível (captura de newsletters falhou: invalid_client) — recompute após reautenticar.

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 13 submissões e a Diar\.ia encontrou outros 125 artigos/);
    assert.doesNotMatch(r.md, /contagem de submissões indisponível/);
  });
});

describe("regressão #2878 — coverage line não confunde '0 real' com 'captura falhou'", () => {
  function makeFixtureEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-2878-regression-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("(a) marker com capture_failed → coverage line NÃO diz '0 submissões'", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        total_editor_urls: 0,
        total_newsletter_urls: 0,
        total_pool_size: 261,
        editor_blocks: 0,
        newsletter_blocks: 0,
        captured_newsletter_count: 0,
        newsletter_source: "inbox-md",
        capture_failed: true,
        capture_error: "invalid_client",
      }),
    );
    const capture = readCaptureFailedFromMarker(dir);
    assert.equal(capture.failed, true);

    const originalMd = `Para esta edição, eu (o editor) enviei 11 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const { md, changed } = capture.failed
      ? rewriteCoverageLineAsCaptureFailed(originalMd, capture.error ?? "motivo desconhecido")
      : rewriteCoverageLine(originalMd, 0, 0, 0);

    assert.ok(changed);
    assert.doesNotMatch(md, /enviei 0 submissões/);
    assert.match(md, /contagem de submissões indisponível \(captura de newsletters falhou: invalid_client\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(b) marker legítimo com 0 → mantém '0 submissões'", () => {
    const dir = makeFixtureEdition();
    writeFileSync(
      join(dir, "_internal", ".marker-inject-inbox-urls.json"),
      JSON.stringify({
        total_editor_urls: 0,
        total_newsletter_urls: 0,
        total_pool_size: 130,
        editor_blocks: 0,
        newsletter_blocks: 0,
        captured_newsletter_count: 0,
        newsletter_source: "inbox-md",
        // sem capture_failed — 0b-bis rodou ok, editor genuinamente não enviou nada.
      }),
    );
    const capture = readCaptureFailedFromMarker(dir);
    assert.equal(capture.failed, false);

    const originalMd = `Para esta edição, eu (o editor) enviei 11 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const x = readSubmissionsCountFromMarker(dir) ?? 0;
    const { md, changed } = capture.failed
      ? rewriteCoverageLineAsCaptureFailed(originalMd, capture.error ?? "motivo desconhecido")
      : rewriteCoverageLine(originalMd, x, 130, 34);

    assert.equal(x, 0);
    assert.ok(changed);
    assert.match(md, /enviei 0 submissões e a Diar\.ia/);
    assert.doesNotMatch(md, /contagem de submissões indisponível/);
    rmSync(dir, { recursive: true, force: true });
  });
});
