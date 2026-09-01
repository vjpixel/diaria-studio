/**
 * test/continuo-cadence-prose-drift-6928.test.ts (#6928)
 *
 * Guard de regressão contra a classe de erro do #6928: cadências dos 2 crons
 * do contínuo (tick `hermes-diaria-continuo`, job `5d791ef6fc2c`; review de
 * PR `continuo-pr-review.sh`, job `3330b108a5b2`) escritas como números na
 * prosa do repo — e uma conclusão numérica (descompasso "12:1", espera
 * "~24h") derivada desses números errados. Medição de 01/09/2026 na issue:
 * a prosa registrava o tick 2× mais lento e o review 2× mais rápido do que
 * o real — nas duas direções.
 *
 * Por que um teste e não só editar a prosa: a prosa já tinha o aviso correto
 * no CLAUDE.md ("cadência/estado nunca se citam daqui nem de memória:
 * derivar com `hermes cron list --all`") e mesmo assim continuou sendo lida
 * como fonte — o aviso protege quem lê o CLAUDE.md, não quem lê o SKILL.md
 * ou o cabeçalho do script (a issue produziu um erro real de relato no dia).
 * `.hermes/cron/jobs.json` é estado de máquina, fora do repo — CI não
 * alcança (por isso a opção "drift-check vs jobs.json" da issue NÃO é este
 * teste). O que este teste tranca é a metade que dá: o repo para de AFFIRMAR
 * número de cadência — número que não está na prosa não pode ficar obsoleto
 * em silêncio.
 *
 * Regra: os tokens de cadência abaixo só podem aparecer em prosa de
 * `hermes/` DENTRO de aspas/backticks — como alegação nomeada-e-rejeitada
 * num registro de correção (padrão do changelog: "registrava X, corrigido
 * no #Y"). Ocorrência solta (afirmação direta) falha o teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

// Tokens que a prosa do repo já registrou errado (`~4h`, `every 240m`,
// `12:1`) ou que afirmam cadência dos crons do contínuo — nunca afirmação
// direta; a fonte canônica é `hermes cron list --all` (CLAUDE.md).
const FORBIDDEN_PATTERNS: RegExp[] = [
  /every 240m/i,
  /every 120m/i,
  /every 60m/i,
  /~4h/,
  /12:1(?!\d)/, // "12:1" — sem casar "12:15" (horário)
  /a cada 120min/i,
];

/** Remove trechos entre aspas duplas e backticks — alegações citadas/rejeitadas são permitidas. */
function stripQuotedSpans(line: string): string {
  return line.replace(/"[^"]*"|`[^`]*`/g, "");
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

describe("continuo-cadence-prose-drift-6928 (#6928)", () => {
  const proseFiles = listFiles(join(REPO_ROOT, "hermes"), [
    ".md",
    ".sh",
  ]).filter((f) => !f.endsWith(".test.sh"));

  it("varre arquivos de prosa do hermes/ (sanidade da própria varredura)", () => {
    assert.ok(
      proseFiles.some((f) => f.endsWith("hermes-diaria-continuo/SKILL.md")),
      "SKILL.md tem que estar no escopo da varredura",
    );
    assert.ok(
      proseFiles.some((f) => f.endsWith("scripts/continuo-pr-review.sh")),
      "continuo-pr-review.sh tem que estar no escopo da varredura",
    );
  });

  it("nenhuma prosa de hermes/ afirma cadência dos crons do contínuo fora de citação", () => {
    const violations: string[] = [];
    for (const file of proseFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const bare = stripQuotedSpans(line);
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(bare)) {
            violations.push(
              `${file}:${i + 1} — token de cadência "${pattern.source}" fora de citação: ${line.trim().slice(0, 120)}`,
            );
          }
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Cadência de cron do Hermes não se escreve em prosa — derivar com \`hermes cron list --all\` (CLAUDE.md; issue #6928). Se a linha é um registro de correção, ponha o token entre aspas/backticks como alegação rejeitada:\n${violations.join("\n")}`,
    );
  });

  it("o ponteiro de derivação continua presente nos pontos onde cadência era afirmada", () => {
    const skill = readFileSync(
      join(REPO_ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md"),
      "utf8",
    );
    const script = readFileSync(
      join(REPO_ROOT, "hermes/scripts/continuo-pr-review.sh"),
      "utf8",
    );
    assert.ok(
      skill.includes("hermes cron list --all"),
      "SKILL.md tem que apontar a fonte canônica de cadência",
    );
    assert.ok(
      script.includes("hermes cron list --all"),
      "continuo-pr-review.sh tem que apontar a fonte canônica de cadência",
    );
  });
});
