/**
 * #9882 — eval de replay do categorizador (`scripts/lib/categorizer-replay.ts`,
 * `analyze-bucket-overrides.ts --replay`). Fixtures sintéticas: o corpus real
 * vive em `data/` (gitignored, ausente no CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { replayEdition, summarizeReplay, renderReplayReport, type CategorizeFn } from "../scripts/lib/categorizer-replay.ts";
import { resolveCliOptions } from "../scripts/analyze-bucket-overrides.ts";

describe("replayEdition", () => {
  it("join por URL canonicalizada; item sem gabarito (cortado/promovido) fica de fora", () => {
    const items = replayEdition(
      "261008",
      {
        radar: [
          { url: "https://example.com/a?utm_source=x", title: "Como usar o ChatGPT para resumir PDFs" },
          { url: "https://example.com/cortado", title: "Item cortado" },
        ],
      },
      { use_melhor: [{ url: "https://example.com/a" }] },
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].frozen, "radar");
    assert.equal(items[0].approved, "use_melhor");
  });

  it("decide sobre o título CRU (title_raw, #9380), não o normalizado", () => {
    const seen: string[] = [];
    const fn: CategorizeFn = (a) => {
      seen.push(a.title ?? "");
      return { category: "noticias", rule: "noticias-default" };
    };
    replayEdition(
      "x",
      { radar: [{ url: "https://example.com/a", title: "Título limpo", title_raw: "Título limpo - Canaltech" }] },
      { radar: [{ url: "https://example.com/a" }] },
      fn,
    );
    assert.deepEqual(seen, ["Título limpo - Canaltech"]);
  });

  it("mesma regra que a congelada preserva o bucket congelado (movimento downstream, não do categorizador)", () => {
    const fn: CategorizeFn = () => ({ category: "lancamento", rule: "lancamento-default" });
    const [it0] = replayEdition(
      "x",
      { radar: [{ url: "https://openai.com/index/a", title: "A", category_rule: "lancamento-default" }] },
      { radar: [{ url: "https://openai.com/index/a" }] },
      fn,
    );
    assert.equal(it0.replay, "radar");
  });

  it("tie-breaker congelado é reaproveitado e o gate de domínio oficial é recomposto (#8211/#9848)", () => {
    const fallback: CategorizeFn = () => ({ category: "noticias", rule: "noticias-default" });
    const [official, nonOfficial] = replayEdition(
      "x",
      {
        radar: [
          // congelado antes do #9848: classificador disse lançamento, gate barrou
          {
            url: "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides",
            title: "X",
            category_rule: "semantic-tiebreaker-radar-nonofficial",
          },
          { url: "https://example.com/news/y", title: "Y", category_rule: "semantic-tiebreaker-radar-nonofficial" },
        ],
      },
      {
        lancamento: [{ url: "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides" }],
        radar: [{ url: "https://example.com/news/y" }],
      },
      fallback,
    );
    assert.equal(official.tiebreakerReused, true);
    assert.equal(official.replay, "lancamento");
    assert.equal(official.replayRule, "semantic-tiebreaker-lancamento");
    assert.equal(nonOfficial.replay, "radar");
    assert.equal(nonOfficial.replayRule, "semantic-tiebreaker-radar-nonofficial");
  });

  it("veredito congelado 'radar' do tie-breaker continua radar mesmo em domínio oficial", () => {
    const fallback: CategorizeFn = () => ({ category: "lancamento", rule: "lancamento-default" });
    const [it0] = replayEdition(
      "x",
      { radar: [{ url: "https://openai.com/index/z", title: "Z", category_rule: "semantic-tiebreaker-radar" }] },
      { radar: [{ url: "https://openai.com/index/z" }] },
      fallback,
    );
    assert.equal(it0.replay, "radar");
    assert.equal(it0.replayRule, "semantic-tiebreaker-radar");
  });

  it("regra NÃO-default do código atual vence o tie-breaker congelado (não reaproveita)", () => {
    const fn: CategorizeFn = () => ({ category: "tutorial", rule: "tutorial-keyword" });
    const [it0] = replayEdition(
      "x",
      { radar: [{ url: "https://example.com/c", title: "C", category_rule: "semantic-tiebreaker-radar" }] },
      { use_melhor: [{ url: "https://example.com/c" }] },
      fn,
    );
    assert.equal(it0.tiebreakerReused, false);
    assert.equal(it0.replay, "use_melhor");
  });
});

describe("summarizeReplay / renderReplayReport", () => {
  const base = { edition: "e1", title: "", frozenRule: null, replayRule: "r", tiebreakerReused: false };
  const items = [
    { ...base, url: "u1", approved: "use_melhor", frozen: "radar", replay: "use_melhor" }, // melhoria
    { ...base, url: "u2", approved: "radar", frozen: "radar", replay: "lancamento" }, // regressão
    { ...base, url: "u3", approved: "lancamento", frozen: "radar", replay: "radar" }, // resíduo
    { ...base, url: "u4", approved: "radar", frozen: "radar", replay: "radar", edition: "e2" }, // acordo
  ] as const;

  it("conta acordo, melhorias, regressões e resíduo por direção", () => {
    const s = summarizeReplay([...items]);
    assert.equal(s.editions, 2);
    assert.equal(s.pairs, 4);
    assert.equal(s.frozenAgree, 2);
    assert.equal(s.replayAgree, 2);
    assert.deepEqual(s.improvements.map((i) => i.url), ["u1"]);
    assert.deepEqual(s.regressions.map((i) => i.url), ["u2"]);
    assert.deepEqual(s.residualItems.map((i) => i.url), ["u3"]);
    assert.deepEqual(s.directions, [
      { direction: "radar->lancamento", moves: 1, residual: 1 },
      { direction: "radar->use_melhor", moves: 1, residual: 0 },
    ]);
  });

  it("relatório nomeia escopo e lista regressões e resíduo", () => {
    const out = renderReplayReport(summarizeReplay([...items]), 20);
    assert.match(out, /últimas 20 edições/);
    assert.match(out, /REGRESSÕES/);
    assert.match(out, /RESÍDUO/);
    assert.match(out, /TOTAL\s+2 movimentos · resíduo 1/);
    assert.match(renderReplayReport(summarizeReplay([...items]), null), /corpus inteiro/);
  });
});

describe("resolveCliOptions — --replay/--all são flags booleanas", () => {
  it("--replay --all --editions-dir X", () => {
    const o = resolveCliOptions(["--replay", "--all", "--editions-dir", "/x"], "/repo");
    assert.equal(o.replayMode, true);
    assert.equal(o.replayAll, true);
    assert.equal(o.editionsDir, "/x");
  });
  it("sem flags: replay desligado", () => {
    const o = resolveCliOptions([], "/repo");
    assert.equal(o.replayMode, false);
    assert.equal(o.replayAll, false);
  });
});
