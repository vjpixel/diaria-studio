/**
 * #9100 (decisão do editor de 05/10/2026): candidato a destaque que repete
 * fato dos D1–D3 das últimas 3 edições é REBAIXADO, nunca descartado.
 *
 * Fixtures com textos reais de `data/editions` (copiados — `data/` não existe
 * no CI): 261005 × 261002 (VigIA), 260930 × 260929 (Sonnet 5.5), 260918 ×
 * 260917 (Cowork, mesma URL) e o desdobramento 260928 × 260925 (Senate
 * inquiry: mesma entidade, nenhum número em comum).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  extractDemotionNumbers,
  extractDemotionEntities,
  isVersionLikeNumber,
  findSameFactDemotionMatch,
  candidateOf,
  demoteSameFactHighlights,
  formatDemotionNote,
  type PublishedDestaque,
} from "../scripts/lib/same-fact-demotion.ts";
import { readRecentPublishedDestaques, markPoolArticles } from "../scripts/demote-same-fact-highlights.ts";
import { removeSameFactSecondary, formatHighlightSameFactNotes, type SameFactWarning } from "../scripts/lib/same-fact-check.ts";
import { dedup } from "../scripts/dedup.ts";
import { extractPastDestaqueUrls, recentEditionDirs } from "../scripts/lib/past-editions-extract.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

// --- D1–D3 publicados (02-reviewed.md reais) -------------------------------

const D1_261002: PublishedDestaque = {
  aammdd: "261002",
  n: 1,
  title: "Você viu Bonner anunciar pesquisa? Era deepfake",
  url: "https://www.agencialupa.org/noticias/2026/10/01/vigia-1o-turno-tem-quase-um-conteudo-eleitoral-com-ia-por-hora-nas-redes/",
  source_title: "VigIA: 1º turno tem quase um conteúdo eleitoral com IA por hora nas redes",
  text:
    "O VigIA, projeto da Agência Lupa que monitora o uso de IA nas eleições, identificou 920 publicações eleitorais criadas ou alteradas com a tecnologia entre 16 de agosto e 28 de setembro. A média é de 20 por dia, quase uma por hora, ao longo do primeiro turno.\n\n" +
    "Em 554 casos (60%), eram deepfakes. Ao menos 30 usavam jornalistas da TV Globo, como William Bonner e Renata Lo Prete, \"noticiando\" pesquisas e resultados falsos. Lula apareceu em 379 conteúdos, quase o dobro dos 190 que retratavam Flávio Bolsonaro.\n\n" +
    "Facebook (559 casos) e Instagram (365) concentraram a maior parte. Seis em cada dez peças circularam sem aviso de uso de IA, e quase metade veio de eleitores e militantes, fora de perfis oficiais.",
};

const D2_260929: PublishedDestaque = {
  aammdd: "260929",
  n: 2,
  title: "Anthropic corta até 30% do custo com Sonnet 5.5",
  url: "https://www.anthropic.com/claude-sonnet-5-5",
  text:
    "A Anthropic lançou o Claude Sonnet 5.5 em 28/09/2026. O modelo está disponível na Claude Platform (claude-sonnet-5-5), na Amazon Web Services, no Google Cloud e no Microsoft Azure.\n\n" +
    "Segundo a empresa, ele roda pelo menos 30% mais rápido e custa até 30% menos na maior parte das tarefas em comparação com o Sonnet 5. O preço por token não muda: US$ 2 por milhão de tokens de entrada e US$ 10 por milhão de saída, com leitura de cache a US$ 0,20.",
};

const D2_260917: PublishedDestaque = {
  aammdd: "260917",
  n: 2,
  title: "Claude funde chat e Cowork num só produto",
  url: "https://claude.com/blog/cowork-is-now-claude",
  text: "A Anthropic anunciou em 16 de setembro que o Claude Cowork, espaço separado dentro do Claude para tarefas maiores e mais complexas, deixa de existir como produto à parte. Chat e Cowork viram um só Claude.",
};

const D1_260925: PublishedDestaque = {
  aammdd: "260925",
  n: 1,
  title: "Agente rebelde invade sistema de governo",
  url: "https://www.theguardian.com/news/video/2026/sep/24/rogue-ai-hacks-government-system-for-first-time-the-latest",
  text:
    "Um banco de dados de governo foi invadido pela primeira vez por um agente de IA fora de controle. O agente se infiltrou no sistema de saúde da Austrália em junho, na primeira invasão desse tipo confirmada publicamente por um governo.\n\n" +
    "A OppenAI percebeu o problema em agosto, mas só avisou as autoridades australianas em setembro, um mês depois. O primeiro-ministro Anthony Albanese classificou o caso como motivo de \"extrema preocupação\".",
};

// --- Candidatos a destaque reais (01-categorized.json) ---------------------

const VIGIA_261005 = {
  rank: 1,
  score: 85,
  bucket: "radar",
  article: {
    url: "https://www.bra1.com.br/tecnologia/id-702240/deepfakes_com_ia_explodem_nas_redes_sociais_mesmo_sendo_proibidos_antes_das_eleicoes_de_2026",
    title: "Deepfakes com IA explodem nas redes sociais mesmo sendo proibidos antes das eleições de 2026",
    summary: "Investiga��o revela que 554 v�deos e imagens falsos criados por intelig�ncia artificial foram postados durante a campanha, com 29 vindo de",
    summary_rejected:
      "Monitoramento VigIA/Lupa encontrou 554 deepfakes durante campanha 2026. Apenas 40% tinha labels de transparência obrigatória. Presidente Lula em 379 publicações falsas, Flávio Bolsonaro em 190. Maioria vinha de contas anônimas (525 de 554).",
    negative_impact: true,
  },
};

const SONNET_260930 = {
  rank: 3,
  score: 80,
  bucket: "lancamento",
  article: {
    url: "https://canaltech.com.br/inteligencia-artificial/quase-um-opus-por-uma-fracao-do-preco-novo-claude-sonnet-55-chega-30-mais-barato/",
    title: "Quase um Opus por uma fração do preço: novo Claude Sonnet 5.5 chega 30% mais barato",
    summary:
      "A Anthropic anunciou o Claude Sonnet 5.5 , segundo modelo da fam&iacute;lia Claude 5.5. Dispon&iacute;vel a partir de 28 de setembro de 2026, a nova IA promete mais velocidade e efici&ecirc;ncia em tarefas de programa&ccedil;&atilde;o, an&aacute;lise e trabalho com ferramentas. Segundo a empresa, o custo por tarefa pode cair at&eacute; 30%, mesmo com os pre&ccedil;os por milh&atilde;o de tokens ma",
  },
};

const COWORK_260918 = {
  rank: 3,
  score: 80,
  bucket: "lancamento",
  article: {
    url: "https://claude.com/blog/cowork-is-now-claude",
    title: "Claude Cowork and chat are now one Claude",
    summary: "",
  },
};

const SENATE_260928 = {
  rank: 2,
  score: 80,
  bucket: "radar",
  article: {
    url: "https://www.theguardian.com/australia-news/2026/sep/27/sam-altman-openai-dario-amodei-anthropic-senate-inquiry-medicare-hack-rogue-ai-agent-leak",
    title: "Heads of OpenAI and Anthropic called to face Senate inquiry after rogue agent incidents",
    summary: "Sam Altman e Dario Amodei foram convocados a depor num inquérito do Senado australiano após agentes da OpenAI invadirem sites de governo.",
  },
};

function hl(rank: number, url: string, title: string, extra: Record<string, unknown> = {}) {
  return { rank, score: 90 - rank, bucket: "radar", article: { url, title, summary: "", ...extra } };
}

// ---------------------------------------------------------------------------

describe("extractDemotionNumbers (#9100)", () => {
  it("normaliza percentual, moeda, decimal e milhar", () => {
    assert.deepEqual([...extractDemotionNumbers("30%")], ["30%"]);
    assert.deepEqual([...extractDemotionNumbers("30 %")], ["30%"]);
    assert.deepEqual([...extractDemotionNumbers("custa US$ 899")], ["899"]);
    assert.deepEqual([...extractDemotionNumbers("R$ 1.299")], ["1299"]);
    assert.deepEqual([...extractDemotionNumbers("Sonnet 5,5")], ["5.5"]);
    assert.deepEqual([...extractDemotionNumbers("Sonnet 5.5")], ["5.5"]);
    assert.deepEqual([...extractDemotionNumbers("14.000 restaurantes")], ["14000"]);
    assert.deepEqual([...extractDemotionNumbers("1,4% do custo")], ["1.4%"]);
  });
  it("ignora anos, inteiros de 1 dígito e datas", () => {
    assert.deepEqual([...extractDemotionNumbers("eleições de 2026, GPT-6 e 3 empresas")], []);
    assert.deepEqual([...extractDemotionNumbers("entre 16 de agosto e 28 de setembro")], []);
    assert.deepEqual([...extractDemotionNumbers("lançado em 28/09/2026 e October 3")], []);
  });
  it("decodifica entidade HTML antes de extrair", () => {
    assert.deepEqual([...extractDemotionNumbers("at&eacute; 30%")], ["30%"]);
  });
});

describe("findSameFactDemotionMatch — casos reais (#9100)", () => {
  it("261005 VigIA × D1 de 261002: entidade + 554/379/190", () => {
    const m = findSameFactDemotionMatch(candidateOf(VIGIA_261005), [D1_261002, D2_260929]);
    assert.ok(m);
    assert.equal(m!.evidence, "entity+numbers");
    assert.equal(m!.matched_edition, "261002");
    assert.equal(m!.matched_destaque, 1);
    for (const n of ["190", "379", "554"]) assert.ok(m!.shared_numbers.includes(n), n);
    assert.ok(m!.shared_entities.includes("vigia"));
  });

  it("260930 Sonnet 5.5 × D2 de 260929: entidade + 30%/5.5", () => {
    const m = findSameFactDemotionMatch(candidateOf(SONNET_260930), [D2_260929]);
    assert.ok(m);
    assert.ok(m!.shared_numbers.includes("30%"));
    assert.ok(m!.shared_numbers.includes("5.5"));
    assert.ok(m!.shared_entities.includes("sonnet"));
  });

  it("260918 Cowork × D2 de 260917: mesma URL", () => {
    const m = findSameFactDemotionMatch(candidateOf(COWORK_260918), [D2_260917]);
    assert.ok(m);
    assert.equal(m!.evidence, "url");
    assert.equal(m!.matched_edition, "260917");
  });

  it("desdobramento (Senate inquiry × D1 de 260925): mesma entidade, nenhum número em comum ⇒ não casa", () => {
    assert.equal(findSameFactDemotionMatch(candidateOf(SENATE_260928), [D1_260925]), null);
  });

  it("2 números iguais sem entidade em comum ⇒ não casa", () => {
    const cand = { url: "https://x.com/a", title: "Pesquisa ouve 554 pessoas", text: "e 379 respostas válidas" };
    const past: PublishedDestaque = { aammdd: "261002", n: 1, title: "outra coisa", url: "https://y.com", text: "554 e 379 em minúsculas sem nome próprio" };
    assert.equal(findSameFactDemotionMatch(cand, [past]), null);
  });

  it("entidade + só 1 número em comum ⇒ não casa", () => {
    const cand = { url: "https://x.com/a", title: "VigIA aponta 379 posts", text: "" };
    assert.equal(findSameFactDemotionMatch(cand, [D1_261002]), null);
  });

  // Finding do review da PR #9662: palavra capitalizada só por abrir frase
  // ("Modelos") virava entidade e versões ("3.5") contavam como fato.
  const GEMINI_PAST: PublishedDestaque = {
    aammdd: "261001",
    n: 1,
    title: "Google lança Gemini 3.5 Pro",
    url: "https://blog.google/gemini-3-5-pro",
    text: "O modelo chega a 100 países. Modelos ficam 40% mais baratos para desenvolvedores.",
  };
  const LLAMA_CAND = {
    url: "https://ai.meta.com/llama-3-5",
    title: "Meta lança Llama 3.5 aberto para 100 países",
    text: "Modelos da Meta custam 40% menos.",
  };

  it("Gemini 3.5 × Llama 3.5 (início de frase 'Modelos' + versão 3.5) ⇒ não casa", () => {
    assert.equal(findSameFactDemotionMatch(LLAMA_CAND, [GEMINI_PAST]), null);
  });

  it("entidade só vem dos TÍTULOS: palavra capitalizada do corpo não conta", () => {
    const ents = extractDemotionEntities([GEMINI_PAST.title], GEMINI_PAST.text);
    assert.ok(!ents.has("modelos"));
    assert.ok(ents.has("gemini"));
    // "Você"/"Era" abrem frase no título e não reaparecem no meio de frase.
    const vigia = extractDemotionEntities([D1_261002.title, D1_261002.source_title!], D1_261002.text);
    assert.ok(!vigia.has("você") && !vigia.has("era"));
    assert.ok(vigia.has("vigia") && vigia.has("bonner"));
  });

  it("versão só conta colada à entidade em comum nos dois textos", () => {
    assert.ok(isVersionLikeNumber("3.5") && isVersionLikeNumber("2.0"));
    assert.ok(!isVersionLikeNumber("30%") && !isVersionLikeNumber("554"));
    // Mesma entidade (Gemini no título passado), mas 3.5 do candidato é do Llama:
    // sobram só 2 números se a versão não contar → precisa de mais 1 para casar.
    const past: PublishedDestaque = { ...GEMINI_PAST, text: "Gemini 3.5 Pro chega a 100 países." };
    const cand = { url: "https://x.com/a", title: "Gemini perde para Llama 3.5 em 100 países", text: "" };
    assert.equal(findSameFactDemotionMatch(cand, [past]), null);
    const anchored = { url: "https://x.com/b", title: "Gemini 3.5 Pro chega a 100 países", text: "" };
    assert.deepEqual(findSameFactDemotionMatch(anchored, [past])?.shared_numbers, ["100", "3.5"]);
  });
});

describe("demoteSameFactHighlights (#9100)", () => {
  it("261005: D1 VigIA rebaixado (não descartado), próximo sobe e o negativo do top-3 é preservado", () => {
    const highlights = [
      VIGIA_261005,
      hl(2, "https://www.theguardian.com/openai-safety-leader-quits", "OpenAI safety leader quits"),
      hl(3, "https://blog.cloudflare.com/clef-decision-models", "Introducing Clef"),
      hl(4, "https://www.startse.com/a-ia-esta-deixando-de-contratar", "A IA pode até não demitir, mas está deixando de contratar", { negative_impact: true }),
      hl(5, "https://www.anthropic.com/news/claude-frontier-academy", "Claude Frontier Academy"),
    ];
    const r = demoteSameFactHighlights(highlights, [D1_261002]);
    assert.equal(r.highlights.length, highlights.length, "nada é descartado");
    assert.equal(r.demoted.length, 1);
    assert.equal(r.demoted[0].from_rank, 1);
    const top3 = r.highlights.filter((h) => (h.rank ?? 99) <= 3).map((h) => h.article!.url);
    assert.ok(!top3.includes(VIGIA_261005.article.url));
    assert.ok(top3.includes("https://www.startse.com/a-ia-esta-deixando-de-contratar"), "#3916: negativo no top-3");
    const demoted = r.highlights.find((h) => h.article!.url === VIGIA_261005.article.url)!;
    assert.ok((demoted.rank ?? 0) > 3);
    assert.deepEqual((demoted as { same_fact_demoted?: { matched_edition: string } }).same_fact_demoted?.matched_edition, "261002");
    // ranks renumerados 1..N, sem buraco
    assert.deepEqual(r.highlights.map((h) => h.rank).sort((a, b) => a! - b!), [1, 2, 3, 4, 5]);
    assert.match(formatDemotionNote(r.demoted[0]), /rebaixado de D1 .*261002/);
  });

  it("260930: D3 Sonnet rebaixado, D4 sobe", () => {
    const highlights = [
      hl(1, "https://canaltech.com.br/openai-cancela-gpt-61-astra", "OpenAI cancela GPT-6.1 Astra", { negative_impact: true }),
      hl(2, "https://www.cnnbrasil.com.br/mcdonalds-ia", "McDonald's adota IA para calcular preço"),
      SONNET_260930,
      hl(4, "https://www.piranot.com.br/golpes-ia-pix", "Golpes com IA tornam voz e vídeo insuficientes"),
    ];
    const r = demoteSameFactHighlights(highlights, [D2_260929]);
    assert.equal(r.demoted.length, 1);
    const byRank = [...r.highlights].sort((a, b) => a.rank! - b.rank!).map((h) => h.article!.url);
    assert.equal(byRank[2], "https://www.piranot.com.br/golpes-ia-pix");
    assert.equal(byRank[3], SONNET_260930.article.url);
  });

  it("260918: D3 com a MESMA URL do D2 de 260917 é rebaixado", () => {
    const highlights = [hl(1, "https://a.com/1", "A"), hl(2, "https://b.com/2", "B"), COWORK_260918, hl(4, "https://d.com/4", "D")];
    const r = demoteSameFactHighlights(highlights, [D2_260917]);
    assert.equal(r.demoted.length, 1);
    assert.equal(r.demoted[0].match.evidence, "url");
  });

  it("desdobramento com mesma entidade sem números repetidos fica no destaque", () => {
    const highlights = [hl(1, "https://a.com/1", "A"), SENATE_260928, hl(3, "https://c.com/3", "C"), hl(4, "https://d.com/4", "D")];
    const r = demoteSameFactHighlights(highlights, [D1_260925]);
    assert.equal(r.demoted.length, 0);
    assert.deepEqual(r.highlights, highlights);
  });

  it("#3916: repetido é o único negativo e não há negativo limpo ⇒ fica no top-3 (só aviso)", () => {
    const highlights = [
      VIGIA_261005,
      hl(2, "https://b.com/2", "B"),
      hl(3, "https://c.com/3", "C"),
      hl(4, "https://d.com/4", "D"),
    ];
    const r = demoteSameFactHighlights(highlights, [D1_261002]);
    assert.equal(r.demoted.length, 0);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0].reason, /#3916/);
    const top3 = r.highlights.filter((h) => h.rank! <= 3).map((h) => h.article!.url);
    assert.ok(top3.includes(VIGIA_261005.article.url));
  });

  it("sem candidatos limpos suficientes ⇒ repetido completa o top-3 (kept)", () => {
    const highlights = [hl(1, "https://a.com/1", "A"), hl(2, "https://b.com/2", "B"), COWORK_260918];
    const r = demoteSameFactHighlights(highlights, [D2_260917]);
    assert.equal(r.demoted.length, 0);
    assert.equal(r.kept.length, 1);
  });

  it("repetido já fora do top-3 ⇒ nada muda", () => {
    const highlights = [hl(1, "https://a.com/1", "A"), hl(2, "https://b.com/2", "B"), hl(3, "https://c.com/3", "C"), { ...COWORK_260918, rank: 4 }];
    const r = demoteSameFactHighlights(highlights, [D2_260917]);
    assert.equal(r.demoted.length, 0);
    assert.deepEqual(r.highlights, highlights);
  });
});

describe("rebaixado nunca é descartado em --no-gates (#9100 × #9386)", () => {
  it("formatHighlightSameFactNotes não duplica o 🚨 para destaque já rebaixado (⬇️)", () => {
    const w = {
      same_fact_warnings: [
        { kind: "highlight", rank: 3, item_title: "Sonnet", item_url: SONNET_260930.article.url, matched_edition: "260929", matched_title: D2_260929.title, shared_products: ["sonnet 5.5"], evidence: "title" },
      ],
    };
    const h = { url: SONNET_260930.article.url, article: { url: SONNET_260930.article.url } };
    assert.equal(formatHighlightSameFactNotes(w, { highlights: [h] }).length, 1);
    assert.deepEqual(
      formatHighlightSameFactNotes(w, { highlights: [{ ...h, same_fact_demoted: { matched_edition: "260929" } }] }),
      [],
    );
  });

  it("removeSameFactSecondary poupa item marcado same_fact_demoted", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: SONNET_260930.article.url, title: SONNET_260930.article.title, same_fact_demoted: { matched_edition: "260929" } }],
      radar: [],
    };
    const warnings: SameFactWarning[] = [
      {
        kind: "highlight",
        rank: 3,
        item_title: SONNET_260930.article.title,
        item_url: SONNET_260930.article.url,
        matched_edition: "260929",
        matched_title: D2_260929.title,
        shared_products: ["sonnet 5.5"],
        matched_bucket: "highlight",
        evidence: "title",
      },
    ];
    const { removed, approved: out } = removeSameFactSecondary(approved, warnings);
    assert.equal(removed.length, 0);
    assert.equal((out.lancamento as unknown[]).length, 1);
  });

  it("markPoolArticles marca o artigo do bucket pela URL canônica", () => {
    const key = canonicalize("https://claude.com/blog/cowork-is-now-claude");
    const out = markPoolArticles(
      { lancamento: [{ url: "https://claude.com/blog/cowork-is-now-claude?utm_source=x" }, { url: "https://x.com" }] },
      new Map([[key, { matched_edition: "260917" }]]),
    );
    const arr = out.lancamento as Array<{ same_fact_demoted?: unknown }>;
    assert.deepEqual(arr[0].same_fact_demoted, { matched_edition: "260917" });
    assert.equal(arr[1].same_fact_demoted, undefined);
  });
});

describe("dedup Pass 1: URL de destaque publicado bloqueia mesmo fora do past-editions.md (#9100, 260918)", () => {
  it("URL só em pastDestaqueUrls (02-reviewed.md) é removida", () => {
    const r = dedup(
      [{ url: "https://claude.com/blog/cowork-is-now-claude", title: "Claude Cowork and chat are now one Claude" }],
      new Set<string>(), // past-editions.md sem a URL (troca pós-gate 1, #8298)
      0.85,
      [],
      0.7,
      [],
      0.6,
      new Set(["https://claude.com/blog/cowork-is-now-claude"]),
    );
    assert.equal(r.kept.length, 0);
    assert.match(r.removed[0].dedup_note ?? "", /destaque de edição anterior/);
  });
});

// --- leitura do disco + CLI ponta a ponta ----------------------------------

function seedEditions(root: string): string {
  const editionsDir = join(root, "editions");
  const reviewed = (n: number, title: string, url: string, body: string) =>
    `**DESTAQUE ${n} | 🔬 PESQUISA**\n\n**[${title}](${url})**  \n\n${body}\n\nPor que isso importa:\n\nPorque sim.\n\n---\n`;
  const mk = (aammdd: string, md: string, approved: unknown) => {
    const dir = join(editionsDir, aammdd.slice(0, 4), aammdd);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    if (md) writeFileSync(join(dir, "02-reviewed.md"), md);
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
  };
  mk("261001", reviewed(1, "Argon", "https://g.com/argon", "Gemini 4 Argon."), { highlights: [] });
  mk("261002", reviewed(1, D1_261002.title, D1_261002.url, D1_261002.text), {
    highlights: [{ url: D1_261002.url, article: { url: D1_261002.url, title: D1_261002.source_title, summary: "" } }],
  });
  // 260930: sem 02-reviewed.md → fallback para os highlights do approved
  mk("260930", "", { highlights: [{ url: "https://h.com/x", article: { url: "https://h.com/x", title: "OpenAI cancela GPT-6.1 Astra", summary: "s" } }] });
  mk("260929", reviewed(2, D2_260929.title, D2_260929.url, D2_260929.text), { highlights: [] });
  // edição corrente (não entra) e futura (não entra)
  mk("261005", "", { highlights: [] });
  mk("261006", reviewed(1, "Futuro", "https://f.com", "x"), { highlights: [] });
  return editionsDir;
}

describe("readRecentPublishedDestaques (#9100)", () => {
  it("lê as 3 edições anteriores à corrente, 02-reviewed.md com fallback no approved", () => {
    const root = mkdtempSync(join(tmpdir(), "demote-9100-"));
    try {
      const editionsDir = seedEditions(root);
      const past = readRecentPublishedDestaques(editionsDir, 3, "261005");
      assert.deepEqual([...new Set(past.map((p) => p.aammdd))], ["261002", "261001", "260930"]);
      const d1 = past.find((p) => p.aammdd === "261002")!;
      assert.equal(d1.url, D1_261002.url);
      assert.match(d1.text, /554/);
      assert.equal(past.find((p) => p.aammdd === "260930")!.title, "OpenAI cancela GPT-6.1 Astra");
      assert.equal(d1.source_title, D1_261002.source_title, "título da fonte vem do approved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replay de edição antiga: janela do dedup não inclui edição POSTERIOR (review #9662)", () => {
    const root = mkdtempSync(join(tmpdir(), "demote-9100-future-"));
    try {
      const editionsDir = seedEditions(root);
      // Rerun de 261001: 261002 e 261006 são posteriores, nunca "passadas".
      assert.deepEqual(recentEditionDirs(editionsDir, 3, "261001"), ["260930", "260929"]);
      const urls = extractPastDestaqueUrls(editionsDir, 3, "261001");
      assert.ok(!urls.has(canonicalize(D1_261002.url)), "URL de edição futura não bloqueia");
      assert.ok(!urls.has(canonicalize("https://f.com")));
      assert.ok(urls.has(canonicalize(D2_260929.url)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI reordena o 01-categorized.json, marca o pool e grava o log", () => {
    const root = mkdtempSync(join(tmpdir(), "demote-9100-cli-"));
    try {
      const editionsDir = seedEditions(root);
      const catPath = join(editionsDir, "2610", "261005", "_internal", "01-categorized.json");
      const others = [2, 3, 4].map((i) => hl(i, `https://o.com/${i}`, `Outro ${i}`, i === 4 ? { negative_impact: true } : {}));
      writeFileSync(
        catPath,
        JSON.stringify({
          highlights: [VIGIA_261005, ...others],
          radar: [{ ...VIGIA_261005.article }, ...others.map((o) => o.article)],
          lancamento: [],
          use_melhor: [],
          video: [],
        }),
      );
      const logPath = join(root, "demoted.json");
      const res = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/demote-same-fact-highlights.ts"), "--categorized", catPath, "--current-edition", "261005", "--editions-dir", editionsDir, "--out-log", logPath],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout.trim().split("\n").pop()!);
      assert.equal(out.demoted, 1);
      const cat = JSON.parse(readFileSync(catPath, "utf8"));
      const top3 = cat.highlights.filter((h: { rank: number }) => h.rank <= 3).map((h: { article: { url: string } }) => h.article.url);
      assert.ok(!top3.includes(VIGIA_261005.article.url));
      assert.equal(cat.highlights.length, 4, "nada descartado");
      assert.ok(cat.radar.find((a: { url: string }) => a.url === VIGIA_261005.article.url).same_fact_demoted, "pool marcado");
      const log = JSON.parse(readFileSync(logPath, "utf8"));
      assert.equal(log.demoted.length, 1);
      assert.equal(log.demoted[0].match.matched_edition, "261002");

      // resume: 2ª rodada sobre o JSON já reordenado não apaga o log
      const res2 = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/demote-same-fact-highlights.ts"), "--categorized", catPath, "--current-edition", "261005", "--editions-dir", editionsDir, "--out-log", logPath],
        { encoding: "utf8" },
      );
      assert.equal(res2.status, 0, res2.stderr);
      assert.equal(JSON.parse(readFileSync(logPath, "utf8")).demoted.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
