/**
 * sources-rss-fixes.test.ts (#1266)
 *
 * Anti-regressão pras URLs RSS corrigidas em #1266. Se alguém acidentalmente
 * reverter pros URLs quebrados (404 / HTML), test falha.
 *
 * Verifica via parse de context/sources.md (output canônico de
 * `npm run sync-sources` a partir de seed/sources.csv).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSourcesMd } from "../scripts/list-active-sources.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

describe("sources RSS fixes (#1266)", () => {
  const md = readFileSync(resolve(ROOT, "context/sources.md"), "utf8");
  const sources = parseSourcesMd(md);
  const byName = new Map(sources.map((s) => [s.name, s]));

  it("#1987: host dedicado-único → site_query host-only (path-scoping sub-retornava)", () => {
    // Hosts dedicados a UMA fonte: dropar o path fixa o under-return do site:.
    // OpenAI Cookbook substituída em #2077 por Simon Willison's Weblog.
    assert.equal(byName.get("LangChain Blog")?.site_query, "site:langchain.com");
    assert.equal(byName.get("Pinecone Learn")?.site_query, "site:pinecone.io");
  });

  it("#1987 code-review: host multi-tenant MANTÉM path (host-only floodaria de terceiros)", () => {
    // github.com (Anthropic Cookbook) host-only → todo o GitHub.
    // SHARED_HOSTS preserva o path.
    // W&B substituída em #2077 por The Gradient.
    assert.equal(byName.get("Anthropic Cookbook")?.site_query, "site:github.com/anthropics/anthropic-cookbook");
  });

  it("#1987 code-review: host com >1 fonte MANTÉM path (host-only colidiria as queries)", () => {
    // huggingface.co tem Blog (/blog) + Learn (/learn); anthropic.com tem news +
    // institute. Host-only colapsaria em queries idênticas (Brave dup + double-attr).
    assert.equal(byName.get("Hugging Face Blog")?.site_query, "site:huggingface.co/blog");
    assert.equal(byName.get("HuggingFace Learn")?.site_query, "site:huggingface.co/learn");
    // distintas (sem colisão)
    assert.notEqual(byName.get("Hugging Face Blog")?.site_query, byName.get("HuggingFace Learn")?.site_query);
  });

  it("Apple ML Research usa rss.xml (não rss-feed.rss)", () => {
    const s = byName.get("Apple Machine Learning Research");
    assert.ok(s, "Apple ML Research deve existir em sources.md");
    assert.equal(
      s!.rss,
      "https://machinelearning.apple.com/rss.xml",
      "URL canônica do Apple ML feed (era rss-feed.rss = 404)",
    );
  });

  it("Nvidia usa blogs.nvidia.com/feed/ (não nvidianews/rss)", () => {
    const s = byName.get("Nvidia");
    assert.ok(s, "Nvidia deve existir em sources.md");
    assert.equal(
      s!.rss,
      "https://blogs.nvidia.com/feed/",
      "URL canônica do Nvidia feed (nvidianews/rss retornava HTML)",
    );
  });

  // Fontes sem feed RSS oficial — devem ter RSS empty no CSV.
  const SOURCES_WITHOUT_RSS = [
    "Meta AI Blog",       // sem feed oficial conhecido
    "Cohere Blog",        // /blog/rss retornava HTML
    "Microsoft",          // feed 200 mas 0 items (stale)
    "Mistral AI News",    // sem feed oficial conhecido
    "Anthropic",          // sem feed oficial conhecido
    // "Agent Pulse" removida em #1637-39: roundup newsletter no aggregator-blocklist
    // (agentpulse.beehiiv.com), conteúdo sempre filtrado → desativada de sources.csv.
  ];

  for (const name of SOURCES_WITHOUT_RSS) {
    it(`${name} não tem RSS configurada (feed oficial não existe / stale)`, () => {
      const s = byName.get(name);
      assert.ok(s, `${name} deve existir em sources.md (URL principal ainda válida pra WebSearch)`);
      assert.equal(s!.rss, undefined, `${name} não deve ter RSS — era ${s!.rss ?? '<none>'}`);
    });
  }

  it("Agent Pulse removida — aggregator blocklisted (#1637-39)", () => {
    assert.equal(
      byName.get("Agent Pulse"),
      undefined,
      "Agent Pulse não deve mais existir em sources.md (roundup newsletter no aggregator-blocklist)",
    );
  });

  it("DeepMind mantida com RSS oficial (baixa cadência mas válido)", () => {
    const s = byName.get("DeepMind");
    assert.ok(s, "DeepMind deve existir em sources.md");
    assert.equal(
      s!.rss,
      "https://deepmind.google/blog/rss.xml",
      "DeepMind feed é válido apesar da cadência baixa",
    );
  });

  // #1862: 7 fontes "Tutoriais" reportadas como secas. Investigação (curl
  // server-side) distinguiu feed quebrado de fonte de baixa cadência.
  // #1971: re-auditoria ao vivo desativou 3 fontes estruturalmente incompatíveis
  // com o pipeline de recência (Fast.ai pivotou pra ensaios, newest jan/2026;
  // Kaggle Learn + Microsoft Learn AI = currículo/catálogo estático evergreen).
  it("#1971: Fast.ai / Kaggle Learn / Microsoft Learn AI desativadas (não no seed)", () => {
    assert.equal(byName.get("Fast.ai"), undefined, "Fast.ai desativada (#1971)");
    assert.equal(byName.get("Kaggle Learn"), undefined, "Kaggle Learn desativada (#1971)");
    assert.equal(byName.get("Microsoft Learn AI"), undefined, "Microsoft Learn AI desativada (#1971)");
  });

  // #1862: feeds RSS mortos (404 / HTML React/Webflow) — fonte mantida pra
  // WebSearch `site:`, mas RSS limpo + URL apontando pro domínio atual.
  // LangChain removida desta lista em #2077: ganhou RSS válido (rss.xml no novo domínio).
  // OpenAI Cookbook e Weights & Biases removidas desta lista em #2077: substituídas por
  // Simon Willison's Weblog e The Gradient (fontes ativas com RSS verificado).
  const SOURCES_1862_NO_RSS: Array<{ name: string; url: string }> = [];
  for (const { name, url } of SOURCES_1862_NO_RSS) {
    it(`#1862: ${name} sem RSS (feed morto) + URL no domínio atual`, () => {
      const s = byName.get(name);
      assert.ok(s, `${name} deve existir em sources.md (mantida pra WebSearch site:)`);
      assert.equal(s!.rss, undefined, `${name} não deve ter RSS — feed morto`);
      assert.equal(s!.url, url, `${name} URL deve apontar pro domínio atual`);
    });
  }

  it("#2077: OpenAI Cookbook e W&B substituídas por fontes ativas de tutoriais", () => {
    assert.equal(
      byName.get("OpenAI Cookbook"),
      undefined,
      "OpenAI Cookbook removida de sources.md (#2077)",
    );
    assert.equal(
      byName.get("Weights & Biases"),
      undefined,
      "Weights & Biases removida de sources.md (#2077)",
    );
  });

  // #2077: Simon Willison estava no editorial-blocklist (#1760) → não pode ser fonte.
  // Substituição de OpenAI Cookbook: Chip Huyen (feed válido, low_cadence=1).
  it("#2077: Chip Huyen adicionada com RSS verificado (substitui OpenAI Cookbook)", () => {
    const s = byName.get("Chip Huyen (Blog)");
    assert.ok(s, "Chip Huyen deve existir em sources.md");
    assert.equal(s!.rss, "https://huyenchip.com/feed.xml", "RSS válido verificado");
    assert.equal(s!.url, "https://huyenchip.com/blog", "URL principal correta");
  });

  it("#2077: The Gradient adicionada com RSS verificado (substitui W&B)", () => {
    const s = byName.get("The Gradient");
    assert.ok(s, "The Gradient deve existir em sources.md");
    assert.equal(s!.rss, "https://thegradient.pub/rss/", "RSS verificado (post Feb/2026)");
    assert.equal(s!.url, "https://thegradient.pub/", "URL principal correta");
  });

  it("#2077: LangChain Blog ganhou RSS válido no novo domínio", () => {
    // blog.langchain.dev/rss era morto (HTML Webflow). Novo feed:
    // www.langchain.com/blog/rss.xml — RSS 2.0 válido com posts de Jun/2026.
    const s = byName.get("LangChain Blog");
    assert.ok(s, "LangChain Blog deve existir em sources.md");
    assert.equal(s!.rss, "https://www.langchain.com/blog/rss.xml", "LangChain Blog deve usar novo RSS válido");
    assert.equal(s!.url, "https://www.langchain.com/blog", "LangChain Blog URL no domínio atual");
  });

  it("#1862: fontes de baixa cadência mantidas com RSS válido (não eram quebradas)", () => {
    // 0 hard failures, só empties → feed funciona, publica pouco. NÃO mexer.
    for (const name of ["Sebastian Raschka (Ahead of AI)", "Hamel Husain", "Eugene Yan"]) {
      const s = byName.get(name);
      assert.ok(s, `${name} deve existir`);
      assert.ok(s!.rss && s!.rss.length > 0, `${name} deve manter o RSS válido (baixa cadência ≠ quebrado)`);
    }
  });
});
