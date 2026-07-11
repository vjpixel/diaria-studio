/**
 * test/link-ctr-categorize.test.ts (#1844)
 *
 * Characterization tests do classificador `categorize` — extraído de
 * build-link-ctr.ts pra scripts/lib/link-ctr-categorize.ts e ANTES sem teste
 * direto (era função não-exportada). Trava o comportamento atual (golden) pra
 * que a extração seja segura e futuras mudanças sejam intencionais.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize, resolveNewsletterSection } from "../scripts/lib/link-ctr-categorize.ts";

describe("categorize (#1844 — golden / characterization)", () => {
  const cases: Array<{ url: string; anchor?: string; section?: string; expected: string }> = [
    { url: "https://openai.com/index/gpt-5", anchor: "GPT-5", section: "LANÇAMENTOS", expected: "Lançamento" },
    { url: "https://arxiv.org/abs/2506.001", anchor: "novo paper", expected: "Pesquisa" },
    { url: "https://github.com/foo/bar", anchor: "repo", expected: "Ferramenta" },
    { url: "https://www.youtube.com/watch?v=abc", anchor: "vídeo", section: "VÍDEOS", expected: "Curiosidade" },
    { url: "https://techcrunch.com/2026/06/01/startup-raises", anchor: "startup levanta", expected: "Mercado" },
    { url: "https://example.com/random", expected: "Outro" },
  ];

  for (const c of cases) {
    it(`${c.url} → ${c.expected}`, () => {
      assert.equal(
        categorize(c.url, c.anchor ?? "", c.section ?? "", "", ""),
        c.expected,
      );
    });
  }

  it("retorna sempre uma string não-vazia (nunca undefined)", () => {
    assert.equal(typeof categorize("https://a.com/x"), "string");
    assert.ok(categorize("https://a.com/x").length > 0);
  });
});

// #3145: hosts adicionados via auditoria de código (sem acesso a dados reais
// de produção nesta sessão — worktree isolado, sem junction data/) pra
// reduzir o fallback 'Outro' no Top 10 de links mais clicados.
//
// Nota: hosts do grupo "Negócios" (linha ~600-847 de link-ctr-categorize.ts)
// não retornam o bucket 'Negócios' diretamente — caem em negociosSubcategory(),
// que sub-classifica por sinal textual (anchor/section/contexto). Sem sinal
// (anchor vazio) o default é 'Indústria' (mesmo comportamento de hosts já
// cobertos por esse bloco, ex: techcrunch.com no golden test acima com anchor
// "startup levanta" → 'Mercado'). Os casos abaixo cobrem ambos: o host cai no
// bloco certo (com anchor vazio → 'Indústria', prova que NÃO caiu em 'Outro')
// e, pra 1 exemplo, um anchor com sinal real prova a subcategorização.
describe("categorize (#3145 — novos hosts, reduz fallback 'Outro')", () => {
  const cases: Array<{ url: string; anchor?: string; expected: string }> = [
    // Regulação — veículos jurídicos/regulatórios BR (bucket direto, sem subcategoria)
    { url: "https://www.jota.info/tributos-e-empresas/ia", expected: "Regulação" },
    { url: "https://www.migalhas.com.br/quentes/ia-lgpd", expected: "Regulação" },
    { url: "https://www.conjur.com.br/2026-jun/decisao-ia", expected: "Regulação" },
    // Lançamento — empresas/ferramentas de IA nativas (bucket direto, isAiCompany)
    { url: "https://groq.com/blog/new-chip", expected: "Lançamento" },
    { url: "https://character.ai/new-feature", expected: "Lançamento" },
    { url: "https://you.com/search", expected: "Lançamento" },
    { url: "https://leonardo.ai/launch", expected: "Lançamento" },
    { url: "https://langchain.com/new-release", expected: "Lançamento" },
    // Negócios — veículos BR de grande porte (sem anchor → default 'Indústria',
    // prova que caem no bloco Negócios e não em 'Outro')
    { url: "https://www.estadao.com.br/economia/ia-startup", expected: "Indústria" },
    { url: "https://www.folha.uol.com.br/mercado/ia", expected: "Indústria" },
    { url: "https://valor.globo.com/empresas/materia-sobre-ia", expected: "Indústria" },
    // Negócios — veículos internacionais de tech/business
    { url: "https://www.semafor.com/article/ai-race", expected: "Indústria" },
    { url: "https://www.marketwatch.com/story/ai-stocks", expected: "Indústria" },
    { url: "https://www.macrumors.com/2026/06/apple-ai", expected: "Indústria" },
    // Negócios com sinal real de anchor → prova a subcategorização (mesmo padrão do golden test techcrunch.com)
    { url: "https://www.estadao.com.br/economia/startup-ia-2", anchor: "startup brasileira levanta rodada", expected: "Mercado" },
  ];

  for (const c of cases) {
    it(`${c.url}${c.anchor ? ` (anchor: "${c.anchor}")` : ""} → ${c.expected}`, () => {
      assert.equal(categorize(c.url, c.anchor ?? "", "", "", ""), c.expected);
    });
  }
});

describe("resolveNewsletterSection (#3145)", () => {
  const cases: Array<{ input: string; expected: string; note: string }> = [
    { input: "", expected: "", note: "heading vazio (post antigo pré-#3043) → ''" },
    { input: "RADAR", expected: "Radar", note: "seção secundária sem emoji" },
    { input: "📡 RADAR", expected: "Radar", note: "seção secundária com emoji" },
    { input: "🛠️ USE MELHOR", expected: "Use Melhor", note: "Use Melhor com emoji (formato real do CSV, cf. #3037)" },
    { input: "USE MELHOR", expected: "Use Melhor", note: "Use Melhor sem emoji" },
    { input: "🚀 LANÇAMENTOS", expected: "Lançamento", note: "plural com emoji" },
    { input: "🚀 LANÇAMENTO", expected: "Lançamento", note: "singular com emoji (1 item)" },
    { input: "📺 VÍDEOS", expected: "Vídeo", note: "plural" },
    { input: "📺 VÍDEO", expected: "Vídeo", note: "singular" },
    { input: "🔬 PESQUISAS", expected: "Radar", note: "alias legacy pré-#1569" },
    { input: "📰 OUTRAS NOTÍCIAS", expected: "Radar", note: "alias legacy pré-#1569" },
    { input: "REGULAÇÃO", expected: "Destaque", note: "categoria editorial de destaque (kicker = d.category), não colide com seção secundária" },
    { input: "NOTÍCIA", expected: "Destaque", note: "categoria editorial de destaque, não colide" },
    { input: "LANÇAMENTO", expected: "Lançamento", note: "limitação CONHECIDA e documentada: colide textualmente com a seção secundária LANÇAMENTOS singularizada (1 item) — ambíguo, resolve pra secundária por design (ver JSDoc)" },
    { input: "PESQUISA", expected: "Radar", note: "limitação CONHECIDA: colide com o alias legacy PESQUISAS (RADAR) singularizado — mesma classe de ambiguidade que LANÇAMENTO acima" },
    { input: "É IA?", expected: "Outro", note: "kicker sem link editorial relevante" },
    { input: "Divulgação", expected: "Outro", note: "kicker sem link editorial relevante (case-insensitive)" },
    { input: "Sorteio", expected: "Outro", note: "kicker sem link editorial relevante" },
    { input: "Para encerrar", expected: "Outro", note: "kicker sem link editorial relevante" },
  ];

  for (const c of cases) {
    it(`"${c.input}" → "${c.expected}" (${c.note})`, () => {
      assert.equal(resolveNewsletterSection(c.input), c.expected);
    });
  }

  it("qualquer categoria editorial de destaque não-enumerada ainda vira 'Destaque' (design: não enumera CATEGORY_EMOJI)", () => {
    assert.equal(resolveNewsletterSection("CONCEITO"), "Destaque");
    assert.equal(resolveNewsletterSection("OPINIÃO"), "Destaque");
    assert.equal(resolveNewsletterSection("BRASIL"), "Destaque");
  });
});
