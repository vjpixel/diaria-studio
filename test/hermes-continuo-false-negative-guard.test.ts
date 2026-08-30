/**
 * test/hermes-continuo-false-negative-guard.test.ts (#6712)
 *
 * Guard de regressão contra o padrão de falso-negativo medido ao vivo em
 * 29/08/2026 (2 ocorrências no mesmo dia): o wrapper `claude-openrouter.sh`
 * pode estourar `--max-budget-usd` DEPOIS de já ter commitado e aberto PR
 * (#6702 → PR #6713) ou criado um worktree (`.claude/worktrees/fix-6706-...`)
 * — em ambos os casos o relatório do tick leu "nada foi feito", desfez o
 * claim, e devolveu a issue pra fila pra ser retrabalhada.
 *
 * Este teste confirma que `hermes/skills/hermes-diaria-continuo/SKILL.md`
 * documenta o guard mínimo (checar `gh pr list --author @me` E a existência
 * de worktree da unidade ANTES de `unclaim-issue` por erro de delegação) —
 * não executa o guard (é instrução em prosa pro harness delegado, não
 * código TS/Python), mas trava que a instrução não regride/desapareça numa
 * edição futura da skill.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

describe("guard de falso-negativo de delegação do contínuo (#6712)", () => {
  const source = readFileSync(SKILL_PATH, "utf8");

  it("a skill instrui checar PR aberto (gh pr list --author @me) antes de desfazer claim por erro de delegação", () => {
    assert.ok(
      /gh pr list --author @me --state open/.test(source),
      "SKILL.md não instrui checar `gh pr list --author @me --state open` antes de " +
        "`unclaim-issue` por falha de delegação — sem isso, uma delegação que " +
        "commitou e abriu PR antes de estourar o budget pode ter seu claim desfeito " +
        "e a issue redevolvida à fila (achado #6712, PR #6713 fantasma).",
    );
  });

  it("a skill instrui checar worktree existente da unidade antes de desfazer claim por erro de delegação", () => {
    assert.ok(
      /\.claude\/worktrees\//.test(source) &&
        /worktree.*já existe|worktree da unidade/i.test(source),
      "SKILL.md não instrui checar `.claude/worktrees/` antes de `unclaim-issue` — " +
        "sem isso, um worktree criado DENTRO do próprio tick pode ser reportado como " +
        "'trabalho de outra sessão' e abandonado (2ª forma do falso-negativo do #6712).",
    );
  });

  it("a instrução de falha do wrapper condiciona o unclaim à ausência de PR/worktree, não a exit≠0 sozinho", () => {
    const idx = source.indexOf("Falha do wrapper (exit");
    assert.ok(idx > -1, "seção 'Falha do wrapper' não encontrada em SKILL.md");
    const section = source.slice(idx, idx + 1800);
    assert.ok(
      /não desfazer o claim/i.test(section),
      "a seção de falha do wrapper não contém a instrução explícita de NÃO desfazer " +
        "o claim quando PR/worktree da unidade já existir.",
    );
  });
});
