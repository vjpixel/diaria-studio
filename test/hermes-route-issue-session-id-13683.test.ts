/**
 * test/hermes-route-issue-session-id-13683.test.ts (#13683)
 *
 * O `route-issue.ts` só solta a claim da PRÓPRIA sessão que roteia (#13671) e,
 * sem `--session-id`, não solta nada. Dentro do Claude Code o hook
 * `inject-session-id` acrescenta a flag; o Hermes roda fora dele, então a skill
 * `hermes-diaria-continuo` precisa mandar passar `--session-id "$SESSION_ID"`
 * em toda chamada de `route-issue.ts`. Sem isso a claim `continuo` fica na
 * issue roteada para `develop`/`bloqueada` e volta o caso da #13605.
 *
 * O guard lê as instruções que o tick do Hermes segue (SKILL.md + referência
 * do re-roteamento) e confere:
 *  1. a instrução de re-roteamento do SKILL.md cita `--session-id "$SESSION_ID"`;
 *  2. a referência `route-issue-triaged-at-11301.md` também;
 *  3. todo comando `route-issue.ts` escrito por extenso em qualquer arquivo
 *     da skill (bloco ou linha que comece pelo executor) traz `--session-id`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, "hermes", "skills", "hermes-diaria-continuo");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const REFERENCE = join(SKILL_DIR, "references", "route-issue-triaged-at-11301.md");

/** Parágrafo do SKILL.md que começa em `**Re-roteamento` (até a linha em branco). */
export function reRoutingParagraph(skill: string): string | null {
  const start = skill.indexOf("**Re-roteamento");
  if (start === -1) return null;
  const end = skill.indexOf("\n\n", start);
  return skill.slice(start, end === -1 ? undefined : end);
}

/**
 * Comandos `route-issue.ts` escritos por extenso: linha cujo 1º token é o
 * executor (`npx tsx`/`tsx`/`node`), juntando as continuações com `\`.
 * Menção em prosa (`` `route-issue.ts` em issue existente ``) não conta.
 */
export function routeIssueCommands(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:npx\s+tsx|tsx|node)\s+\S*route-issue\.ts\b/.test(lines[i])) continue;
    let cmd = lines[i];
    while (/\\\s*$/.test(cmd) && i + 1 < lines.length) {
      i++;
      cmd = cmd.replace(/\\\s*$/, " ") + lines[i].trim();
    }
    out.push(cmd.trim());
  }
  return out;
}

function skillMarkdownFiles(): string[] {
  const refs = readdirSync(join(SKILL_DIR, "references"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(SKILL_DIR, "references", f));
  return [SKILL_MD, ...refs];
}

describe("hermes-diaria-continuo passa --session-id ao route-issue.ts (#13683)", () => {
  it("instrução de re-roteamento do SKILL.md cita --session-id \"$SESSION_ID\"", () => {
    const paragraph = reRoutingParagraph(readFileSync(SKILL_MD, "utf8"));
    assert.ok(paragraph, "parágrafo **Re-roteamento não encontrado no SKILL.md");
    assert.ok(paragraph.includes("route-issue.ts"), paragraph);
    assert.ok(paragraph.includes('--session-id "$SESSION_ID"'), paragraph);
  });

  it("referência do re-roteamento cita --session-id \"$SESSION_ID\"", () => {
    const ref = readFileSync(REFERENCE, "utf8");
    assert.ok(ref.includes('--session-id "$SESSION_ID"'), ref);
  });

  it("todo comando route-issue.ts escrito por extenso na skill traz --session-id", () => {
    const missing: string[] = [];
    let total = 0;
    for (const file of skillMarkdownFiles()) {
      for (const cmd of routeIssueCommands(readFileSync(file, "utf8"))) {
        total++;
        if (!/--session-id\b/.test(cmd)) missing.push(`${file}: ${cmd}`);
      }
    }
    assert.ok(total > 0, "nenhum comando route-issue.ts por extenso — a referência devia trazer a forma completa");
    assert.deepEqual(missing, []);
  });

  it("routeIssueCommands discrimina: comando sem a flag é apontado, prosa não conta", () => {
    const sample = [
      "`route-issue.ts` em issue existente leva a flag.",
      "    npx tsx scripts/route-issue.ts --issue 1 --track develop \\",
      '      --triaged-at "t"',
      '    npx tsx scripts/route-issue.ts --issue 2 --track develop --session-id "$SESSION_ID"',
    ].join("\n");
    const cmds = routeIssueCommands(sample);
    assert.equal(cmds.length, 2);
    assert.equal(/--session-id\b/.test(cmds[0]), false);
    assert.equal(/--session-id\b/.test(cmds[1]), true);
  });
});
