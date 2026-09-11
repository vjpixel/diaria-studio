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
 * spawn/execFile close o bastante pra colidir. **2º modo de falso-negativo,
 * medido ao vivo (achado do fleet review pré-merge, comment-analyzer):** a
 * janela também casa `windowsHide: true` citado em PROSA de comentário (ex:
 * os próprios comentários explicativos que este PR adiciona citam a opção
 * pelo nome) — o guard geral não distingue código de comentário, é texto
 * puro. Mitigado neste arquivo especificamente pelo 2º guard abaixo, que
 * varre só PRA FRENTE a partir da chamada (comentários explicativos ficam
 * ANTES da chamada no estilo deste repo, então saem da janela forward) —
 * mas o guard geral, aplicado aos outros 17 hooks, segue exposto a esse
 * modo. Aceito pelo mesmo custo/benefício acima.
 *
 * **2º guard, mais estrito, só pro arquivo que este PR toca (achado do fleet
 * review pré-merge, silent-failure-hunter):** `detached: true` sozinho NÃO
 * cobre `runBootstrap()`/`cloneRepo()` em `session-start-claude-config-sync.mjs`
 * — as duas chamam `execFile` SEM `detached` (são síncronas do ponto de
 * vista do filho que as invoca), mas ainda alocam console próprio no
 * Windows por rodarem um binário de console (`git`/`powershell.exe`) —
 * é exatamente por isso que a #7952 pediu `windowsHide` nelas também. O
 * guard geral acima nunca as veria (não têm `detached: true` pra ancorar a
 * busca). `findWindowsHideMissingCalls` cobre TODA chamada
 * `execFile`/`execFileSync`/`spawn`/`spawnSync`, com ou sem `detached` —
 * mas só é aplicado a `session-start-claude-config-sync.mjs`, não a todo
 * hook do diretório: os outros hooks têm `execFileSync("git", ...)` sem
 * `windowsHide` pré-existentes, fora do escopo desta issue (#7952 mira
 * especificamente o hook de SessionStart, o de maior frequência — 1x por
 * sessão nova) — aplicar o guard estrito a todo o diretório seria escopo
 * novo, não a regressão deste PR.
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

/** Pura — recebe o conteúdo já lido de um arquivo `.mjs`, devolve o offset
 * (não linha — mais barato de calcular, suficiente pra achar no editor) de todo
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

/** 2º guard, mais estrito (ver docstring do módulo) — varre TODA chamada
 * `execFile`/`execFileSync`/`spawn`/`spawnSync`, com ou sem `detached`, e
 * confirma `windowsHide: true` na janela ao redor. Pura. */
export function findWindowsHideMissingCalls(content: string): number[] {
  const offenders: number[] = [];
  const callRe = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(content)) !== null) {
    const start = match.index;
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

describe("findWindowsHideMissingCalls (#7952, achado do fleet review) — lógica pura", () => {
  it("execFile SEM detached e SEM windowsHide -> 1 ofensor (era invisível pro 1º guard)", () => {
    const content = `execFile("git", ["clone", url, dir], { timeout: 60000 }, cb);`;
    assert.deepEqual(findWindowsHideMissingCalls(content).length, 1);
  });

  it("execFile SEM detached mas COM windowsHide -> nenhum ofensor", () => {
    const content = `execFile("git", ["clone", url, dir], { timeout: 60000, windowsHide: true }, cb);`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("spawn detached COM windowsHide -> nenhum ofensor (mesma chamada, os 2 guards concordam)", () => {
    const content = `spawn("node", [], { detached: true, windowsHide: true });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
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

describe("Regressão #7952 (guard estrito) — session-start-claude-config-sync.mjs", () => {
  const STRICT_FILE = "session-start-claude-config-sync.mjs";

  it(`${STRICT_FILE}: TODA chamada execFile/execFileSync/spawn/spawnSync declara windowsHide:true, ` +
    "com ou sem detached (os 3 pontos que a #7952 corrigiu — runBootstrap e cloneRepo não têm " +
    "detached, então o guard geral acima nunca os veria)", () => {
    const path = join(HOOKS_DIR, STRICT_FILE);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      assert.fail(`${STRICT_FILE} deveria existir em ${HOOKS_DIR} — este guard é específico dele`);
      return;
    }
    const offenders = findWindowsHideMissingCalls(content);
    assert.deepEqual(
      offenders,
      [],
      `${STRICT_FILE}: ${offenders.length} chamada(s) de processo sem windowsHide:true (offsets: ` +
        `${offenders.join(", ")}) — mesmo sem detached, rodar um binário de console (git/powershell.exe) ` +
        "aloca janela no Windows (#7952).",
    );
  });
});
