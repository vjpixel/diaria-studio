/**
 * test/aggregator-lists-parity.test.ts (#9746)
 *
 * Existem duas listas paralelas de agregadores:
 *   - `AGGREGATOR_HOSTS` + `AGGREGATOR_PATTERNS` em `scripts/lib/aggregators.ts`
 *     (safety net do dedup / review-use-melhor / validate-domains);
 *   - `AGGREGATOR_BLOCKLIST` em `scripts/lib/aggregator-blocklist.ts`
 *     (pre-flight de fontes no Stage 1, espelhada no `source-researcher.md`).
 *
 * O #9655 foi exatamente o drift entre elas (um domínio novo precisava entrar
 * nos dois lados à mão). Este teste trava a paridade, com as exceções
 * declaradas abaixo — cada uma com motivo.
 *
 * Há ainda uma 3ª lista relacionada, `AI_RELEVANT_DOMAINS`
 * (`scripts/lib/ai-relevance.ts`), que NÃO é de agregador (é o bypass do
 * filtro de relevância de IA), mas carrega as mesmas newsletters de roundup
 * de IA: a checagem é de inclusão (roundup ⊂ AI_RELEVANT_DOMAINS), não de
 * igualdade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGGREGATOR_HOSTS,
  AGGREGATOR_PATTERNS,
  isAggregator as isAggregatorDedup,
} from "../scripts/lib/aggregators.ts";
import {
  AGGREGATOR_BLOCKLIST,
  isAggregator as isAggregatorBlocklist,
} from "../scripts/lib/aggregator-blocklist.ts";
import { AI_RELEVANT_DOMAINS } from "../scripts/lib/ai-relevance.ts";

/**
 * Entradas `domain` do blocklist que NÃO entram em `AGGREGATOR_HOSTS`.
 * `perplexity.ai`: o blocklist tem o escape de fonte primária
 * (`research.perplexity.ai`, `/hub/`) que `aggregators.ts` não modela —
 * colocá-lo em `AGGREGATOR_HOSTS` derrubaria o blog oficial da Perplexity no
 * dedup.
 */
const BLOCKLIST_ONLY = new Set(["perplexity.ai"]);

/** Entradas de `AGGREGATOR_HOSTS` que não existem no blocklist. Hoje nenhuma. */
const HOSTS_ONLY = new Set<string>([]);

const blocklistDomains = AGGREGATOR_BLOCKLIST.filter((e) => e.type === "domain").map((e) =>
  e.pattern.toLowerCase(),
);
const blocklistPaths = AGGREGATOR_BLOCKLIST.filter((e) => e.type === "path_prefix").map((e) =>
  e.pattern.toLowerCase(),
);

describe("paridade AGGREGATOR_HOSTS × AGGREGATOR_BLOCKLIST (#9746)", () => {
  it("todo domínio do blocklist está em AGGREGATOR_HOSTS (ou é exceção declarada)", () => {
    const missing = blocklistDomains.filter(
      (d) => !AGGREGATOR_HOSTS.has(d) && !BLOCKLIST_ONLY.has(d),
    );
    assert.deepEqual(
      missing,
      [],
      `Domínios em aggregator-blocklist.ts ausentes de aggregators.ts: ${missing.join(", ")}`,
    );
  });

  it("todo host de AGGREGATOR_HOSTS está no blocklist (ou é exceção declarada)", () => {
    const known = new Set(blocklistDomains);
    const missing = [...AGGREGATOR_HOSTS].filter((h) => !known.has(h) && !HOSTS_ONLY.has(h));
    assert.deepEqual(
      missing,
      [],
      `Hosts em aggregators.ts ausentes de aggregator-blocklist.ts: ${missing.join(", ")}`,
    );
  });

  it("exceções declaradas continuam reais (sem exceção órfã)", () => {
    for (const d of BLOCKLIST_ONLY) {
      assert.ok(blocklistDomains.includes(d), `BLOCKLIST_ONLY órfã: ${d}`);
      assert.ok(!AGGREGATOR_HOSTS.has(d), `${d} entrou em AGGREGATOR_HOSTS — remover da exceção`);
    }
    for (const h of HOSTS_ONLY) {
      assert.ok(AGGREGATOR_HOSTS.has(h), `HOSTS_ONLY órfã: ${h}`);
    }
  });

  it("todo path_prefix do blocklist é coberto por AGGREGATOR_PATTERNS", () => {
    assert.ok(blocklistPaths.length > 0, "blocklist sem path_prefix — teste vazio");
    const uncovered = blocklistPaths.filter(
      (p) => !AGGREGATOR_PATTERNS.some((re) => re.test(p)) || !AGGREGATOR_PATTERNS.some((re) => re.test(p + "/x")),
    );
    assert.deepEqual(uncovered, [], `path_prefix sem regex correspondente: ${uncovered.join(", ")}`);
  });

  it("as duas libs concordam sobre um subdomínio de cada domínio listado", () => {
    // Fecha o item 4 da issue: o dedup comparava host exato e deixava passar
    // `news.bensbites.com`, que o pre-flight do blocklist já pegava.
    const divergent: string[] = [];
    for (const d of blocklistDomains) {
      if (BLOCKLIST_ONLY.has(d)) continue;
      const url = `https://news.${d}/p/x`;
      if (isAggregatorDedup(url) !== isAggregatorBlocklist(url).blocked) divergent.push(url);
    }
    assert.deepEqual(divergent, [], `Divergência de subdomínio: ${divergent.join(", ")}`);
  });
});

describe("aggregators.ts isAggregator — match de subdomínio (#9746)", () => {
  it("bloqueia subdomínio de host cadastrado", () => {
    assert.equal(isAggregatorDedup("https://news.bensbites.com/p/x"), true);
    assert.equal(isAggregatorDedup("https://mail.crescendo.ai/x"), true);
  });

  it("track.newsletter.7min.ai segue bloqueado (coberto por 7min.ai)", () => {
    assert.equal(isAggregatorDedup("https://track.newsletter.7min.ai/c/abc"), true);
  });

  it("sufixo textual sem ponto não casa", () => {
    assert.equal(isAggregatorDedup("https://fake-crescendo.ai/x"), false);
    assert.equal(isAggregatorDedup("https://sometechstartups.com/x"), false);
  });

  it("perplexity.ai não é bloqueado no dedup (exceção declarada)", () => {
    assert.equal(isAggregatorDedup("https://www.perplexity.ai/hub/blog/x"), false);
  });
});

describe("roundup de IA ⊂ AI_RELEVANT_DOMAINS (#9746, 3ª lista)", () => {
  it("toda newsletter de roundup do blocklist está no bypass de relevância de IA", () => {
    const roundups = AGGREGATOR_BLOCKLIST.filter((e) => e.category === "ai_roundup_newsletter").map(
      (e) => e.pattern.split("/")[0].toLowerCase(),
    );
    const missing = roundups.filter((d) => !AI_RELEVANT_DOMAINS.has(d));
    assert.deepEqual(missing, [], `Roundups ausentes de AI_RELEVANT_DOMAINS: ${missing.join(", ")}`);
  });
});
