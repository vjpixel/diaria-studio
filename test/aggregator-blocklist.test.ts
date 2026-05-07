import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isAggregator,
  filterSources,
  AGGREGATOR_BLOCKLIST,
} from "../scripts/lib/aggregator-blocklist.ts";

describe("isAggregator (#717 hyp 5)", () => {
  it("detecta agregador clássico (crescendo.ai)", () => {
    const r = isAggregator("https://crescendo.ai/news/today");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "classic_aggregator");
    assert.equal(r.pattern, "crescendo.ai");
  });

  it("detecta newsletter de roundup AI (aibreakfast.beehiiv.com)", () => {
    const r = isAggregator("https://aibreakfast.beehiiv.com/");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "ai_roundup_newsletter");
  });

  it("case-insensitive match", () => {
    const r = isAggregator("https://AIBREAKFAST.beehiiv.com/p/123");
    assert.equal(r.blocked, true);
  });

  it("matcha path-prefix (tldr.tech/ai mas NÃO tldr.tech/security)", () => {
    assert.equal(isAggregator("https://tldr.tech/ai/2026-05-06").blocked, true);
    assert.equal(isAggregator("https://tldr.tech/security/2026-05-06").blocked, false);
  });

  it("perplexity.ai bloqueado por default", () => {
    const r = isAggregator("https://www.perplexity.ai/search?q=foo");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "perplexity_non_primary");
  });

  it("perplexity.ai/hub/ NÃO bloqueado (fonte primária)", () => {
    const r = isAggregator("https://www.perplexity.ai/hub/blog/some-post");
    assert.equal(r.blocked, false);
  });

  it("research.perplexity.ai NÃO bloqueado (fonte primária)", () => {
    const r = isAggregator("https://research.perplexity.ai/articles/foo");
    assert.equal(r.blocked, false);
  });

  it("URL não-agregador retorna blocked: false", () => {
    assert.equal(isAggregator("https://anthropic.com/news/article").blocked, false);
    assert.equal(isAggregator("https://openai.com/blog/x").blocked, false);
    assert.equal(isAggregator("https://news.google.com/articles/foo").blocked, false);
  });

  it("URL inválida retorna blocked: false (defensive)", () => {
    assert.equal(isAggregator("").blocked, false);
    assert.equal(isAggregator(null as unknown as string).blocked, false);
    assert.equal(isAggregator(undefined as unknown as string).blocked, false);
  });

  it("br_republisher (docmanagement.com.br)", () => {
    const r = isAggregator("https://docmanagement.com.br/post/x");
    assert.equal(r.blocked, true);
    assert.equal(r.category, "br_republisher");
  });
});

describe("filterSources (#717 hyp 5)", () => {
  it("separa kept e skipped corretamente", () => {
    const sources = [
      { name: "Anthropic", url: "https://anthropic.com/news" },
      { name: "AI Breakfast", url: "https://aibreakfast.beehiiv.com/" },
      { name: "OpenAI", url: "https://openai.com/blog/" },
      { name: "TLDR AI", url: "https://tldr.tech/ai/" },
      { name: "Perplexity Research", url: "https://research.perplexity.ai/" },
    ];
    const r = filterSources(sources);
    assert.equal(r.kept.length, 3, "kept: anthropic, openai, perplexity-research");
    assert.equal(r.skipped.length, 2, "skipped: aibreakfast, tldr/ai");
    assert.deepEqual(
      r.kept.map((s) => s.name).sort(),
      ["Anthropic", "OpenAI", "Perplexity Research"],
    );
    assert.deepEqual(
      r.skipped.map((s) => s.name).sort(),
      ["AI Breakfast", "TLDR AI"],
    );
  });

  it("skipped inclui category + pattern pra log/debug", () => {
    const sources = [{ name: "AI Breakfast", url: "https://aibreakfast.beehiiv.com/" }];
    const r = filterSources(sources);
    assert.equal(r.skipped[0].category, "ai_roundup_newsletter");
    assert.equal(r.skipped[0].pattern, "aibreakfast.beehiiv.com");
  });

  it("array vazio retorna kept e skipped vazios", () => {
    const r = filterSources([]);
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.skipped, []);
  });
});

describe("AGGREGATOR_BLOCKLIST (#717 hyp 5)", () => {
  it("nenhuma entrada vazia ou com whitespace", () => {
    for (const entry of AGGREGATOR_BLOCKLIST) {
      assert.ok(entry.pattern.length > 0, `pattern vazio: ${JSON.stringify(entry)}`);
      assert.equal(
        entry.pattern.trim(),
        entry.pattern,
        `pattern com whitespace: ${JSON.stringify(entry)}`,
      );
    }
  });

  it("todas as entradas têm category válida", () => {
    const validCategories = new Set([
      "classic_aggregator",
      "ai_roundup_newsletter",
      "br_republisher",
      "perplexity_non_primary",
    ]);
    for (const entry of AGGREGATOR_BLOCKLIST) {
      assert.ok(
        validCategories.has(entry.category),
        `category inválida: ${entry.category}`,
      );
    }
  });

  it("todas as entradas têm type válido (domain | path_prefix)", () => {
    const validTypes = new Set(["domain", "path_prefix"]);
    for (const entry of AGGREGATOR_BLOCKLIST) {
      assert.ok(
        validTypes.has(entry.type),
        `type inválido: ${entry.type} em ${JSON.stringify(entry)}`,
      );
    }
  });

  it("entries path_prefix têm '/' no pattern", () => {
    for (const entry of AGGREGATOR_BLOCKLIST) {
      if (entry.type === "path_prefix") {
        assert.ok(
          entry.pattern.includes("/"),
          `path_prefix sem '/' no pattern: ${entry.pattern}`,
        );
      }
    }
  });

  it("entries domain NÃO têm '/' no pattern", () => {
    for (const entry of AGGREGATOR_BLOCKLIST) {
      if (entry.type === "domain") {
        assert.ok(
          !entry.pattern.includes("/"),
          `domain com '/' no pattern: ${entry.pattern} (deveria ser path_prefix)`,
        );
      }
    }
  });
});

describe("isAggregator — substring FP fix (#838)", () => {
  it("techstartups.com NÃO matcha sometechstartups.com (false-positive antigo)", () => {
    assert.equal(isAggregator("https://sometechstartups.com/x").blocked, false);
  });

  it("techstartups.com NÃO matcha techstartups.com.fakedomain.com", () => {
    // Esse é o caso clássico de path-injection em substring matching.
    // Com URL parsing, o host é fakedomain.com (ou o que o resolver retornar).
    assert.equal(
      isAggregator("https://techstartups.com.fakedomain.com/x").blocked,
      false,
    );
  });

  it("perplexity.ai NÃO matcha perplexity.airline.com (false-positive antigo)", () => {
    assert.equal(isAggregator("https://perplexity.airline.com/foo").blocked, false);
  });

  it("tldr.tech/ai NÃO matcha tldr.tech/airport (path FP)", () => {
    assert.equal(isAggregator("https://tldr.tech/airport/2026").blocked, false);
  });

  it("tldr.tech/ai matcha exato (/ai sem nada depois)", () => {
    assert.equal(isAggregator("https://tldr.tech/ai").blocked, true);
  });

  it("subdomínio matcha o domínio: mail.crescendo.ai → blocked", () => {
    // subdomínios de domínios bloqueados continuam bloqueados (ex:
    // newsletter.aibreakfast.beehiiv.com seria igual ao raiz).
    assert.equal(isAggregator("https://mail.crescendo.ai/x").blocked, true);
  });

  it("crescendo.ai matcha www.crescendo.ai (extractHost normaliza www)", () => {
    assert.equal(isAggregator("https://www.crescendo.ai/news").blocked, true);
  });
});

describe("AGGREGATOR_BLOCKLIST drift detection (#838)", () => {
  // Garante que cada entry da lib aparece textualmente no source-researcher.md
  // e vice-versa. Catch silent drift quando alguém atualiza um lado e esquece
  // o outro. Exceções documentadas no md (importai.substack.com, news.google.com)
  // são listadas explicitamente abaixo.

  const MD_ONLY_EXCEPTIONS = [
    "importai.substack.com",
    "news.google.com",
  ];

  function readSourceResearcherMd(): string {
    return readFileSync(".claude/agents/source-researcher.md", "utf8");
  }

  it("cada entry de AGGREGATOR_BLOCKLIST aparece em source-researcher.md", () => {
    const md = readSourceResearcherMd();
    const missing: string[] = [];
    for (const entry of AGGREGATOR_BLOCKLIST) {
      // For path_prefix, check the full pattern; for domain, check exactly.
      if (!md.includes(entry.pattern)) {
        missing.push(entry.pattern);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Patterns na lib mas ausentes em source-researcher.md: ${missing.join(", ")}`,
    );
  });

  it("cada domínio mencionado em source-researcher.md está em AGGREGATOR_BLOCKLIST ou em exceções", () => {
    const md = readSourceResearcherMd();
    // Extrai termos backtick-quoted que parecem domain (contém ".") da seção
    // de agregadores. Padrão simples: `(host[.tld]+(/path)?)`
    const knownPatterns = new Set(
      AGGREGATOR_BLOCKLIST.map((e) => e.pattern.toLowerCase()),
    );
    for (const exception of MD_ONLY_EXCEPTIONS) {
      knownPatterns.add(exception.toLowerCase());
    }

    // Match: backtick-cercado + começa com letra/número + tem ponto.
    // Filtra `host`, `host.tld`, `host.tld/path`. Ignora `path/file`,
    // pure paths, etc.
    const tokenRe = /`([a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:\/[a-z0-9./*-]+)?)`/gi;
    const matches = md.matchAll(tokenRe);
    const drift: string[] = [];
    for (const m of matches) {
      const candidate = m[1].toLowerCase();
      // skip wildcards (used in narrative like "perplexity.ai/*")
      if (candidate.includes("*")) continue;
      // skip if perplexity.ai/hub or research.perplexity.ai (primary paths,
      // mentioned as exceptions inline)
      if (candidate.startsWith("perplexity.ai/hub") || candidate === "research.perplexity.ai") {
        continue;
      }
      // skip path-only references like 'scripts/lib/x'
      if (candidate.startsWith("scripts/")) continue;
      if (knownPatterns.has(candidate)) continue;
      // Also accept if the pattern is a base of the candidate (subdomain
      // mention in prose): bensbites.co matches a known bensbites.co.
      let matched = false;
      for (const known of knownPatterns) {
        if (candidate === known || candidate.endsWith("." + known)) {
          matched = true;
          break;
        }
      }
      if (!matched) drift.push(candidate);
    }
    assert.deepEqual(
      drift,
      [],
      `Domínios em source-researcher.md ausentes da lib (ou de exceções): ${drift.join(", ")}`,
    );
  });
});
