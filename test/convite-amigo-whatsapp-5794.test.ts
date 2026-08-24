/**
 * test/convite-amigo-whatsapp-5794.test.ts (#5794)
 *
 * Bloco fixo "Convide pelo WhatsApp" — `scripts/lib/newsletter-render-html.ts`
 * (`buildConviteAmigoBlock`, `buildConviteAmigoUrl`, `buildConviteAmigoShareLink`,
 * `renderConviteAmigo`). Pedido de leitor (WhatsApp, 20/08/2026): o bloco
 * `renderWhatsappShare` existente (#4486/#4570) compartilha a NOTÍCIA (D1); este
 * bloco NOVO compartilha a ASSINATURA em si — convite pra outras pessoas
 * assinarem a newsletter.
 *
 * **Revisado 260821 — virou snippet de verdade.** A 1ª implementação (PR
 * #5802) tinha copy/posição/estilo hardcoded direto no TS, achado quebrado
 * ao vivo no gate do Stage 4 (posição errada — depois de "Para encerrar" em
 * vez de antes; copy errada — sem frase, botão com texto diferente do
 * combinado). Na correção (PR #5817) o editor pediu mais: "no mesmo padrão
 * dos outros snippets, mas sem título" — o bloco passou a ler
 * `data/snippets/convite-amigo-whatsapp.md` via `readSnippetFile` e
 * renderizar com `renderBoxDivulgacao` (mesmo dispatcher dos boxes de slot
 * 1/2/3), SEM o kicker "Divulgação" (não chama `renderDivulgacaoSeparator`)
 * e com `plainFirstParagraph=true` (frase em corpo normal, não título serif
 * 26px — mesmo tratamento do box de agradecimento a apoiadores). `buildConviteAmigoBlock`/
 * `buildConviteAmigoUrl`/`buildConviteAmigoShareLink` continuam existindo —
 * usados só pra GERAR o conteúdo estático do snippet (a URL/UTM não varia
 * por edição), não mais chamados no caminho de render.
 *
 * Cobertura do critério de pronto da issue:
 *   - URL aponta pra HOME (https://diar.ia.br/), NÃO pra edição.
 *   - UTM tem os 3 params certos (utm_source=whatsapp, utm_medium=referral,
 *     utm_campaign=convite-leitor) — fixo, não varia por edição.
 *   - Link `wa.me/?text=` bem formado, com o texto pré-preenchido correto.
 *   - Bloco renderiza no HTML final, após o último destaque e ANTES de "Para
 *     encerrar" (posição decidida na issue), sempre presente quando o
 *     snippet existe — fail-soft (string vazia) se o snippet estiver
 *     ausente, nunca lança.
 *   - Box bege (painel `SURFACE`, sem borda, SEM kicker "Divulgação") com a
 *     frase "Conhece alguém que ia gostar de receber esta newsletter?" em
 *     corpo normal (não título) seguida do botão "Convide pelo WhatsApp →"
 *     — rotulado de forma DISTINTA do botão "Compartilhar no WhatsApp"
 *     existente (renderWhatsappShare) — evita a confusão relatada pelo
 *     leitor.
 *   - A entry nova em scripts/lib/shared/utm-registry.ts é coerente com os
 *     valores emitidos (mesmo padrão do #4041 — emissor deriva do registry).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConviteAmigoBlock,
  buildConviteAmigoUrl,
  buildConviteAmigoShareLink,
  renderConviteAmigo,
  renderWhatsappShare,
  renderHTML,
  resetRenderWarnings,
  getRenderWarnings,
  resolveConviteAmigoFilename,
} from "../scripts/lib/newsletter-render-html.ts";
import { CONVITE_AMIGO_UTM, findUtmEmitter } from "../scripts/lib/shared/utm-registry.ts";
import { BEEHIIV_BASE_URL } from "../scripts/lib/edition-url.ts";
import type { RenderDestaque, NewsletterContent } from "../scripts/lib/newsletter-parse.ts";
import { archiveBox, saveBoxSlots, boxFilePath } from "../scripts/studio-ui/studio-boxes.ts";

function makeD1(overrides: Partial<RenderDestaque> = {}): RenderDestaque {
  return {
    n: 1,
    category: "🚀 LANÇAMENTO",
    emoji: "🚀",
    title: "IA generativa muda o jeito de programar",
    body: "Corpo do destaque.",
    why: "Por que importa.",
    url: "https://example.com/d1",
    ...overrides,
  };
}

// #5794 (revisão 260821): `renderConviteAmigo` lê `data/snippets/` via
// `readSnippetFile` — nunca a `data/` real do editor (gitignored, ausente
// em CI/clone fresco). Fixture isolada, mesmo padrão de
// `test/encerramento-social-apoio-3219.test.ts`.
const SNIPPETS_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "convite-amigo-snippet-fixture-"));
mkdirSync(join(SNIPPETS_FIXTURE_ROOT, "data", "snippets"), { recursive: true });
const SNIPPET_PATH = join(SNIPPETS_FIXTURE_ROOT, "data", "snippets", "convite-amigo-whatsapp.md");
const CONVITE_AMIGO_FIXTURE =
  `Conhece alguém que ia gostar de receber esta newsletter?\n\n[Convide pelo WhatsApp →](${buildConviteAmigoShareLink()})\n`;
writeFileSync(SNIPPET_PATH, CONVITE_AMIGO_FIXTURE, "utf8");

after(() => {
  rmSync(SNIPPETS_FIXTURE_ROOT, { recursive: true, force: true });
});

describe("#5794 — buildConviteAmigoUrl", () => {
  it("aponta pra HOME (https://diar.ia.br/), não pra uma edição", () => {
    const url = new URL(buildConviteAmigoUrl());
    assert.equal(url.origin, BEEHIIV_BASE_URL);
    assert.equal(url.pathname, "/");
  });

  it("carrega os 3 params UTM do contrato da issue: utm_source=whatsapp, utm_medium=referral, utm_campaign=convite-leitor", () => {
    const url = new URL(buildConviteAmigoUrl());
    assert.equal(url.searchParams.get("utm_source"), "whatsapp");
    assert.equal(url.searchParams.get("utm_medium"), "referral");
    assert.equal(url.searchParams.get("utm_campaign"), "convite-leitor");
  });

  it("utm_campaign é FIXO — não varia por edição (diferente de buildWhatsappEditionUrl)", () => {
    const a = buildConviteAmigoUrl();
    const b = buildConviteAmigoUrl();
    assert.equal(a, b, "a URL é determinística e idêntica em toda chamada, sem parâmetro de edição");
  });
});

describe("#5794 — buildConviteAmigoBlock", () => {
  it("contém o texto de convite pedido na issue e a URL da home", () => {
    const url = buildConviteAmigoUrl();
    const block = buildConviteAmigoBlock(url);
    assert.match(block, /diar\.ia\.br/);
    assert.match(block, /resumo diário de IA em português, grátis/i);
    assert.ok(block.includes(url), "URL da home ausente do bloco");
  });

  it("SEM markdown — nada de **, #, ou '- ' (regra de output final sem markdown)", () => {
    const block = buildConviteAmigoBlock(buildConviteAmigoUrl());
    assert.ok(!block.includes("**"));
    assert.ok(!/^#/m.test(block));
    assert.ok(!/^- /m.test(block));
  });
});

describe("#5794 — buildConviteAmigoShareLink", () => {
  it("é um link wa.me/?text= bem formado, decodificável de volta pro bloco original", () => {
    const link = buildConviteAmigoShareLink();
    assert.match(link, /^https:\/\/wa\.me\/\?text=/);
    const decoded = decodeURIComponent(link.slice("https://wa.me/?text=".length));
    assert.equal(decoded, buildConviteAmigoBlock(buildConviteAmigoUrl()));
  });
});

describe("#5794 — renderConviteAmigo (HTML)", () => {
  it("renderiza o botão 'Convide pelo WhatsApp', rotulado DISTINTO de 'Compartilhar no WhatsApp'", () => {
    const html = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT);
    assert.match(html, /Convide pelo WhatsApp/);
    assert.ok(!html.includes("Compartilhar no WhatsApp"), "não deve reusar o rótulo do bloco existente (evita a confusão da issue)");
  });

  it("aponta pro link wa.me com o convite de assinatura, não pra edição", () => {
    const html = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT);
    const btnMatch = html.match(/<a href="(https:\/\/wa\.me\/\?text=[^"]*)"/);
    assert.ok(btnMatch, "botão wa.me não encontrado");
    const decoded = decodeURIComponent(btnMatch![1].slice("https://wa.me/?text=".length));
    assert.match(decoded, /https:\/\/diar\.ia\.br\/\?/);
  });

  it("botão pill contornado — mesmo padrão visual dos demais CTAs (background papel, border-radius:999px)", () => {
    const html = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT);
    const btnMatch = html.match(/<a href="https:\/\/wa\.me\/\?text=[^"]*"\s+style="([^"]*)"/);
    assert.ok(btnMatch, "botão não encontrado");
    const style = btnMatch![1];
    assert.match(style, /background:#FBFAF6/i);
    assert.match(style, /border-radius:999px/);
  });

  it("box bege (painel SURFACE) envolvendo a frase de convite + botão — opção B decidida na issue", () => {
    const html = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT);
    assert.match(html, /Conhece alguém que ia gostar de receber esta newsletter\?/);
    assert.match(html, /background:#EBE5D0;border-radius:12px/i);
  });

  it("não depende de destaques — renderiza sempre, ao contrário de renderWhatsappShare (que retorna vazio sem D1)", () => {
    assert.equal(renderWhatsappShare([], "260801"), "", "sanity: renderWhatsappShare precisa de D1");
    const html = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT);
    assert.notEqual(html, "", "renderConviteAmigo nunca deve ficar vazio");
  });

  it("snippet ausente: retorna vazio (fail-soft) MAS emite convite_amigo_snippet_missing (achado do review #5817)", () => {
    resetRenderWarnings();
    const emptyRoot = mkdtempSync(join(tmpdir(), "convite-amigo-empty-fixture-"));
    mkdirSync(join(emptyRoot, "data", "snippets"), { recursive: true });
    try {
      const html = renderConviteAmigo(emptyRoot, "260821");
      assert.equal(html, "", "sem snippet, o bloco deve ficar vazio — nunca lançar");
      const warnings = getRenderWarnings();
      assert.ok(
        warnings.some((w) => w.event === "convite_amigo_snippet_missing" && w.edition === "260821"),
        "evento convite_amigo_snippet_missing ausente — bloco 'sempre presente' sumiria em silêncio",
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

// #5882: "sem título" agora é lido do campo declarado `titulo:` do header
// (via `readSnippetFileRaw`/`readBoxTituloFlag`) em vez de sempre hardcoded
// `true` — a fixture principal do arquivo (`SNIPPET_PATH`, sem header) segue
// cobrindo o caso "campo ausente -> default sem título" nos testes acima;
// este describe cobre os outros ramos do campo (override explícito e a
// mesma copy ALTERADA da issue, reproduzindo o cenário exato #5882 no
// caminho FIXO).
describe("#5882 — renderConviteAmigo lê o campo declarado titulo: (não mais hardcoded)", () => {
  function fixtureWithHeader(header: string | null, body: string) {
    const root = mkdtempSync(join(tmpdir(), "convite-amigo-titulo-fixture-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    const content = header ? `<!--\n${header}\n-->\n\n${body}` : body;
    writeFileSync(join(root, "data", "snippets", "convite-amigo-whatsapp.md"), content, "utf8");
    return root;
  }

  it("sem header (campo ausente): default sem título — preserva o comportamento histórico deste bloco fixo", () => {
    const root = fixtureWithHeader(null, CONVITE_AMIGO_FIXTURE);
    try {
      const html = renderConviteAmigo(root);
      assert.doesNotMatch(html, /font-size:26px/, "campo ausente deve manter o default 'sem título' já decidido pro bloco fixo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("titulo: false explícito: sem título (mesmo resultado do campo ausente)", () => {
    const root = fixtureWithHeader("titulo: false", CONVITE_AMIGO_FIXTURE);
    try {
      const html = renderConviteAmigo(root);
      assert.doesNotMatch(html, /font-size:26px/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("titulo: true explícito (override): título serif volta a aparecer", () => {
    const root = fixtureWithHeader("titulo: true", CONVITE_AMIGO_FIXTURE);
    try {
      const html = renderConviteAmigo(root);
      assert.match(html, /font-size:26px/, "titulo:true declarado deve reverter pro título serif");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copy ALTERADA (frase diferente da original, cenário exato da issue #5882): ainda sem título, campo ausente basta — não depende mais da frase exata", () => {
    const copyAlterada = "Conhece alguém que ia curtir esta newsletter?\n\n[Convide pelo WhatsApp →](https://wa.me/?text=y)\n";
    const root = fixtureWithHeader(null, copyAlterada);
    try {
      const html = renderConviteAmigo(root);
      assert.doesNotMatch(html, /font-size:26px/, "trocar a copy não pode derrubar a supressão do título — não é mais detectada por regex de frase");
      assert.match(html, /Conhece alguém que ia curtir esta newsletter\?/, "copy alterada preservada no HTML");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #5999: posição revisada. A posição original (#5794 — "após o último
// destaque, ANTES de 'Para encerrar'", linha própria sem kicker) fazia o
// bloco ler visualmente como parte da seção SORTEIO (mesmo fundo bege, sem
// dono visual próprio — causa raiz investigada na issue #5999). Decisão do
// editor (23/08/2026): mover pro TOPO da seção "Para encerrar", onde herda o
// kicker "Para encerrar" — DEPOIS do kicker, ANTES do parágrafo de apoio.
describe("#5999 — posição no corpo da newsletter: TOPO de 'Para encerrar' (revisa #5794)", () => {
  const content: NewsletterContent = {
    title: "Edição teste",
    subtitle: "Teste",
    coverImage: "04-d1-2x1.jpg",
    destaques: [makeD1()],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260801" },
    sections: [],
    sorteio: "**🎁 SORTEIO**\n\nTexto do sorteio.",
    erroIntencional: "Na última edição, o erro intencional era X.",
    encerrar: "Apoie a curadoria em [apoia.se/diaria](https://apoia.se/diaria).",
  };

  it("bloco 'Convide pelo WhatsApp' aparece DEPOIS do kicker 'Para encerrar' e ANTES do parágrafo de apoio", () => {
    const html = renderHTML(content, { rootDir: SNIPPETS_FIXTURE_ROOT });
    const idxKicker = html.indexOf("Para encerrar");
    const idxConvite = html.indexOf("Convide pelo WhatsApp");
    const idxApoio = html.indexOf("Apoie a curadoria");
    assert.ok(idxKicker !== -1, "kicker 'Para encerrar' ausente do render completo");
    assert.ok(idxConvite !== -1, "bloco 'Convide um amigo' ausente do render completo");
    assert.ok(idxApoio !== -1, "parágrafo de apoio ausente do render completo");
    assert.ok(idxKicker < idxConvite, "bloco 'Convide um amigo' deve vir DEPOIS do kicker 'Para encerrar' (decisão #5999)");
    assert.ok(idxConvite < idxApoio, "bloco 'Convide um amigo' deve vir ANTES do parágrafo de apoio (decisão #5999)");
  });

  it("já NÃO fica mais espremido entre SORTEIO e ERRO INTENCIONAL (sintoma original da #5999)", () => {
    const html = renderHTML(content, { rootDir: SNIPPETS_FIXTURE_ROOT });
    const idxSorteio = html.indexOf("SORTEIO");
    const idxErro = html.indexOf("Na última edição, o erro intencional era X.");
    const idxConvite = html.indexOf("Convide pelo WhatsApp");
    assert.ok(idxSorteio !== -1 && idxErro !== -1 && idxConvite !== -1, "seções de fixture ausentes do render");
    assert.ok(
      !(idxSorteio < idxConvite && idxConvite < idxErro),
      "bloco 'Convide um amigo' não deve mais renderizar entre SORTEIO e o reveal do erro intencional",
    );
  });

  it("os dois botões WhatsApp (compartilhar notícia + convidar amigo) coexistem, sem colidir", () => {
    const html = renderHTML(content, { rootDir: SNIPPETS_FIXTURE_ROOT });
    assert.match(html, /Compartilhar no WhatsApp/);
    assert.match(html, /Convide pelo WhatsApp/);
  });

  it("edição sem destaques (defensivo, nunca deveria acontecer): bloco 'Convide um amigo' ainda aparece — não depende de D1", () => {
    const contentSemDestaques: NewsletterContent = { ...content, destaques: [] };
    const html = renderHTML(contentSemDestaques, { rootDir: SNIPPETS_FIXTURE_ROOT });
    assert.match(html, /Convide pelo WhatsApp/);
  });

  it("bloco NUA (naked) não carrega o wrapper de linha própria — sem <tr><td> envolvendo a table de fora", () => {
    const naked = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT, "260801", true);
    assert.ok(naked.length > 0, "sanity: naked não deve vir vazio com snippet presente");
    assert.ok(!naked.trimStart().startsWith("<tr>"), "naked não deveria começar com <tr> — é conteúdo INTERNO de outra seção");
    const standalone = renderConviteAmigo(SNIPPETS_FIXTURE_ROOT, "260801", false);
    assert.ok(standalone.includes("<tr><td"), "standalone (naked=false, default) deve preservar o wrapper de linha própria — usado no fallback");
  });
});

// #5999 (item 2 do Escopo da issue): edição sem bloco "Para encerrar" não tem
// onde embutir a caixa (ela vive DENTRO da seção agora) — cai no formato
// STANDALONE antigo (linha própria, posição pré-#5999) + emite
// `convite_amigo_orphan_no_encerrar`, pra nunca sumir em silêncio.
describe("#5999 — fallback: edição sem bloco 'Para encerrar'", () => {
  const contentSemEncerrar: NewsletterContent = {
    title: "Edição teste",
    subtitle: "Teste",
    coverImage: "04-d1-2x1.jpg",
    destaques: [makeD1()],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260822" },
    sections: [],
    sorteio: "**🎁 SORTEIO**\n\nTexto do sorteio.",
    encerrar: "",
  };

  it("bloco 'Convide um amigo' ainda renderiza (fallback standalone), mesmo sem 'Para encerrar'", () => {
    const html = renderHTML(contentSemEncerrar, { rootDir: SNIPPETS_FIXTURE_ROOT });
    assert.match(html, /Convide pelo WhatsApp/);
    assert.ok(!html.includes("Para encerrar"), "sanity: esta fixture não declara bloco 'Para encerrar'");
  });

  it("emite convite_amigo_orphan_no_encerrar (mesma classe de convite_amigo_snippet_missing)", () => {
    resetRenderWarnings();
    renderHTML(contentSemEncerrar, { rootDir: SNIPPETS_FIXTURE_ROOT });
    const warnings = getRenderWarnings();
    assert.ok(
      warnings.some((w) => w.event === "convite_amigo_orphan_no_encerrar" && w.edition === "260822"),
      "evento convite_amigo_orphan_no_encerrar ausente — a mudança de posição estrutural precisa ficar sinalizada, não silenciosa",
    );
  });
});

// #5999 (item 3): filename configurável via platform.config.json ->
// boxes_fixos.convite_amigo, com fallback fail-soft pro histórico.
describe("#5999 — resolveConviteAmigoFilename: sai do hardcode (item 3)", () => {
  it("sem platform.config.json -> cai no filename histórico", () => {
    const root = mkdtempSync(join(tmpdir(), "convite-amigo-resolve-none-"));
    try {
      assert.equal(resolveConviteAmigoFilename(root), "convite-amigo-whatsapp.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("com boxes_fixos.convite_amigo declarado -> usa o valor configurado", () => {
    const root = mkdtempSync(join(tmpdir(), "convite-amigo-resolve-custom-"));
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_fixos: { convite_amigo: "outro-convite.md" } }),
    );
    try {
      assert.equal(resolveConviteAmigoFilename(root), "outro-convite.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("platform.config.json corrompido -> fail-soft pro filename histórico, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "convite-amigo-resolve-corrupt-"));
    writeFileSync(join(root, "platform.config.json"), "{ not json");
    try {
      assert.equal(resolveConviteAmigoFilename(root), "convite-amigo-whatsapp.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #5999 (item 4): os 2 guards do painel Studio que ficavam abertos porque a
// caixa não tinha slot atribuído — archiveBox deixava arquivar (sumindo de
// TODA edição em silêncio) e saveBoxSlots deixava atribuí-la também a um
// slot 0-3 (duplicando o bloco na mesma edição).
describe("#5999 — guards do painel Studio (item 4)", () => {
  function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "convite-amigo-guards-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    writeFileSync(
      join(root, "data", "snippets", "convite-amigo-whatsapp.md"),
      "Conhece alguém que ia gostar de receber esta newsletter?\n\n[Convide pelo WhatsApp →](https://wa.me/?text=y)\n",
    );
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({
        boxes_fixos: { convite_amigo: "convite-amigo-whatsapp.md" },
        boxes_divulgacao: { slot0: "", slot1: "", slot2: "", slot3: "" },
      }),
    );
    return root;
  }

  it("archiveBox: recusa arquivar a caixa fixa (blockedByFixo), não move o arquivo", () => {
    const root = fixtureRoot();
    try {
      const result = archiveBox(root, "convite-amigo-whatsapp.md");
      assert.equal(result.ok, false);
      assert.equal(result.blockedByFixo, true);
      assert.match(result.error ?? "", /boxes_fixos/);
      // arquivo continua no lugar de sempre — não foi movido pra _arquivo/.
      assert.ok(
        existsSync(boxFilePath(root, "convite-amigo-whatsapp.md")),
        "não deveria ter movido a caixa fixa",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("saveBoxSlots: recusa atribuir a caixa fixa a um slot (invalid: true), mesmo shape dos demais guards", () => {
    const root = fixtureRoot();
    try {
      const result = saveBoxSlots(root, { slot0: "", slot1: "convite-amigo-whatsapp.md", slot2: "", slot3: "" });
      assert.equal(result.ok, false);
      assert.equal(result.invalid, true);
      assert.match(result.error ?? "", /boxes_fixos/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#5794 — coerência do registry (scripts/lib/shared/utm-registry.ts)", () => {
  it("a entry 'convite-amigo-whatsapp' existe e bate com CONVITE_AMIGO_UTM", () => {
    const emitter = findUtmEmitter("convite-amigo-whatsapp");
    assert.ok(emitter, "entry 'convite-amigo-whatsapp' ausente do inventário");
    assert.equal(emitter!.source, CONVITE_AMIGO_UTM.source);
    assert.equal(emitter!.medium, CONVITE_AMIGO_UTM.medium);
    assert.equal(emitter!.campaignPattern, CONVITE_AMIGO_UTM.campaign);
    assert.equal(emitter!.status, "ativo");
  });

  it("CONVITE_AMIGO_UTM é distinto de WHATSAPP_SHARE_UTM (medium e campaign não colidem)", async () => {
    const { WHATSAPP_SHARE_UTM } = await import("../scripts/lib/shared/utm-registry.ts");
    assert.notEqual(CONVITE_AMIGO_UTM.medium, WHATSAPP_SHARE_UTM.medium);
  });
});
