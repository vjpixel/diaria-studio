/**
 * #11116 (pool-cut) / #11119 (bucket-move) — regressões dos casos reais que o
 * editor cortou ou moveu de seção nas edições 261016-261026. Cada caso usa o
 * título/summary/URL congelados em `_internal/01-categorized.json` da edição.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { categorizeWithRule, type Article } from "../scripts/lib/launch-heuristics.ts";
import { categorizeArticles, collapseRepeatedGithubReleases } from "../scripts/categorize.ts";

function cat(a: Partial<Article>) {
  return categorizeWithRule({ summary: "", ...a } as Article);
}

describe("#11119/#11116: 'how X used' exige nomes capitalizados de verdade", () => {
  it("261022: 'How one hacker used AI agents…' não é tutorial (USE MELHOR → RADAR pelo editor)", () => {
    const r = cat({
      url: "https://www.rappler.com/technology/features/hacker-used-ai-agents-break-into-websites-norforge-report",
      title: "How one hacker used AI agents and a few thousand dollars to break into scores of sites",
      summary:
        "Snorre Fagerland of NorForge says instances of bad actors using AI agents to perform hacks is evidence these agents could pull off complex intrusions",
    });
    assert.notEqual(r.category, "tutorial");
    assert.notEqual(r.rule, "tutorial-title-extra");
  });

  it("261020: summary 'how this money might actually be used' não vira tutorial (cortado de USE MELHOR)", () => {
    const r = cat({
      url: "https://techcrunch.com/2026/10/18/anthropic-says-its-committing-5-of-its-shares-to-a-public-benefit-fund",
      title: "Anthropic says it’s committing 5% of its shares to a ‘public benefit fund’",
      summary:
        "The company offered some broad-strokes ideas for how this money might actually be used, such as “large donations to traditional nonprofits or direct distributions to specific populations.”",
    });
    assert.notEqual(r.category, "tutorial");
  });
});

describe("#11116 (261023): notícia de segurança no PHP não é USE MELHOR", () => {
  const php = {
    url: "https://canaltech.com.br/seguranca/ia-revela-falhas-escondidas-ha-mais-de-10-anos-no-php-entenda-a-descoberta/",
    title: "IA revela falhas escondidas há mais de 10 anos no PHP",
    summary:
      "Ferramentas de inteligência artificial (IA) ajudaram pesquisadores a descobrir como explorar falhas de segurança presentes no PHP há mais de uma década . As vulnerabilidades, que podem permitir invasões de servidores, provocaram um alerta mundial.",
  };

  it("o caso real inteiro (título + summary) sai de tutorial", () => {
    assert.notEqual(cat(php).category, "tutorial");
  });

  it("'IA' singular não forma listicle de descoberta com 'escondidas'", () => {
    assert.notEqual(cat({ ...php, summary: "" }).category, "tutorial");
  });

  it("'como explorar falhas' é ataque, não procedimento para o leitor", () => {
    assert.notEqual(cat({ url: php.url, title: "Notícia qualquer", summary: "descobriram como explorar falhas de segurança" }).category, "tutorial");
  });

  it("listicle de descoberta no plural e 'como usar' seguem tutorial", () => {
    assert.equal(
      cat({ url: "https://exame.com/tecnologia/ias-pouco-conhecidas", title: "7 IAs pouco conhecidas que podem mudar sua forma de trabalhar" }).category,
      "tutorial",
    );
    assert.equal(cat({ url: "https://exame.com/tecnologia/x", title: "Como usar o ChatGPT para organizar planilhas" }).category, "tutorial");
  });
});

describe("#11119 (261022): divulgação de vulnerabilidade em domínio oficial é RADAR", () => {
  it("'Patch the Planet…' (openai.com) vira noticias", () => {
    const r = cat({
      url: "https://openai.com/index/coordinated-disclosure-of-critical-vulnerabilities",
      title: "Patch the Planet: global response coordination as agents uncover critical vulnerabilities",
    });
    assert.equal(r.category, "noticias");
    assert.equal(r.rule, "lancamento-non-product-official");
  });

  it("lançamento de ferramenta de segurança com verbo de lançamento segue LANÇAMENTO", () => {
    const r = cat({
      url: "https://openai.com/index/introducing-aardvark",
      title: "Introducing Aardvark: an agentic security researcher that finds vulnerabilities",
    });
    assert.equal(r.category, "lancamento");
  });

  it("'Security incident disclosure — July 2026' (huggingface.co, type_hint noticia) vira noticias", () => {
    const r = cat({
      url: "https://huggingface.co/blog/security-incident-july-2026",
      title: "Security incident disclosure — July 2026",
      type_hint: "noticia",
    });
    assert.equal(r.category, "noticias");
    assert.equal(r.rule, "lancamento-non-product-official");
  });
});

describe("#11183: ferramenta de segurança confirmada pelo agent não sai de LANÇAMENTO", () => {
  const tool = {
    url: "https://www.anthropic.com/news/automated-security-reviews-claude-code",
    title: "Automated security reviews in Claude Code: catch vulnerabilities before you ship",
  };

  it("type_hint=lancamento vence o padrão de vulnerabilidade (sem verbo de anúncio no título)", () => {
    const r = cat({ ...tool, type_hint: "lancamento" });
    assert.equal(r.category, "lancamento");
    assert.equal(r.rule, "lancamento-type-hint");
  });

  it("sem type_hint, o mesmo título segue demovido (comportamento do #11119 preservado)", () => {
    const r = cat(tool);
    assert.equal(r.category, "noticias");
    assert.equal(r.rule, "lancamento-non-product-official");
  });
});

describe("#11116 (261026): duas releases do mesmo repo GitHub → só a mais nova", () => {
  const r307 = { url: "https://github.com/anthropics/claude-code/releases/tag/v2.1.307", title: "v2.1.307" } as Article;
  const r310 = { url: "https://github.com/anthropics/claude-code/releases/tag/v2.1.310", title: "v2.1.310" } as Article;

  it("descarta a mais antiga, independente da ordem de entrada", () => {
    for (const items of [[r307, r310], [r310, r307]]) {
      const { kept, dropped } = collapseRepeatedGithubReleases(items);
      assert.deepEqual(kept.map((a) => a.url), [r310.url]);
      assert.deepEqual(dropped, [{ url: r307.url, kept_url: r310.url }]);
    }
  });

  it("compara numericamente (v2.1.99 < v2.1.307), não lexicograficamente", () => {
    const r99 = { url: "https://github.com/anthropics/claude-code/releases/tag/v2.1.99", title: "v2.1.99" } as Article;
    assert.deepEqual(collapseRepeatedGithubReleases([r99, r307]).kept.map((a) => a.url), [r307.url]);
  });

  it("repos diferentes, tag não numérica e submissão do editor ficam", () => {
    const other = { url: "https://github.com/openai/codex/releases/tag/v0.9.1", title: "v0.9.1" } as Article;
    const nightly = { url: "https://github.com/anthropics/claude-code/releases/tag/nightly", title: "nightly" } as Article;
    const editor = { ...r307, flag: "editor_submitted" } as Article;
    const { kept, dropped } = collapseRepeatedGithubReleases([r310, other, nightly, editor]);
    assert.equal(kept.length, 4);
    assert.deepEqual(dropped, []);
  });

  it("tag com `%` malformado não lança (decodeURIComponent) e o item fica", () => {
    const bad = { url: "https://github.com/anthropics/claude-code/releases/tag/v1%2", title: "v1%2" } as Article;
    const { kept, dropped } = collapseRepeatedGithubReleases([r310, bad]);
    assert.deepEqual(kept.map((a) => a.url), [r310.url, bad.url]);
    assert.deepEqual(dropped, []);
    const summary = "Claude Code release notes for the AI coding agent";
    assert.doesNotThrow(() => categorizeArticles([{ ...bad, summary }, { ...r310, summary }]));
  });

  it("tag percent-encoded válida segue comparável", () => {
    const enc = { url: "https://github.com/anthropics/claude-code/releases/tag/v2%2E1%2E400", title: "v2.1.400" } as Article;
    assert.deepEqual(collapseRepeatedGithubReleases([r310, enc]).kept.map((a) => a.url), [enc.url]);
  });

  it("categorizeArticles aplica o colapso e reporta o descarte no onEvent", () => {
    const events: unknown[] = [];
    const summary = "Claude Code release notes for the AI coding agent";
    const out = categorizeArticles([{ ...r307, summary }, { ...r310, summary }], { onEvent: (e) => events.push(e) });
    const urls = Object.values(out).flat().map((a) => (a as Article).url);
    assert.deepEqual(urls, [r310.url]);
    assert.equal(events.length, 1);
  });
});
