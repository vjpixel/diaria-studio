/**
 * Testes da morfologia de aquisição em DEAL_PATTERNS (#7415).
 *
 * Edição 260904: "NVIDIA to Acquire Hugging Face" chegou a lancamento[] por
 * duas razões acumuladas — (1) o short-circuit type_hint==="lancamento"
 * (#1173/#1453, decisão de design: agent que leu a página vence) impede
 * isBusinessDeal de rodar quando o agent etiqueta mal, e (2) o padrão
 * `acquir(es|ed|ing)?` NÃO casava com o infinitivo solto "Acquire" (o \b
 * interno falha quando o sufixo não casa) — então mesmo sem o hint do agent
 * o artigo caía no default silencioso `lancamento-default`. O guard #6440
 * (lancamento-has-product-signal) pegou os 2 itens em runtime e os moveu
 * para radar[].
 *
 * Este teste trava: (a) o fix do fix (2) — infinitivo "acquire" e morfologia
 * PT (adquiriu/adquirir) agora casam e demovem para noticias via
 * lancamento-business-deal; (b) a precedência documentada (1) — type_hint
 * do agent vence isBusinessDeal por design; reverter isso exige decisão
 * deliberada (comentário da #7415: só na reincidência, com o precedente das
 * heurísticas pré-short-circuit).
 *
 * Fixtures são os títulos reais da edição 260904 (NVIDIA-Hugging Face,
 * openai.com/jalapeno) — o `runtime-fixes.jsonl` de 260904 não é
 * git-tracked (data/ é gitignored), então os títulos são inline aqui.
 *
 * Decisão sobre `adquir\w*` (review #7439 F4): o reviewer tem razão que o
 * `\w*` expande a cobertura de PT ~5× (adquiremos/adquiriam/etc.). Não é
 * falso-positivo real porque `isBusinessDeal()` só roda DENTRO do bloco
 * `LANCAMENTO_DOMAINS.has(host)` em categorizeWithRule() — títulos em
 * domínio não-oficial (ex: "Como adquirir bons hábitos") caem em
 * `noticias-default` sem nunca tocar DEAL_PATTERNS. Probe em
 * ./probe-7415.ts confirmou: 13 títulos não-oficiais → todos
 * `noticias-default`; em domínios oficiais, os 2 deal reais caem em
 * `lancamento-business-deal` e os lançamentos genuínos seguem
 * `lancamento-default` (não demovidos). Teste anti-falso-positivo acima
 * trava isso. Se um dia isBusinessDeal subir para antes do gate de
 * domínio oficial, reavaliar — mas não é o caso agora.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeWithRule, type Article } from "../scripts/lib/launch-heuristics.ts";

const NVIDIA_HF = {
  url: "https://blogs.nvidia.com/blog/nvidia-to-acquire-hugging-face/",
  title: "NVIDIA to Acquire Hugging Face",
} as const;

describe("DEAL_PATTERNS — infinitivo solto e morfologia PT (#7415)", () => {
  it("fixture real da 260904 sem type_hint → noticias via lancamento-business-deal (antes: lancamento-default)", () => {
    const r = categorizeWithRule({ ...NVIDIA_HF } as Article);
    assert.equal(r.category, "noticias", JSON.stringify(r));
    assert.equal(r.rule, "lancamento-business-deal", JSON.stringify(r));
  });

  it("infinitivo solto 'to Acquire' casa (regressão do bug lexical)", () => {
    const cases = [
      "NVIDIA to Acquire Hugging Face",
      "OpenAI to acquire io Products",
      "Google acquires Wiz for $32 billion", // já casava antes (es); mantém
      "NVIDIA acquired Run:ai", // já casava antes (ed); mantém
      "Microsoft acquiring nuTonomy", // já casava antes (ing); mantém
    ];
    for (const title of cases) {
      const r = categorizeWithRule({ url: "https://blogs.nvidia.com/blog/x/", title } as Article);
      assert.equal(r.category, "noticias", `${title}: ${JSON.stringify(r)}`);
      assert.equal(r.rule, "lancamento-business-deal", `${title}: ${JSON.stringify(r)}`);
    }
  });

  it("morfologia PT de aquisição casa (adquiriu/adquirir/adquirida)", () => {
    const cases = [
      "NVIDIA adquiriu a Hugging Face por US$ 5 bilhões",
      "Por que a OpenAI quer adquirir a io",
      "Startup adquirida pela Anthropic integrará o Claude",
    ];
    for (const title of cases) {
      const r = categorizeWithRule({ url: "https://blogs.nvidia.com/blog/x/", title } as Article);
      assert.equal(r.category, "noticias", `${title}: ${JSON.stringify(r)}`);
      assert.equal(r.rule, "lancamento-business-deal", `${title}: ${JSON.stringify(r)}`);
    }
  });

  it("anti-falso-positivo: verbo de anúncio de produto continua lancamento (default com sinal)", () => {
    const keep = [
      { url: "https://blogs.nvidia.com/blog/nvidia-rtx-spark-announced/", title: "NVIDIA Announces Jetson Spark for Local AI" },
      { url: "https://blog.google/technology/ai/introducing-new-model/", title: "Introducing Gemma 4: celebrating 100 million downloads" },
    ];
    for (const a of keep) {
      const r = categorizeWithRule(a as Article);
      assert.equal(r.category, "lancamento", `${a.title}: ${JSON.stringify(r)}`);
    }
  });
});

describe("precedência documentada: short-circuit type_hint vence isBusinessDeal (#1173/#1453, #7415)", () => {
  it("agent que leu a página e disse lancamento GANHA — mesmo com título de aquisição (design, não bug)", () => {
    // É exatamente o caminho que produziu o runtime fix da 260904: o guard
    // #6440 no Stage 1 é o backstop desenhado pra esse caso, não o categorize.
    // Se este teste um dia falhar porque isBusinessDeal subiu pra antes do
    // short-circuit, isso REVERTE decisão de design documentada — atualizar
    // este teste só como decisão deliberada (comentário da #7415).
    const r = categorizeWithRule({ ...NVIDIA_HF, type_hint: "lancamento" } as Article);
    assert.equal(r.category, "lancamento", JSON.stringify(r));
    assert.equal(r.rule, "lancamento-type-hint", JSON.stringify(r));
  });

  it("type_hint noticia → noticias (hint contra-heurística do agent respeitado)", () => {
    // Só a categoria é pinada — com o fix da morfologia (#7415), o rule
    // legítimo aqui passou a ser lancamento-business-deal (isBusinessDeal
    // roda antes da regra type-hint-noticia), antes era lancamento-type-hint-noticia.
    const r = categorizeWithRule({ ...NVIDIA_HF, type_hint: "noticia" } as Article);
    assert.equal(r.category, "noticias", JSON.stringify(r));
  });
});
