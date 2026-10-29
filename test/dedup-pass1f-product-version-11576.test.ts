/**
 * #11576: o Pass-1f (#11511) removia do pool QUALQUER artigo com produto+versão
 * em comum com um título publicado nas últimas 3 edições. Agora ele usa o
 * critério do (b2) intra-edição (#11496): remove só com segundo sinal (tópico
 * em comum ou os dois títulos são anúncio); sem ele, o item fica no pool com
 * `event_dedup_flagged`; variantes nomeadas diferentes descartam o par.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { renderMarkdown } from "../scripts/refresh-past-editions.ts";
import { matchProductVersionStory, hasStorySecondSignal } from "../scripts/lib/product-version-story.ts";

it("#11576: 'GPT-6.1 banido em escolas' × 'GPT-6.1 ganha modo de voz' não tem segundo sinal", () => {
  const m = matchProductVersionStory("GPT-6.1 banido em escolas", "GPT-6.1 ganha modo de voz");
  assert.ok(m);
  assert.deepEqual(m.products, ["gpt 6.1"]);
  assert.equal(hasStorySecondSignal(m), false);
});

it("#11576: variantes diferentes descartam o par; anúncio × anúncio é segundo sinal", () => {
  assert.equal(matchProductVersionStory("Gemini 3.8 Flash chega ao Android", "Google lança Gemini 3.8 Pro"), null);
  const launch = matchProductVersionStory("OpenAI anuncia GPT-6.1 para todos", "OpenAI lança GPT-6.1");
  assert.ok(launch && hasStorySecondSignal(launch));
});

it("#11576: Pass-1f mantém no pool história diferente sobre o mesmo produto+versão", () => {
  const root = mkdtempSync(join(tmpdir(), "pass1f-11576-"));
  try {
    const dir = join(root, "data/editions/2610/261028");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal/01-approved.json"), JSON.stringify({ highlights: [], radar: [] }));
    // Cenário da issue: a 261028 publica no Radar "OpenAI lança GPT-6.1" e
    // "Google lança Gemini 3.8 Pro".
    writeFileSync(join(dir, "02-reviewed.md"),
      "**[OpenAI lança GPT-6.1](https://a.example/gpt)**\n**[Google lança Gemini 3.8 Pro](https://a.example/gemini)**");
    const md = renderMarkdown([{
      id: "test", title: "Manchete sem produto", published_at: "2026-10-28",
      links: ["https://a.example/gpt", "https://a.example/gemini"],
    }], root);
    const past = join(root, "past.md");
    writeFileSync(past, md);
    const articles = join(root, "articles.json");
    writeFileSync(articles, JSON.stringify([
      { url: "https://b.example/ban", title: "GPT-6.1 é banido em escolas da Califórnia" },
      { url: "https://b.example/flash", title: "Gemini 3.8 Flash chega ao Android" },
      { url: "https://b.example/again", title: "OpenAI anuncia GPT-6.1 para todos" },
    ]));
    const out = join(root, "out.json");
    execFileSync(process.execPath, ["--import", "tsx", resolve("scripts/dedup.ts"),
      "--articles", articles, "--past-editions", past, "--editions-dir", join(root, "missing"),
      "--current-edition", "261029", "--log-root-dir", root, "--out", out], { stdio: "pipe" });
    const result = JSON.parse(readFileSync(out, "utf8"));
    const kept = new Map(result.kept.map((a: { url: string }) => [a.url, a]));
    const ban = kept.get("https://b.example/ban") as { event_dedup_flagged?: string } | undefined;
    assert.ok(ban, "história diferente sobre GPT-6.1 continua no pool");
    assert.match(ban.event_dedup_flagged ?? "", /sem segundo sinal \(#11576: gpt 6\.1\)/);
    const flash = kept.get("https://b.example/flash") as { event_dedup_flagged?: string } | undefined;
    assert.ok(flash, "variante diferente (Flash × Pro) continua no pool");
    assert.equal(flash.event_dedup_flagged, undefined);
    assert.deepEqual(result.removed.map((r: { url: string }) => r.url), ["https://b.example/again"]);
    assert.match(result.removed[0].dedup_note, /same-product-version \(#11511, os dois são anúncio\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
