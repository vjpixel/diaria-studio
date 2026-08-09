/**
 * test/generate-hub-sources.test.ts (#4558 Parte A)
 *
 * Cobre a parte PURA de `scripts/generate-hub-sources.ts` (`collectHubSources`)
 * — sem tocar `data/beehiiv-cache/`. Cobre em particular o achado ao vivo da
 * sessão que implementou o hub Anthropic/Claude: o cache Beehiiv guarda
 * texto em NFD (acento como combining mark separado) — `stripAccents()` é
 * defensiva aqui (o `PATTERN` de teste abaixo tem um termo acentuado de
 * propósito, pra realmente exercitar o caminho que `HUB_KEYWORD_PATTERNS`
 * de produção hoje não exercita — ver nota do módulo sob teste). Também
 * cobre o achado do fleet review da PR: post confirmado e casado mas sem
 * `slug`/`publish_date` resolvível vira WARNING, nunca um drop mudo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { collectHubSources } from "../scripts/generate-hub-sources.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";

// Termo acentuado ("análise") de propósito — diferente de HUB_KEYWORD_PATTERNS
// de produção (sem acento), isso garante que o teste de NFD abaixo realmente
// dependeria de `stripAccents()` pra passar, não passaria de qualquer jeito.
const PATTERN = /anthropic|\bclaude\b|\bopus\b|análise/i;

describe("collectHubSources (#4558 Parte A)", () => {
  it("casa mesmo quando o texto vem em NFD (combining mark separado) — regression do achado ao vivo", () => {
    // "á" armazenado como "a" + U+0301 (combining acute), igual ao cache real.
    const nfdTitle = "Claude submetido a análise psicológica".normalize("NFD");
    const posts: RawCachedPost[] = [
      { slug: "edicao-nfd", title: nfdTitle, status: "confirmed", publish_date: Date.UTC(2026, 3, 9, 18) / 1000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matchedHeadlines.length, 1);
  });

  it("ignora posts não confirmados (draft)", () => {
    const posts: RawCachedPost[] = [
      { slug: "rascunho", title: "Anthropic lança algo", status: "draft", publish_date: 1753000000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows, []);
    assert.deepEqual(warnings, []);
  });

  it("post confirmado e casado sem slug vira warning, não drop mudo", () => {
    const posts: RawCachedPost[] = [
      { title: "Anthropic lança algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sem slug resolvível/);
  });

  it("post confirmado e casado sem publish_date vira warning, não drop mudo (e não entra com date vazio)", () => {
    const posts: RawCachedPost[] = [{ slug: "sem-data", title: "Claude faz algo", status: "confirmed" }];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sem publish_date/);
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
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].matchedHeadlines, ["Anthropic lança Claude Opus 5"]);
  });

  it("url usa o domínio de marca diar.ia.br, não o slug bruto do Beehiiv", () => {
    const posts: RawCachedPost[] = [
      { slug: "meu-slug", title: "Claude faz algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.equal(rows[0].url, "https://diar.ia.br/p/meu-slug");
    assert.equal(rows[0].editionSlug, "meu-slug");
  });

  it("ordena por data crescente", () => {
    const posts: RawCachedPost[] = [
      { slug: "b", title: "Claude B", status: "confirmed", publish_date: Date.UTC(2026, 5, 1, 18) / 1000 },
      { slug: "a", title: "Claude A", status: "confirmed", publish_date: Date.UTC(2026, 0, 1, 18) / 1000 },
    ];
    const { rows } = collectHubSources(posts, PATTERN);
    assert.deepEqual(
      rows.map((r) => r.editionSlug),
      ["a", "b"],
    );
  });

  it("mistura de posts válidos e inválidos: só os válidos entram em rows, cada inválido gera 1 warning", () => {
    const posts: RawCachedPost[] = [
      { slug: "valido", title: "Claude válido", status: "confirmed", publish_date: Date.UTC(2026, 0, 1, 18) / 1000 },
      { title: "Claude sem slug", status: "confirmed", publish_date: 1753000000 },
      { slug: "sem-data", title: "Claude sem data", status: "confirmed" },
      { slug: "irrelevante", title: "Google lança algo", status: "confirmed", publish_date: 1753000000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].editionSlug, "valido");
    assert.equal(warnings.length, 2);
  });
});

describe("collectHubSources — propagação do override de data (#4803)", () => {
  it("um override presente e válido vence o publish_date bruto na entrada final", () => {
    const posts: RawCachedPost[] = [
      {
        slug: "edicao-antiga",
        title: "Anthropic lança algo antigo",
        status: "confirmed",
        publish_date: Date.UTC(2025, 8, 3, 18, 0, 0) / 1000,
      },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN, {
      overrides: { "edicao-antiga": "2025-06-15" },
      discarded: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2025-06-15");
    assert.deepEqual(warnings, []);
  });

  it("overridesResult.error vira warning visível, sem bloquear o resto do processamento", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-x", title: "Claude X", status: "confirmed", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { rows, warnings } = collectHubSources(posts, PATTERN, {
      overrides: {},
      error: "Unexpected end of JSON input",
      discarded: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-07-01");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /malformado/);
  });

  it("overridesResult.discarded (entrada de formato inválido) vira warning visível", () => {
    const posts: RawCachedPost[] = [
      { slug: "edicao-y", title: "Claude Y", status: "confirmed", publish_date: Date.UTC(2026, 6, 1, 18) / 1000 },
    ];
    const { warnings } = collectHubSources(posts, PATTERN, {
      overrides: {},
      discarded: [`slug "edicao-y": valor de override inválido (esperado "YYYY-MM-DD", recebido "")`],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /edicao-y/);
  });
});
