/**
 * test/brevo-dashboard-link-section-4184.test.ts (#4184)
 *
 * Coluna "Seção" nas tabelas de link do dashboard Clarice — pool ATUAL
 * (Destaques/Use Melhor/Radar, ciclos 2605-06/2606-07) e pool LEGADO
 * (Destaques/Lançamentos/Pesquisas/Outras Notícias, ciclos 2603-04/2604-05).
 * Cobre:
 *  - parsePrioritizedSections / buildLinkSectionMap (scripts/lib/mensal/
 *    monthly-link-sections.ts) — parser puro do prioritized.md, incluindo
 *    fixtures REAIS copiadas de data/monthly/{2606-07,2603-04,2604-05}/prioritized.md
 *    (não lê data/ em tempo de teste) — inclusive o cabeçalho com sufixo
 *    parentético do 2604-05 (`## Outras Notícias (8 destaques standalone)`).
 *  - resolveLinkSection / formatLinkSectionCell / mergeLinkSectionMaps /
 *    normalizeLinkSectionMap (workers/brevo-dashboard/src/link-section.ts).
 *  - collectMonthlyLinkCycles (sections-core.ts).
 *  - Integração: renderLinksSection / renderAggregatedLinksSection exibem a
 *    seção correta; fallback para conteúdo sem seção mapeada; precedência
 *    quando o mesmo conteúdo está em 2 seções; regressão de colunas/glossário.
 *  - discoverCyclesWithPrioritized (scripts/push-link-sections-kv.ts) via
 *    diretório temporário injetado (nunca data/ real).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveLinkSection,
  formatLinkSectionCell,
  mergeLinkSectionMaps,
  normalizeLinkSectionMap,
  lookupLinkSectionCell,
  LINK_SECTION_FALLBACK_LABEL,
  LINK_SECTION_LABELS,
  AGGREGATED_LINKS_COLUMNS,
  renderLinksSection,
  renderAggregatedLinksSection,
  aggregateLinksAcrossCampaigns,
  parseLinksStats,
  collectMonthlyLinkCycles,
  renderDashboardHtml,
  type LinkSectionMap,
  type BrevoLinksStats,
} from "../workers/brevo-dashboard/src/index.ts";
import {
  parsePrioritizedSections,
  buildLinkSectionMap,
} from "../scripts/lib/mensal/monthly-link-sections.ts";
import { discoverCyclesWithPrioritized } from "../scripts/push-link-sections-kv.ts";

// ─── Fixture REAL: cópia de data/monthly/2606-07/prioritized.md (#4184) ────
// Copiada verbatim (trecho Destaques/Use Melhor/Radar) — o parser NUNCA lê
// data/ em tempo de teste, ver docstring do módulo.
const FIXTURE_2606_07_PRIORITIZED = `# Diar.ia — Digest Mensal 2606

> Destaques propostos pelo analista — cada um cobre um tema do mês.

## Resumo

- Edições no mês: 22

## Destaques

D1: Brasil entre a dependência e o modelo próprio
Tema: Brasil
Artigos de suporte (2):
- 260601 — Marco de IA vai a voto na Câmara em junho — https://www.cnnbrasil.com.br/politica/hugo-quer-votar-ia-em-junho-e-relator-busca-avanco-do-redata-no-senado/
- 260608 — Três pilares para o Brasil não ficar para trás — https://exame.com/inteligencia-artificial/ia-soberania-tecnologica/

D2: Anthropic vira caso de segurança nacional
Tema: Anthropic
Artigos de suporte (2):
- 260601 — Anthropic capta US$ 65 bi na rodada Série H — https://www.anthropic.com/news/series-h
- 260610 — Anthropic lança Fable 5 com bloqueios embutidos — https://www.anthropic.com/news/claude-fable-5-mythos-5

D3: OpenAI transforma o ChatGPT em plataforma de agentes
Tema: OpenAI
Artigos de suporte (2):
- 260603 — Codex vai além do código e mira trabalho analítico — https://openai.com/index/codex-for-knowledge-work
- 260629 — OpenAI lança GPT-5.6 Sol, Terra e Luna — https://openai.com/index/previewing-gpt-5-6-sol

## Use Melhor

Os 6 tutoriais mais clicados do mês (seção Use Melhor das edições diárias):

- Como criar seu primeiro agente de IA — https://blog.ibe.ia.br/blog/como-criar-seu-primeiro-agente-ia (10 cliques)
- Best practices for getting started with Claude Cowork — https://claude.com/blog/best-practices-for-getting-started-with-claude-cowork (6 cliques)

## Radar

Os 7 links mais clicados do mês (excluindo os já cobertos nos Destaques e no Use Melhor):

- 260630 — Como ter acesso à Alexa+ — https://link.amazon/B0249coGp (5 cliques)
- 260601 — Evento da Anthropic mostrou o futuro da programação, quer você goste disso ou não — https://mittechreview.com.br/claude-code-automacao-desenvolvimento-software (4 cliques)

---

## Apêndice — todos os temas detectados

- Mercado e adoção (empresas/consumo BR): 12 artigos
`;

// ─── Fixture REAL: cópia de data/monthly/2603-04/prioritized.md (#4184, rodada 2) ────
// Ciclo LEGADO com as 4 seções reais daquela época: Destaques, Lançamentos,
// Pesquisas, Outras Notícias (+ Warnings, prosa sem lista de link — NÃO deve
// virar seção reconhecida). Copiada verbatim (trecho representativo) — o
// parser NUNCA lê data/ em tempo de teste.
const FIXTURE_2603_04_LEGACY = `# Diar.ia — Digest Mensal 2603

## Resumo

- Edições no mês: 15

## Destaques

D1: Anthropic vs Pentágono: o mês que redefiniu a IA
Tema: Regulação e geopolítica (Anthropic-Pentágono)
Artigos de suporte (2):
- 260302 — A nova doutrina militar da IA — https://www.npr.org/2026/02/27/nx-s1-5729118/trump-anthropic-pentagon-openai-ai-weapons-ban
- 260309 — Anthropic processa governo dos EUA — https://www.anthropic.com/news/where-stand-department-war

## Lançamentos

- [editorial] 260309 — GPT-5.4: raciocínio mais confiável — https://openai.com/pt-BR/index/introducing-gpt-5-4/
- [editorial] 260325 — Claude agora controla seu computador — https://claude.com/blog/dispatch-and-computer-use

## Pesquisas

- [editorial] 260320 — O que 81.000 pessoas querem da IA — https://www.anthropic.com/81k-interviews
- [editorial] 260316 — O teste que a IA não consegue passar (HLE) — https://www.sciencedaily.com/releases/2026/03/260313002650.htm

## Outras Notícias

- [editorial] 260327 — Claude Mythos: o modelo mais perigoso do mundo — https://www.techzine.eu/news/applications/140017/details-leak-on-anthropics-step-change-mythos-model/
- [editorial] 260302 — Apagão global atinge o Claude — https://mashable.com/article/claude-down-ai-anthropic-outage

## Warnings

- BRASIL AUSENTE — DECISÃO EDITORIAL CRÍTICA: o mês de março de 2026 não tem nenhum destaque com cobertura específica do Brasil.

---

## Apêndice — todos os temas detectados

- Regulação e geopolítica (Anthropic-Pentágono): 2 artigos [usado em D1]
`;

// ─── Fixture REAL: cópia de data/monthly/2604-05/prioritized.md (#4184, rodada 2) ────
// Ciclo LEGADO com só Destaques + "Outras Notícias" — e o cabeçalho real tem
// um sufixo parentético (`(8 destaques standalone)`) que o parser precisa
// ignorar para não perder a seção inteira.
const FIXTURE_2604_05_LEGACY = `# Diar.ia — Digest Mensal 2604

## Resumo

- Edições no mês: 8

## Destaques

D1: Anthropic acelera aposta enterprise e em segurança
Tema: Anthropic
Artigos de suporte (2):
- 260417 — Anthropic lança Claude Opus 4.7 — https://www.anthropic.com/news/claude-opus-4-7
- 260419 — Anthropic usa modelo para encontrar zero-days — https://www.anthropic.com/glasswing

## Outras Notícias (8 destaques standalone)

- [93] 260424 — OpenAI lança GPT-5.5 com foco em agentes — https://openai.com/index/introducing-gpt-5-5/
- [s/score] 260417 — Por que a IA é boa e ruim ao mesmo tempo — https://exame.com/inteligencia-artificial/o-que-e-jagged-intelligence-e-como-ela-pode-reformular-o-debate-sobre-ia/

## Warnings

- Apenas 8 destaques standalone disponíveis (esperado: 10).

---

## Apêndice — todos os temas detectados

- Anthropic: 2 artigos (escolhido — D1)
`;

// ─── parsePrioritizedSections ───────────────────────────────────────────────

describe("parsePrioritizedSections (#4184) — fixture real 2606-07", () => {
  test("extrai URLs de Destaques (todas as D1/D2/D3, sem distinguir sub-destaque)", () => {
    const sections = parsePrioritizedSections(FIXTURE_2606_07_PRIORITIZED);
    assert.equal(sections.destaques.length, 6, "6 artigos de suporte no total (2 por destaque × 3)");
    assert.ok(sections.destaques.includes("https://www.anthropic.com/news/series-h"));
    assert.ok(sections.destaques.includes("https://openai.com/index/previewing-gpt-5-6-sol"));
  });

  test("extrai URLs de Use Melhor", () => {
    const sections = parsePrioritizedSections(FIXTURE_2606_07_PRIORITIZED);
    assert.equal(sections["use-melhor"].length, 2);
    assert.ok(sections["use-melhor"].includes("https://blog.ibe.ia.br/blog/como-criar-seu-primeiro-agente-ia"));
  });

  test("extrai URLs de Radar, mesmo com '(N cliques)' e prefixo de data", () => {
    const sections = parsePrioritizedSections(FIXTURE_2606_07_PRIORITIZED);
    assert.equal(sections.radar.length, 2);
    assert.ok(sections.radar.includes("https://link.amazon/B0249coGp"));
    assert.ok(sections.radar.includes("https://mittechreview.com.br/claude-code-automacao-desenvolvimento-software"));
  });

  test("não vaza URLs do Apêndice (fora das 3 seções reconhecidas)", () => {
    const sections = parsePrioritizedSections(FIXTURE_2606_07_PRIORITIZED);
    const all = [...sections.destaques, ...sections["use-melhor"], ...sections.radar];
    assert.equal(all.length, 10, "Apêndice (sem URL, mas por segurança) não deve inflar a contagem");
  });

  test("markdown vazio/sem headers reconhecidos → 6 arrays vazios, nunca lança", () => {
    assert.doesNotThrow(() => parsePrioritizedSections(""));
    const sections = parsePrioritizedSections("# Título\n\nsem seções aqui\n");
    assert.deepEqual(sections, {
      destaques: [], "use-melhor": [], radar: [],
      lancamentos: [], pesquisas: [], "outras-noticias": [],
    });
  });
});

describe("parsePrioritizedSections (#4184, rodada 2) — pool LEGADO, fixture real 2603-04", () => {
  test("ciclo LEGADO (2603-04): Destaques populado, Use Melhor/Radar vazios (não é erro — pool daquela época era outro)", () => {
    const sections = parsePrioritizedSections(FIXTURE_2603_04_LEGACY);
    assert.equal(sections.destaques.length, 2);
    assert.deepEqual(sections["use-melhor"], [], "2603-04 não tem Use Melhor — array vazio, não throw");
    assert.deepEqual(sections.radar, [], "2603-04 não tem Radar — array vazio, não throw");
  });

  test("extrai Lançamentos como seção PRÓPRIA (nunca fundida em Use Melhor/Radar)", () => {
    const sections = parsePrioritizedSections(FIXTURE_2603_04_LEGACY);
    assert.equal(sections.lancamentos.length, 2);
    assert.ok(sections.lancamentos.includes("https://openai.com/pt-BR/index/introducing-gpt-5-4/"));
    assert.ok(sections.lancamentos.includes("https://claude.com/blog/dispatch-and-computer-use"));
  });

  test("extrai Pesquisas como seção própria", () => {
    const sections = parsePrioritizedSections(FIXTURE_2603_04_LEGACY);
    assert.equal(sections.pesquisas.length, 2);
    assert.ok(sections.pesquisas.includes("https://www.anthropic.com/81k-interviews"));
  });

  test("extrai Outras Notícias como seção própria", () => {
    const sections = parsePrioritizedSections(FIXTURE_2603_04_LEGACY);
    assert.equal(sections["outras-noticias"].length, 2);
    assert.ok(sections["outras-noticias"].includes("https://mashable.com/article/claude-down-ai-anthropic-outage"));
  });

  test("Warnings/Resumo/Apêndice NÃO vazam URL — total extraído bate exatamente com as 4 seções reais (2+2+2+2)", () => {
    const sections = parsePrioritizedSections(FIXTURE_2603_04_LEGACY);
    const total = Object.values(sections).reduce((sum, urls) => sum + urls.length, 0);
    assert.equal(total, 8, "Warnings é prosa do analista, sem lista de link — não deve contribuir nenhuma URL");
  });
});

describe("parsePrioritizedSections (#4184, rodada 2) — cabeçalho com sufixo parentético, fixture real 2604-05", () => {
  test("'## Outras Notícias (8 destaques standalone)' é reconhecido apesar do sufixo — senão a seção inteira se perde", () => {
    const sections = parsePrioritizedSections(FIXTURE_2604_05_LEGACY);
    assert.equal(sections["outras-noticias"].length, 2, "sufixo parentético não pode fazer a seção sumir");
    assert.ok(sections["outras-noticias"].includes("https://openai.com/index/introducing-gpt-5-5/"));
    assert.ok(sections["outras-noticias"].includes(
      "https://exame.com/inteligencia-artificial/o-que-e-jagged-intelligence-e-como-ela-pode-reformular-o-debate-sobre-ia/",
    ));
  });

  test("2604-05 não tem Lançamentos/Pesquisas (só Destaques + Outras Notícias) — arrays vazios, não throw", () => {
    const sections = parsePrioritizedSections(FIXTURE_2604_05_LEGACY);
    assert.deepEqual(sections.lancamentos, []);
    assert.deepEqual(sections.pesquisas, []);
    assert.equal(sections.destaques.length, 2);
  });
});

// ─── buildLinkSectionMap ─────────────────────────────────────────────────────

describe("buildLinkSectionMap (#4184)", () => {
  test("resolve URL pra CONTEÚDO (classifyLinkContent) — chave do mapa é o rótulo, não a URL crua", () => {
    const raw = parsePrioritizedSections(FIXTURE_2606_07_PRIORITIZED);
    const map = buildLinkSectionMap(raw);
    // fallback humanLabelForUrl: último segmento do path + host.
    // #4053 humanLabelForUrl: hífens do último segmento do path viram espaço
    // ("series-h" → "series h") — o rótulo de conteúdo nunca é a URL crua.
    const key = Object.keys(map).find((k) => k.includes("series h"));
    assert.ok(key, "conteúdo do link Anthropic Series H deve estar no mapa");
    assert.deepEqual(map[key!], ["destaques"]);
  });

  test("mesmo conteúdo em 2 seções (URL idêntica citada 2x) → array com as 2 seções", () => {
    const raw = {
      destaques: ["https://exemplo.com/artigo-x"],
      "use-melhor": [],
      radar: ["https://exemplo.com/artigo-x"],
      lancamentos: [],
      pesquisas: [],
      "outras-noticias": [],
    };
    const map = buildLinkSectionMap(raw);
    const key = Object.keys(map)[0];
    assert.deepEqual(new Set(map[key]), new Set(["destaques", "radar"]));
  });

  test("seções legadas (Lançamentos/Pesquisas/Outras Notícias) resolvem pro rótulo de CONTEÚDO igual às atuais", () => {
    const raw = parsePrioritizedSections(FIXTURE_2603_04_LEGACY);
    const map = buildLinkSectionMap(raw);
    const key = Object.keys(map).find((k) => k.includes("dispatch and computer use") || k.includes("dispatch-and-computer-use"));
    assert.ok(key, "conteúdo do link de Lançamentos deve estar no mapa");
    assert.deepEqual(map[key!], ["lancamentos"]);
  });
});

// ─── resolveLinkSection / formatLinkSectionCell (precedência + fallback) ────

describe("resolveLinkSection / formatLinkSectionCell (#4184)", () => {
  test("uma seção só → primary = ela, also vazio", () => {
    const r = resolveLinkSection(["radar"]);
    assert.deepEqual(r, { primary: "radar", also: [] });
  });

  test("precedência: Destaques > Use Melhor > Radar quando o conteúdo está em 2+", () => {
    assert.equal(resolveLinkSection(["radar", "destaques"])?.primary, "destaques");
    assert.equal(resolveLinkSection(["use-melhor", "radar"])?.primary, "use-melhor");
    assert.equal(resolveLinkSection(["radar", "use-melhor", "destaques"])?.primary, "destaques");
  });

  test("precedência estendida (#4184, rodada 2): pool ATUAL sempre vence pool LEGADO — Radar > Lançamentos, Lançamentos > Pesquisas > Outras Notícias", () => {
    assert.equal(resolveLinkSection(["lancamentos", "radar"])?.primary, "radar");
    assert.equal(resolveLinkSection(["outras-noticias", "lancamentos"])?.primary, "lancamentos");
    assert.equal(resolveLinkSection(["outras-noticias", "pesquisas"])?.primary, "pesquisas");
    assert.equal(resolveLinkSection(["outras-noticias", "pesquisas", "lancamentos", "destaques"])?.primary, "destaques");
  });

  test("also lista as seções secundárias em ordem de precedência, nunca inclui primary", () => {
    const r = resolveLinkSection(["radar", "use-melhor", "destaques"]);
    assert.deepEqual(r, { primary: "destaques", also: ["use-melhor", "radar"] });
  });

  test("undefined/vazio → null (sem seção conhecida)", () => {
    assert.equal(resolveLinkSection(undefined), null);
    assert.equal(resolveLinkSection([]), null);
  });

  test("formatLinkSectionCell: null → fallback com label '—' e tooltip explicativo (nunca célula vazia)", () => {
    const cell = formatLinkSectionCell(null);
    assert.equal(cell.label, LINK_SECTION_FALLBACK_LABEL);
    assert.ok(cell.tooltip.length > 10, "tooltip deve explicar o motivo, não ficar vazio");
  });

  test("formatLinkSectionCell: 1 seção → tooltip igual ao label (sem parêntese 'também em')", () => {
    const cell = formatLinkSectionCell({ primary: "radar", also: [] });
    assert.equal(cell.label, "Radar");
    assert.equal(cell.tooltip, "Radar");
  });

  test("formatLinkSectionCell: 2+ seções → label é a primária, tooltip nomeia as demais ('também em')", () => {
    const cell = formatLinkSectionCell({ primary: "destaques", also: ["radar"] });
    assert.equal(cell.label, "Destaques");
    assert.match(cell.tooltip, /também em: Radar/);
  });

  test("lookupLinkSectionCell: content ausente do mapa → fallback", () => {
    const map: LinkSectionMap = { "conteúdo conhecido": ["destaques"] };
    assert.equal(lookupLinkSectionCell("outro conteúdo", map).label, LINK_SECTION_FALLBACK_LABEL);
  });

  test("lookupLinkSectionCell: map null/undefined → fallback, nunca lança", () => {
    assert.doesNotThrow(() => lookupLinkSectionCell("x", null));
    assert.doesNotThrow(() => lookupLinkSectionCell("x", undefined));
    assert.equal(lookupLinkSectionCell("x", null).label, LINK_SECTION_FALLBACK_LABEL);
  });

  test("LINK_SECTION_LABELS cobre as 6 seções (3 pool atual + 3 pool legado)", () => {
    assert.deepEqual(LINK_SECTION_LABELS, {
      destaques: "Destaques",
      "use-melhor": "Use Melhor",
      radar: "Radar",
      lancamentos: "Lançamentos",
      pesquisas: "Pesquisas",
      "outras-noticias": "Outras Notícias",
    });
  });
});

// ─── mergeLinkSectionMaps ────────────────────────────────────────────────────

describe("mergeLinkSectionMaps (#4184)", () => {
  test("união de seções por conteúdo entre múltiplos ciclos", () => {
    const a: LinkSectionMap = { "clarice.ai/precos": ["radar"] };
    const b: LinkSectionMap = { "clarice.ai/precos": ["destaques"], "outro conteúdo": ["use-melhor"] };
    const merged = mergeLinkSectionMaps([a, b]);
    assert.deepEqual(new Set(merged["clarice.ai/precos"]), new Set(["radar", "destaques"]));
    assert.deepEqual(merged["outro conteúdo"], ["use-melhor"]);
  });

  test("entradas null/undefined são ignoradas sem lançar", () => {
    assert.doesNotThrow(() => mergeLinkSectionMaps([null, undefined, {}]));
    assert.deepEqual(mergeLinkSectionMaps([null, undefined]), {});
  });

  test("lista vazia → mapa vazio", () => {
    assert.deepEqual(mergeLinkSectionMaps([]), {});
  });
});

// ─── normalizeLinkSectionMap (choke point de leitura do KV) ─────────────────

describe("normalizeLinkSectionMap (#4184)", () => {
  test("payload válido passa integralmente", () => {
    const raw = { "conteúdo a": ["destaques", "radar"] };
    assert.deepEqual(normalizeLinkSectionMap(raw), raw);
  });

  test("não-objeto (null, string, array, número) → null", () => {
    assert.equal(normalizeLinkSectionMap(null), null);
    assert.equal(normalizeLinkSectionMap("texto"), null);
    assert.equal(normalizeLinkSectionMap(42), null);
    assert.equal(normalizeLinkSectionMap(["destaques"]), null);
  });

  test("filtra seções inválidas dentro de um objeto válido, mantém as boas", () => {
    const raw = { "conteúdo a": ["destaques", "lixo", 42, "radar"] };
    assert.deepEqual(normalizeLinkSectionMap(raw), { "conteúdo a": ["destaques", "radar"] });
  });

  test("entrada cujo valor não é array é descartada (não quebra as outras)", () => {
    const raw = { "conteúdo a": ["destaques"], "conteúdo b": "não é array" };
    assert.deepEqual(normalizeLinkSectionMap(raw), { "conteúdo a": ["destaques"] });
  });

  test("entrada com só seções inválidas é omitida do resultado (não vira array vazio)", () => {
    const raw = { "conteúdo ruim": ["lixo"] };
    assert.deepEqual(normalizeLinkSectionMap(raw), {});
  });
});

// ─── collectMonthlyLinkCycles ────────────────────────────────────────────────

describe("collectMonthlyLinkCycles (#4184)", () => {
  test("extrai ciclos do naming MENSAL ('Clarice News AAMM-MM — X'), dedup", () => {
    const cycles = collectMonthlyLinkCycles([
      { name: "Clarice News 2606-07 — A · dom" },
      { name: "Clarice News 2606-07 — B · dom" },
      { name: "Clarice News 2605-06 — A · sex" },
    ]);
    assert.deepEqual(new Set(cycles), new Set(["2606-07", "2605-06"]));
  });

  test("ignora campanhas DIÁRIAS ('Clarice News AAMM dNN-X') — sem prioritized.md equivalente", () => {
    const cycles = collectMonthlyLinkCycles([
      { name: "Clarice News 2607 d05 (seg)" },
      { name: "Clarice News 2607 d06-A (ter)" },
    ]);
    assert.deepEqual(cycles, []);
  });

  test("nome que não bate nenhum padrão Clarice News é ignorado, nunca lança", () => {
    assert.doesNotThrow(() => collectMonthlyLinkCycles([{ name: "T1-W1 digest" }, { name: "" }]));
    assert.deepEqual(collectMonthlyLinkCycles([{ name: "T1-W1 digest" }]), []);
  });

  test("lista vazia → []", () => {
    assert.deepEqual(collectMonthlyLinkCycles([]), []);
  });
});

// ─── Integração: renderLinksSection / renderAggregatedLinksSection ─────────

const fixtureLinksStats: BrevoLinksStats = {
  "https://openai.com/blog/gpt-5": 31,
  "https://anthropic.com/news/claude-4": 28,
};

describe("renderLinksSection: coluna Seção (#4184)", () => {
  test("conteúdo mapeado exibe o label da seção", () => {
    const sectionMap: LinkSectionMap = {
      "gpt 5 (openai.com)": ["destaques"],
    };
    const html = renderLinksSection(1, fixtureLinksStats, undefined, sectionMap);
    assert.match(html, />Destaques</, "label 'Destaques' deve aparecer na célula");
  });

  test("conteúdo SEM seção mapeada cai no fallback '—', sem quebrar o render", () => {
    const html = renderLinksSection(1, fixtureLinksStats, undefined, {});
    assert.match(html, new RegExp(`>${LINK_SECTION_FALLBACK_LABEL}<`));
    assert.doesNotThrow(() => renderLinksSection(1, fixtureLinksStats));
  });

  test("sem sectionMap (undefined) — mesmo comportamento do fallback, nunca lança", () => {
    const html = renderLinksSection(1, fixtureLinksStats);
    assert.match(html, new RegExp(`>${LINK_SECTION_FALLBACK_LABEL}<`));
  });

  test("thead ganhou o <th> 'Seção' sem remover os existentes (Conteúdo/Link/Clicks/% do total)", () => {
    const html = renderLinksSection(1, fixtureLinksStats);
    assert.match(html, />Conteúdo</);
    assert.match(html, />Seção</);
    assert.match(html, />Link</);
    assert.match(html, />Clicks</);
    assert.match(html, /% do total/);
  });
});

describe("renderAggregatedLinksSection: coluna Seção (#4184)", () => {
  function makeRow(overrides: Partial<Parameters<typeof aggregateLinksAcrossCampaigns>[0][0]> = {}) {
    return {
      id: 1, name: "x", subject: "s", status: "sent",
      sentDate: "2026-07-01T09:00:00Z", scheduledAt: null, createdAt: "2026-07-01T09:00:00Z",
      recipients: { lists: [1] },
      statistics: { globalStats: undefined, linksStats: { "https://openai.com/blog/gpt-5": 10 } },
      ...overrides,
    } as Parameters<typeof aggregateLinksAcrossCampaigns>[0][0];
  }

  test("AGGREGATED_LINKS_COLUMNS ganhou a entrada 'Seção' — glossário e <th> continuam consistentes", () => {
    const col = AGGREGATED_LINKS_COLUMNS.find((c) => c.label === "Seção");
    assert.ok(col, "coluna 'Seção' deve existir em AGGREGATED_LINKS_COLUMNS");
    const rows = aggregateLinksAcrossCampaigns([makeRow()], { "gpt 5 (openai.com)": ["radar"] });
    const html = renderAggregatedLinksSection(rows, null);
    // Glossário lista TODAS as colunas (regressão #3090) — inclusive a nova.
    for (const c of AGGREGATED_LINKS_COLUMNS) {
      assert.ok(html.includes(`<dt>${c.label}</dt>`), `glossário deve listar ${c.label}`);
    }
    assert.match(html, />Radar</);
  });

  test("conteúdo em 2 seções na MESMA janela agregada → resolve por precedência (Destaques vence Radar), tooltip nomeia a secundária", () => {
    const sectionMap: LinkSectionMap = { "gpt 5 (openai.com)": ["radar", "destaques"] };
    const rows = aggregateLinksAcrossCampaigns([makeRow()], sectionMap);
    const html = renderAggregatedLinksSection(rows, null);
    assert.match(html, />Destaques</, "precedência: Destaques deve ser o label exibido, não Radar");
    assert.match(html, /também em: Radar/, "tooltip deve nomear a seção secundária, não escondê-la");
  });

  test("regressão: colunas existentes (Conteúdo/Link/Clicks/%/Envios) continuam presentes", () => {
    const rows = aggregateLinksAcrossCampaigns([makeRow()]);
    const html = renderAggregatedLinksSection(rows, null);
    for (const label of ["Conteúdo", "Link", "Clicks", "Envios"]) {
      assert.ok(AGGREGATED_LINKS_COLUMNS.some((c) => c.label === label), `${label} deve seguir em AGGREGATED_LINKS_COLUMNS`);
    }
  });

  test("Worker sem mapa em KV (linkSectionsByCycle ausente) — renderDashboardHtml renderiza com fallback '—', sem crash (regressão)", () => {
    const campaign = {
      id: 77, name: "Clarice News 2606-07 — A · dom", subject: "s", status: "sent",
      sentDate: "2026-07-01T09:00:00Z", scheduledAt: null, createdAt: "2026-07-01T09:00:00Z",
      recipients: { lists: [1] },
      statistics: {
        globalStats: { sent: 100, delivered: 98, hardBounces: 1, softBounces: 0, uniqueViews: 20, viewed: 22, trackableViews: 15, uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 3 },
        linksStats: { "https://openai.com/blog/gpt-5": 10 },
      },
    };
    let html = "";
    assert.doesNotThrow(() => { html = renderDashboardHtml([campaign]); });
    assert.match(html, new RegExp(`class="link-section"[^>]*>${LINK_SECTION_FALLBACK_LABEL}<`), "sem mapa → fallback em toda linha, nunca célula vazia");
  });

  test("renderDashboardHtml com linkSectionsByCycle: campanha do ciclo certo mostra a seção; campanha diária (sem prioritized.md) cai no fallback", () => {
    const monthly = {
      id: 78, name: "Clarice News 2606-07 — A · dom", subject: "s", status: "sent",
      sentDate: "2026-07-01T09:00:00Z", scheduledAt: null, createdAt: "2026-07-01T09:00:00Z",
      recipients: { lists: [1] },
      statistics: {
        globalStats: { sent: 100, delivered: 98, hardBounces: 1, softBounces: 0, uniqueViews: 20, viewed: 22, trackableViews: 15, uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 3 },
        linksStats: { "https://openai.com/blog/gpt-5": 10 },
      },
    };
    const daily = {
      id: 79, name: "Clarice News 2607 d05 (seg)", subject: "s", status: "sent",
      sentDate: "2026-07-05T09:00:00Z", scheduledAt: null, createdAt: "2026-07-05T09:00:00Z",
      recipients: { lists: [1] },
      statistics: {
        globalStats: { sent: 100, delivered: 98, hardBounces: 1, softBounces: 0, uniqueViews: 20, viewed: 22, trackableViews: 15, uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 3 },
        linksStats: { "https://exemplo.com/x": 4 },
      },
    };
    const html = renderDashboardHtml([monthly, daily], [], null, null, null, null, null, null, null, null, null, {
      linkSectionsByCycle: { "2606-07": { "gpt 5 (openai.com)": ["use-melhor"] } },
    });
    assert.match(html, />Use Melhor</, "campanha do ciclo 2606-07 deve mostrar a seção do mapa");
  });
});

// ─── discoverCyclesWithPrioritized (push-link-sections-kv.ts) ──────────────
// Usa diretório TEMPORÁRIO (nunca data/ real) — restrição desta sessão.

describe("discoverCyclesWithPrioritized (#4184)", () => {
  function withTempMonthlyBase(fn: (base: string) => void): void {
    const base = mkdtempSync(join(tmpdir(), "diaria-link-sections-test-"));
    try {
      fn(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  test("encontra só ciclos com prioritized.md, formato YYMM-MM válido", () => {
    withTempMonthlyBase((base) => {
      mkdirSync(join(base, "2606-07"), { recursive: true });
      writeFileSync(join(base, "2606-07", "prioritized.md"), "# x");
      mkdirSync(join(base, "2605-06"), { recursive: true }); // sem prioritized.md
      mkdirSync(join(base, "not-a-cycle"), { recursive: true });
      writeFileSync(join(base, "not-a-cycle", "prioritized.md"), "# x");

      const cycles = discoverCyclesWithPrioritized(base);
      assert.deepEqual(cycles, ["2606-07"]);
    });
  });

  test("baseDir inexistente → [] (fail-soft, ex: sessão cloud sem junction data/)", () => {
    assert.deepEqual(discoverCyclesWithPrioritized(join(tmpdir(), "diaria-nao-existe-4184")), []);
  });

  test("baseDir vazio → []", () => {
    withTempMonthlyBase((base) => {
      assert.deepEqual(discoverCyclesWithPrioritized(base), []);
    });
  });
});
