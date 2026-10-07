/**
 * test/artigo-especial-producao-review-9099.test.ts (#9099, fleet review da PR #9843)
 *
 * Regressões dos achados do review sobre o conversor draft.md → HTML e o
 * state das etapas de produção. Cada `it` reproduz um achado: falha no
 * código anterior ao fix, passa no atual.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ArtigoEspecialDraftError,
  extractBaseStyle,
  isCalendarDate,
  parseArtigoEspecialDraft,
  renderArtigoEspecialHtml,
  renderInline,
  splitSectionBlocks,
} from "../scripts/lib/artigo-especial-draft.ts";
import {
  artigoEspecialStatePath,
  buildDoneChannelState,
  readArtigoEspecialState,
  withProducaoEtapa,
  type ArtigoEspecialState,
} from "../scripts/lib/artigo-especial-state.ts";
import { runMarkProducaoEtapa } from "../scripts/artigo-especial-producao.ts";
import { runMarkArtigoEspecialChannel } from "../scripts/mark-artigo-especial-channel.ts";
import { parseArtigoMetaHtml } from "../scripts/lib/artigo-especial-meta.ts";
import { runProbeArtigoEspecial } from "../scripts/probe-artigo-especial.ts";
import { GATE_CTA_ID } from "../scripts/lib/shared/artigo-especial-gate-cta.ts";

const ROOT = resolve(import.meta.dirname, "..");
const base = extractBaseStyle(readFileSync(resolve(ROOT, "workers/artigos/articles-src/o-jev.html"), "utf8"));

const FM = `---
titulo: T
dek: D
slug: s
ano: 2026
data: 2026-10-15
capa_alt: A
---
`;
const BODY = `Lede.

## Um

Texto um.

## Dois

Texto dois.
`;
const draft = (body = BODY, fm = FM) => `${fm}\n${body}`;
const isDraftErr = (re: RegExp) => (e: Error) => e instanceof ArtigoEspecialDraftError && re.test(e.message);

describe("#9099 review — markdown inline", () => {
  it("código dentro do rótulo do link não vira 'undefined'", () => {
    assert.equal(renderInline("[o `jev-latest`](https://x.com)"), '<a href="https://x.com">o <code>jev-latest</code></a>');
  });

  it("URL com um nível de parêntese (Wikipedia/DOI) e link com título", () => {
    assert.equal(
      renderInline("[w](https://pt.wikipedia.org/wiki/Jev_(modelo)) fim"),
      '<a href="https://pt.wikipedia.org/wiki/Jev_(modelo)">w</a> fim',
    );
    assert.equal(renderInline('[t](https://x.com "Título & cia")'), '<a href="https://x.com" title="Título &amp; cia">t</a>');
  });

  it("link que não dá para ler (espaço na URL) é erro, nunca texto cortado", () => {
    assert.throws(() => renderInline("[t](https://x.com/a b)"), isDraftErr(/link markdown malformado/));
  });

  it("itálico dentro de negrito", () => {
    assert.equal(renderInline("**um *dois* três**"), "<strong>um <em>dois</em> três</strong>");
  });
});

describe("#9099 review — blocos", () => {
  it("HTML cru desbalanceado é erro, em vez de engolir o resto da seção e o corte", () => {
    assert.throws(() => splitSectionBlocks("<div>\n<p>a</p>\n\nTexto\n\n<!-- corte -->", "seção X"), isDraftErr(/marcador de corte dentro de um bloco HTML cru|nunca fechado/));
    assert.throws(() => splitSectionBlocks("<div>\n<p>a</p>\n\nTexto", "seção X"), isDraftErr(/nunca fechado/));
  });

  it("lista com linha introdutória e item com continuação", () => {
    const blocks = splitSectionBlocks("Três respostas:\n- escolha, com a\n  probabilidade de cada\n- nota\n1. passo", "s");
    assert.deepEqual(blocks, [
      { kind: "paragraph", text: "Três respostas:" },
      { kind: "ul", items: ["escolha, com a probabilidade de cada", "nota"] },
      { kind: "ol", items: ["passo"] },
    ]);
  });

  it("corte sem linha em branco ao redor vira bloco próprio — nem texto literal, nem o parágrafo seguinte vira cru", () => {
    assert.deepEqual(splitSectionBlocks("Antes.\n<!-- corte -->\nDepois.", "s"), [
      { kind: "paragraph", text: "Antes." },
      { kind: "cut" },
      { kind: "paragraph", text: "Depois." },
    ]);
    const html = renderArtigoEspecialHtml(parseArtigoEspecialDraft(draft(BODY.replace("Texto um.", "Texto um.\n<!-- corte -->\nMais um."))), base);
    assert.ok(!html.includes("<!-- corte -->"));
    assert.ok(html.includes("<p>Mais um.</p>"));
  });

  it("markup não suportado é erro: ####, ##Título sem espaço, linha ---", () => {
    for (const [b, re] of [
      [BODY.replace("Texto um.", "#### Sub"), /###/],
      [BODY.replace("## Dois", "##Dois"), /sem espaço/],
      [BODY.replace("Texto um.", "Texto um.\n\n---"), /linha horizontal/],
    ] as const) {
      assert.throws(() => parseArtigoEspecialDraft(draft(b)), isDraftErr(re));
    }
  });
});

describe("#9099 review — frontmatter", () => {
  it("chave desconhecida ou repetida, data impossível, capa com caminho", () => {
    const cases: Array<[string, RegExp]> = [
      [FM.replace("capa_alt: A", "capa_alt: A\ncapa-alt: B"), /chave desconhecida "capa-alt"/],
      [FM.replace("dek: D", "dek: D\ndek: E"), /repetida/],
      [FM.replace("data: 2026-10-15", "data: 2026-02-31"), /data AAAA-MM-DD válida/],
      [FM.replace("capa_alt: A", "capa_alt: A\ncapa: ../../../wrangler.toml"), /nome de arquivo/],
      [FM.replace("capa_alt: A", "capa_alt: A\natualizado: 2026-10-01"), /anterior à data/],
    ];
    for (const [fm, re] of cases) assert.throws(() => parseArtigoEspecialDraft(draft(BODY, fm)), isDraftErr(re));
    assert.equal(isCalendarDate("2024-02-29"), true);
    assert.equal(isCalendarDate("2026-02-29"), false);
  });
});

describe("#9099 review — escape no HTML final", () => {
  it("aspas e & em og/alt; </script> no título não fecha o JSON-LD", () => {
    const fm = FM.replace("titulo: T", 'titulo: Quando a IA diz "</script><b>x" & foge').replace("capa_alt: A", 'capa_alt: Uma "máquina" & papel');
    const html = renderArtigoEspecialHtml(parseArtigoEspecialDraft(draft(BODY, fm)), base);
    assert.ok(html.includes('<meta property="og:title" content="Quando a IA diz &quot;&lt;/script&gt;&lt;b&gt;x&quot; &amp; foge">'));
    assert.ok(html.includes('alt="Uma &quot;máquina&quot; &amp; papel"'));
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
    assert.ok(!ld.includes("</script"), "o JSON-LD não pode conter </script");
    assert.equal(JSON.parse(ld)["@graph"][0].headline, 'Quando a IA diz "</script><b>x" & foge');
    assert.equal(parseArtigoMetaHtml(html).datePublished, "2026-10-15");
  });
});

describe("#9099 review — state das etapas", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "artigo-producao-review-")); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const at = "2026-10-07T12:00:00.000Z";
  const s0: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };

  it("tema só com a etapa tema; pr done exige url (função pura e CLI)", () => {
    const s1 = withProducaoEtapa(s0, "tema", buildDoneChannelState(at, null), "T");
    assert.throws(() => withProducaoEtapa(s1, "briefing", buildDoneChannelState(at, null), "outro"), /só pode ser gravado com a etapa "tema"/);
    let s = withProducaoEtapa(s1, "briefing", buildDoneChannelState(at, null));
    s = withProducaoEtapa(s, "rascunho", buildDoneChannelState(at, null));
    s = withProducaoEtapa(s, "html", buildDoneChannelState(at, null));
    assert.throws(() => withProducaoEtapa(s, "pr", buildDoneChannelState(at, null)), /URL do PR/);
    assert.throws(() => runMarkProducaoEtapa({ dataDir, ano: "2026", slug: "x", etapa: "pr", status: "done" }), /exige --url/);
  });

  it("published.json corrompido → mark recusa escrever (não zera os canais)", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, "{ corrompido");
    assert.throws(() => runMarkProducaoEtapa({ dataDir, ano: "2026", slug: "x", etapa: "tema", status: "done", tema: "T" }), /não é JSON válido/);
    assert.equal(readFileSync(p, "utf8"), "{ corrompido");
  });

  it("ordem inversa: canal gravado ANTES da produção sobrevive à escrita da etapa", () => {
    runMarkArtigoEspecialChannel({ ano: "2026", slug: "x", channel: "box", status: "done", url: "https://github.com/x/pull/1", dataDir });
    runMarkProducaoEtapa({ dataDir, ano: "2026", slug: "x", etapa: "tema", status: "done", tema: "T" });
    const s = readArtigoEspecialState(artigoEspecialStatePath(dataDir, "2026", "x"), "2026", "x");
    assert.equal(s.channels.box?.status, "done");
    assert.equal(s.producao?.etapas.tema?.status, "done");
  });

  it("etapas malformado → aviso e tratado como nenhuma etapa feita", () => {
    const p = artigoEspecialStatePath(dataDir, "2026", "x");
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ ano: "2026", slug: "x", channels: {}, producao: { tema: "T", etapas: ["tema"] } }));
    const s = readArtigoEspecialState(p, "2026", "x");
    assert.deepEqual(s.producao, { tema: "T", etapas: {} });
  });
});

describe("#9099 review — probe --mark com etapas anteriores pendentes", () => {
  it("imprime o OK do probe ANTES e mostra o erro de ordem com clareza (exit 2, nada gravado)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "probe-mark-"));
    try {
      const url = "https://especial.diar.ia.br/2026/x/";
      const lines: string[] = [];
      const r = await runProbeArtigoEspecial({
        ano: "2026",
        slug: "x",
        attempts: 1,
        intervalMs: 0,
        fetchImpl: async () => ({ status: 200, text: async () => `<meta property="og:url" content="${url}"><div id="${GATE_CTA_ID}"></div>` }),
        markDataDir: dataDir,
        log: (m) => lines.push(`log:${m}`),
        err: (m) => lines.push(`err:${m}`),
      });
      assert.equal(r.exitCode, 2);
      assert.equal(r.ok, true);
      assert.match(lines[0], /^log:OK — /);
      assert.match(lines[1], /^err:--mark NÃO gravou.*antes de "tema"/);
      assert.ok(!lines.some((l) => l.includes("inesperado")));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
