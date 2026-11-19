/**
 * #13662: na edição 261119 o D2 ("Como agentes de IA conseguiram invadir
 * sistemas de empresas?", Fantástico/G1 de 16/11) recontava o caso dos agentes
 * da OpenAI na Hugging Face e no sistema de saúde da Austrália, já publicado
 * no D3 de 260928 (52 dias antes). A data da fonte era certa e recente, então
 * o rebaixamento por data velha (#13341/#13364) não tinha o que pegar; o
 * `stale-highlight-repeat` (#13313) só roda no gate 4, depois da escrita e das
 * imagens. O editor trocou o D2 no gate 4 — 2ª vez em 3 dias (261117, D3).
 *
 * Título e resumo do candidato copiados de `_internal/01-approved.gate1.json`
 * da 261119; item passado copiado do `02-reviewed.md` real da 260928.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStaleHighlightRepeats, vendorHintsFromUrl } from "../scripts/lib/stale-highlight.ts";
import {
  demoteStaleDateHighlights,
  formatStaleDateNote,
  staleRepeatHits,
  type StaleDateHighlight,
} from "../scripts/lib/stale-date-demotion.ts";
import { runStaleDateDemotion } from "../scripts/demote-stale-date-highlights.ts";

const G1_URL =
  "https://g1.globo.com/fantastico/noticia/2026/11/16/como-agentes-da-openai-ultrapassaram-barreiras-de-seguranca-e-invadiram-sistemas.ghtml";
const G1_TITLE = "Como agentes de IA conseguiram invadir sistemas de empresas?";
const G1_SUMMARY =
  "Sistemas de inteligência artificial encontraram brechas de segurança para cumprir tarefas e chegaram a acessar computadores de uma empresa americana e dados do sistema público de saúde da Austrália; especialistas alertam para os riscos da autonomia dessas ferramentas.";

const GUARDIAN_URL =
  "https://www.theguardian.com/australia-news/2026/sep/27/sam-altman-openai-dario-amodei-anthropic-senate-inquiry-medicare-hack-rogue-ai-agent-leak";
const PAST_D3_TITLE = "Por que a Austrália convocou Altman e Amodei?";
const PAST_D3_BODY =
  "Sam Altman e Dario Amodei, CEOs da OpenAI e da Anthropik, foram convocados a depor no Senado australiano depois que agentes da OpenAI fora de controle invadiram sites dos governos da Austrália e dos Estados Unidos.\n\n" +
  "O primeiro-ministro Anthony Albanese disse que os casos já somam \"dezenas\" de acessos não autorizados.";
const pastD3 = { label: "D3", title: PAST_D3_TITLE, summary: PAST_D3_BODY, url: GUARDIAN_URL, aammdd: "260928", highlight: true };

const GPT62 = "https://openai.com/index/introducing-gpt-6-2-astra-sol";
const GEMINI = "https://blog.google/innovation-and-ai/products/gemini-app/tasks-in-gemini-free-new-features/";
const NEON = "https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-neon/";
const JOVENS = "https://canaltech.com.br/inteligencia-artificial/um-terco-dos-jovens-ja-usa-ia-como-amigo";
const ANTHROPIC_IPO = "https://www.theguardian.com/technology/2026/nov/18/anthropic-share-price-stock-market-ipo";

function hl(rank: number, url: string, title: string, extra: Record<string, unknown> = {}): StaleDateHighlight {
  return { rank, score: 100 - rank, bucket: "noticias", article: { url, title, date_unverified: false, ...extra } };
}

/** Top-6 da 261119 como saiu do scorer-select (só o D2 e o 5º são negativos). */
const HIGHLIGHTS_261119 = (): StaleDateHighlight[] => [
  hl(1, GPT62, "Introducing GPT-6.2 Astra and Sol", { date_unverified: true }),
  hl(2, G1_URL, G1_TITLE, { summary: G1_SUMMARY, date: "2026-11-16", negative_impact: true }),
  hl(3, GEMINI, "Put Gemini to work for you"),
  hl(4, NEON, "Introducing Gemini 4 Neon"),
  hl(5, JOVENS, "Um terço dos jovens já usa IA como amigo", { negative_impact: true }),
  hl(6, ANTHROPIC_IPO, "Anthropic sets share price at $83 for stock market debut"),
];

test("#13662: o fornecedor do slug da URL entra como entidade", () => {
  assert.deepEqual(vendorHintsFromUrl(G1_URL), ["OpenAI"]);
  assert.deepEqual(vendorHintsFromUrl("https://example.com/noticia/sem-empresa"), []);
  assert.deepEqual(vendorHintsFromUrl("não é url"), []);
});

test("#13662 causa: só título + resumo do Stage 1, o detector do gate 4 não casa (1 entidade só)", () => {
  const w = findStaleHighlightRepeats([{ label: "D2", title: G1_TITLE, summary: G1_SUMMARY, url: G1_URL }], [pastD3], "261119");
  assert.equal(w.length, 0, "sem a OpenAI no texto, só 'Austrália' em comum");
});

test("#13662 regressão: D2 da 261119 é acusado no Stage 1 como incidente de 260928 (52 dias)", () => {
  const hits = staleRepeatHits(HIGHLIGHTS_261119(), [pastD3], "261119");
  assert.deepEqual([...hits.keys()], [G1_URL]);
  const hit = hits.get(G1_URL)!;
  assert.equal(hit.days, 52);
  assert.equal(hit.iso, "2026-09-28");
  assert.equal(hit.repeat?.kind, "incident");
  assert.equal(hit.repeat?.matched_edition, "260928");
  assert.match(hit.repeat!.signal, /invasao; entidades: australia, openai/);
});

test("#13662: D2 repetido sai do top-3 e o melhor negativo restante sobe (#3916)", () => {
  const h = HIGHLIGHTS_261119();
  const r = demoteStaleDateHighlights(h, staleRepeatHits(h, [pastD3], "261119"));
  assert.deepEqual(r.highlights.slice(0, 3).map((x) => x.article?.url), [GPT62, GEMINI, JOVENS]);
  assert.equal(r.highlights.length, 6, "nenhum item sai da edição");
  assert.equal(r.demoted.length, 1);
  assert.equal(r.demoted[0].from_rank, 2);
  const moved = r.highlights.find((x) => x.article?.url === G1_URL)!;
  assert.equal((moved as Record<string, unknown>).stale_date_demoted, undefined);
  assert.deepEqual((moved as Record<string, unknown>).stale_repeat_demoted, {
    kind: "incident",
    matched_edition: "260928",
    matched_title: PAST_D3_TITLE,
    signal: "incidente: invasao; entidades: australia, openai",
    days: 52,
  });
  assert.match(formatStaleDateNote(r.demoted[0]), /NOTÍCIA REPETIDA.*D2.*260928.*52 dias/);
});

test("#13662: item passado com menos de 31 dias fica para os dedups de 30 dias (sem rebaixamento aqui)", () => {
  const recent = { ...pastD3, aammdd: "261101" };
  assert.equal(staleRepeatHits(HIGHLIGHTS_261119(), [recent], "261119").size, 0);
});

test("#13662: pedido do editor que repete notícia fica no top-3 (só aviso)", () => {
  const h = HIGHLIGHTS_261119();
  h[1] = hl(2, G1_URL, G1_TITLE, { summary: G1_SUMMARY, negative_impact: true, flag: "editor_submitted" });
  const r = demoteStaleDateHighlights(h, staleRepeatHits(h, [pastD3], "261119"));
  assert.equal(r.highlights[1].article?.url, G1_URL);
  assert.equal(r.demoted.length, 0);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].repeat?.matched_edition, "260928");
});

const block = (n: number, title: string, url: string, body: string) =>
  `**DESTAQUE ${n} | 🔒 SEGURANÇA**\n\n**[${title}](${url})**  \n\n${body}\n\nPor que isso importa:\nContexto.\n\n---\n`;

test("#13662 ponta a ponta: com --editions-dir o script rebaixa o D2 da 261119 e grava o motivo", async () => {
  const root = mkdtempSync(join(tmpdir(), "stale-repeat-13662-"));
  try {
    const editions = join(root, "editions");
    const past = join(editions, "2609", "260928");
    const cur = join(editions, "2611", "261119", "_internal");
    mkdirSync(past, { recursive: true });
    mkdirSync(cur, { recursive: true });
    writeFileSync(join(past, "02-reviewed.md"), block(3, PAST_D3_TITLE, GUARDIAN_URL, PAST_D3_BODY));
    const categorizedPath = join(cur, "01-categorized.json");
    writeFileSync(categorizedPath, JSON.stringify({ highlights: HIGHLIGHTS_261119(), radar: [] }));
    const outLog = join(cur, "01-stale-date-demoted.json");
    const noText = async () => ({ text: null, via: "none" as const });

    // Sem --editions-dir: comportamento da #13341 (nada muda; a data do D2 é verificada).
    const before = await runStaleDateDemotion({ categorizedPath, edition: "261119", loadText: noText, dryRun: true, rootDir: root });
    assert.equal(before.demoted, 0);
    assert.equal(before.repeats, 0);

    const res = await runStaleDateDemotion({ categorizedPath, edition: "261119", loadText: noText, outLog, rootDir: root, editionsRoot: editions });
    assert.equal(res.error, undefined);
    assert.equal(res.repeats, 1);
    assert.equal(res.demoted, 1);
    assert.match(res.notes[0], /NOTÍCIA REPETIDA/);
    const out = JSON.parse(readFileSync(categorizedPath, "utf8"));
    assert.deepEqual(out.highlights.slice(0, 3).map((x: StaleDateHighlight) => x.article?.url), [GPT62, GEMINI, JOVENS]);
    const log = JSON.parse(readFileSync(outLog, "utf8"));
    assert.equal(log.repeats[0].url, G1_URL);
    assert.equal(log.repeats[0].matched_edition, "260928");
    assert.equal(log.demoted[0].repeat.kind, "incident");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
