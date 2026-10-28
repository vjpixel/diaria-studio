/**
 * #11496: a mesma história entrou duas vezes na edição 261029.
 *
 *   1. Siri em português: o candidato a D1 (tecnoblog, "iOS 27.2 libera nova
 *      Siri…") repetia o D2 de 261028 (canaltech, "…Apple libera iOS 27.2 com
 *      Siri AI…"). `extractVersionedProducts` não reconhecia "iOS" (inicial
 *      minúscula), então o MESMO FATO não disparava. Depois, demovida de D3,
 *      a Siri voltou ao RADAR repetindo a edição de ontem.
 *   2. Genie 4 em D2 (deepmind.google) e em LANÇAMENTOS (blog.google):
 *      `isIntraEditionDuplicate` devolvia null (Jaccard 0.31, a empresa só na
 *      URL, "We’re" virando a entidade "were").
 *
 * Títulos, URLs e textos copiados das edições reais 261028/261029.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVersionedProducts, findSameFactMatches } from "../scripts/lib/same-fact-check.ts";
import {
  isIntraEditionDuplicate,
  dedupIntraEdition,
  extractNamedEntitiesIntra,
  extractCompanyMentionsFromUrl,
} from "../scripts/dedup-intra-edition.ts";
import { findStoryTwice } from "../scripts/lib/story-twice-in-edition.ts";
import {
  checkStoryTwiceInEdition,
  checkThemeCrossSourceRepeat,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

const SIRI_261028_URL = "https://canaltech.com.br/apps/atualize-ja-apple-libera-ios-272-com-siri-ai-em-portugues/";
const SIRI_261028_APPROVED = "Atualize já: Apple libera iOS 27.2 com Siri AI em português";
const SIRI_261028_REVIEWED = "Apple solta a nova Siri em português no iOS 27.2";
const SIRI_261029_URL = "https://tecnoblog.net/noticias/ios-27-2-libera-nova-siri-em-portugues-no-brasil/";
const SIRI_261029 = "iOS 27.2 libera nova Siri em português no Brasil";

const GENIE_D2_URL = "https://deepmind.google/blog/genie-4-a-new-generation-of-world-simulation/";
const GENIE_D2 = "Genie 4: A new generation of world simulation — Google DeepMind";
const GENIE_D2_REVIEWED = "Genie 4 cria mundos que você comanda por texto";
const GENIE_LANC_URL = "https://blog.google/innovation-and-ai/models-and-research/google-deepmind/introducing-genie-4/";
const GENIE_LANC = "We’re announcing Genie 4, our new world model for real-time interactive simulation";

// --- 1. MESMO FATO com marca em camelCase -----------------------------------

test("#11496: extractVersionedProducts reconhece iOS/macOS/iPadOS (inicial minúscula)", () => {
  assert.deepEqual([...extractVersionedProducts(SIRI_261029)], ["ios 27.2"]);
  assert.deepEqual([...extractVersionedProducts(SIRI_261028_APPROVED)], ["ios 27.2"]);
  assert.deepEqual([...extractVersionedProducts(SIRI_261028_REVIEWED)], ["ios 27.2"]);
  assert.deepEqual([...extractVersionedProducts("macOS 27 chega com Siri nova")], ["macos 27"]);
  assert.deepEqual([...extractVersionedProducts("iPadOS 27.1 corrige bug")], ["ipados 27.1"]);
  // palavra comum em minúsculas segue de fora
  assert.deepEqual([...extractVersionedProducts("versão 2 do app e top 10 dicas")], []);
});

test("#11496: candidato Siri de 261029 casa o D2 de 261028 como MESMO FATO", () => {
  const w = findSameFactMatches(
    [{ kind: "highlight", rank: 1, title: SIRI_261029, url: SIRI_261029_URL }],
    [{ title: SIRI_261028_APPROVED, aammdd: "261028", url: SIRI_261028_URL, bucket: "highlight" }],
  );
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_edition, "261028");
  assert.deepEqual(w[0].shared_products, ["ios 27.2"]);
  assert.equal(w[0].evidence, "title");
});

// --- 2. dedup intra-edição: Genie 4 -----------------------------------------

test("#11496: apóstrofe tipográfica não gera a falsa entidade 'were'", () => {
  const ents = extractNamedEntitiesIntra(GENIE_LANC);
  assert.ok(!ents.has("were"), `entidades: ${[...ents]}`);
  assert.ok(ents.has("genie"));
  // possessivo também sai: "OpenAI's" → openai (stopword de empresa), não "openais"
  assert.ok(!extractNamedEntitiesIntra("OpenAI's Sora Studio arrives").has("openais"));
});

test("#11496: empresa vem também do host e do caminho da URL", () => {
  assert.deepEqual([...extractCompanyMentionsFromUrl(GENIE_LANC_URL)].sort(), ["deepmind", "google"]);
  assert.deepEqual([...extractCompanyMentionsFromUrl(GENIE_D2_URL)].sort(), ["deepmind", "google"]);
  assert.deepEqual([...extractCompanyMentionsFromUrl("https://tecnoblog.net/noticias/x/")], []);
  assert.deepEqual([...extractCompanyMentionsFromUrl("não é url")], []);
});

test("#11496: LANÇAMENTO do Genie 4 é duplicata do D2 (antes: null)", () => {
  const m = isIntraEditionDuplicate(
    { url: GENIE_LANC_URL, title: GENIE_LANC },
    [{ url: GENIE_D2_URL, title: GENIE_D2 }],
  );
  assert.ok(m, "o par do Genie 4 tem que casar");
  assert.equal(m.match_type, "product_version");
  assert.equal(m.matched_highlight, GENIE_D2);
});

test("#11496: dedupIntraEdition tira o Genie 4 de LANÇAMENTOS e preserva o resto", () => {
  const r = dedupIntraEdition(
    {
      highlights: [
        { rank: 1, url: SIRI_261029_URL, title: SIRI_261029 },
        { rank: 2, url: GENIE_D2_URL, title: GENIE_D2 },
      ],
      lancamento: [
        { url: GENIE_LANC_URL, title: GENIE_LANC },
        { url: "https://blog.n8n.io/introducing-n8n-v3/", title: "Introducing n8n 3.0" },
      ],
      radar: [],
    },
    { destaqueCount: 3 },
  );
  assert.deepEqual(r.removed.map((x) => x.url), [GENIE_LANC_URL]);
  assert.deepEqual((r.kept.lancamento ?? []).map((a) => a.url), ["https://blog.n8n.io/introducing-n8n-v3/"]);
});

test("#11496: mesma versão sem segundo sinal NÃO é duplicata (review #9430)", () => {
  assert.equal(
    isIntraEditionDuplicate(
      { url: "https://a.example/x", title: "GPT-6.1 ganha modo de voz" },
      [{ url: "https://b.example/y", title: "GPT-6.1 banido em escolas da Califórnia" }],
    ),
    null,
  );
  // variantes nomeadas diferentes descartam o par, mesmo com os dois
  // títulos com verbo de lançamento
  assert.equal(
    isIntraEditionDuplicate(
      { url: "https://a.example/x", title: "GPT-6.1 Sol launches for coding" },
      [{ url: "https://b.example/y", title: "GPT-6.1 Astra launches for voice" }],
    ),
    null,
  );
  // controle: mesma variante + lançamento casa
  assert.equal(
    isIntraEditionDuplicate(
      { url: "https://a.example/x", title: "GPT-6.1 Sol launches for coding" },
      [{ url: "https://b.example/y", title: "OpenAI lança o GPT-6.1 Sol" }],
    )?.match_type,
    "product_version",
  );
});

test("#11496: dois anúncios diferentes do mesmo blog oficial não casam só pela URL", () => {
  assert.equal(
    isIntraEditionDuplicate(
      { url: "https://blog.google/products/gemini/gemini-app-new-features/", title: "New features in the Gemini app" },
      [{ url: "https://blog.google/technology/ai/gemini-in-chrome-app/", title: "Gemini comes to the Chrome app" }],
    ),
    null,
  );
});

// --- 3. Stage 4: mesma história na edição final -----------------------------

const REVIEWED_261028 = `**DESTAQUE 2 | 📱 APPS**

**[${SIRI_261028_REVIEWED}](${SIRI_261028_URL})**

A Siri reformulada com IA generativa passou a falar português com o iOS 27.2.

Por que isso importa:

Quem tem iPhone compatível passa a usar a assistente em português.

---
`;

const REVIEWED_261029 = `**DESTAQUE 1 | 🇧🇷 BRASIL**

**[Lula promete uma IA brasileira](https://www.cnnbrasil.com.br/economia/money/inteligencia-artificial/reeleito-lula-fala-em-criar-ia-brasileira-e-regular-big-techs/)**

Reeleito, Lula falou em criar uma IA brasileira.

Por que isso importa:

Política industrial de IA entra na agenda.

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[${GENIE_D2_REVIEWED}](${GENIE_D2_URL})**

O Genie 4 gera mundos interativos em tempo real.

Por que isso importa:

Simulação de mundos vira ferramenta.

---

**🛠️ USE MELHOR**

**[Como usar o Genie 4 para criar mundos](https://exemplo.com.br/como-usar-genie-4)**
Tutorial passo a passo. (5 min)

---

**🚀 LANÇAMENTOS**

**[${GENIE_LANC}](${GENIE_LANC_URL})**
O Google DeepMind anunciou o Genie 4.

**[Introducing n8n 3.0](https://blog.n8n.io/introducing-n8n-v3/)**
Nova versão do n8n.

---

**📡 RADAR**

**[${SIRI_261029}](${SIRI_261029_URL})**
A Siri AI chegou ao português no Brasil.

**[Só 3% das empresas viram ganhos com IA, mostra estudo](https://tecnoblog.net/noticias/so-3-das-empresas-viram-ganhos-com-ia-mostra-estudo/)**
Estudo sobre retorno de IA nas empresas.

---
`;

test("#11496: findStoryTwice acusa Genie 4 (D2 × LANÇAMENTOS) e Siri (RADAR × D2 de ontem)", () => {
  const w = findStoryTwice(
    [{ label: "D2", title: GENIE_D2_REVIEWED, url: GENIE_D2_URL }],
    [
      { label: "LANÇAMENTOS", title: GENIE_LANC, url: GENIE_LANC_URL },
      { label: "USE MELHOR", title: "Como usar o Genie 4 para criar mundos", url: "https://exemplo.com.br/como-usar-genie-4" },
      { label: "RADAR", title: SIRI_261029, url: SIRI_261029_URL },
    ],
    [{ label: "D2", title: SIRI_261028_REVIEWED, url: SIRI_261028_URL, aammdd: "261028", highlight: true }],
  );
  assert.deepEqual(
    w.map((x) => [x.scope, x.item_url, x.matched_label]),
    [
      ["edition", GENIE_LANC_URL, "D2"],
      ["past", SIRI_261029_URL, "D2"],
    ],
  );
  assert.equal(w[1].matched_edition, "261028");
});

test("#11496: item de seção passado não conta (só destaques passados)", () => {
  const w = findStoryTwice(
    [],
    [{ label: "LANÇAMENTOS", title: "Google lança Gemini 3.8 Live", url: "https://a.example/x" }],
    [{ label: "LANÇAMENTOS", title: "Build apps with Gemini 3.8 Live", url: "https://b.example/y", aammdd: "260916", highlight: false }],
  );
  assert.deepEqual(w, []);
});

test("#11496 Stage 4: invariante story-twice-in-edition no 02-reviewed.md final (layout nested)", () => {
  const rule = STAGE_4_RULES.find((r) => r.id === "story-twice-in-edition");
  assert.ok(rule && rule.stage === 4);
  const root = mkdtempSync(join(tmpdir(), "story-twice-11496-"));
  try {
    mkdirSync(join(root, "2610", "261028"), { recursive: true });
    mkdirSync(join(root, "2610", "261029"), { recursive: true });
    writeFileSync(join(root, "2610", "261028", "02-reviewed.md"), REVIEWED_261028);
    writeFileSync(join(root, "2610", "261029", "02-reviewed.md"), REVIEWED_261029);
    const v = checkStoryTwiceInEdition(join(root, "2610", "261029"), root);
    assert.equal(v.length, 2, v.map((x) => x.message).join("\n"));
    assert.ok(v.every((x) => x.severity === "warning" && x.rule === "story-twice-in-edition"));
    assert.ok(v.some((x) => x.message.includes(GENIE_LANC_URL) && x.message.includes("D2")));
    assert.ok(v.some((x) => x.message.includes(SIRI_261029_URL) && x.message.includes("261028")));
    // sem 02-reviewed.md: nada
    assert.deepEqual(checkStoryTwiceInEdition(join(root, "2610", "261030"), root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 4. aviso cross-source do passe de tema sobe ao gate 4 ------------------

test("#11496 Stage 4: theme-cross-source-repeat traz o warning cross-source do Stage 1", () => {
  assert.ok(STAGE_4_RULES.some((r) => r.id === "theme-cross-source-repeat" && r.stage === 4));
  const dir = mkdtempSync(join(tmpdir(), "theme-cross-11496-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_261029);
    const theme = {
      warnings: [
        // caso real 261029
        { candidate_rank: 1, candidate_title: SIRI_261029, candidate_url: SIRI_261029_URL, matched_edition: "261028", matched_title: SIRI_261028_APPROVED, jaccard: 0.5, shared_entities: ["siri"], cross_source_match: true },
        // sem cross_source_match: fica de fora
        { candidate_rank: 2, candidate_title: GENIE_D2, candidate_url: GENIE_D2_URL, matched_edition: "261020", matched_title: "x", jaccard: 0.7 },
        // cross-source, mas cortado da edição final: fica de fora
        { candidate_rank: 3, candidate_title: "Outro", candidate_url: "https://cortado.example/a", matched_edition: "261027", matched_title: "y", jaccard: 0.3, cross_source_match: true },
      ],
      same_fact_warnings: [],
    };
    writeFileSync(join(dir, "_internal", "01-highlight-theme-check.json"), JSON.stringify(theme));
    const v = checkThemeCrossSourceRepeat(dir);
    assert.equal(v.length, 1);
    assert.ok(v[0].message.includes(SIRI_261029_URL) && v[0].message.includes("261028"));
    assert.equal(v[0].severity, "warning");

    // já com MESMO FATO: um aviso por item, este sai
    writeFileSync(
      join(dir, "_internal", "01-highlight-theme-check.json"),
      JSON.stringify({ ...theme, same_fact_warnings: [{ item_url: SIRI_261029_URL }] }),
    );
    assert.deepEqual(checkThemeCrossSourceRepeat(dir), []);

    // JSON ilegível: fail-soft
    writeFileSync(join(dir, "_internal", "01-highlight-theme-check.json"), "{nope");
    assert.deepEqual(checkThemeCrossSourceRepeat(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
