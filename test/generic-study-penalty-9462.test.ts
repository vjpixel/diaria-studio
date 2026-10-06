/**
 * #9462 — penalidade de seleção de destaque para estudo/estatística ou case
 * corporativo genérico sem fato novo (decisão do editor de 05/10/2026).
 *
 * Textos REAIS das edições, rotulados pela decisão do editor no gate 4
 * (02-reviewed.md × top-3 do 01-categorized.json, casados por URL), não por
 * rótulo de agente (lição da #8412).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyGenericStudy,
  demoteGenericStudyHighlights,
  formatGenericStudyNote,
  type GenericStudyHighlight,
} from "../scripts/lib/generic-study-penalty.ts";
import {
  DEFAULT_CONFIG_PATH,
  readGenericStudyPenaltyConfig,
  runGenericStudyPenalty,
} from "../scripts/demote-generic-study-highlights.ts";

// Destaques que o editor TIROU (positivos) — 260915→261005 e anteriores.
const REMOVED_GENERIC: string[] = [
  "IA já devolve 5,4 horas por semana ao RH: potencial chega a 31% da jornada; revela estudo", // 260916
  "Vídeo: Inteligência artificial já decide quais currículos chegam aos recrutadores", // 260917
  "17,8% do mundo já usa IA no trabalho. Entenda onde o Brasil está nesse mapa", // 260921
  "Quase 70% dos médicos já usam IA, aponta estudo da MV - Saúde Digital News", // 260921
  "Grupo Sabin reduz em 25% o tempo de atendimento com uso de IA", // 260925
  "Como as PMEs da América Latina estão acelerando o crescimento com o Gemini Enterprise", // 260928
  "Depois do hype, o que sobra? O pragmatismo que está mudando o uso da IA nas empresas", // 260929
  "McDonald's adota IA para calcular preço de seus lanches; entenda estratégia", // 260930
  "Quase metade dos alunos no Brasil usa chatbots de IA para estudar; índice é maior que média global", // 260910
  "IA já domina a rotina dos funcionários, mas só 27% dos líderes confiam na própria empresa", // 260903
  "ChatGPT está mudando quem faz o quê nas empresas, aponta estudo da OpenAI", // 260807
  "Claude já escreve 80% do código da Anthropic e assusta a empresa", // 260609 — fatia do trabalho feita por IA
];

// Destaques que o editor MANTEVE ou PROMOVEU — não podem ser penalizados.
const KEPT_NOT_GENERIC: Array<[string, string | undefined]> = [
  // 3c: os dois itens BR com fato novo que o editor pôs no lugar.
  ["Veja como os agentes de IA podem ser o próximo grande salto de produtividade para empreendedores e profissionais autônomos", "radar"], // 260925 Empiricus
  ["Golpes com IA tornam voz e vídeo insuficientes para confirmar um Pix", "radar"], // 260930 piranot
  ["Quem sabe usar inteligência artificial ganha mais como freelancer? Os dados mostram", "radar"], // 260915
  ["IA já está mudando carreiras fora da tecnologia; veja quais habilidades ganham espaço", "radar"], // 260922
  ["iFood lança IA que ajuda restaurantes a vender mais e envia relatórios pelo WhatsApp", "radar"], // 260918
  ["Gemini invade três empresas reais durante teste de segurança", "radar"], // 260921
  ["IA já afeta empregabilidade e renda de jovens no Brasil, aponta estudo do FGV Ibre", "pesquisa"], // 260423
  ["'No one has done this in the wild': study observes AI replicate itself", undefined], // 260508
  ["Reddit, news outlets weigh cutting Google off as AI summaries kill traffic: report", "radar"], // 260724
  ["INTERPOL report finds AI linked to more than half of cybercrime in Africa", "radar"], // 260805
  ["Código IA acelera entregas e amplia instabilidade: planilhas ensinam cibersegurança", "radar"], // 260916
  ["40% das empresas podem desativar agentes de IA até 2027 por falhas de governança, aponta pesquisa", "radar"], // 261006
  ["Introducing Gemini 3.8 Live with Live Avatar", "lancamento"],
  ["Quase um Opus por uma fração do preço: novo Claude Sonnet 5.5 chega 30% mais barato", "radar"],
];

// Review da PR #9667 (alta): notícia concreta que a 1ª versão marcava como
// genérica — preço/limite, empresa de IA adotando algo, recurso chegando a
// usuários, "Pesquisa" como produto, % que não é de população, IA trapaceando.
const CONCRETE_NEWS: string[] = [
  "OpenAI reduz preço da API do GPT-5 em 80%",
  "Anthropic reduz limites de uso do Claude Code",
  "Apple adota Gemini na Siri",
  "Meta adota marca d'água em imagens geradas por IA",
  "ChatGPT ganha pesquisa profunda para todos os usuários",
  "Google leva Pesquisa com IA a mais 40 países",
  "Nvidia perde 17% do valor de mercado após DeepSeek",
  "Estudo da Anthropic: Claude aprende a trapacear em testes",
];

describe("classifyGenericStudy (#9462) — notícia concreta não é estudo genérico (review #9667)", () => {
  for (const title of CONCRETE_NEWS) {
    it(`não penaliza: ${title}`, () => {
      const v = classifyGenericStudy({ title, bucket: "radar" });
      assert.equal(v.generic, false, `sinais=${v.signals} vetos=${v.vetoes}`);
    });
  }

  it("preço do CLIENTE do case não absolve (McDonald's segue genérico)", () => {
    const v = classifyGenericStudy({ title: "McDonald's adota IA para calcular preço de seus lanches; entenda estratégia" });
    assert.equal(v.generic, true, `vetos=${v.vetoes}`);
  });

  it("OCDE como régua de comparação não vira decisão (260910 segue genérico)", () => {
    const v = classifyGenericStudy({
      title: "Quase metade dos alunos no Brasil usa chatbots de IA para estudar; índice é maior do que em países da OCDE",
    });
    assert.equal(v.generic, true, `vetos=${v.vetoes}`);
  });

  it("'eu' pronome não é a UE: só a sigla em maiúscula conta como ator", () => {
    assert.equal(classifyGenericStudy({ title: "Pesquisa: eu e mais 70% dos profissionais já usamos IA" }).generic, true);
    assert.equal(classifyGenericStudy({ title: "EU publica relatório sobre IA generativa" }).generic, false);
  });
});

describe("classifyGenericStudy (#9462) — instituição como ator é simétrica (review #9667)", () => {
  // Mesmo título, só a INSTITUIÇÃO muda — nacional, estrangeira, genérica.
  const INSTITUTIONS = [
    "STF",
    "ANPD",
    "Ministério da Saúde",
    "Senado",
    "Casa Branca",
    "FTC",
    "SEC",
    "Comissão Europeia",
    "Parlamento Europeu",
    "UE",
    "Governo",
    "Tribunal",
    "Agência reguladora",
    "Regulador",
    "Congresso",
  ];
  const TEMPLATES = [
    "{X} divulga relatório sobre IA",
    "{X} publica relatório sobre IA generativa",
    "{X} investiga estudo sobre chatbots e crianças",
  ];
  for (const tpl of TEMPLATES) {
    it(`mesmo veredito para toda instituição: "${tpl}"`, () => {
      for (const x of INSTITUTIONS) {
        assert.equal(classifyGenericStudy({ title: tpl.replace("{X}", x) }).generic, false, `${x}: ${tpl}`);
      }
    });
  }

  it("sem instituição, o mesmo estudo é genérico (o veto vem do ator, não do país)", () => {
    assert.equal(classifyGenericStudy({ title: "Consultoria divulga relatório sobre IA" }).generic, true);
  });
});

describe("classifyGenericStudy (#9462) — gabarito do editor", () => {
  for (const title of REMOVED_GENERIC) {
    it(`penaliza: ${title.slice(0, 60)}`, () => {
      const v = classifyGenericStudy({ title, bucket: "radar" });
      assert.equal(v.generic, true, `sinais=${v.signals} vetos=${v.vetoes}`);
    });
  }
  for (const [title, bucket] of KEPT_NOT_GENERIC) {
    it(`não penaliza: ${title.slice(0, 60)}`, () => {
      const v = classifyGenericStudy({ title, bucket });
      assert.equal(v.generic, false, `sinais=${v.signals} vetos=${v.vetoes}`);
    });
  }

  it("Empiricus (260925) e golpes no Pix (260930) não são penalizados — critério 3 do editor", () => {
    assert.equal(classifyGenericStudy({ title: KEPT_NOT_GENERIC[0][0] }).generic, false);
    assert.equal(classifyGenericStudy({ title: KEPT_NOT_GENERIC[1][0] }).generic, false);
  });

  it("bucket lancamento (link oficial) nunca é penalizado", () => {
    const v = classifyGenericStudy({ title: "Pesquisa revela: 80% das empresas usam agentes", bucket: "lancamento" });
    assert.equal(v.generic, false);
    assert.ok(v.vetoes.includes("bucket:lancamento"));
  });

  it("ângulo Brasil não é sinal: trocar o país não muda o veredito", () => {
    const all = [...REMOVED_GENERIC, ...KEPT_NOT_GENERIC.map(([t]) => t)];
    for (const title of all) {
      const base = classifyGenericStudy({ title }).generic;
      for (const [from, to] of [
        [/Brasil/g, "México"],
        [/Brasil/g, "EUA"],
        [/Brasil/g, "União Europeia"],
        [/brasileir/g, "american"],
        [/América Latina/g, "Europa"],
      ] as Array<[RegExp, string]>) {
        if (!from.test(title)) continue;
        assert.equal(classifyGenericStudy({ title: title.replace(from, to) }).generic, base, `${title} → ${to}`);
      }
    }
    // E o contrário: estatística genérica sobre outro país é penalizada igual.
    assert.equal(classifyGenericStudy({ title: "Quase 70% dos médicos nos EUA já usam IA, aponta estudo" }).generic, true);
    assert.equal(classifyGenericStudy({ title: "Quase 70% dos médicos no Brasil já usam IA, aponta estudo" }).generic, true);
  });
});

function h(rank: number, score: number, bucket: string, url: string, title: string, neg = false): GenericStudyHighlight {
  return { rank, score, bucket, url, negative_impact: neg, article: { url, title, negative_impact: neg } };
}

// Candidatos reais do 01-categorized.json.
const ED_260925 = [
  h(1, 85, "lancamento", "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-with-live-avatar/", "Introducing Gemini 3.8 Live with Live Avatar"),
  h(2, 65, "radar", "https://exame.com/inteligencia-artificial/o-chatgpt-pode-hacker-governos-pesquisadores-encontraram-evidencias-de-que-isso-ja-aconteceu/", "O ChatGPT pode hacker governos? Pesquisadores encontraram evidências de que isso já aconteceu", true),
  h(3, 80, "radar", "https://exame.com/negocios/grupo-sabin-tempo-atendimento-ia/", "Grupo Sabin reduz em 25% o tempo de atendimento com uso de IA"),
  h(4, 77, "radar", "https://www.seudinheiro.com/2026/carreiras/veja-como-os-agentes-de-ia-podem-ser-o-proximo-grande-salto-de-produtividade-para-empreendedores-e-profissionais-autonomos-lbrdgm092/", "Veja como os agentes de IA podem ser o próximo grande salto de produtividade para empreendedores e profissionais autônomos"),
  h(5, 63, "radar", "https://canaltech.com.br/inteligencia-artificial/muse-deve-ser-a-nova-ia-dos-ray-ban-meta-veja-o-que-vai-mudar-de-verdade/", "Muse deve ser a nova IA dos Ray-Ban Meta; veja o que vai mudar de verdade"),
  h(6, 65, "lancamento", "https://developers.googleblog.com/introducing-support-for-local-ai-models-in-the-antigravity-sdk/", "Introducing Support for Local AI Models in the Antigravity SDK"),
];
const ED_260930 = [
  h(1, 73, "radar", "https://canaltech.com.br/inteligencia-artificial/openai-cancela-gpt-61-astra-apos-ia-mentir-sobre-o-que-fez-e-quebrar-regras/", "OpenAI cancela GPT-6.1 Astra após IA mentir sobre o que fez e quebrar regras", true),
  h(2, 73, "radar", "https://www.cnnbrasil.com.br/economia/money/negocios/mcdonalds-adota-ia-para-calcular-preco-de-seus-lanches-entenda-estrategia/", "McDonald's adota IA para calcular preço de seus lanches; entenda estratégia"),
  h(3, 73, "radar", "https://canaltech.com.br/inteligencia-artificial/quase-um-opus-por-uma-fracao-do-preco-novo-claude-sonnet-55-chega-30-mais-barato/", "Quase um Opus por uma fração do preço: novo Claude Sonnet 5.5 chega 30% mais barato"),
  h(4, 70, "radar", "https://www.piranot.com.br/2026/09/28/noticias/tecnologia-e-inovacao/golpes-ia-pix-deepfakes/", "Golpes com IA tornam voz e vídeo insuficientes para confirmar um Pix", true),
  h(5, 68, "radar", "https://www.theverge.com/tech/1001749/amd-world-labs-ai-acquisition-deal", "AMD is acquiring AI company World Labs in a deal worth more than $8 billion"),
  h(6, 70, "lancamento", "https://developers.googleblog.com/introducing-support-for-local-ai-models-in-the-antigravity-sdk/", "Introducing Support for Local AI Models in the Antigravity SDK"),
];
const ED_260921 = [
  h(1, 75, "radar", "https://exame.com/inteligencia-artificial/gemini-invade-tres-empresas-reais-durante-teste-de-seguranca/", "Gemini invade três empresas reais durante teste de segurança", true),
  h(2, 83, "radar", "https://exame.com/inteligencia-artificial/178-do-mundo-ja-usa-ia-no-trabalho-entenda-onde-o-brasil-esta-nesse-mapa/", "17,8% do mundo já usa IA no trabalho. Entenda onde o Brasil está nesse mapa"),
  h(3, 81, "radar", "https://saudedigitalnews.com.br/18/09/2026/quase-70-dos-medicos-ja-usam-ia-aponta-estudo-da-mv/", "Quase 70% dos médicos já usam IA, aponta estudo da MV - Saúde Digital News"),
  h(4, 80, "radar", "https://www.dataprivacybr.org/ia-na-pre-eleicao-deepfakes-desinformacao-e-novos-desafios-para-a-integridade-das-eleicoes-de-2026/", "IA na pré-eleição: deepfakes, desinformação e novos desafios para a integridade das eleições de 2026 - Data Privacy Brasil Research", true),
  h(5, 75, "radar", "https://www.cnnbrasil.com.br/economia/seu-bolso/empreendedorismo-e-trabalho/ia-em-pequenos-negocios-5-principais-erros-ao-adotar-e-como-evitar/", "IA em pequenos negócios: 5 principais erros ao adotar — e como evitar"),
  h(6, 70, "lancamento", "https://blog.google/products-and-platforms/products/education/college-credit-ai-educator-series/", "Earn continuing education and college credits for AI educator training"),
];

const top3Urls = (hs: GenericStudyHighlight[]) =>
  [...hs].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 3).map((x) => x.url);

describe("demoteGenericStudyHighlights (#9462) — replay de edições reais", () => {
  it("260925: Sabin sai do top-3 e sobe o Empiricus (a troca que o editor fez)", () => {
    const r = demoteGenericStudyHighlights(ED_260925);
    assert.deepEqual(r.demoted.map((d) => d.url), [ED_260925[2].url]);
    assert.deepEqual(top3Urls(r.highlights), [ED_260925[0].url, ED_260925[1].url, ED_260925[3].url]);
    assert.equal(r.demoted[0].from_rank, 3);
    assert.equal(r.demoted[0].replaced_by, ED_260925[3].article!.title);
    // Nunca descarta: os 6 continuam em highlights.
    assert.equal(r.highlights.length, 6);
    const demoted = r.highlights.find((x) => x.url === ED_260925[2].url)!;
    assert.ok(demoted.generic_study_demoted);
    assert.ok((demoted.rank ?? 0) > 3);
  });

  it("260930: McDonald's sai e sobem os golpes no Pix; ≥1 negativo preservado (#3916)", () => {
    const r = demoteGenericStudyHighlights(ED_260930);
    assert.deepEqual(r.demoted.map((d) => d.url), [ED_260930[1].url]);
    const top = top3Urls(r.highlights);
    assert.ok(top.includes(ED_260930[3].url), "Pix sobe");
    assert.ok(r.highlights.filter((x) => (x.rank ?? 0) <= 3).some((x) => x.negative_impact));
  });

  it("260921: os dois estudos genéricos saem, o negativo do D1 fica", () => {
    const r = demoteGenericStudyHighlights(ED_260921);
    assert.deepEqual(r.demoted.map((d) => d.url).sort(), [ED_260921[1].url, ED_260921[2].url].sort());
    assert.equal(top3Urls(r.highlights)[0], ED_260921[0].url);
    assert.equal(top3Urls(r.highlights).length, 3);
  });

  it("sem genérico no top-3 → no-op", () => {
    const hs = [ED_260925[0], ED_260925[1], ED_260925[3], ED_260925[2]].map((x, i) => ({ ...x, rank: i + 1 }));
    const r = demoteGenericStudyHighlights(hs);
    assert.equal(r.demoted.length, 0);
    assert.deepEqual(r.highlights, hs);
  });

  it("genérico negativo sem substituto negativo fica no top-3 (kept, #3916)", () => {
    const negGeneric = h(1, 80, "radar", "https://x.example/a", "Quase 70% dos trabalhadores já usam IA, aponta estudo", true);
    const hs = [negGeneric, ED_260925[0], ED_260925[3], ED_260925[5]].map((x, i) => ({ ...x, rank: i + 1 }));
    const r = demoteGenericStudyHighlights(hs);
    assert.equal(r.demoted.length, 0);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0].reason, /#3916/);
    assert.ok(top3Urls(r.highlights).includes(negGeneric.url));
  });

  it("menos de 3 não-genéricos → genérico completa o top-3 (edição nunca perde destaque)", () => {
    const g1 = h(2, 80, "radar", "https://x.example/g1", "Grupo Sabin reduz em 25% o tempo de atendimento com uso de IA");
    const g2 = h(3, 80, "radar", "https://x.example/g2", "McDonald's adota IA para calcular preço de seus lanches; entenda estratégia");
    const r = demoteGenericStudyHighlights([ED_260925[0], g1, g2]);
    assert.equal(top3Urls(r.highlights).length, 3);
    assert.equal(r.kept.length, 2);
    assert.equal(r.demoted.length, 0);
  });

  it("item rebaixado por MESMO FATO (#9100) nunca sobe por causa desta penalidade", () => {
    const sameFact = { ...ED_260925[3], rank: 4, same_fact_demoted: { matched_edition: "260924" } };
    const hs = [ED_260925[0], ED_260925[1], ED_260925[2], sameFact, ED_260925[4], ED_260925[5]];
    const r = demoteGenericStudyHighlights(hs);
    assert.ok(!top3Urls(r.highlights).includes(sameFact.url));
    assert.ok(top3Urls(r.highlights).includes(ED_260925[4].url), "sobe o próximo elegível");
  });

  it("não muta a entrada", () => {
    const copy = JSON.parse(JSON.stringify(ED_260925));
    demoteGenericStudyHighlights(ED_260925);
    assert.deepEqual(ED_260925, copy);
  });

  it("nota do gate: aplicada (⬇️) e modo sombra (🔎)", () => {
    const d = demoteGenericStudyHighlights(ED_260925).demoted[0];
    assert.match(formatGenericStudyNote(d), /^⬇️ ESTUDO\/CASE GENÉRICO — "Grupo Sabin/);
    assert.match(formatGenericStudyNote(d, false), /^🔎 .*seria rebaixado/);
  });
});

describe("demote-generic-study-highlights CLI core (#9462) — flag + fail-soft", () => {
  function setup(config: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "gsp-9462-"));
    const cat = join(dir, "01-categorized.json");
    writeFileSync(cat, JSON.stringify({ highlights: ED_260925, radar: [] }, null, 2));
    const cfg = join(dir, "platform.config.json");
    if (config !== null) writeFileSync(cfg, config);
    return { dir, cat, cfg, log: join(dir, "01-generic-study-demoted.json") };
  }

  it("config: chave ausente = desligada; enabled:true = ligada", () => {
    const a = setup("{}");
    assert.deepEqual(readGenericStudyPenaltyConfig(a.cfg), { enabled: false });
    const m = setup(null);
    assert.deepEqual(readGenericStudyPenaltyConfig(m.cfg), { enabled: false, missing: true });
    const b = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: true } } }));
    assert.deepEqual(readGenericStudyPenaltyConfig(b.cfg), { enabled: true });
  });

  it("platform.config.json do repo declara a chave (default documentado)", () => {
    const cfg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.equal(typeof cfg.selection?.generic_study_penalty?.enabled, "boolean");
  });

  it("ligada: reordena o JSON e grava applied:true", () => {
    const s = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: true } } }));
    const res = runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    assert.equal(res.applied, true);
    assert.equal(res.demoted, 1);
    const out = JSON.parse(readFileSync(s.cat, "utf8"));
    assert.ok(!top3Urls(out.highlights).includes(ED_260925[2].url));
    const log = JSON.parse(readFileSync(s.log, "utf8"));
    assert.equal(log.applied, true);
    assert.equal(log.demoted[0].url, ED_260925[2].url);
  });

  it("desligada: modo sombra — JSON intocado, log applied:false com o que faria", () => {
    const s = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: false } } }));
    const before = readFileSync(s.cat, "utf8");
    const res = runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    assert.equal(res.applied, false);
    assert.equal(readFileSync(s.cat, "utf8"), before);
    const log = JSON.parse(readFileSync(s.log, "utf8"));
    assert.equal(log.applied, false);
    assert.equal(log.demoted.length, 1);
    assert.match(res.notes[0], /^🔎/);
  });

  it("config malformada: fail-soft — JSON intocado, warn no run-log, sem lançar", () => {
    const s = setup("{ isto não é json");
    const before = readFileSync(s.cat, "utf8");
    const res = runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir, edition: "260925" });
    assert.ok(res.error);
    assert.equal(res.applied, false);
    assert.equal(readFileSync(s.cat, "utf8"), before);
    assert.equal(existsSync(s.log), false);
    const runLog = readFileSync(join(s.dir, "data", "run-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runLog[0].level, "warn");
    assert.equal(runLog[0].edition, "260925");
    assert.match(runLog[0].message, /#9462/);
  });

  it("config default resolvida pela raiz do repo, não pelo cwd", () => {
    assert.equal(DEFAULT_CONFIG_PATH, join(import.meta.dirname, "..", "platform.config.json"));
  });

  it("config ausente: desligada (sombra) + warn no run-log", () => {
    const s = setup(null);
    const res = runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir, edition: "260925" });
    assert.equal(res.error, undefined);
    assert.equal(res.applied, false);
    const runLog = readFileSync(join(s.dir, "data", "run-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runLog[0].level, "warn");
    assert.match(runLog[0].message, /não encontrada/);
  });

  it("desligada: rerun SEM rebaixamento regrava o log (não sobra 'seria rebaixado' velho)", () => {
    const s = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: false } } }));
    runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    assert.equal(JSON.parse(readFileSync(s.log, "utf8")).demoted.length, 1);
    // Seleção mudou (rerun do Stage 1): o genérico saiu dos candidatos.
    const cat = JSON.parse(readFileSync(s.cat, "utf8"));
    cat.highlights = cat.highlights.filter((x: GenericStudyHighlight) => x.url !== ED_260925[2].url);
    writeFileSync(s.cat, JSON.stringify(cat));
    runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    const log = JSON.parse(readFileSync(s.log, "utf8"));
    assert.equal(log.demoted.length, 0);
    assert.equal(log.applied, false);
  });

  it("ligada: resume sobre o JSON já reordenado preserva o log aplicado", () => {
    const s = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: true } } }));
    runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    const first = readFileSync(s.log, "utf8");
    const res = runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    assert.equal(res.demoted, 0);
    assert.equal(readFileSync(s.log, "utf8"), first);
  });

  it("ligada: log de sombra antigo não sobrevive a uma rodada aplicada sem nada", () => {
    const s = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: true } } }));
    const cat = JSON.parse(readFileSync(s.cat, "utf8"));
    cat.highlights = cat.highlights.filter((x: GenericStudyHighlight) => x.url !== ED_260925[2].url);
    writeFileSync(s.cat, JSON.stringify(cat));
    writeFileSync(s.log, JSON.stringify({ applied: false, demoted: [{ url: ED_260925[2].url }], kept: [] }));
    runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, outLog: s.log, rootDir: s.dir });
    const log = JSON.parse(readFileSync(s.log, "utf8"));
    assert.equal(log.applied, true);
    assert.equal(log.demoted.length, 0);
  });

  it("categorized ilegível: fail-soft", () => {
    const s = setup(JSON.stringify({ selection: { generic_study_penalty: { enabled: true } } }));
    writeFileSync(s.cat, "nope");
    const res = runGenericStudyPenalty({ categorizedPath: s.cat, configPath: s.cfg, rootDir: s.dir });
    assert.ok(res.error);
    assert.equal(readFileSync(s.cat, "utf8"), "nope");
  });
});
