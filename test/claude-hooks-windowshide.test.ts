/**
 * test/claude-hooks-windowshide.test.ts (#7952)
 *
 * Regressão pro flash de janelas de console no Windows a CADA SessionStart —
 * família irmã de `test/claude-settings-hooks-exec-form.test.ts` (#7106), que
 * travou a forma "exec" dos hooks em `settings.json`. Este guard ataca uma
 * segunda causa, distinta: dentro de um hook `.mjs` já em exec form, um
 * `spawn`/`spawnSync`/`execFile`/`execFileSync` com `detached: true` mas SEM
 * `windowsHide: true` ainda aloca console próprio no Windows (doc do Node:
 * "the child will have its own console window" quando `detached`) — visível
 * como uma janela do Windows Terminal que abre e fecha rápido.
 *
 * Achado ao vivo (#7952, 10/09/2026): `session-start-claude-config-sync.mjs`
 * (este repo) e `~/claude-config/sync-check.cjs` tinham exatamente esse
 * padrão — `spawn(..., { detached: true, stdio: "ignore" })` sem
 * `windowsHide`. Prova medida na issue: script mínimo com/sem `windowsHide`
 * contando `conhost`/`OpenConsole` alocados — BASE 26, DETACHED 27 (+1),
 * HIDDEN 26 (0 a mais).
 *
 * Escopo: só varre `.claude/hooks/*.mjs` DESTE repo (o `sync-check.cjs`
 * equivalente em `claude-config` não tem CI — mudança lá é tratada à parte,
 * ver corpo da #7952).
 *
 * Heurística (não é um parser AST completo — nenhum outro guard de hook
 * deste repo é): pra cada ocorrência de `detached:\s*true`, procura
 * `windowsHide:\s*true` numa JANELA de texto ao redor (mesmo objeto de
 * opções, na prática — objetos de opções de spawn/execFile deste repo nunca
 * passam de ~15 linhas). Falso positivo teórico (um `windowsHide: true` de
 * OUTRA chamada caindo dentro da janela) é aceitável pro custo/benefício de
 * um guard estático simples — nenhum hook real hoje tem duas chamadas
 * spawn/execFile close o bastante pra colidir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(ROOT, ".claude", "hooks");

/** Janela de caracteres ao redor de cada `detached: true` onde
 * `windowsHide: true` precisa aparecer. Generosa o bastante pra cobrir um
 * objeto de opções multi-linha inteiro (chamadas reais deste repo não
 * passam de ~600 chars entre `detached:` e o fechamento do objeto). */
const WINDOW_CHARS = 600;

export interface DetachedWithoutWindowsHide {
  file: string;
  /** Offset (não linha — mais barato de calcular, suficiente pra achar no editor) do `detached: true` ofensor. */
  offset: number;
}

/** Pura — recebe o conteúdo já lido de um arquivo `.mjs`, devolve todo
 * `detached: true` sem `windowsHide: true` na janela ao redor. */
export function findDetachedWithoutWindowsHide(content: string): number[] {
  const offenders: number[] = [];
  const detachedRe = /detached\s*:\s*true/g;
  let match: RegExpExecArray | null;
  while ((match = detachedRe.exec(content)) !== null) {
    const start = Math.max(0, match.index - WINDOW_CHARS);
    const end = Math.min(content.length, match.index + WINDOW_CHARS);
    const window = content.slice(start, end);
    if (!/windowsHide\s*:\s*true/.test(window)) {
      offenders.push(match.index);
    }
  }
  return offenders;
}

function listHookFiles(): string[] {
  try {
    return readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".mjs"));
  } catch {
    return []; // diretório ausente (clone parcial/worktree isolado) — nada a varrer, não é falha
  }
}

describe("findDetachedWithoutWindowsHide (#7952) — lógica pura", () => {
  it("detached:true sem windowsHide -> 1 ofensor", () => {
    const content = `spawn("node", [], { detached: true, stdio: "ignore" });`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content).length, 1);
  });

  it("detached:true COM windowsHide na mesma chamada -> nenhum ofensor", () => {
    const content = `spawn("node", [], { detached: true, stdio: "ignore", windowsHide: true });`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content), []);
  });

  it("windowsHide em linha separada dentro do objeto multi-linha -> nenhum ofensor", () => {
    const content = [
      "spawn(process.execPath, [path], {",
      "  detached: true,",
      "  stdio: 'ignore',",
      "  windowsHide: true,",
      "  env: {},",
      "});",
    ].join("\n");
    assert.deepEqual(findDetachedWithoutWindowsHide(content), []);
  });

  it("sem detached:true nenhum -> nenhum ofensor (execFile comum sem detach)", () => {
    const content = `execFile("git", ["status"], { timeout: 5000 }, cb);`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content), []);
  });

  it("2 chamadas detached no mesmo arquivo, só 1 sem windowsHide -> 1 ofensor", () => {
    const content = [
      `spawn("a", [], { detached: true, windowsHide: true });`,
      "x".repeat(2000), // separação grande o bastante pra sair da janela da 1ª chamada
      `spawn("b", [], { detached: true, stdio: "ignore" });`,
    ].join("\n");
    assert.deepEqual(findDetachedWithoutWindowsHide(content).length, 1);
  });
});

describe("Regressão #7952 — .claude/hooks/*.mjs reais deste repo", () => {
  const files = listHookFiles();

  it("existe pelo menos 1 hook .mjs pra varrer (sanity — senão o guard não prova nada)", () => {
    assert.ok(files.length > 0, `nenhum .mjs encontrado em ${HOOKS_DIR}`);
  });

  for (const file of files) {
    it(`${file}: todo spawn/spawnSync/execFile/execFileSync com detached:true declara windowsHide:true junto`, () => {
      const content = readFileSync(join(HOOKS_DIR, file), "utf8");
      const offenders = findDetachedWithoutWindowsHide(content);
      assert.deepEqual(
        offenders,
        [],
        `${file}: ${offenders.length} chamada(s) com detached:true sem windowsHide:true na janela ao redor ` +
          `(offsets: ${offenders.join(", ")}) — no Windows isso aloca um console visível a cada SessionStart (#7952).`,
      );
    });
  }
});
