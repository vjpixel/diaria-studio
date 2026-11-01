/**
 * #11763: item de RADAR da 261103 (CNN Brasil) cobria, via imprensa, o relatório
 * da Anthropic já publicado no D1 de 261020. Textos copiados da issue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStudySourceRecurrences, extractKeyNumbers } from "../scripts/lib/study-source-recurrence.ts";
import { checkStudySourceRecurrence, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const CNN_URL = "https://www.cnnbrasil.com.br/economia/money/inteligencia-artificial/ia-trabalha-seis-vezes-mais-que-humanos-empregos-estao-em-risco/";
const CNN_TITLE = "IA trabalha seis vezes mais que humanos; empregos estão em risco?";
const CNN_DESC = "Estudo interno da Anthropic aponta que agentes de IA superam humanos em horas trabalhadas.";
const D1_TITLE = "Seu cargo de júnior sobreviveria na Anthropic?";
const D1_BODY = "As contratações júnior técnicas na Anthropic caíram de 27% para 9%. Em agosto, os agentes de IA dos funcionários somavam seis vezes as horas dos humanos, segundo o relatório da empresa.";

const past = [{ label: "D1", title: D1_TITLE, summary: D1_BODY, url: "https://www.anthropic.com/research/junior-hiring", aammdd: "261020" }];

test("#11763: CNN × relatório da Anthropic de 261020 casa (publicador + 6x)", () => {
  const w = findStudySourceRecurrences([{ label: "RADAR", title: CNN_TITLE, summary: CNN_DESC, url: CNN_URL }], past);
  assert.equal(w.length, 1);
  assert.equal(w[0].matched_edition, "261020");
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

test("#11763: fonte primária (host do publicador) e mesma URL ficam de fora", () => {
  const prim = findStudySourceRecurrences(
    [{ label: "RADAR", title: CNN_TITLE, summary: CNN_DESC, url: "https://www.anthropic.com/research/other" }], past);
  assert.deepEqual(prim, []);
  const same = findStudySourceRecurrences(
    [{ label: "RADAR", title: CNN_TITLE, summary: CNN_DESC, url: past[0].url }], past);
  assert.deepEqual(same, []);
});

test("#11763: extractKeyNumbers lê palavra, dígito e percentual", () => {
  const n = extractKeyNumbers("seis vezes, 6x e 27% para 9 por cento");
  assert.deepEqual([...n.ratios], ["6x"]);
  assert.deepEqual([...n.percents].sort(), ["27%", "9%"]);
});

test("#11763 Stage 4: invariante no 02-reviewed.md, janela de 30 dias, warning-only", () => {
  const rule = STAGE_4_RULES.find((r) => r.id === "study-source-recurrence");
  assert.ok(rule && rule.stage === 4);
  const root = mkdtempSync(join(tmpdir(), "study-11763-"));
  try {
    mkdirSync(join(root, "2610", "261020"), { recursive: true });
    mkdirSync(join(root, "2611", "261103"), { recursive: true });
    writeFileSync(join(root, "2610", "261020", "02-reviewed.md"),
      `**DESTAQUE 1 | IA**\n\n[${D1_TITLE}](https://www.anthropic.com/research/junior-hiring)\n\n${D1_BODY}\n\nPor que isso importa:\nTexto.\n\n---\n`);
    writeFileSync(join(root, "2611", "261103", "02-reviewed.md"),
      `**RADAR**\n\n[${CNN_TITLE}](${CNN_URL})\n${CNN_DESC}\n`);
    const v = checkStudySourceRecurrence(join(root, "2611", "261103"), root);
    assert.equal(v.length, 1, v.map((x) => x.message).join("\n"));
    assert.equal(v[0].severity, "warning");
    assert.ok(v[0].message.includes("261020") && v[0].message.includes(CNN_URL));
    // edição antiga fora da janela de 30 dias não conta
    mkdirSync(join(root, "2609", "260915"), { recursive: true });
    writeFileSync(join(root, "2609", "260915", "02-reviewed.md"), "x");
    assert.deepEqual(checkStudySourceRecurrence(join(root, "2610", "261020"), root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
