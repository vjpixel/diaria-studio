/**
 * #11763: o RADAR da 261103 (CNN Brasil, "IA trabalha seis vezes mais que
 * humanos") cobria, via imprensa, o relatório da Anthropic já publicado no D1
 * de 261020. Textos copiados das edições reais (01-approved.json da 261103 e
 * 02-reviewed.md da 261020).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findStudySourceRecurrences,
  extractKeyNumbers,
  detectPublishers,
  isPublisherHost,
  formatStudySourceNotes,
} from "../scripts/lib/study-source-recurrence.ts";
import { checkStudySourceRecurrence, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const CNN_URL = "https://www.cnnbrasil.com.br/economia/money/inteligencia-artificial/ia-trabalha-seis-vezes-mais-que-humanos-empregos-estao-em-risco/";
const CNN_TITLE = "IA trabalha seis vezes mais que humanos; empregos estão em risco?";
const CNN_SUMMARY = "Estudo interno da Anthropic revela que agentes de IA superam humanos em horas trabalhadas e mudam o perfil das contratações";
const D1_URL = "https://www.anthropic.com/research/employment-at-anthropic";
const D1_TITLE = "Seu cargo de júnior sobreviveria na Anthropic?";
const D1_BODY = "Na Anthropic, a fatia de contratações para vagas técnicas júnior caiu de 27% para 9%, segundo relatório da empresa. Em agosto, os agentes de IA dos funcionários já somavam seis vezes mais horas de trabalho que eles.\n\nOs commits por engenheiro chegaram a cinco vezes o ritmo de seis meses antes.";

const past = [{ label: "D1", title: D1_TITLE, summary: D1_BODY, url: D1_URL, aammdd: "261020" }];
const cnn = { label: "RADAR", title: CNN_TITLE, summary: CNN_SUMMARY, url: CNN_URL };

const D1_MD = `**DESTAQUE 1 | 🔬 PESQUISA**\n\n**[${D1_TITLE}](${D1_URL})**  \n\n${D1_BODY}\n\nPor que isso importa:\n\nSão dados internos.\n\n---\n`;
const RADAR_MD = `**RADAR**\n\n[${CNN_TITLE}](${CNN_URL})\n${CNN_SUMMARY}\n`;

test("#11763 regressão: CNN 261103 × relatório da Anthropic no D1 de 261020 casa (publicador + 6x)", () => {
  const w = findStudySourceRecurrences([cnn], past);
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_edition, "261020");
  assert.equal(w[0].matched_label, "D1");
  assert.equal(w[0].publisher, "anthropic");
  assert.deepEqual(w[0].shared_numbers, ["6x"]);
});

test("#11763: sem falso positivo — outro estudo da Anthropic com números diferentes", () => {
  const w = findStudySourceRecurrences(
    [{ label: "RADAR", title: "Estudo da Anthropic: agentes erram 3 vezes menos em revisão de código", url: "https://x.example/a" }], past);
  assert.deepEqual(w, []);
});

test("#11763: sem falso positivo — mesmo número, outro publicador", () => {
  const w = findStudySourceRecurrences(
    [{ label: "RADAR", title: "Estudo da McKinsey: IA rende seis vezes mais em tarefas de escritório", url: "https://x.example/b" }], past);
  assert.deepEqual(w, []);
});

test("#11763: sem falso positivo — mesmo publicador e número, sem menção a estudo/relatório", () => {
  const w = findStudySourceRecurrences(
    [{ label: "LANÇAMENTOS", title: "Anthropic lança Claude seis vezes mais rápido", url: "https://x.example/c" }], past);
  assert.deepEqual(w, []);
});

test("#11763: fonte primária (host do publicador) e mesma URL ficam de fora", () => {
  assert.deepEqual(findStudySourceRecurrences([{ ...cnn, url: "https://www.anthropic.com/research/other" }], past), []);
  assert.deepEqual(findStudySourceRecurrences([{ ...cnn, url: D1_URL }], past), []);
});

test("#11763: dois percentuais em comum também casam; um só não", () => {
  const two = findStudySourceRecurrences(
    [{ label: "RADAR", title: "Relatório da Anthropic: vagas júnior caem de 27% para 9%", url: "https://g1.example/x" }], past);
  assert.equal(two.length, 1);
  assert.deepEqual(two[0].shared_numbers.sort(), ["27%", "9%"]);
  const one = findStudySourceRecurrences(
    [{ label: "RADAR", title: "Relatório da Anthropic: 27% dos júniores usam agentes; 40% dos seniores", url: "https://g1.example/y" }], past);
  assert.deepEqual(one, []);
});

test("#11763: extractKeyNumbers lê palavra, dígito e percentual; razão absurda é ignorada", () => {
  const n = extractKeyNumbers("seis vezes, 6x e 27% para 9 por cento");
  assert.deepEqual([...n.ratios], ["6x"]);
  assert.deepEqual([...n.percents].sort(), ["27%", "9%"]);
  assert.equal(extractKeyNumbers("em 2026 vezes").ratios.size, 0);
  assert.equal(extractKeyNumbers("muitas vezes").ratios.size, 0);
});

test("#11763: nomes ambíguos exigem grafia própria (a meta ≠ a Meta; meta-análise ≠ Meta)", () => {
  assert.ok(detectPublishers("Estudo da Meta mostra 4x mais cliques").has("meta"));
  assert.ok(!detectPublishers("o estudo bate a meta de 4x").has("meta"));
  assert.ok(!detectPublishers("Meta-análise aponta 4x").has("meta"));
  assert.ok(!detectPublishers("submit o estudo").has("mit"));
});

test("#11763: host do publicador por rótulo — metropoles.com não é a Meta", () => {
  assert.ok(isPublisherHost("https://about.meta.com/x", "meta"));
  assert.ok(!isPublisherHost("https://www.metropoles.com/tec/a", "meta"));
  assert.ok(!isPublisherHost("https://mittechreview.com.br/a", "mit"));
  const metaPast = [{ label: "D1", title: "Estudo da Meta mostra 4x mais cliques", url: "https://ai.meta.com/x", aammdd: "261020" }];
  assert.equal(findStudySourceRecurrences(
    [{ label: "RADAR", title: "Estudo da Meta mostra 4x mais cliques", url: "https://www.metropoles.com/tec/a" }], metaPast).length, 1);
});

test("#11763 Stage 1: notas do relatório só para item que segue no 01-approved.json", () => {
  const themeCheck = { study_source_warnings: findStudySourceRecurrences([cnn], past) };
  const kept = formatStudySourceNotes(themeCheck, { buckets: { radar: [{ article: { url: CNN_URL } }] } });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startsWith("🚨") && kept[0].includes("261020") && kept[0].includes(CNN_URL));
  assert.deepEqual(formatStudySourceNotes(themeCheck, { highlights: [] }), []);
  assert.deepEqual(formatStudySourceNotes({}, {}), []);
  assert.deepEqual(formatStudySourceNotes(null, null), []);
});

test("#11763 Stage 1: check-highlight-themes.ts grava study_source_warnings no JSON de saída", () => {
  const root = mkdtempSync(join(tmpdir(), "study-11763-s1-"));
  try {
    const editions = join(root, "editions");
    mkdirSync(join(editions, "2610", "261020"), { recursive: true });
    writeFileSync(join(editions, "2610", "261020", "02-reviewed.md"), D1_MD);
    const internal = join(editions, "2611", "261103", "_internal");
    mkdirSync(internal, { recursive: true });
    const categorized = join(internal, "01-categorized.json");
    writeFileSync(categorized, JSON.stringify({ highlights: [], radar: [{ article: { title: CNN_TITLE, url: CNN_URL, summary: CNN_SUMMARY } }] }));
    const out = join(internal, "01-highlight-theme-check.json");
    const r = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/check-highlight-themes.ts",
      "--categorized", categorized, "--editions-dir", editions, "--current-edition", "261103",
      "--past-editions", join(root, "missing-past-editions.md"), "--out-json", out,
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(json.study_source_warnings.length, 1);
    assert.equal(json.study_source_warnings[0].item_url, CNN_URL);
    assert.equal(json.study_source_warnings[0].matched_edition, "261020");
    assert.match(r.stderr, /Mesmo estudo\/relatório já publicado/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#11763 Stage 4: invariante sobre o 02-reviewed.md, warning-only, janela de 30 dias", () => {
  const rule = STAGE_4_RULES.find((r) => r.id === "study-source-recurrence");
  assert.ok(rule && rule.stage === 4);
  const root = mkdtempSync(join(tmpdir(), "study-11763-"));
  const write = (ym: string, ed: string, md: string) => {
    mkdirSync(join(root, ym, ed), { recursive: true });
    writeFileSync(join(root, ym, ed, "02-reviewed.md"), md);
    return join(root, ym, ed);
  };
  try {
    write("2610", "261020", D1_MD);
    const cur = write("2611", "261103", RADAR_MD);
    const v = checkStudySourceRecurrence(cur, root);
    assert.equal(v.length, 1, v.map((x) => x.message).join("\n"));
    assert.equal(v[0].severity, "warning");
    assert.equal(v[0].rule, "study-source-recurrence");
    assert.ok(v[0].message.startsWith("🚨") && v[0].message.includes("261020") && v[0].message.includes(CNN_URL));

    // janela: o mesmo D1 a 31 dias (261003) não avisa; a 29 dias (261005) avisa
    rmSync(join(root, "2610", "261020"), { recursive: true });
    write("2610", "261003", D1_MD);
    assert.deepEqual(checkStudySourceRecurrence(cur, root), []);
    write("2610", "261005", D1_MD);
    const v29 = checkStudySourceRecurrence(cur, root);
    assert.equal(v29.length, 1);
    assert.ok(v29[0].message.includes("261005"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
