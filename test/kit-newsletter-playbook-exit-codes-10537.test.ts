/**
 * #10537 — os exit codes de `schedule-newsletter-kit.ts` (Stage 6) e de
 * `publish-newsletter-kit.ts` (Stage 5) precisam ter ação documentada no
 * playbook correspondente. O exit 7 do schedule (audiência divergente, com o
 * caminho "undo falhou — DESAGENDE À MÃO") nasceu em e8ae50118 sem linha na
 * tabela do §6d-kit: o orchestrator podia logar como `info` e apresentar o
 * Stage 6 como concluído com um broadcast agendado pra audiência errada.
 *
 * Guard: todo código que o SCRIPT pode devolver (lido do fonte, não de uma
 * lista à mão) aparece no trecho do playbook — então um exit novo sem linha
 * no playbook quebra o CI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");

/** Códigos que o script atribui/devolve: `process.exitCode = N`, `exitCode: N`, `code: N`. */
function exitCodesInSource(src: string): number[] {
  const codes = new Set<number>();
  for (const m of src.matchAll(/\b(?:exitCode|code)\s*[:=]\s*(\d+)\b/g)) codes.add(Number(m[1]));
  codes.delete(0);
  return [...codes].sort((a, b) => a - b);
}

function section(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  assert.ok(i >= 0, `âncora "${start}" não achada no playbook`);
  const j = text.indexOf(end, i + start.length);
  assert.ok(j > i, `âncora final "${end}" não achada depois de "${start}"`);
  return text.slice(i, j);
}

describe("#10537: exit codes dos scripts Kit têm ação no playbook", () => {
  it("schedule-newsletter-kit.ts × tabela do §6d-kit (Stage 6) — inclusive o exit 7", () => {
    const codes = exitCodesInSource(read("scripts/schedule-newsletter-kit.ts"));
    assert.ok(codes.includes(7), `sanidade: o exit 7 (#10437) deveria estar no fonte (achados: ${codes.join(",")})`);
    const playbook = read(".claude/agents/orchestrator-stage-6.md");
    const table = section(playbook, "| Exit | Significado | Ação |", "newsletter kit stage6 schedule: exit");
    // 1 = uso/erro genérico (args), sem linha própria na tabela por design.
    const missing = codes.filter((c) => c !== 1 && !table.includes(`| \`${c}\` |`));
    assert.deepEqual(missing, [], `exit codes sem linha na tabela do §6d-kit: ${missing.join(", ")}`);
  });

  it("exit 7 do Stage 6 é bloqueante, trata o caso DESAGENDE e entra no nível error do log-event", () => {
    const playbook = read(".claude/agents/orchestrator-stage-6.md");
    const row = playbook.split("\n").find((l) => l.startsWith("| `7` |"));
    assert.ok(row, "linha do exit 7 ausente");
    assert.match(row, /Bloqueia sempre/);
    assert.match(row, /DESAGENDE/);
    assert.match(row, /render-halt-banner\.ts/);
    const level = playbook.match(/--level \{info se exit 0, error se ([0-9/]+)\}/);
    assert.ok(level, "linha --level do log-event do §6d-kit não achada");
    assert.ok(level[1].split("/").includes("7"), `nível error não inclui o 7: ${level[1]}`);
  });

  it("publish-newsletter-kit.ts × §5c-1-kit (Stage 5) — inclusive 8, 10 e 13", () => {
    const codes = exitCodesInSource(read("scripts/publish-newsletter-kit.ts"));
    for (const c of [8, 10, 13]) assert.ok(codes.includes(c), `sanidade: exit ${c} deveria estar no fonte`);
    const playbook = read(".claude/agents/orchestrator-stage-5.md");
    const text = section(playbook, "**Passo 5c-1-kit:", "**Nenhum dos dois caminhos de teste");
    const missing = codes.filter((c) => !text.includes(`\`${c}\``));
    assert.deepEqual(missing, [], `exit codes sem menção no §5c-1-kit: ${missing.join(", ")}`);
  });
});
