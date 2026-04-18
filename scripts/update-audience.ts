/**
 * Regera `context/audience-profile.md` a partir das respostas de survey do Beehiiv.
 *
 * Este script NÃO chama o Beehiiv diretamente por HTTP — o acesso acontece via
 * Beehiiv MCP (ferramentas `list_surveys` e `list_survey_responses`). O script
 * espera receber os dados em JSON via stdin, ou ler de `data/audience-raw.json`
 * (produzido por um subagente que chamou o MCP).
 *
 * Uso:
 *   cat data/audience-raw.json | npx tsx scripts/update-audience.ts
 *   OU
 *   npx tsx scripts/update-audience.ts data/audience-raw.json
 *
 * Fluxo esperado (executado pela skill /diaria-atualiza-audiencia):
 *   1. subagente chama mcp__beehiiv__list_surveys → escolhe a survey ativa
 *   2. subagente chama mcp__beehiiv__list_survey_responses → salva em data/audience-raw.json
 *   3. este script lê o JSON, computa pesos, escreve context/audience-profile.md
 *   4. arquiva versão anterior em context/audience-history/{YYYY-MM-DD}.md
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "context/audience-profile.md");
const HISTORY_DIR = resolve(ROOT, "context/audience-history");

type BeehiivResponse = {
  id: string;
  status?: string;
  created?: string;
  answers: {
    question_id: string;
    question_prompt: string;
    answer: string;
  }[];
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^\w]/g, "");
}

function loadInput(): BeehiivResponse[] {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, "utf8"));
  // fallback: stdin
  const stdin = readFileSync(0, "utf8");
  return JSON.parse(stdin);
}

function countAnswers(responses: BeehiivResponse[], questionMatcher: RegExp) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of responses) {
    for (const a of r.answers) {
      if (!questionMatcher.test(a.question_prompt)) continue;
      const v = a.answer;
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
      total += 1;
    }
  }
  const entries = [...counts.entries()]
    .map(([label, n]) => ({ id: normalize(label), label, weight: total ? +(n / total).toFixed(3) : 0, count: n }))
    .sort((a, b) => b.weight - a.weight);
  return { entries, total };
}

function main() {
  const responses = loadInput();
  const active = responses.filter((r) => !r.status || r.status === "active");

  const contentTypes = countAnswers(active, /se[çc][õo]es|tipos? de conte[úu]do/i);
  const sectors = countAnswers(active, /setor de atua[çc][ãa]o da organiza/i);
  const areas = countAnswers(active, /principal [áa]rea de atua[çc][ãa]o/i);
  const aiLevel = countAnswers(active, /n[íi]vel de conhecimento em ia/i);

  const today = new Date().toISOString().slice(0, 10);

  // archive existing
  if (existsSync(OUT)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
    copyFileSync(OUT, resolve(HISTORY_DIR, `${today}.md`));
  }

  const lines: string[] = [
    "# Perfil de Audiência — Diar.ia",
    "",
    `**updated_at:** ${today}`,
    `**respondentes ativos:** ${active.length}`,
    "",
    "## Tipos de conteúdo preferidos (ordenados por peso)",
    "",
    ...contentTypes.entries.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
    "",
    "## Setores (organização onde trabalham)",
    "",
    ...sectors.entries.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
    "",
    "## Áreas de atuação profissional",
    "",
    ...areas.entries.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
    "",
    "## Nível de conhecimento em IA",
    "",
    ...aiLevel.entries.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
    "",
    "---",
    "",
    "_Regerado por `scripts/update-audience.ts` a partir de respostas do Beehiiv MCP._",
  ];

  writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(`Wrote audience profile (${active.length} respondents) → ${OUT}`);
}

main();
