/**
 * test/video-pauta-13090.test.ts (#13090, item 1)
 * Pauta perene de vídeo a partir do Keyword Planner: intenção, tema, ranking,
 * relatório e CLI sobre arquivos temporários. Sem rede, sem `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyIntent,
  topicKey,
  buildPautaTopics,
  mergeIdeaSources,
  renderPautaReport,
} from "../scripts/lib/video-pauta.ts";
import { findLatestPull, readPullFile, main } from "../scripts/video-pauta-report.ts";
import { expandDateToken, parseSeedsCsv } from "../scripts/google-keyword-pull.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import type { KeywordIdea } from "../scripts/lib/google-keyword-planner.ts";

const idea = (keyword: string, vol: number | null, competition = "LOW"): KeywordIdea => ({
  keyword, avgMonthlySearches: vol, competition, competitionIndex: null, lowBidBrl: null, highBidBrl: null,
});

describe("#13090 — intenção", () => {
  const cases: [string, string][] = [
    ["como usar o chatgpt", "tutorial"],
    ["como criar imagens com ia", "tutorial"],
    ["como fazer as fotos da inteligência artificial", "tutorial"],
    ["como usar ia para estudar", "tutorial"],
    ["o que é ia generativa", "explicador"],
    ["ia generativa o que é", "explicador"],
    ["como funciona o chatgpt", "explicador"],
    ["como o chatgpt funciona", "explicador"],
    ["chatgpt o que é e como funciona", "explicador"],
    ["chatgpt vs gemini", "comparativo"],
    ["chatgpt ou gemini qual é melhor", "comparativo"],
    ["chatgpt ou gemini", "comparativo"],
    ["diferença entre ia e machine learning", "comparativo"],
    ["qual a melhor ia para programar", "lista"],
    ["melhor ia gratuita em português", "lista"],
    ["ferramentas de inteligência artificial", "lista"],
    ["cursos gratuitos de inteligência artificial", "lista"],
    ["como a ia vai afetar meu emprego", "outro"],
    ["newsletter de ia", "outro"],
  ];
  for (const [kw, intent] of cases) {
    it(`${kw} → ${intent}`, () => assert.equal(classifyIntent(kw), intent));
  }
});

describe("#13090 — tema junta variantes do mesmo vídeo", () => {
  it("criar/fazer/gerar + imagem/foto + ia/inteligência artificial = mesmo tema", () => {
    const k = topicKey("como criar imagens com ia");
    for (const v of [
      "como criar imagem com ia",
      "como fazer foto com inteligência artificial",
      "como gerar imagens com inteligencia artificial",
      "como fazer as fotos da inteligência artificial",
    ]) {
      assert.equal(topicKey(v), k, v);
    }
  });

  it("ordem e 'chat gpt' não mudam o tema", () => {
    assert.equal(topicKey("chatgpt como funciona"), topicKey("como funciona o chatgpt"));
    assert.equal(topicKey("chat gpt como funciona"), topicKey("como funciona o chatgpt"));
    assert.equal(topicKey("chatgpt o que é e como funciona"), topicKey("como funciona o chatgpt"));
    assert.equal(topicKey("como o chatgpt funciona"), topicKey("como funciona o chatgpt"));
    assert.equal(topicKey("inteligência artificial que cria textos"), topicKey("inteligencia artificial que faz textos"));
  });

  it("assuntos diferentes ficam separados", () => {
    assert.notEqual(topicKey("como usar o chatgpt"), topicKey("como usar o gemini"));
    assert.notEqual(topicKey("ia para marketing"), topicKey("ia para advogados"));
  });
});

describe("#13090 — ranking", () => {
  it("demanda do tema é o MAIOR volume entre variantes, não a soma; líder é a variante de maior volume", () => {
    const [t] = buildPautaTopics([idea("como criar imagem com ia", 2900, "MEDIUM"), idea("como criar imagens com ia", 2900, "MEDIUM"), idea("como fazer foto com ia", 1000, "MEDIUM")]);
    assert.equal(t.intent, "tutorial");
    assert.equal(t.volume, 2900);
    assert.equal(t.volumeSum, 6800);
    assert.equal(t.variants.length, 3);
    assert.equal(t.score, 2175);
  });

  it("competição desconta: 1.300 LOW passa à frente de 1.600 HIGH", () => {
    const topics = buildPautaTopics([idea("o que é prompt", 1600, "HIGH"), idea("ia generativa o que é", 1300, "LOW")]);
    assert.deepEqual(topics.map((t) => t.lead), ["ia generativa o que é", "o que é prompt"]);
  });

  it("volume null fica no fim e não quebra", () => {
    const topics = buildPautaTopics([idea("o que é llm", null), idea("o que é prompt", 10)]);
    assert.equal(topics.at(-1)!.lead, "o que é llm");
    assert.equal(topics.at(-1)!.score, 0);
  });

  it("merge de fontes mantém 1 linha por termo, a de maior volume, e ignora linha sem keyword", () => {
    const merged = mergeIdeaSources([[idea("Como usar o ChatGPT", 100)], [idea("como usar o chatgpt", 500), { avgMonthlySearches: 1 } as KeywordIdea]]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].avgMonthlySearches, 500);
  });
});

describe("#13090 — relatório", () => {
  const topics = buildPautaTopics([
    idea("como criar imagens com ia", 2900, "MEDIUM"),
    idea("como fazer foto com ia", 2400, "MEDIUM"),
    idea("ia generativa o que é", 1300, "LOW"),
    idea("chatgpt ou gemini qual é melhor", 590, "LOW"),
    idea("newsletter de ia", 50, "LOW"),
  ]);
  const md = renderPautaReport({
    date: "2026-11-15",
    sources: ["video-keywords-2026-11-01.json"],
    topics,
    contaminated: [{ seed: "como usar o gemini", volume: 900, discardedNeighbours: ["gemini dj"] }],
  });

  it("tem top geral sem 'outro', seção por intenção com variantes e sementes contaminadas", () => {
    assert.match(md, /## Top 10 temas para vídeo/);
    const top = md.split("## Tutorial")[0];
    assert.doesNotMatch(top, /newsletter de ia/);
    assert.match(md, /## Tutorial \(como usar \/ como fazer\) — 1 tema/);
    assert.match(md, /\| 1 \| como criar imagens com ia \| 2\.900 \| MEDIUM \| 2\.175 \| como fazer foto com ia \|/);
    assert.match(md, /## Explicador/);
    assert.match(md, /## Comparativo/);
    assert.match(md, /## Outros/);
    assert.match(md, /como usar o gemini \(900\/mês\)/);
  });

  it("sem markdown de negrito (relatório interno, mas sem **)", () => {
    assert.doesNotMatch(md, /\*\*/);
  });
});

describe("#13090 — CLI e arquivos", () => {
  const dir = mkdtempSync(join(tmpdir(), "pauta-13090-"));
  const pull = (kept: KeywordIdea[]) => JSON.stringify({ pulled_at: "x", seeds: [], kept, discarded: [], contaminated_seeds: [], raw: [] });
  writeFileSync(join(dir, "video-keywords-2026-10-01.json"), pull([idea("o que é llm", 10)]));
  writeFileSync(join(dir, "video-keywords-2026-11-01.json"), pull([idea("como usar o chatgpt", 880)]));
  writeFileSync(join(dir, "google-keywords-2026-11-01.json"), pull([idea("como funciona o chatgpt", 1000)]));
  writeFileSync(join(dir, "video-keywords-2026-11-01.md"), "x");

  it("findLatestPull escolhe pela data do nome e não confunde os prefixos", () => {
    assert.equal(findLatestPull(dir, "video-keywords"), resolve(dir, "video-keywords-2026-11-01.json"));
    assert.equal(findLatestPull(dir, "google-keywords"), resolve(dir, "google-keywords-2026-11-01.json"));
    assert.equal(findLatestPull(dir, "inexistente"), null);
    assert.equal(findLatestPull(join(dir, "nao-existe"), "video-keywords"), null);
  });

  it("readPullFile recusa arquivo sem 'kept'", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ seeds: [] }));
    assert.throws(() => readPullFile(bad), /sem array "kept"/);
  });

  it("main com --input junta as duas fontes e grava md + json", async () => {
    const out = join(dir, "pauta.md");
    const jsonOut = join(dir, "pauta.json");
    const code = await main([
      "--input", `${join(dir, "video-keywords-2026-11-01.json")},${join(dir, "google-keywords-2026-11-01.json")}`,
      "--out", out, "--json-out", jsonOut,
    ]);
    assert.equal(code, 0);
    const md = readFileSync(out, "utf8");
    assert.match(md, /como usar o chatgpt/);
    assert.match(md, /como funciona o chatgpt/);
    const json = JSON.parse(readFileSync(jsonOut, "utf8"));
    assert.equal(json.topics.length, 2);
    assert.deepEqual(json.sources, ["video-keywords-2026-11-01.json", "google-keywords-2026-11-01.json"]);
  });

  it("main sai 1 com fonte vazia e 2 com --top inválido, sem gravar", async () => {
    const empty = join(dir, "video-keywords-2026-12-01.json");
    writeFileSync(empty, pull([]));
    const out = join(dir, "nunca.md");
    assert.equal(await main(["--input", empty, "--out", out, "--json-out", join(dir, "nunca.json")]), 1);
    assert.equal(existsSync(out), false);
    assert.equal(await main(["--top", "0", "--input", empty]), 2);
  });
});

describe("#13090 — sementes de vídeo e task mensal", () => {
  it("seed/video-keywords.csv tem sementes dos 3 formatos pedidos (como usar / o que é / vs) e cabe em 2 lotes", () => {
    const seeds = parseSeedsCsv(readFileSync(resolve(import.meta.dirname, "../seed/video-keywords.csv"), "utf8"));
    assert.ok(seeds.length > 20 && seeds.length <= 40, `${seeds.length} sementes`);
    assert.ok(seeds.some((s) => s.startsWith("como usar ")));
    assert.ok(seeds.some((s) => s.startsWith("o que é ")));
    assert.ok(seeds.some((s) => / vs /.test(s)));
    assert.equal(new Set(seeds).size, seeds.length, "semente duplicada");
  });

  it("--out com {date} vira a data do pull", () => {
    assert.equal(expandDateToken("data/seo/video-keywords-{date}.json", "2026-12-01"), "data/seo/video-keywords-2026-12-01.json");
    assert.equal(expandDateToken("data/seo/x.json", "2026-12-01"), "data/seo/x.json");
  });

  it("a task mensal roda o pull geral, o de vídeo e o relatório — os dois novos best-effort", () => {
    const task = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Google-Keyword-Monthly-Pull");
    assert.ok(task);
    assert.deepEqual(task.steps.map((s) => s.key), ["keywords", "video-keywords", "pauta-video"]);
    assert.ok(!task.steps[0].bestEffort, "o pull geral segue reprovando a task");
    const video = task.steps[1];
    assert.equal(video.bestEffort, true);
    assert.ok(video.args?.includes("seed/video-keywords.csv"));
    assert.ok(video.args?.includes("data/seo/video-keywords-{date}.json"));
    assert.equal(task.steps[2].script, "scripts/video-pauta-report.ts");
    assert.equal(task.steps[2].bestEffort, true);
  });
});
