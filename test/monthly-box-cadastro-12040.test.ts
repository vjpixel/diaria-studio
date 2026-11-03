/**
 * test/monthly-box-cadastro-12040.test.ts (#12040)
 *
 * Decisão do editor (03/11/2026): a Clarice News não tem espaço livre, então
 * o convite pra assinar a diária entra NO LUGAR do box LIVROS. O template e o
 * writer passam a emitir `**CADASTRO**`; o render desenha um box com botão e
 * `utm_campaign` próprio (`clarice-{ciclo}-box-cadastro`), e o canal dos
 * apoiadores (página + Kit), que já recebe a diária, corta o box.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CADASTRO_BOX_KICKER,
  classifySection,
  draftToEmail,
  isSectionLabel,
  normalizeLabel,
  renderCtaButton,
  setMonthlyUtmCiclo,
  splitByLabels,
} from "../scripts/lib/mensal/monthly-render.ts";
import { buildArticleHtml } from "../scripts/lib/mensal/build-article-page.ts";
import { draftToEmailApoiadoresKit } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { filterDraftForApoiadores, isApoiadoresExcludedBox } from "../scripts/lib/mensal/monthly-draft-filter.ts";
import { checkOptionalSectionIntegrity } from "../scripts/lint-monthly-draft.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const BASE = readFileSync(resolve(__dir, "fixtures/publish-monthly/2604/draft.md"), "utf-8");
const TEMPLATE = readFileSync(resolve(ROOT, "context/templates/newsletter-monthly.md"), "utf-8");
const WRITER = readFileSync(resolve(ROOT, ".claude/agents/writer-monthly.md"), "utf-8");

/** Bloco `**CADASTRO**` do template, do label até o CTA (sem o `---`). */
function templateCadastroBlock(): string {
  const m = TEMPLATE.match(/\*\*CADASTRO\*\*\n[\s\S]*?\n→ \[[^\]]+\]\([^)]+\)/);
  assert.ok(m, "template sem bloco **CADASTRO**");
  return m[0];
}

function draftWithCadastro(): string {
  return BASE.replace("**PARA ENCERRAR**", `${templateCadastroBlock()}\n\n---\n\n**PARA ENCERRAR**`);
}

/** `href` do botão cujo rótulo é `label`. */
function buttonHref(html: string, label: string): string | undefined {
  const re = new RegExp(`<a href="([^"]+)"[^>]*>${label}</a>`);
  return html.match(re)?.[1]?.replace(/&amp;/g, "&");
}

describe("#12040 — box CADASTRO no lugar do LIVROS", () => {
  it("CADASTRO é label de seção e classifica como box próprio", () => {
    assert.equal(isSectionLabel("**CADASTRO**"), true);
    assert.equal(classifySection("CADASTRO").kind, "cadastro");
  });

  it("template emite CADASTRO e não emite mais LIVROS", () => {
    assert.match(TEMPLATE, /^\*\*CADASTRO\*\*$/m);
    assert.doesNotMatch(TEMPLATE, /^\*\*LIVROS\*\*$/m);
  });

  it("writer-monthly carrega o mesmo texto fixo do template", () => {
    const block = templateCadastroBlock();
    const indented = block.split("\n").map((l) => (l ? `   ${l}` : "")).join("\n");
    assert.ok(WRITER.includes(indented), "bloco CADASTRO do writer diverge do template");
    assert.doesNotMatch(WRITER, /^\s*\*\*LIVROS\*\*$/m);
  });

  it("e-mail Clarice: box com kicker, botão e utm_campaign próprio", () => {
    const draft = draftWithCadastro();
    const labels = splitByLabels(draft).map((c) => normalizeLabel(c.split("\n")[0]));
    assert.ok(labels.includes("CADASTRO"), labels.join(","));

    const { html } = draftToEmail(draft, null, "2604");
    assert.ok(html.includes(`&nbsp;${CADASTRO_BOX_KICKER}`), "kicker do box ausente");
    const href = buttonHref(html, "Assinar a edição diária");
    assert.ok(href, "botão do box ausente");
    const u = new URL(href);
    assert.equal(u.hostname, "diar.ia.br");
    assert.equal(u.searchParams.get("utm_source"), "clarice");
    assert.match(u.searchParams.get("utm_campaign") ?? "", /^clarice-.+-box-cadastro$/);
  });

  it("demais botões de box seguem com a posição `cta` (default inalterado)", () => {
    setMonthlyUtmCiclo("2604-05");
    try {
      const html = renderCtaButton("→ [Confira a página de livros](https://livros.diar.ia.br)");
      const href = buttonHref(html, "Confira a página de livros");
      assert.equal(new URL(href!).searchParams.get("utm_campaign"), "clarice-2604-05-cta");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("canal dos apoiadores corta o box (página e Kit)", () => {
    const draft = draftWithCadastro();
    assert.equal(isApoiadoresExcludedBox("CADASTRO"), true);
    const labels = splitByLabels(filterDraftForApoiadores(draft)).map((c) => normalizeLabel(c.split("\n")[0]));
    assert.ok(!labels.includes("CADASTRO"), labels.join(","));
    assert.doesNotMatch(buildArticleHtml(draft, "2604-05").html, /Assinar a edição diária/);
    assert.doesNotMatch(draftToEmailApoiadoresKit(draft, null, "2604").html, /Assinar a edição diária/);
  });

  it("lint acusa CADASTRO malformado que não vira seção", () => {
    const ok = checkOptionalSectionIntegrity(draftWithCadastro());
    assert.ok(!ok.missing.includes("CADASTRO"), ok.missing.join(","));
    const broken = draftWithCadastro().replace("**CADASTRO**", "**CADASTRO");
    assert.ok(checkOptionalSectionIntegrity(broken).missing.includes("CADASTRO"));
  });
});
