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
  // server-side) distinguiu feed quebrado de fonte de baixa cadência:
  it("#1862: Fast.ai usa index.xml (atom.xml era 404)", () => {
    const s = byName.get("Fast.ai");
    assert.ok(s, "Fast.ai deve existir em sources.md");
    assert.equal(
      s!.rss,
      "https://www.fast.ai/index.xml",
      "atom.xml retornava 404; index.xml é o feed declarado no homepage (200 application/xml)",
    );
  });

  // #1862: feeds RSS mortos (404 / HTML React/Webflow) — fonte mantida pra
  // WebSearch `site:`, mas RSS limpo + URL apontando pro domínio atual.
  const SOURCES_1862_NO_RSS: Array<{ name: string; url: string }> = [
    { name: "OpenAI Cookbook", url: "https://developers.openai.com/cookbook" }, // migrou de cookbook.openai.com (rss 404)
    { name: "LangChain Blog", url: "https://www.langchain.com/blog" }, // blog.langchain.dev/rss → 301 → HTML Webflow
    { name: "Weights & Biases", url: "https://wandb.ai/fully-connected" }, // /site/articles/rss.xml 404; fully-connected é React (sem XML)
  ];
  for (const { name, url } of SOURCES_1862_NO_RSS) {
    it(`#1862: ${name} sem RSS (feed morto) + URL no domínio atual`, () => {
      const s = byName.get(name);
      assert.ok(s, `${name} deve existir em sources.md (mantida pra WebSearch site:)`);
      assert.equal(s!.rss, undefined, `${name} não deve ter RSS — feed morto`);
      assert.equal(s!.url, url, `${name} URL deve apontar pro domínio atual`);
    });
  }

  it("#1862: fontes de baixa cadência mantidas com RSS válido (não eram quebradas)", () => {
    // 0 hard failures, só empties → feed funciona, publica pouco. NÃO mexer.
    for (const name of ["Sebastian Raschka (Ahead of AI)", "Hamel Husain", "Eugene Yan"]) {
      const s = byName.get(name);
      assert.ok(s, `${name} deve existir`);
      assert.ok(s!.rss && s!.rss.length > 0, `${name} deve manter o RSS válido (baixa cadência ≠ quebrado)`);
    }
  });
});
