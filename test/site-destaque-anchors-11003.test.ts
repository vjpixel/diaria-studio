/**
 * test/site-destaque-anchors-11003.test.ts (#11003)
 *
 * Âncoras #d1..#d3 nas páginas `diar.ia.br/p/{slug}`: id estável no `<h2>` da
 * manchete de cada destaque, folga de rolagem, backfill das páginas já
 * publicadas (âncora e script do modal juntos, ou nenhum) e o link do post
 * da Stack apontando para o destaque. O comportamento do modal na chegada
 * por âncora é exercitado em `edition-page-cta-comportamento-7576.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESTAQUE_ANCHOR_SCROLL_MARGIN_PX,
  backfillDestaqueAnchors,
  destaqueAnchorId,
  hasDestaqueAnchors,
  injectDestaqueAnchors,
} from "../scripts/lib/site-destaque-anchors.ts";
import { renderHeadlineInner } from "../scripts/lib/newsletter-render-html.ts";
import { buildEditionArchivePost } from "../scripts/lib/edition-site-page.ts";
import { buildArchivePageHtml } from "../scripts/lib/site-archive-pages.ts";
import { editionCtaScript } from "../scripts/lib/edition-page-cta.ts";
import { backfillDestaqueAnchorsDir } from "../scripts/backfill-site-destaque-anchors-11003.ts";
import {
  renderCircleStackPost,
  withDestaqueAnchor,
  buildCircleStackUrl,
  type CircleStackSelection,
} from "../scripts/lib/circle-stack-render.ts";
import { extractWeeklyCandidates } from "../scripts/lib/weekly-linkedin-parse.ts";
import { parseStoredCircleStackSelection } from "../scripts/publish-circle-stack.ts";

/** Corpo como o render real da newsletter sai: N manchetes `renderHeadlineInner`. */
function bodyWithHeadlines(n: number): string {
  const rows = Array.from({ length: n }, (_, i) =>
    `<tr><td>${renderHeadlineInner(`Destaque ${i + 1}`, `https://fonte.example/${i + 1}`)}<p>Texto ${i + 1}.</p></td></tr>`,
  );
  return `<table>${rows.join("")}</table>`;
}

function headlineIds(html: string): string[] {
  return [...html.matchAll(/class="headline"[^>]*>\s*<h2\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
}

describe("#11003 — injectDestaqueAnchors", () => {
  it("põe id d1..d3 nas manchetes, na ordem", () => {
    const out = injectDestaqueAnchors(bodyWithHeadlines(3));
    assert.deepEqual(headlineIds(out), ["d1", "d2", "d3"]);
  });

  it("edição de 2 destaques ganha d1 e d2", () => {
    assert.deepEqual(headlineIds(injectDestaqueAnchors(bodyWithHeadlines(2))), ["d1", "d2"]);
  });

  it("acrescenta a folga de rolagem sem perder o estilo original do h2", () => {
    const out = injectDestaqueAnchors(bodyWithHeadlines(1));
    const h2 = out.match(/<h2\b[^>]*>/)?.[0] ?? "";
    assert.ok(h2.includes(`scroll-margin-top:${DESTAQUE_ANCHOR_SCROLL_MARGIN_PX}px;`), h2);
    assert.ok(h2.includes("font-size:26px"), "estilo inline do render preservado");
    assert.equal((h2.match(/style=/g) ?? []).length, 1, "um só atributo style");
  });

  it("idempotente: rodar 2x não duplica id nem folga", () => {
    const once = injectDestaqueAnchors(bodyWithHeadlines(3));
    assert.equal(injectDestaqueAnchors(once), once);
  });

  it("página sem manchete reconhecível (acervo Beehiiv) fica intocada", () => {
    const legado = `<html><body><h1>Edição</h1><h2>Destaque</h2></body></html>`;
    assert.equal(injectDestaqueAnchors(legado), legado);
  });

  it("mais de 3 manchetes = formato desconhecido, nada de âncora chutada", () => {
    const quatro = bodyWithHeadlines(4);
    assert.equal(injectDestaqueAnchors(quatro), quatro);
  });

  it("id d1..d3 já usado por outro elemento: não cria id duplicado", () => {
    const html = `<div id="d2"></div>${bodyWithHeadlines(3)}`;
    assert.equal(injectDestaqueAnchors(html), html);
  });

  it("destaqueAnchorId recusa índice fora de 1..3", () => {
    assert.equal(destaqueAnchorId(2), "d2");
    assert.throws(() => destaqueAnchorId(0));
    assert.throws(() => destaqueAnchorId(4));
  });
});

describe("#11003 — a página da edição sai com as âncoras", () => {
  it("buildArchivePageHtml grava d1..d3 nas manchetes da edição", () => {
    const built = buildEditionArchivePost({
      html: bodyWithHeadlines(3),
      postUrl: "https://diar.ia.br/p/edicao-teste-11003",
      title: "Edição teste",
      subtitle: "Sub",
      publishedAtIso: "2026-10-23T09:00:00.000Z",
    });
    assert.ok(built.ok);
    const page = buildArchivePageHtml(built.post);
    assert.deepEqual(headlineIds(page), ["d1", "d2", "d3"]);
    assert.ok(page.includes(editionCtaScript()), "e com o script do modal atual, que espera o gesto do leitor");
  });
});

describe("#11003 — backfill das páginas já publicadas", () => {
  /** Página como as que estão em disco: corpo + script do modal de uma versão anterior. */
  function paginaPublicada(n: number, script = "<script>\n(function () {\n  var modal = document.getElementById(\"diaria-cta-modal\");\n  if (!modal) return;\n  /* versão antiga */\n})();\n</script>"): string {
    return `<html><body>${bodyWithHeadlines(n)}<script>/* signup */</script>\n${script}\n</body></html>`;
  }

  it("aplica âncoras E troca o script do modal pelo atual", () => {
    const r = backfillDestaqueAnchors(paginaPublicada(3));
    assert.equal(r.changed, true);
    assert.deepEqual(headlineIds(r.html), ["d1", "d2", "d3"]);
    assert.ok(r.html.includes(editionCtaScript()));
    assert.ok(!r.html.includes("versão antiga"), "o script antigo sai inteiro");
    assert.ok(r.html.includes("<script>/* signup */</script>"), "o script vizinho fica intacto");
  });

  it("sem o script do modal reconhecível, não põe âncora (abriria o modal na chegada)", () => {
    const html = `<html><body>${bodyWithHeadlines(3)}</body></html>`;
    const r = backfillDestaqueAnchors(html);
    assert.equal(r.changed, false);
    assert.equal(r.skipped, "sem-script-do-modal");
    assert.equal(r.html, html);
  });

  it("acervo sem manchete fica intocado", () => {
    const r = backfillDestaqueAnchors("<html><body><h2>x</h2></body></html>");
    assert.deepEqual([r.changed, r.skipped], [false, "sem-manchetes"]);
  });

  it("idempotente: a 2ª passada não muda nada", () => {
    const first = backfillDestaqueAnchors(paginaPublicada(3));
    const second = backfillDestaqueAnchors(first.html);
    assert.deepEqual([second.changed, second.skipped], [false, "ja-atualizada"]);
    assert.equal(second.html, first.html);
  });

  it("CLI: --dry-run não escreve; sem ele, escreve só as páginas reconhecidas", () => {
    const dir = mkdtempSync(join(tmpdir(), "anchors-11003-"));
    try {
      const pagina = (slug: string, html: string) => {
        mkdirSync(join(dir, slug));
        writeFileSync(join(dir, slug, "index.html"), html);
      };
      pagina("kit", paginaPublicada(3));
      pagina("beehiiv", "<html><body><h2>x</h2></body></html>");
      const original = readFileSync(join(dir, "kit", "index.html"), "utf8");

      const dry = backfillDestaqueAnchorsDir(dir, true);
      assert.deepEqual(dry.map((r) => [r.slug, r.outcome]).sort(), [["beehiiv", "sem-manchetes"], ["kit", "backfilled"]]);
      assert.equal(readFileSync(join(dir, "kit", "index.html"), "utf8"), original, "dry-run não escreve");

      backfillDestaqueAnchorsDir(dir, false);
      const escrito = readFileSync(join(dir, "kit", "index.html"), "utf8");
      assert.ok(hasDestaqueAnchors(escrito));
      assert.deepEqual(backfillDestaqueAnchorsDir(dir, false).find((r) => r.slug === "kit")?.outcome, "ja-atualizada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11033 — o acervo publicado já está com as âncoras", () => {
  // O backfill da #11033 rodou sobre workers/site/public/p. Página com
  // manchete reconhecível que volte sem âncora (republicação por um caminho
  // antigo, merge que traga a versão anterior) aparece aqui como pendente.
  it("nenhuma página publicada com manchetes ficou pendente de âncora", () => {
    const dir = join(import.meta.dirname, "..", "workers", "site", "public", "p");
    const results = backfillDestaqueAnchorsDir(dir, true);
    assert.ok(results.length > 0, "diretório das páginas /p/ não encontrado ou vazio");
    const pendentes = results.filter((r) => r.outcome === "backfilled" || r.outcome === "sem-script-do-modal");
    assert.deepEqual(pendentes.map((r) => `${r.slug}: ${r.outcome}`), []);
    assert.ok(results.some((r) => r.outcome === "ja-atualizada"), "nenhuma página com âncora: o acervo Kit sumiu?");
  });
});

describe("#11003 — o post da Stack aponta para o destaque", () => {
  const selection: CircleStackSelection = {
    cycle: "26w42",
    contentWindow: ["261012", "261013", "261014", "261015", "261016"],
    destaques: [
      { editionDate: "261013", url: "https://fonte.example/a", title: "A", body: "Corpo.", why: "", destaqueN: 2 },
      { editionDate: "261013", url: "https://fonte.example/b", title: "B", body: "Corpo.", why: "" },
    ],
    lancamentos: [],
    useMelhor: [],
    radar: [],
    weeklyEditions: [{ editionDate: "261013", url: "https://diar.ia.br/p/gemini", destaques: ["X", "A", "Y"] }],
  };

  it("destaque com posição leva ao #dN, depois das UTMs", () => {
    const md = renderCircleStackPost(selection).markdown;
    const esperado = `${buildCircleStackUrl("https://diar.ia.br/p/gemini", "26w42", "edicao")}#d2`;
    assert.ok(md.includes(`(${esperado})`), md);
  });

  it("destaque sem posição (seleção antiga) segue no topo da edição", () => {
    const md = renderCircleStackPost({ ...selection, destaques: [selection.destaques[1]] }).markdown;
    assert.ok(!/#d\d/.test(md));
  });

  it("withDestaqueAnchor ignora índice fora de 1..3", () => {
    assert.equal(withDestaqueAnchor("https://diar.ia.br/p/x", 4), "https://diar.ia.br/p/x");
    assert.equal(withDestaqueAnchor("https://diar.ia.br/p/x", undefined), "https://diar.ia.br/p/x");
    assert.equal(withDestaqueAnchor("https://diar.ia.br/p/x?a=1", 3), "https://diar.ia.br/p/x?a=1#d3");
  });

  it("a extração da semana grava a posição do destaque na edição", () => {
    const md = [
      "**DESTAQUE 1 | IA**",
      "",
      "[Título um](https://fonte.example/1)",
      "",
      "Corpo um.",
      "",
      "Por que isso importa:",
      "",
      "Porque sim.",
      "",
      "---",
      "",
      "**DESTAQUE 2 | IA**",
      "",
      "[Título dois](https://fonte.example/2)",
      "",
      "Corpo dois.",
      "",
      "Por que isso importa:",
      "",
      "Porque também.",
    ].join("\n");
    const destaques = extractWeeklyCandidates(md, "261013").filter((c) => c.kind === "destaque");
    assert.deepEqual(destaques.map((d) => [d.url, d.destaqueN]), [
      ["https://fonte.example/1", 1],
      ["https://fonte.example/2", 2],
    ]);
  });

  it("seleção editável com destaqueN inválido é recusada com mensagem", () => {
    const bad = { ...selection, destaques: [{ ...selection.destaques[0], destaqueN: 7 }] };
    assert.throws(() => parseStoredCircleStackSelection(JSON.stringify(bad), "sel.json", "26w42"), /destaqueN precisa ser 1, 2 ou 3/);
    assert.doesNotThrow(() => parseStoredCircleStackSelection(JSON.stringify(selection), "sel.json", "26w42"));
  });
});
