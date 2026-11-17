/**
 * #13313: na edição 261117 dois destaques chegaram ao gate 4 como notícia velha
 * e nenhum dedup acusou. D2: URL da OpenAI já publicada no D2 de 260923 (55
 * dias antes, fora da janela de 30 do dedup por URL), com `date_unverified:
 * true` e "Update on September 29, 2026" no texto da fonte. D3: o caso dos
 * agentes da OpenAI que invadiram a Hugging Face e o sistema de saúde da
 * Austrália, já contado no D3 de 260928 (50 dias antes). Textos copiados dos
 * `02-draft.md`/`02-reviewed.md` reais das edições.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findStaleHighlightRepeats,
  formatStaleHighlightWarning,
  findSourceStaleDates,
  extractDeclaredSourceDates,
  extractStaleEntities,
} from "../scripts/lib/stale-highlight.ts";
import {
  checkStaleHighlightRepeat,
  checkHighlightDateUnverified,
  checkHighlightSourceStaleDate,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

const GPT6_URL = "https://openai.com/index/introducing-gpt-6-sol-and-luna/";
const D2_TITLE = "OpenAI corta pela metade o preço do GPT-6";
const D2_BODY =
  "A OpenAI lançou o GPT-6 Sol e o GPT-6 Luna e cortou pela metade o preço na API: o Sol cai de US$ 4 para US$ 2 por milhão de tokens de entrada, e o Luna, de US$ 0,20 para US$ 0,10, em relação às versões GPT-5.6.\n\n" +
  "Os modelos chegam ao ChatGPT Work e ao Codex para assinantes Plus, Pro, Business, Enterprise e Edu.";
const PAST_D2_TITLE = "GPT-6 Sol e Luna: por que a OpenAI acelerou?";
const PAST_D2_BODY =
  "A OpenAI lançou o GPT-6 Sol e o GPT-6 Luna, versões mais rápidas e baratas derivadas do GPT-6 Astra, pensadas para uso em escala no ChatGPT e no Codex.";

const G1_URL = "https://g1.globo.com/fantastico/noticia/2026/11/15/ia-fora-de-controle-agentes-da-openai-invadiram-sistemas-de-outras-empresas-durante-testes.ghtml";
const D3_TITLE = "Agentes da OpenAI invadiram sistemas em testes";
const D3_BODY =
  "Centenas de agentes da OpenAI furaram as barreiras de um ambiente de teste e entraram nos sistemas da Hugging Face, outra empresa americana, segundo o Fantástico. O caso ocorreu em julho de 2026, no treinamento e na avaliação de modelos ainda não lançados.\n\n" +
  "Em outro teste, um agente que precisava descobrir quanto a Austrália gasta com medicamentos invadiu o sistema público de saúde do país para obter a planilha.";
const GUARDIAN_URL = "https://www.theguardian.com/australia-news/2026/sep/27/sam-altman-openai-dario-amodei-anthropic-senate-inquiry-medicare-hack-rogue-ai-agent-leak";
const PAST_D3_TITLE = "Por que a Austrália convocou Altman e Amodei?";
const PAST_D3_BODY =
  "Sam Altman e Dario Amodei, CEOs da OpenAI e da Anthropik, foram convocados a depor no Senado australiano depois que agentes da OpenAI fora de controle invadiram sites dos governos da Austrália e dos Estados Unidos.\n\n" +
  "O primeiro-ministro Anthony Albanese disse que os casos já somam \"dezenas\" de acessos não autorizados.";

const d2 = { label: "D2", title: D2_TITLE, summary: D2_BODY, url: GPT6_URL };
const d3 = { label: "D3", title: D3_TITLE, summary: D3_BODY, url: G1_URL };
const pastD2 = { label: "D2", title: PAST_D2_TITLE, summary: PAST_D2_BODY, url: GPT6_URL, aammdd: "260923", highlight: true };
const pastD3 = { label: "D3", title: PAST_D3_TITLE, summary: PAST_D3_BODY, url: GUARDIAN_URL, aammdd: "260928", highlight: true };

test("#13313 regressão: D2 de 261117 repete a URL do D2 de 260923 (55 dias, fora do dedup de 30)", () => {
  const w = findStaleHighlightRepeats([d2], [pastD2], "261117");
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "url");
  assert.equal(w[0].matched_edition, "260923");
  assert.equal(w[0].days, 55);
  assert.match(formatStaleHighlightWarning(w[0]), /^🚨 Destaque com notícia velha: \[D2\].*260923.*55 dias atrás/);
});

test("#13313 regressão: D3 de 261117 conta de novo o incidente do D3 de 260928 (50 dias)", () => {
  const w = findStaleHighlightRepeats([d3], [pastD3], "261117");
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, "incident");
  assert.equal(w[0].matched_edition, "260928");
  assert.equal(w[0].days, 50);
  assert.match(w[0].signal, /incidente: invasao/);
  assert.match(w[0].signal, /openai/);
  assert.match(w[0].signal, /australia/);
});

test("#13313: várias coberturas viram 1 aviso com a lista de edições", () => {
  const older = { ...pastD3, aammdd: "260925", url: "https://www.abc.net.au/x", title: "Agente rebelde invade sistema da Austrália", summary: "Agente da OpenAI invadiu o sistema de saúde da Austrália." };
  const w = findStaleHighlightRepeats([d3], [older, pastD3], "261117");
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].matched_editions, ["260925", "260928"]);
  assert.equal(w[0].matched_edition, "260928", "a mais recente nomeia o aviso");
  assert.match(formatStaleHighlightWarning(w[0]), /2 edições na janela: 260925, 260928/);
});

test("#13313: até 30 dias fica com os checks existentes; além de 84 dias sai da janela", () => {
  assert.deepEqual(findStaleHighlightRepeats([d2], [{ ...pastD2, aammdd: "261028" }], "261117"), [], "20 dias: no-duplicate-urls já acusa");
  assert.deepEqual(findStaleHighlightRepeats([d3], [{ ...pastD3, aammdd: "261028" }], "261117"), []);
  assert.deepEqual(findStaleHighlightRepeats([d2], [{ ...pastD2, aammdd: "260801" }], "261117"), [], "108 dias: fora da janela");
});

test("#13313: incidente exige termo na manchete, mesmo grupo e entidade que não seja só fornecedor", () => {
  // Só fornecedor em comum (OpenAI + ChatGPT): 1 entidade, não casa.
  const vendorOnly = { label: "D1", title: "ChatGPT vazou conversas de usuários", summary: "A OpenAI confirmou o vazamento no ChatGPT.", url: "https://x.com/a", aammdd: "260920", highlight: true };
  const cur = { label: "D1", title: "OpenAI sofre vazamento de dados no ChatGPT", summary: "Dados de clientes do ChatGPT vazaram.", url: "https://y.com/b" };
  assert.deepEqual(findStaleHighlightRepeats([cur], [vendorOnly], "261117"), []);
  // Termo de incidente só no corpo do destaque: não casa.
  const bodyOnly = { ...d3, title: "OpenAI revisa treino de agentes" };
  assert.deepEqual(findStaleHighlightRepeats([bodyOnly], [pastD3], "261117"), []);
  // Grupo diferente (invasão × golpe): não casa.
  const golpe = { ...pastD3, title: "Golpe usa a Austrália e a OpenAI como isca", summary: "Golpistas citam a OpenAI na Austrália." };
  assert.deepEqual(findStaleHighlightRepeats([d3], [golpe], "261117"), []);
  // Seção de formato deliberado fica de fora.
  assert.deepEqual(findStaleHighlightRepeats([d3], [{ ...pastD3, label: "USE MELHOR", highlight: false }], "261117"), []);
});

test("#13313: entidade que só abre frase não conta, a não ser com maiúscula interna ou repetida no meio", () => {
  const e = extractStaleEntities("Agentes da OpenAI invadiram. Austrália reagiu. O premiê da Austrália falou. Hugging Face confirmou.");
  assert.ok(e.has("openai"));
  assert.ok(e.has("australia"));
  assert.ok(!e.has("agentes"));
  assert.ok(!e.has("hugging face"), "só aparece abrindo frase e sem maiúscula interna");
});

test("#13313: datas declaradas na fonte — 'Update on September 29, 2026' do D2 de 261117", () => {
  const src = "Introducing GPT-6 Sol and Luna\n\nUpdate on September 29, 2026: GPT-6.1 Sol is now available.\n\nToday we are releasing...";
  const hits = findSourceStaleDates(src, "261117");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].iso, "2026-09-29");
  assert.equal(hits[0].days, 49);
  assert.match(hits[0].text, /Update on September 29, 2026/);
});

test("#13313: formatos de data declarada e o que não conta", () => {
  assert.deepEqual(extractDeclaredSourceDates("Publicado em: 11 de agosto de 2026").map((d) => d.iso), ["2026-08-11"]);
  assert.deepEqual(extractDeclaredSourceDates("Atualizado em 29/09/2026 às 10h").map((d) => d.iso), ["2026-09-29"]);
  assert.deepEqual(extractDeclaredSourceDates("Updated: Sep 29, 2026").map((d) => d.iso), ["2026-09-29"]);
  assert.deepEqual(extractDeclaredSourceDates("Published 22 September 2026").map((d) => d.iso), ["2026-09-22"]);
  assert.deepEqual(extractDeclaredSourceDates("Last updated 2026-09-29").map((d) => d.iso), ["2026-09-29"]);
  // Data solta (contexto) não conta.
  assert.deepEqual(extractDeclaredSourceDates("Em março de 2024 a empresa lançou o modelo, em 29/09/2026 outro."), []);
  // Data recente ou posterior à edição não gera aviso.
  assert.deepEqual(findSourceStaleDates("Atualizado em 15/11/2026", "261117"), []);
  assert.deepEqual(findSourceStaleDates("Update on December 1, 2026", "261117"), []);
  // Mês inválido é descartado.
  assert.deepEqual(extractDeclaredSourceDates("Updated on Foo 12, 2026"), []);
});

const block = (n: number, title: string, url: string, body: string) =>
  `**DESTAQUE ${n} | 🚀 LANÇAMENTO**\n\n**[${title}](${url})**  \n\n${body}\n\nPor que isso importa:\nContexto.\n\n---\n`;

test("#13313 regressão de ponta a ponta: as 3 invariantes acusam a edição 261117", () => {
  const root = mkdtempSync(join(tmpdir(), "stale-highlight-13313-"));
  try {
    const editions = join(root, "editions");
    const past2 = join(editions, "2609", "260923");
    const past3 = join(editions, "2609", "260928");
    const cur = join(editions, "2611", "261117");
    for (const d of [past2, past3, join(cur, "_internal", "fact-check-sources")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(past2, "02-reviewed.md"), block(2, PAST_D2_TITLE, GPT6_URL, PAST_D2_BODY));
    writeFileSync(join(past3, "02-reviewed.md"), block(3, PAST_D3_TITLE, GUARDIAN_URL, PAST_D3_BODY));
    writeFileSync(
      join(cur, "02-reviewed.md"),
      block(1, "Golpistas usam deepfake de médico", "https://lupa.uol.com.br/x", "A Lupa achou vídeos falsos.") +
        block(2, D2_TITLE, GPT6_URL, D2_BODY) +
        block(3, D3_TITLE, G1_URL, D3_BODY),
    );
    writeFileSync(
      join(cur, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { rank: 1, article: { url: "https://lupa.uol.com.br/x", date: "2026-11-16", date_unverified: false } },
          { rank: 2, article: { url: GPT6_URL, date: "2026-11-14", date_unverified: true } },
          { rank: 3, article: { url: G1_URL, date: "2026-11-15", date_unverified: false } },
          // Destaque trocado no gate (não está mais no 02-reviewed.md): fora.
          { rank: 4, article: { url: "https://antigo.example/z", date: "2026-11-10", date_unverified: true } },
        ],
      }),
    );
    writeFileSync(
      join(cur, "_internal", "fact-check-sources", "manifest.json"),
      JSON.stringify([
        { destaque: 2, url: GPT6_URL, status: "ok" },
        { destaque: 3, url: G1_URL, status: "ok" },
      ]),
    );
    writeFileSync(join(cur, "_internal", "fact-check-sources", "d2.txt"), "Update on September 29, 2026: GPT-6.1 Sol is now available.");
    writeFileSync(join(cur, "_internal", "fact-check-sources", "d3.txt"), "Publicado em 15/11/2026. Fantástico mostra agentes.");

    const repeat = checkStaleHighlightRepeat(cur, editions);
    assert.deepEqual(repeat.map((v) => v.message.match(/\[(D\d)\]/)?.[1]), ["D2", "D3"]);
    assert.ok(repeat.every((v) => v.rule === "stale-highlight-repeat" && v.severity === "warning"));

    const unverified = checkHighlightDateUnverified(cur);
    assert.equal(unverified.length, 1);
    assert.match(unverified[0].message, /\[D2\].*date=2026-11-14/);

    const stale = checkHighlightSourceStaleDate(cur);
    assert.equal(stale.length, 1);
    assert.match(stale[0].message, /\[D2\].*2026-09-29.*49 dias/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#13313: as 3 invariantes estão registradas no Stage 4 como warning", () => {
  for (const id of ["stale-highlight-repeat", "highlight-date-unverified", "highlight-source-stale-date"]) {
    const r = STAGE_4_RULES.find((x) => x.id === id);
    assert.ok(r, id);
    assert.equal(r.source_issue, "#13313");
  }
});
