/**
 * #12776 — o guard do #5716 recusou como merge (forma "que o guard não
 * consegue provar") um comando que só gravava dois arquivos de texto, depois
 * do fix da #12619 (sessão /diaria-desbloqueia no Neo, 11/11/2026):
 *
 *   C=/c/Users/.../scratchpad/c
 *   cat > $C/new-apoio-email-261110.md <<'EOF' … EOF
 *   cat > $C/c-12370-261110.md <<'EOF' … cita o comando de merge … EOF
 *   echo ok
 *
 * Reprodução isolou duas causas, cada uma suficiente: (1) a atribuição em
 * LINHA PRÓPRIA antes do 1º `cat` (a whitelist só aceitava `C=…; ` na mesma
 * linha) e (2) o `echo ok` no fim (nenhum consumidor da whitelist era `echo`).
 * Destino literal × `$VAR/…` e corpo com × sem o texto do comando foram
 * medidos: sozinhos, nenhum dos dois dispara.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isGhPrMergeCommand, isHeredocDataCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  detectMergeForGuard: (command: string, opts?: Record<string, unknown>) => { isMerge: boolean; error: string | null };
};

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
const detected = (cmd: string) => guard.detectMergeForGuard(cmd, { detect: (c: string) => isMerge(c) }).isMerge;
const MERGE = ["gh", "pr", "merge"].join(" ");
const C = "/c/Users/vjpixel/AppData/Local/Temp/claude/scratchpad/c";

const REAL =
  `C=${C}\n` +
  `cat > $C/new-apoio-email-261110.md <<'EOF'\nOlá, obrigado pelo apoio.\nEOF\n` +
  `cat > $C/c-12370-261110.md <<'EOF'\nA PR #12351 foi mergeada com \`${MERGE} 12351 --squash\`.\nEOF\n` +
  `echo ok`;

describe("#12776 — o comando real e as duas causas isoladas deixam de ser merge", () => {
  it("comando real (atribuição em linha própria + dois blocos + echo ok)", () => {
    assert.equal(isHeredocDataCommand(REAL), true);
    assert.equal(isMerge(REAL), false);
    assert.equal(detected(REAL), false);
  });

  const variants: Record<string, string> = {
    "só a atribuição em linha própria": `C=${C}\ncat > $C/b.md <<'EOF'\n\`${MERGE} 5\`\nEOF`,
    "só o echo ok no fim (destino literal)": `cat > /tmp/a.md <<'EOF'\nx\nEOF\ncat > /tmp/b.md <<'EOF'\n\`${MERGE} 5\`\nEOF\necho ok`,
    "atribuição em linha própria com ; no fim": `C=${C};\ncat > $C/b.md <<'EOF'\n\`${MERGE} 5\`\nEOF\necho ok`,
    "cd e atribuição em linhas próprias": `cd /wt\nC=${C}\ncat > $C/b.md <<'EOF'\n\`${MERGE} 5\`\nEOF\ngh issue comment 1 --body-file $C/b.md`,
    "echo com argumento entre aspas simples": `cat > /tmp/b.md <<'EOF'\n\`${MERGE} 5\`\nEOF\necho 'gravado'`,
  };
  for (const [name, cmd] of Object.entries(variants)) {
    it(name, () => {
      assert.equal(isMerge(cmd), false, cmd);
      assert.equal(detected(cmd), false, cmd);
    });
  }
});

describe("#12776 — merge real continua bloqueado", () => {
  const bypasses: Record<string, string> = {
    "merge simples": `${MERGE} 5 --squash`,
    "merge na linha de atribuição": `C=/tmp && ${MERGE} 5\ncat > $C/b.md <<'EOF'\nx\nEOF`,
    "atribuição com substituição de comando": `C=$(${MERGE} 5)\ncat > $C/b.md <<'EOF'\nx\nEOF`,
    "atribuição perigosa em linha própria": `GIT_EDITOR='sh /tmp/b.md'\ncat > /tmp/b.md <<'EOF'\n${MERGE} 5\nEOF\ngit commit`,
    "atribuição em linha própria restringe git commit": `C=/tmp\ncat > $C/b.md <<'EOF'\n${MERGE} 5\nEOF\ngit commit -F $C/b.md`,
    "merge entre a atribuição e o cat": `C=/tmp\n${MERGE} 5\ncat > $C/b.md <<'EOF'\nx\nEOF`,
    "merge depois do echo": `cat > /tmp/b.md <<'EOF'\nx\nEOF\necho ok\n${MERGE} 5`,
    "echo com substituição de comando": `cat > /tmp/b.md <<'EOF'\nx\nEOF\necho $(${MERGE} 5)`,
    "echo com crase": `cat > /tmp/b.md <<'EOF'\nx\nEOF\necho \`${MERGE} 5\``,
    "echo encadeado com merge": `cat > /tmp/b.md <<'EOF'\nx\nEOF\necho ok; ${MERGE} 5`,
    "echo com saída num shell": `cat > /tmp/b.md <<'EOF'\n${MERGE} 5\nEOF\necho ok | sh /tmp/b.md`,
    "corpo executado depois do echo": `C=/tmp\ncat > $C/b.md <<'EOF'\n${MERGE} 5\nEOF\necho ok\nbash $C/b.md`,
  };
  for (const [name, cmd] of Object.entries(bypasses)) {
    it(name, () => {
      assert.equal(isMerge(cmd), true, cmd);
      assert.equal(detected(cmd), true, cmd);
    });
  }
});
