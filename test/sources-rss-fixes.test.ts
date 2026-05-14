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
    "Agent Pulse",        // feed alternativo retornava 0 items
  ];

  for (const name of SOURCES_WITHOUT_RSS) {
    it(`${name} não tem RSS configurada (feed oficial não existe / stale)`, () => {
      const s = byName.get(name);
      assert.ok(s, `${name} deve existir em sources.md (URL principal ainda válida pra WebSearch)`);
      assert.equal(s!.rss, undefined, `${name} não deve ter RSS — era ${s!.rss ?? '<none>'}`);
    });
  }

  it("DeepMind mantida com RSS oficial (baixa cadência mas válido)", () => {
    const s = byName.get("DeepMind");
    assert.ok(s, "DeepMind deve existir em sources.md");
    assert.equal(
      s!.rss,
      "https://deepmind.google/blog/rss.xml",
      "DeepMind feed é válido apesar da cadência baixa",
    );
  });
});
