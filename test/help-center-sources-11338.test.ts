/**
 * test/help-center-sources-11338.test.ts (#11338)
 *
 * Decisão do editor: cadastrar `alignment.openai.com`, `help.openai.com` e
 * `support.claude.com` como fontes (origem recorrente de inclusões manuais,
 * #11246). Sem a exceção de `isNonEditorialForSource`, o filtro #1559 da busca
 * `site:` descartaria TODO resultado das duas centrais de ajuda (host
 * `help.*`/`support.*`), e a fonte nasceria morta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isNonEditorialForSource, siteQueryHost } from "../scripts/lib/non-editorial-paths.ts";
import { processResult, buildSourceQuery } from "../scripts/fetch-websearch-batch.ts";
import { categorize } from "../scripts/categorize.ts";
import { isOfficialLancamentoUrl } from "../scripts/lib/launch-heuristics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("siteQueryHost (#11338)", () => {
  it("extrai o host do site:, sem www e sem path", () => {
    assert.equal(siteQueryHost(buildSourceQuery({ name: "x", site_query: "site:help.openai.com" })), "help.openai.com");
    assert.equal(siteQueryHost("site:www.anthropic.com/news AI"), "anthropic.com");
    assert.equal(siteQueryHost('AI agents "inteligência artificial"'), null);
    assert.equal(siteQueryHost(undefined), null);
  });
});

describe("isNonEditorialForSource (#11338)", () => {
  it("central de ajuda cadastrada como fonte mantém os próprios artigos", () => {
    assert.equal(
      isNonEditorialForSource("https://help.openai.com/en/articles/6825453-chatgpt-release-notes", "site:help.openai.com AI"),
      false,
    );
    assert.equal(
      isNonEditorialForSource("https://support.claude.com/en/articles/12138966-release-notes", "site:support.claude.com AI"),
      false,
    );
  });

  it("regressão 260529 preservada: site:openai.com segue descartando help.openai.com", () => {
    assert.equal(
      isNonEditorialForSource("https://help.openai.com/it-it/articles/12677804-what-is-chatgpt-faq", "site:openai.com AI"),
      true,
    );
  });

  it("sem site: (discovery) o filtro vale inteiro", () => {
    assert.equal(isNonEditorialForSource("https://help.openai.com/en/articles/1", undefined), true);
  });

  it("URL editorial nunca vira não-editorial", () => {
    assert.equal(isNonEditorialForSource("https://openai.com/blog/x", "site:help.openai.com"), false);
  });
});

describe("processResult com a fonte de ajuda (#11338)", () => {
  const cutoff = "2026-10-20";
  const hit = {
    title: "ChatGPT release notes: new AI features",
    url: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
    description: "Latest updates to ChatGPT and AI models",
    page_age: "2026-10-26T10:00:00Z",
  };

  it("query da própria fonte: resultado mantido", () => {
    const query = buildSourceQuery({ name: "OpenAI Help Center", site_query: "site:help.openai.com" });
    const r = processResult(hit, "OpenAI Help Center", cutoff, false, query);
    assert.ok(r.kept, `esperado kept, veio ${r.reason}`);
  });

  it("query de outra fonte (site:openai.com): descartado como não-editorial", () => {
    const query = buildSourceQuery({ name: "OpenAI", site_query: "site:openai.com" });
    const r = processResult(hit, "OpenAI", cutoff, false, query);
    assert.equal(r.kept, null);
    assert.equal(r.reason, "non_editorial_path");
  });

  it("discovery com a mesma URL: descartado", () => {
    const r = processResult(hit, "discovery: x", cutoff, true, "site:help.openai.com AI");
    assert.equal(r.reason, "non_editorial_path");
  });
});

describe("seed/sources.csv tem as 3 fontes (#11338)", () => {
  const csv = readFileSync(resolve(ROOT, "seed/sources.csv"), "utf8");
  const rows = csv.trim().split("\n").map((l) => l.split(","));
  const byUrl = (u: string) => rows.find((r) => r[2] === u);

  it("alignment.openai.com como Pesquisa, com RSS", () => {
    const r = byUrl("https://alignment.openai.com/");
    assert.ok(r, "alignment.openai.com ausente");
    assert.equal(r![1], "Pesquisa");
    assert.equal(r![3], "https://alignment.openai.com/rss.xml");
  });

  it("help.openai.com e support.claude.com como Tutoriais/Use Melhor", () => {
    for (const u of ["https://help.openai.com/en/", "https://support.claude.com/en/"]) {
      const r = byUrl(u);
      assert.ok(r, `${u} ausente`);
      assert.equal(r![1], "Tutoriais", u);
      assert.equal(r![5], "1", `${u} deveria ser use_melhor=1`);
    }
  });

  it("context/sources.md foi regenerado com as 3", () => {
    const md = readFileSync(resolve(ROOT, "context/sources.md"), "utf8");
    for (const q of ["site:alignment.openai.com", "site:help.openai.com", "site:support.claude.com"]) {
      assert.ok(md.includes(q), q);
    }
  });
});

describe("categorização e gate de LANÇAMENTOS (#11338, #160)", () => {
  it("post do alignment.openai.com cai em pesquisa", () => {
    assert.equal(
      categorize({ url: "https://alignment.openai.com/laser/", title: "Meet LASER: Recursive sampling for safer conversations" }),
      "pesquisa",
    );
  });

  it("centrais de ajuda não entram no registro de lançamento (#11004 mantém)", () => {
    assert.equal(isOfficialLancamentoUrl("https://help.openai.com/en/articles/1"), false);
    assert.equal(isOfficialLancamentoUrl("https://support.claude.com/en/articles/1"), false);
    assert.equal(isOfficialLancamentoUrl("https://alignment.openai.com/laser/"), false);
  });
});
