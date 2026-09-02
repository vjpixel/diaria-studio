/**
 * test/claude-settings-hooks-exec-form.test.ts
 *
 * Regressão do #7106 (janelas de console piscando no Windows).
 *
 * Achado ao vivo 02/09/2026: 60s de amostragem de criação de processo na
 * máquina do editor capturaram **88 `conhost.exe`** — ~1,5 janela de console
 * por segundo, piscando por cima do que ele estivesse fazendo. Dos 191 spawns
 * de `bash.exe` no mesmo intervalo, **112 eram hooks**.
 *
 * Causa: os hooks estavam em SHELL FORM — `command` como string única
 * (`node "${CLAUDE_PROJECT_DIR}/.claude/hooks/foo.mjs"`), sem `args`. Nessa
 * forma o Claude Code SEMPRE entrega a string a um shell; no Windows esse
 * shell é o Git Bash, e cada `bash.exe` do Git for Windows aloca um
 * `conhost.exe`. Uma janela por hook, por chamada de ferramenta.
 *
 * O `"shell": "bash"` explícito que os hooks carregavam era REDUNDANTE, não a
 * causa — Git Bash já é o default no Windows, então removê-lo sozinho não
 * mudaria nada (era a correção errada que quase foi aplicada). O que tira o
 * shell do caminho é EXEC FORM: `command: "node"` + `args: [...]`, em que o
 * binário é spawnado direto.
 *
 * `${CLAUDE_PROJECT_DIR}` continua resolvendo em exec form: é placeholder de
 * path substituído pelo próprio Claude Code, inclusive dentro de elementos de
 * `args` — não é expansão de shell. Era exatamente essa dúvida que tornava a
 * migração arriscada sem confirmar: uma quebra silenciosa aqui desarmaria os
 * guards (`block-gh-pr-merge-subagent`, `block-branch-checkout-main`).
 *
 * Por que um teste e não o label `no-regression-test`: o que foi consertado
 * não é um bug pontual, é uma FORMA de escrever hook. Nada impede que o
 * próximo hook nasça em shell form e recrie as janelas — o custo reaparece em
 * silêncio, porque nada falha, só pisca. Este guard trava o invariante.
 *
 * Irmão de `test/claude-settings-headless-permissions.test.ts`: mesmo padrão
 * de ler o `.claude/settings.json` REAL e afirmar um invariante sobre ele
 * (fixture não serviria — o que precisa não regredir é o arquivo de verdade).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SETTINGS_PATH = resolve(REPO_ROOT, ".claude/settings.json");

interface HookEntry {
  type?: string;
  command?: string;
  args?: unknown;
  shell?: unknown;
}

/** Achata `hooks.{evento}[].hooks[]` numa lista com o evento de origem junto. */
function loadHookEntries(): Array<{ event: string; index: number; hook: HookEntry }> {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as {
    hooks?: Record<string, Array<{ hooks?: HookEntry[] }>>;
  };
  const hooks = parsed.hooks ?? {};
  const out: Array<{ event: string; index: number; hook: HookEntry }> = [];
  for (const [event, groups] of Object.entries(hooks)) {
    assert.ok(Array.isArray(groups), `hooks.${event} deve ser um array`);
    for (const group of groups) {
      for (const [index, hook] of (group.hooks ?? []).entries()) {
        out.push({ event, index, hook });
      }
    }
  }
  return out;
}

/** Descreve um hook de forma legível no assert (o índice sozinho não ajuda). */
function label(event: string, index: number, hook: HookEntry): string {
  const args = Array.isArray(hook.args) ? (hook.args as unknown[]) : [];
  const script = typeof args[0] === "string" ? (args[0] as string).split("/").pop() : hook.command;
  return `${event}[${index}] (${script})`;
}

describe("claude-settings-hooks-exec-form (#7106)", () => {
  it("há hooks configurados (o guard não passa por vacuidade)", () => {
    assert.ok(loadHookEntries().length > 0, "nenhum hook lido de .claude/settings.json");
  });

  it("nenhum hook declara a chave `shell`", () => {
    for (const { event, index, hook } of loadHookEntries()) {
      if (hook.type !== "command") continue;
      assert.equal(
        hook.shell,
        undefined,
        `${label(event, index, hook)} declara \`shell\` — em exec form ela é ` +
          `desnecessária, e sua presença sinaliza retorno ao shell form (#7106)`,
      );
    }
  });

  it("todo hook de comando usa exec form: `command` é só o binário, com `args`", () => {
    for (const { event, index, hook } of loadHookEntries()) {
      if (hook.type !== "command") continue;
      const where = label(event, index, hook);

      assert.ok(
        Array.isArray(hook.args) && (hook.args as unknown[]).length > 0,
        `${where} não tem \`args\` — sem ele o Claude Code roda em shell form, ` +
          `spawnando Git Bash (e uma janela de console) por invocação no Windows`,
      );

      // Shell form embute o caminho/argumentos dentro do próprio `command`.
      // Em exec form, `command` é só o executável — sem espaço, sem aspas.
      assert.doesNotMatch(
        String(hook.command ?? ""),
        /[\s"']/,
        `${where}: \`command\` deve ser só o binário (ex: "node"); ` +
          `caminho e argumentos vão em \`args\``,
      );
    }
  });

  it("os caminhos de script continuam em `args`, com o placeholder preservado", () => {
    for (const { event, index, hook } of loadHookEntries()) {
      if (hook.type !== "command") continue;
      const args = hook.args as unknown[];
      const first = args[0];
      assert.equal(
        typeof first,
        "string",
        `${label(event, index, hook)}: args[0] deve ser o caminho do script`,
      );
      // `${CLAUDE_PROJECT_DIR}` é substituído pelo Claude Code nos elementos de
      // `args` também — é o que torna a exec form viável sem shell.
      assert.match(
        first as string,
        /^\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\//,
        `${label(event, index, hook)}: caminho do hook deve começar por ` +
          `\${CLAUDE_PROJECT_DIR}/.claude/hooks/ (path absoluto ou relativo quebra ` +
          `dependendo de onde a sessão foi aberta)`,
      );
    }
  });

  it("argumentos posicionais ficam em elementos SEPARADOS de `args`", () => {
    // O caso que a migração podia ter errado: `notify-sound.mjs notification`
    // vira ["...notify-sound.mjs", "notification"], nunca um elemento só com o
    // espaço dentro (sem shell, isso vira um nome de arquivo com espaço).
    for (const { event, index, hook } of loadHookEntries()) {
      if (hook.type !== "command") continue;
      for (const [i, arg] of (hook.args as unknown[]).entries()) {
        assert.doesNotMatch(
          String(arg),
          /\s/,
          `${label(event, index, hook)}: args[${i}] contém espaço — em exec form ` +
            `cada argumento é um elemento próprio, não uma string a ser dividida`,
        );
      }
    }
  });
});
