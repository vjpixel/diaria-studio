/**
 * #9595 — regressão: o D1 de 261005 (bra1.com.br, "554 deepfakes") era a
 * mesma história do D1 de 261002 ("VigIA: 1º turno...", Agência Lupa) — mesmas
 * cifras (Lula 379, Flávio Bolsonaro 190), outro veículo. URL e título
 * diferentes, nenhum produto+versão: dedup e MESMO FATO (#9100/#9386) passaram
 * limpos. Dados reais de data/editions/2610/261002 e 261005 (o resumo do bra1
 * chegou truncado/mojibake; as cifras estavam em `summary_rejected`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractFactNumbers,
  findSameFactMatches,
  findSameFactNumberMatches,
  formatHighlightSameFactNotes,
  removeSameFactSecondary,
} from "../scripts/lib/same-fact-check.ts";
import { extractHighlightCandidates } from "../scripts/check-highlight-themes.ts";
import { extractPastDestaqueTitles } from "../scripts/lib/past-editions-extract.ts";

const BRA1_URL =
  "https://www.bra1.com.br/tecnologia/id-702240/deepfakes_com_ia_explodem_nas_redes_sociais_mesmo_sendo_proibidos_antes_das_eleicoes_de_2026";
const BRA1 = {
  kind: "highlight",
  rank: 1,
  title: "Deepfakes com IA explodem nas redes sociais mesmo sendo proibidos antes das eleições de 2026",
  url: BRA1_URL,
  summary: "Investiga��o revela que 554 v�deos e imagens falsos criados por intelig�ncia artificial foram postados durante a campanha, com 29 vindo de",
  fact_text:
    "Monitoramento VigIA/Lupa encontrou 554 deepfakes durante campanha 2026. Apenas 40% tinha labels de transparência obrigatória. Presidente Lula em 379 publicações falsas, Flávio Bolsonaro em 190. Maioria vinha de contas anônimas (525 de 554).",
};

const VIGIA_URL =
  "https://www.agencialupa.org/noticias/2026/10/01/vigia-1o-turno-tem-quase-um-conteudo-eleitoral-com-ia-por-hora-nas-redes/";
const PAST_261002 = [
  {
    aammdd: "261002",
    title: "VigIA: 1º turno tem quase um conteúdo eleitoral com IA por hora nas redes",
    url: VIGIA_URL,
    summary:
      "Projeto VigIA monitora conteúdo eleitoral gerado por IA no Brasil. Entre agosto e setembro, identificados 920 posts com IA, 60% deepfakes de jornalistas. Lula apareceu em 379 conteúdos manipulados contra 190 de Bolsonaro. Facebook e Instagram concentram maioria dos casos.",
  },
  {
    aammdd: "261002",
    title: "Anthropic planeja IPO para novembro e mira avaliação de até US$ 2 trilhões",
    url: "https://finance.yahoo.com/technology/article/anthropic-reportedly-looking-to-ipo-as-early-as-mid-november-180315768.html",
    summary: "Dona do Claude pode iniciar apresentação da oferta a investidores na semana de 9 de novembro e pretende estrear na bolsa até o fim do ano",
  },
];

test("#9595: extractFactNumbers — só cifras distintivas (sem ano, redondo, %, versão, pequena)", () => {
  const n = extractFactNumbers("Em 2026, 554 deepfakes; 40% com label; 100 milhões; Sonnet 5.5; top 10; 1.234 posts; 29 contas");
  assert.deepEqual([...n].sort(), ["1234", "554"]);
});

test("#9595: caso real — D1 261005 (bra1) casa com D1 261002 (VigIA) pelas cifras 190 e 379", () => {
  // Sinal de produto+versão (#9100/#9386) não pega — é o furo da issue.
  assert.equal(findSameFactMatches([BRA1], PAST_261002).length, 0);
  const w = findSameFactNumberMatches([BRA1], PAST_261002);
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_edition, "261002");
  assert.equal(w[0].matched_url, VIGIA_URL);
  assert.equal(w[0].evidence, "numbers");
  assert.equal(w[0].matched_bucket, "highlight");
  assert.deepEqual(w[0].shared_numbers, ["190", "379"]);
  assert.deepEqual(w[0].shared_products, []);
});

test("#9595: sem o summary_rejected (fact_text) o resumo mojibake não basta — o campo é load-bearing", () => {
  const { fact_text: _omit, ...semFact } = BRA1;
  assert.equal(findSameFactNumberMatches([semFact], PAST_261002).length, 0);
});

test("#9595: 1 cifra em comum não sinaliza; mesma URL é pulada; passado secundário não entra", () => {
  const umaCifra = { ...BRA1, fact_text: "Lula em 379 publicações falsas." };
  assert.equal(findSameFactNumberMatches([umaCifra], PAST_261002).length, 0);
  assert.equal(findSameFactNumberMatches([{ ...BRA1, url: VIGIA_URL }], PAST_261002).length, 0);
  const secundario = PAST_261002.map((p) => ({ ...p, bucket: "radar" }));
  assert.equal(findSameFactNumberMatches([BRA1], secundario).length, 0);
});

test("#9595: warning por cifras nunca remove item do pool (só evidência por título remove)", () => {
  const w = findSameFactNumberMatches([{ ...BRA1, kind: "radar" }], PAST_261002);
  assert.equal(w.length, 1);
  const approved = { radar: [{ url: BRA1_URL, title: BRA1.title }] };
  const { approved: out, removed } = removeSameFactSecondary(approved, w);
  assert.equal(removed.length, 0);
  assert.equal((out.radar as unknown[]).length, 1);
});

test("#9595: formatHighlightSameFactNotes — aviso para destaque ainda aprovado (visível em --no-gates)", () => {
  const w = findSameFactNumberMatches([BRA1], PAST_261002);
  const notes = formatHighlightSameFactNotes(
    { same_fact_warnings: w },
    { highlights: [{ url: BRA1_URL, article: { url: BRA1_URL, title: BRA1.title } }] },
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /MESMO FATO — D1 .*261002.*cifras: 190, 379/);
  // Item que já não é destaque não gera aviso; shape inválida é fail-soft.
  assert.deepEqual(formatHighlightSameFactNotes({ same_fact_warnings: w }, { highlights: [] }), []);
  assert.deepEqual(formatHighlightSameFactNotes(null, {}), []);
  assert.deepEqual(formatHighlightSameFactNotes({ same_fact_warnings: "x" }, { highlights: [] }), []);
});

// Regressão #9750: no 01-approved.json a flag `same_fact_demoted` vive em
// `article` (markPoolArticles marca o artigo do pool; buildHighlight o põe em
// `article`). O guard só olhava o nível de cima e nunca casava.
test("#9750: formatHighlightSameFactNotes pula destaque com same_fact_demoted em article", () => {
  const w = findSameFactNumberMatches([BRA1], PAST_261002);
  const mark = { matched_edition: "261002", matched_destaque: 1 };
  assert.deepEqual(
    formatHighlightSameFactNotes(
      { same_fact_warnings: w },
      { highlights: [{ url: BRA1_URL, article: { url: BRA1_URL, title: BRA1.title, same_fact_demoted: mark } }] },
    ),
    [],
  );
  // Flag no nível de cima (shape do 01-categorized.json) segue funcionando.
  assert.deepEqual(
    formatHighlightSameFactNotes(
      { same_fact_warnings: w },
      { highlights: [{ url: BRA1_URL, same_fact_demoted: mark, article: { url: BRA1_URL, title: BRA1.title } }] },
    ),
    [],
  );
});

test("#9595: extractPastDestaqueTitles devolve o resumo; extractHighlightCandidates lê summary_rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "same-fact-9595-"));
  try {
    const editions = join(root, "editions");
    mkdirSync(join(editions, "2610", "261002", "_internal"), { recursive: true });
    writeFileSync(
      join(editions, "2610", "261002", "_internal", "01-approved.json"),
      JSON.stringify({ highlights: PAST_261002.map((p) => ({ url: p.url, article: { url: p.url, title: p.title, summary: p.summary } })) }),
    );
    const past = extractPastDestaqueTitles(editions, 3, "261005");
    assert.equal(past.length, 2);
    assert.equal(past[0].summary, PAST_261002[0].summary);

    const cat = join(root, "01-categorized.json");
    writeFileSync(
      cat,
      JSON.stringify({ highlights: [{ rank: 1, article: { url: BRA1_URL, title: BRA1.title, summary: BRA1.summary, summary_rejected: BRA1.fact_text } }] }),
    );
    const cands = extractHighlightCandidates(cat);
    assert.equal(cands[0].fact_text, BRA1.fact_text);
    const w = findSameFactNumberMatches(
      cands.map((c) => ({ kind: "highlight", rank: c.rank, title: c.title, url: c.url, summary: c.summary, fact_text: c.fact_text })),
      past,
    );
    assert.equal(w.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
