/**
 * test/generate-hub-sources.test.ts (#4558 Parte A)
 *
 * Cobre a parte PURA de `scripts/generate-hub-sources.ts` (`collectHubSources`)
 * — sem tocar `data/beehiiv-cache/`. Cobre em particular o achado ao vivo da
 * sessão que implementou o hub Anthropic/Claude: o cache Beehiiv guarda
 * texto em NFD (acento como combining mark separado), então casar um regex
 * escrito com acento normal contra o texto CRU falha silenciosamente — a
 * função sob teste precisa normalizar (`stripAccents`) antes de comparar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { collectHubSources } from "../scripts/generate-hub-sources.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";

const PATTERN = /anthropic|\bclaude\b|\bopus\b/i;

describe("collectHubSources (#4558 Parte A)", () => {
  it("casa mesmo quando o texto vem em NFD (combining mark separado) — regression do achado ao vivo", () => {
    // "ç" armazenado como "c" + U+0327 (combining cedilla), igual ao cache real.
    const nfdTitle = "Anthropic lança fábrica de agentes".normalize("NFD");
    const posts: RawCachedPost[] = [
      { slug: "edicao-nfd", title: nfdTitle, status: "confirmed", publish_date: Date.UTC(2026, 3, 9, 18) / 1000 },
    ];
    const rows = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matchedHeadlines.length, 1);
  });

  it("ignora posts não confirmados (draft)", () => {
    const posts: RawCachedPost[] = [
      { slug: "rascunho", title: "Anthropic lança algo", status: "draft", publish_date: 1753000000 },
    ];
    assert.deepEqual(collectHubSources(posts, PATTERN), []);
  });

  it("ignora posts sem slug", () => {
    const posts: RawCachedPost[] = [
      { title: "Anthropic lança algo", status: "confirmed", publish_date: 1753000000 },
    ];
    assert.deepEqual(collectHubSources(posts, PATTERN), []);
  });

  it("só inclui os destaques (título/itens do subtítulo) que batem a palavra-chave, não a edição inteira", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-mista",
        title: "Google lança Gemini 4",
        subtitle: "Anthropic lança Claude Opus 5 | Meta compra startup",
        status: "confirmed",
        publish_date: Date.UTC(2026, 6, 27, 18) / 1000,
      },
    ];
    const rows = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].matchedHeadlines, ["Anthropic lança Claude Opus 5"]);
  });

  it("url usa o domínio de marca diar.ia.br, não o slug bruto do Beehiiv", () => {
    const posts: RawCachedPost[] = [
      { slug: "meu-slug", title: "Claude faz algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const rows = collectHubSources(posts, PATTERN);
    assert.equal(rows[0].url, "https://diar.ia.br/p/meu-slug");
  });

  it("ordena por data crescente", () => {
    const posts: RawCachedPost[] = [
      { slug: "b", title: "Claude B", status: "confirmed", publish_date: Date.UTC(2026, 5, 1, 18) / 1000 },
      { slug: "a", title: "Claude A", status: "confirmed", publish_date: Date.UTC(2026, 0, 1, 18) / 1000 },
    ];
    const rows = collectHubSources(posts, PATTERN);
    assert.deepEqual(
      rows.map((r) => r.slug),
      ["a", "b"],
    );
  });
});
