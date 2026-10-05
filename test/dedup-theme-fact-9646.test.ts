/**
 * #9646: Pass-1d (theme-entity, #1475) exige entidade (palavra inteira) E
 * ≥1 termo em comum com o FATO da edição que gerou a entidade (manchete + D1).
 *
 * Fixtures são textos reais (title/summary de `tmp-articles-raw.json` e D1 de
 * `01-approved.json`) das edições medidas na #9646.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "../scripts/dedup.ts";
import {
  extractPastThemeFacts,
  matchesRecentThemeFact,
  themeFactTokens,
} from "../scripts/lib/past-editions-extract.ts";

// --- Fatos passados (manchete da edição + D1 do 01-approved.json) ----------
const PAST_MD = `# Past editions

## 2026-10-01 — "Seu próximo modelo de código pode ser o Argon?"
URL: https://diariabr.kit.com/posts/seu-proximo-modelo-de-codigo-pode-ser-o-argon

Links usados:
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/

Temas cobertos:
- Argon

---

## 2026-09-25 — "Agente rebelde invade sistema de governo"
URL: https://diariabr.kit.com/posts/agente-rebelde-invade-sistema-de-governo

Links usados:
- https://www.theguardian.com/news/video/2026/sep/24/rogue-ai-hacks-government-system-for-first-time-the-latest

Temas cobertos:
- Agente

---

## 2026-09-23 — "Claude Opus 5.5 chega dias após alerta de Amodei"
URL: https://diariabr.kit.com/posts/claude-opus-5-5

Links usados:
- https://www.anthropic.com/news/claude-opus-5-5

Temas cobertos:
- Claude
- Opus
- Amodei
`;

const PAST_D1 = [
  {
    aammdd: "261001",
    title: "Gemini 4 Argon: our next era of frontier intelligence",
    summary:
      "Announcing Gemini 4 Argon, our frontier model for real-world coding, enterprise knowledge work, and cyber defense, rolling out soon.",
  },
  {
    aammdd: "260925",
    title: "Rogue AI hacks government system for first time - The Latest",
    summary:
      "A government database has been hacked for the first time by a rogue OpenAI agent, which infiltrated part of the Australian healthcare scheme in June. OpenAI became aware of the hack in August, but only informed the government in September. Australia’s prime minister, Anthony Albanese, has expressed his ‘extreme concern’ about the hack, which raises serious AI security concerns for governments around the world.",
  },
  {
    aammdd: "260923",
    title: "Introducing Claude Opus 5.5",
    summary:
      "Claude Opus 5.5 leads in agentic coding and knowledge work, and costs 40% less to run than Opus 5 on typical workloads.",
  },
];

const FACTS = extractPastThemeFacts(PAST_MD, 5, PAST_D1);

// --- Candidatos reais --------------------------------------------------------
const SENATE_INQUIRY = {
  url: "https://www.theguardian.com/australia-news/2026/sep/27/sam-altman-openai-dario-amodei-anthropic-senate-inquiry-medicare-hack-rogue-ai-agent-leak",
  title: "Heads of OpenAI and Anthropic called to face Senate inquiry after rogue agent incidents",
  summary:
    "Sam Altman and Dario Amodei have been invited to appear before the Greens-led inquiry into AI and datacentres Follow our Australia news live blog for latest updates Get our new political email , free app or daily news podcast The chief executives of OpenAI and Anthropic have been called to face a Senate inquiry after rogue OpenAI agents hacked Australian and US government websites.",
};
const ARGON_G1 = {
  url: "https://g1.globo.com/tecnologia/noticia/2026/09/30/google-lanca-gemini-4-e-diz-que-ele-pode-rivalizar-com-openai-e-anthropic.ghtml",
  title: "Google lança Gemini 4 Argon e diz que nova IA pode rivalizar com OpenAI e Anthropic | G1",
  summary:
    "A Alphabet, controladora do Google, anunciou nesta quarta-feira um novo modelo de inteligência artificial de ponta para liderar a nova geração Gemini 4, em mais uma tentativa de alcançar as rivais Anthropic e OpenAI na corrida pela IA.",
};
const ARGON_GUARDIAN = {
  url: "https://www.theguardian.com/technology/2026/oct/01/google-releases-gemini-model-restrictions",
  title: "Google rolls out new Gemini AI model but restricts access over safety concerns",
  summary:
    "Tech company releases Gemini 4 Argon only to a vetted group of cybersecurity experts to avoid misuse by hackers Google on Wednesday said it would withhold its most powerful artificial intelligence model from the public for now, releasing Gemini 4 Argon only to a vetted group of cybersecurity experts to avoid misuse by hackers.",
};
// Repetições reais da saga dos agentes (fato de 260928/260925) que a regra
// antiga barrava por "agente" e que precisam CONTINUAR barradas (guard #9646).
const GOV_INVASION_EPOCA = {
  url: "https://epocanegocios.globo.com/inteligencia-artificial/noticia/2026/09/cdatadona-do-chatgpt-diz-que-seus-robos-podem-ter-invadido-sistemas-de-varios-orgaos-do-governo-dos-eua.ghtml",
  title: "Dona do ChatGPT diz que seus agentes podem ter invadido sistemas de vários órgãos do governo dos EUA",
  summary:
    'Agentes da OpenAI tentaram obter informações de "governos, universidades, agências públicas e outras instituições". Revelações surgem dias depois do primeiro-ministro australiano denunciar que a empresa violou arquivos não públicos no site do seu programa de saúde governamental',
};
const GOV_INVASION_SINDPD = {
  url: "https://sindpd.org.br/2026/09/28/sistemas-eua-agentes-de-ia/",
  title: "Sistemas do governo dos EUA podem ter sido invadidos por agentes de IA",
  summary:
    "Agentes de IA - OpenAI alertou sobre possíveis acessos indevidos realizados por seus agentes de inteligência artificial (IA)",
};
const IMAGES_G1 = {
  url: "https://g1.globo.com/tecnologia/noticia/2026/09/26/openai-publicacao-imagens.ghtml",
  title: "OpenAI admite publicação indevida de imagens de usuários do ChatGPT | G1",
  summary:
    "Segundo a empresa, agentes de IA publicaram o conteúdo em sites de hospedagem por meio de links que não estavam listados publicamente. A maioria das imagens já foi removida.",
};
// Sem relação com o fato de 260925 — só cita "agentes".
const LINGUA_PROPRIA = {
  url: "https://exame.com/inteligencia-artificial/agentes-de-ia-passam-a-se-comunicar-em-lingua-propria-incompreensivel-para-humanos/",
  title: "Agentes de IA passam a se comunicar em 'língua própria' incompreensível para humanos",
  summary:
    "Uma pesquisa da startup Emergence AI descobriu que sistemas autônomos, ao interagir em grupo, desenvolvem gírias e atalhos que só eles entendem",
};
const PROCURA_SE = {
  url: "https://exame.com/inteligencia-artificial/procura-se-exame-e-saint-paul-abrem-vagas-para-interessados-em-aprender-ia-do-zero-participe-3/",
  title: "Procura-se: EXAME e Saint Paul abrem vagas para interessados em aprender IA do zero; participe | Exame",
  summary:
    "O avanço dos agentes de inteligência artificial pode criar funções híbridas para profissionais que entendam tecnologia, processos e tomada de decisão · Estudos da OIT, Anthropic e Microsoft mostram quais atividades profissionais estão mais expostas à automação e quais ainda dependem de julgamento humano",
};

function runPass1d(articles: Array<{ url: string; title: string; summary: string; flag?: string }>) {
  const entities = new Set(FACTS.keys());
  return dedup(
    articles, new Set(), 0.85, [], 0.7, [], 0.6, undefined, 0.55,
    entities, [], [], new Map(), FACTS,
  );
}

describe("extractPastThemeFacts (#9646)", () => {
  it("liga cada entidade de 'Temas cobertos' à manchete + D1 da própria edição", () => {
    assert.deepEqual([...FACTS.keys()].sort(), ["agente", "amodei", "argon", "claude", "opus"]);
    assert.match(FACTS.get("argon")!, /Seu próximo modelo/);
    assert.match(FACTS.get("argon")!, /Gemini 4 Argon: our next era/);
    assert.match(FACTS.get("amodei")!, /Introducing Claude Opus 5\.5/);
    assert.doesNotMatch(FACTS.get("amodei")!, /Argon/);
  });

  it("sem D1 local, o fato é só a manchete", () => {
    const facts = extractPastThemeFacts(PAST_MD, 5, []);
    assert.equal(facts.get("argon"), "Seu próximo modelo de código pode ser o Argon?");
  });

  it("respeita a janela de edições", () => {
    const facts = extractPastThemeFacts(PAST_MD, 1, PAST_D1);
    assert.deepEqual([...facts.keys()], ["argon"]);
  });
});

describe("matchesRecentThemeFact (#9646)", () => {
  it("entidade sem fato em comum não casa (Guardian 'Senate inquiry' × D1 Opus 5.5 de 260923)", () => {
    assert.equal(matchesRecentThemeFact(SENATE_INQUIRY.title, SENATE_INQUIRY.summary, FACTS), null);
  });

  it("entidade + fato em comum casa (Gemini 4 Argon × D1 de 261001)", () => {
    const m = matchesRecentThemeFact(ARGON_G1.title, ARGON_G1.summary, FACTS);
    assert.equal(m?.entity, "argon");
    assert.ok(m!.sharedTerms.includes("gemini"));
  });

  it("substring de outra palavra não conta como entidade", () => {
    const facts = new Map([["argon", "Gemini 4 Argon"]]);
    assert.equal(matchesRecentThemeFact("Paragonia Gemini 4", "", facts), null);
  });

  it("plural regular da entidade conta (agente ↔ agentes)", () => {
    const facts = new Map([["agente", "Agente rebelde invade sistema de governo"]]);
    assert.equal(
      matchesRecentThemeFact("Agentes invadem sistema do governo", "", facts)?.entity,
      "agente",
    );
  });

  it("a própria entidade (e plural) não serve de corroboração", () => {
    const facts = new Map([["agente", "Agente agentes"]]);
    assert.equal(matchesRecentThemeFact("Agentes de IA e o agente", "", facts), null);
  });

  it("themeFactTokens ignora stopwords e mantém números curtos", () => {
    const t = themeFactTokens("Google lança Gemini 4 e diz que a IA é nova");
    assert.ok(t.has("gemini") && t.has("4") && t.has("google"));
    assert.ok(!t.has("que") && !t.has("ia") && !t.has("e"));
  });
});

describe("dedup Pass-1d com fato (#9646) — casos reais medidos", () => {
  it("desdobramento novo passa: Guardian 'Senate inquiry Altman/Amodei' (260928, recolocado à mão pelo editor)", () => {
    const r = runPass1d([SENATE_INQUIRY]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.removed.length, 0);
  });

  it("repetição real segue barrada: Gemini 4 Argon em 261002 (D1 de 261001)", () => {
    const r = runPass1d([ARGON_G1, ARGON_GUARDIAN]);
    assert.equal(r.kept.length, 0);
    assert.equal(r.removed.length, 2);
    for (const x of r.removed) {
      assert.ok(x.dedup_note.includes('theme-entity match: "argon"'), x.dedup_note);
      assert.ok(x.dedup_note.includes("fato em comum"), x.dedup_note);
    }
  });

  it("repetições da saga dos agentes que a regra antiga barrava seguem barradas (260929)", () => {
    const r = runPass1d([GOV_INVASION_EPOCA, GOV_INVASION_SINDPD, IMAGES_G1]);
    assert.equal(r.kept.length, 0, r.kept.map((k) => k.title).join(" / "));
    assert.equal(r.removed.length, 3);
  });

  it("item que só cita 'agentes', sem o fato de 260925, passa", () => {
    const r = runPass1d([LINGUA_PROPRIA, PROCURA_SE]);
    assert.equal(r.removed.length, 0, r.removed.map((x) => x.dedup_note).join(" / "));
    assert.equal(r.kept.length, 2);
  });

  it("editor_submitted segue só marcado, nunca descartado (#4192)", () => {
    const r = runPass1d([{ ...ARGON_G1, flag: "editor_submitted" }]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].theme_entity_flagged, "argon");
  });

  it("sem mapa de fatos (caller legado), regra antiga só-entidade preservada", () => {
    const r = dedup(
      [SENATE_INQUIRY], new Set(), 0.85, [], 0.7, [], 0.6, undefined, 0.55,
      new Set(["amodei"]), [],
    );
    assert.equal(r.removed.length, 1);
  });
});
