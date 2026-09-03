/**
 * test/session-beacon-matcher.test.ts (#7194)
 *
 * Regressão: o matcher `PreToolUse` do `session-beacon.mjs` em
 * `.claude/settings.json` era `"Bash|Edit|Write|NotebookEdit"` — não cobria
 * `mcp__*` nem `AskUserQuestion`. Uma sessão presa numa sequência longa de
 * chamadas MCP (Beehiiv, Gmail, browser) ou parada num gate `AskUserQuestion`
 * esperando o editor não emitia heartbeat nenhum, ficando indistinguível de
 * morta — e o `session-registry` só mede silêncio (`lastHeartbeat`), então
 * "não chamou Bash/Edit/Write há muito tempo" virava, incorretamente,
 * "sessão morta": claims expiravam e outra coordenadora podia legitimamente
 * assumir o trabalho de uma sessão viva (achado ao vivo #7194, 02-03/09/2026
 * — `develop-Neo-1a9173b8` teve `claimed_issues_effective` esvaziado e o PR
 * #7164 assumido por outra sessão enquanto estava viva, numa chamada MCP +
 * `AskUserQuestion` de gate).
 *
 * Este guard trava só a DIREÇÃO (a) do corpo da issue — ampliar o matcher
 * para cobrir os dois tipos de ferramenta que hoje não emitem heartbeat. As
 * direções (b)/(c)/(d) (heartbeat em `PostToolUse`, sinal de vitalidade via
 * `pid`) são follow-up, fora do escopo deste PR.
 *
 * Companheiro de `test/claude-settings-hooks-exec-form.test.ts` (que trava a
 * FORMA exec dos hooks, não o conteúdo do matcher) e de
 * `test/session-beacon-hook.test.ts` (comportamento das funções puras do
 * hook) — nenhum dos dois travava o valor do matcher em si.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SETTINGS_PATH = resolve(REPO_ROOT, ".claude/settings.json");
const HOOK_SCRIPT_NAME = "session-beacon.mjs";

interface HookEntry {
  type?: string;
  command?: string;
  args?: unknown;
}

interface PreToolUseGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

function loadPreToolUseGroups(): PreToolUseGroup[] {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as {
    hooks?: { PreToolUse?: PreToolUseGroup[] };
  };
  return parsed.hooks?.PreToolUse ?? [];
}

/** Acha o grupo `PreToolUse` cujos hooks incluem o script do beacon. */
function findBeaconGroup(groups: PreToolUseGroup[]): PreToolUseGroup {
  const matches = groups.filter((g) =>
    (g.hooks ?? []).some((h) => {
      const args = Array.isArray(h.args) ? (h.args as unknown[]) : [];
      return args.some((a) => typeof a === "string" && a.endsWith(`/${HOOK_SCRIPT_NAME}`));
    }),
  );
  assert.equal(
    matches.length,
    1,
    `esperava exatamente 1 grupo PreToolUse com ${HOOK_SCRIPT_NAME} em .claude/settings.json, achou ${matches.length}`,
  );
  return matches[0];
}

/** Tools que o matcher precisa cobrir depois do fix do #7194 — cada um por um teste próprio. */
const MUST_MATCH_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "AskUserQuestion",
  "mcp__clarice__correct_text",
  "mcp__claude_ai_Beehiiv__get_post",
  "mcp__claude-in-chrome__navigate",
];

describe("session-beacon matcher cobre mcp__* e AskUserQuestion (#7194)", () => {
  const group = findBeaconGroup(loadPreToolUseGroups());

  it("o grupo do beacon declara um matcher (string, não vazio)", () => {
    assert.equal(typeof group.matcher, "string");
    assert.ok((group.matcher as string).length > 0);
  });

  for (const toolName of MUST_MATCH_TOOL_NAMES) {
    it(`matcher casa com a tool "${toolName}"`, () => {
      const pattern = new RegExp(`^(?:${group.matcher})$`);
      assert.ok(
        pattern.test(toolName),
        `matcher "${group.matcher}" não casa com "${toolName}" — o beacon não emitiria heartbeat nessa chamada`,
      );
    });
  }

  it("matcher continua sem casar com uma tool nunca coberta (sanity — regex não virou catch-all acidental)", () => {
    const pattern = new RegExp(`^(?:${group.matcher})$`);
    assert.equal(
      pattern.test("TotallyUnrelatedToolName"),
      false,
      "matcher virou catch-all — perde o valor de sinalizar QUAIS ferramentas emitem heartbeat",
    );
  });
});
