/**
 * #11325 — o guard do #5716 (`block-gh-pr-merge-subagent.mjs`, detector em
 * `.claude/hooks/lib/gh-pr-merge-command.mjs`) bloqueava comando cujo TEXTO
 * citava `gh api` de endpoint variável: o self-review da #11300 escrito por
 * `cat > corpo.md <<'EOF'` com o trecho entre crases foi lido como comando
 * (crase = substituição) e o `gh api "$URL" -f …` virou "merge de endpoint
 * opaco".
 *
 * A correção NÃO descarta corpo de heredoc (o que o hook do #11300 faz é
 * aceitável lá, mas abriria `bash <<'EOF'` aqui): ela estende a whitelist
 * `isHeredocDataCommand` com as formas em que o corpo vai pra um arquivo ou
 * pro stdin do `gh … --body-file -`. Cada caso de falso positivo vem com o
 * bypass que a mudança não pode abrir — o guard de merge não fica mais frouxo
 * pra comando real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isGhPrMergeCommand, isHeredocDataCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  detectMergeForGuard: (command: string, opts?: Record<string, unknown>) => { isMerge: boolean; error: string | null };
};

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);

/** Trecho de self-review como o da #11300: cita `gh api` de endpoint variável. */
const REVIEW_TEXT = [
  "**Finding (confiança média, P3):** o comentário inline saiu por",
  '`gh api "$URL" -f body="$B"` em vez do helper.',
  "```",
  'gh api "repos/$REPO/pulls/$PR/comments" -X POST -f body=x',
  "```",
].join("\n");

const helper = "npx tsx scripts/gh-pr-review-api.ts comment --pr 11319 --path a.ts --line 3 --body-file /tmp/r-11325.md";

describe("#11325 — texto citando gh api/gh pr merge não é merge", () => {
  const cases: Record<string, string> = {
    "caso real: cat > arq <<'EOF' com crase citando gh api de endpoint variável": `cat > /tmp/r-11325.md <<'EOF'\n${REVIEW_TEXT}\nEOF`,
    "cat <<'EOF' > arq (ordem inversa)": `cat <<'EOF' > /tmp/r-11325.md\n${REVIEW_TEXT}\nEOF`,
    "cat >> arq (append) e cat >arq colado": `cat >>/tmp/r-11325.md <<'EOF'\n${REVIEW_TEXT}\nEOF`,
    "cat > arq seguido do helper de review na linha seguinte": `cat > /tmp/r-11325.md <<'EOF'\n${REVIEW_TEXT}\nEOF\n${helper}`,
    "cd do worktree antes, e consumidor com cd": `cd /wt/agent-x && cat > /tmp/r.md <<'EOF'\n${REVIEW_TEXT}\nEOF\ncd /wt/agent-x && gh pr comment 5 --body-file /tmp/r.md`,
    "corpo citando gh pr merge numa linha própria": `cat > /tmp/r.md <<'EOF'\nNunca rode:\ngh pr merge 5 --squash\n\`gh pr merge 5\`\nEOF`,
    "seguido de git commit -F e push": `cat > /tmp/m.md <<'EOF'\n${REVIEW_TEXT}\nEOF\ngit commit -F /tmp/m.md && git push -u origin overnight/fix-11325-x`,
    "gh pr comment --body-file - <<'EOF'": `gh pr comment 5 --body-file - <<'EOF'\n${REVIEW_TEXT}\nEOF`,
    "gh issue comment --body-file - <<'EOF'": `gh issue comment 11325 --body-file - <<'EOF'\n${REVIEW_TEXT}\nEOF`,
    "texto entre aspas simples": `echo 'use gh api "$URL" -X PUT e nunca gh pr merge 5'`,
    "--body entre aspas simples": `gh pr comment 5 --body 'nunca gh api "$URL" -X PUT nem gh pr merge 5'`,
    "--body entre aspas duplas (escapes)": `gh pr comment 5 --body "nunca gh api \\"\\$URL\\" -X PUT nem gh pr merge 5"`,
  };
  for (const [name, cmd] of Object.entries(cases)) {
    it(name, () => {
      assert.equal(isMerge(cmd), false, cmd);
      assert.equal(guard.detectMergeForGuard(cmd, { detect: (c: string) => isMerge(c) }).isMerge, false, cmd);
    });
  }

  it("as formas de heredoc entram na whitelist", () => {
    assert.equal(isHeredocDataCommand(cases["caso real: cat > arq <<'EOF' com crase citando gh api de endpoint variável"]), true);
    assert.equal(isHeredocDataCommand(cases["cat > arq seguido do helper de review na linha seguinte"]), true);
    assert.equal(isHeredocDataCommand(cases["gh pr comment --body-file - <<'EOF'"]), true);
  });
});

describe("#11325 — merge real continua bloqueado (a whitelist não abre bypass)", () => {
  const bypasses: Record<string, string> = {
    "gh pr merge simples": "gh pr merge 5 --squash",
    "gh api PUT …/pulls/N/merge": "gh api -X PUT repos/vjpixel/diaria-studio/pulls/5/merge",
    "gh api de endpoint variável executado de verdade": 'gh api "$URL" -X PUT',
    "arquivo escrito e executado na mesma chamada": "cat > /tmp/x.sh <<'EOF'\ngh pr merge 5\nEOF\nbash /tmp/x.sh",
    "arquivo escrito e sourced": "cat > /tmp/x.sh <<'EOF'\ngh pr merge 5\nEOF\n. /tmp/x.sh",
    "merge depois do fecho": "cat > /tmp/r.md <<'EOF'\nx\nEOF\ngh pr merge 5",
    "consumidor seguido de merge": `cat > /tmp/r.md <<'EOF'\nx\nEOF\n${helper}; gh pr merge 5`,
    "consumidor com 2ª linha de merge": `cat > /tmp/r.md <<'EOF'\nx\nEOF\n${helper}\ngh pr merge 5`,
    "consumidor com substituição no argumento": "cat > /tmp/r.md <<'EOF'\nx\nEOF\ngh pr comment 5 --body-file $(gh pr merge 5)",
    "merge no cabeçalho depois do cat": "cat > /tmp/r.md <<'EOF' && gh pr merge 5\nx\nEOF",
    "destino com substituição": "cat > \"$(gh pr merge 5)\" <<'EOF'\nx\nEOF",
    "delimitador sem aspas (o corpo expande)": "cat > /tmp/r.md <<EOF\n$(gh pr merge 5)\nEOF",
    "delimitador sem aspas com crase": "cat > /tmp/r.md <<EOF\n`gh pr merge 5`\nEOF",
    "cat | sh": "cat <<'EOF' | sh\ngh pr merge 5\nEOF",
    "bash <<'EOF'": "bash <<'EOF'\ngh pr merge 5\nEOF",
    "fecho antecipado em D)": "cat > /tmp/r.md <<'EOF'\nx\nEOF)\ngh pr merge 5\nEOF",
    "gh pr comment --body-file - com merge depois do fecho": "gh pr comment 5 --body-file - <<'EOF'\nx\nEOF\ngh pr merge 5",
    "--body-file - num comando que não é gh comment": "bash --body-file - <<'EOF'\ngh pr merge 5\nEOF",
    "aspas não cobrem o comando real": `echo 'texto' && gh pr merge 5`,
    // self-review finding 1: o consumidor executa código do repo — o destino
    // do `cat` não pode ser um arquivo que ele roda.
    "sobrescreve o helper e o executa": `cat > scripts/gh-pr-review-api.ts <<'EOF'\nexecSync(\`gh pr merge 5\`);\nEOF\n${helper}`,
    "sobrescreve hook do git e commita": "cat > .git/hooks/pre-commit <<'EOF'\ngh pr merge 5\nEOF\ngit commit -F /tmp/m.md",
    "sobrescreve tsconfig.json e roda tsx": `cat > tsconfig.json <<'EOF'\n{"x": "\`gh pr merge 5\`"}\nEOF\n${helper}`,
    "destino .md com sufixo enganoso": "cat > /tmp/x.md.sh <<'EOF'\ngh pr merge 5\nEOF",
  };
  for (const [name, cmd] of Object.entries(bypasses)) {
    it(name, () => {
      assert.equal(isMerge(cmd), true, cmd);
      assert.equal(guard.detectMergeForGuard(cmd, { detect: (c: string) => isMerge(c) }).isMerge, true, cmd);
    });
  }
});
