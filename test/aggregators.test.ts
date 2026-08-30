/**
 * test/aggregators.test.ts (#6440)
 *
 * `scripts/lib/aggregators.ts` (`isAggregator`) é o safety-net que dedup.ts,
 * review-use-melhor.ts e validate-domains.ts usam pra descartar URLs de
 * agregador/roundup. Não tinha teste dedicado até o #6440.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAggregator } from "../scripts/lib/aggregators.ts";

describe("isAggregator — hosts/patterns existentes", () => {
  it("bloqueia agregador clássico cadastrado", () => {
    assert.equal(isAggregator("https://crescendo.ai/some-article"), true);
  });

  it("bloqueia tldr.tech/ai por path prefix, mas não tldr.tech raiz", () => {
    assert.equal(isAggregator("https://tldr.tech/ai/2026-08-28"), true);
    assert.equal(isAggregator("https://tldr.tech/"), false);
  });

  it("URL inválida não é agregador (defensivo)", () => {
    assert.equal(isAggregator("not-a-url"), false);
  });

  it("domínio oficial comum não é agregador", () => {
    assert.equal(isAggregator("https://openai.com/index/gpt-5"), false);
  });
});

describe("isAggregator — *.beehiiv.com blanket block (#6440)", () => {
  // Caso real 260828: therundownai.beehiiv.com/p/... chegou ao USE MELHOR —
  // não batia nenhuma entrada individual de AGGREGATOR_HOSTS (só
  // theaipulse/agentpulse/aibreakfast estavam cadastrados à mão).
  it("bloqueia newsletter de terceiro hospedada na beehiiv, mesmo sem entrada cadastrada", () => {
    assert.equal(isAggregator("https://therundownai.beehiiv.com/p/some-post"), true);
  });

  it("bloqueia qualquer subdomínio novo de terceiro", () => {
    assert.equal(isAggregator("https://umnewsletterqualquer.beehiiv.com/p/x"), true);
  });

  // #6724: beehiiv.com/www.beehiiv.com é o domínio RAIZ (página de marketing/
  // referral da própria Beehiiv) — nunca hospeda newsletter de terceiro, só
  // subdomínios hospedam conteúdo roundup. Falso positivo real: o link de
  // disclosure `?via=Diaria` do nosso próprio bloco "PARA ENCERRAR" foi
  // bloqueado como agregador na edição 260830.
  it("NÃO bloqueia o domínio raiz beehiiv.com/www.beehiiv.com (nosso link de referral)", () => {
    assert.equal(isAggregator("https://beehiiv.com/p/whatever"), false);
    assert.equal(isAggregator("https://www.beehiiv.com?via=Diaria"), false);
  });

  it("NÃO bloqueia nosso próprio host legado na Beehiiv (diaria.beehiiv.com)", () => {
    assert.equal(isAggregator("https://diaria.beehiiv.com/p/260827"), false);
  });

  it("NÃO bloqueia o subdomínio de tracking do nosso próprio host (link.diaria.beehiiv.com)", () => {
    assert.equal(isAggregator("https://link.diaria.beehiiv.com/click/abc123"), false);
  });

  it("continua bloqueando as entradas *.beehiiv.com já cadastradas individualmente", () => {
    assert.equal(isAggregator("https://theaipulse.beehiiv.com/p/x"), true);
    assert.equal(isAggregator("https://agentpulse.beehiiv.com/p/x"), true);
    assert.equal(isAggregator("https://aibreakfast.beehiiv.com/p/x"), true);
  });
});
