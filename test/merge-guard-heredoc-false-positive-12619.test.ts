/**
 * #12619 — o guard do #5716 (`block-gh-pr-merge-subagent.mjs`, detector em
 * `.claude/hooks/lib/gh-pr-merge-command.mjs`) bloqueou dois comandos que não
 * eram merge, na sessão de 10/11/2026 (PR #12597). Os dois comandos reais
 * estão em `test/fixtures/merge-guard-12619/`, copiados do transcript:
 *
 * 1. `cd X; python3 - <<'EOF' … EOF` com um script de `str.replace`: o corpo
 *    (aspas triplas do Python, crases de template literal do TS) era lido
 *    como shell, aninhava além de `MAX_DEPTH` e virava merge opaco ("depth"),
 *    sem `gh` nenhum no texto.
 * 2. `cd X; S=…; cat > $S/e1.md <<'EOF' … EOF` + `gh issue create
 *    --body-file`, DUAS vezes na mesma chamada, com o 2º corpo citando o
 *    comando de merge em prosa: a whitelist de heredoc-como-dado só aceitava
 *    um bloco, e `cd` antes da atribuição, com `;`.
 *
 * Cada falso positivo vem com os merges reais que a mudança não pode soltar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isGhPrMergeCommand,
  isHeredocDataCommand,
  stripInterpreterHeredocBody,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  detectMergeForGuard: (command: string, opts?: Record<string, unknown>) => { isMerge: boolean; error: string | null };
};

const noAliases = { aliases: new Map<string, string>() };
const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
const detected = (cmd: string) => guard.detectMergeForGuard(cmd, { detect: (c: string) => isMerge(c) }).isMerge;
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/merge-guard-12619/${name}`, import.meta.url), "utf8");

const PY_REAL = fixture("python-heredoc.sh.txt");
const ISSUES_REAL = fixture("two-issue-bodies.sh.txt");
const MERGE = ["gh", "pr", "merge"].join(" ");
const S = "/tmp/claude-1000/x/scratchpad";

describe("#12619 — os dois comandos reais deixam de ser merge", () => {
  it("as fixtures são as do incidente (sanidade)", () => {
    assert.match(PY_REAL, /^cd \/home\/vjpixel\/diaria-wt-12591; python3 - <<'EOF'\n/);
    assert.doesNotMatch(PY_REAL, /\bgh\b/);
    assert.equal(ISSUES_REAL.split("gh issue create").length - 1, 2);
    assert.ok(ISSUES_REAL.includes(`\`${MERGE}\``), "o 2º corpo cita o comando em prosa");
  });

  it("caso 1: python3 - <<'EOF' com o script real", () => {
    assert.equal(isMerge(PY_REAL), false);
    assert.equal(detected(PY_REAL), false);
    assert.notEqual(stripInterpreterHeredocBody(PY_REAL), null);
  });

  it("caso 2: dois cat > $S/x.md <<'EOF' + gh issue create --body-file", () => {
    assert.equal(isHeredocDataCommand(ISSUES_REAL), true);
    assert.equal(isMerge(ISSUES_REAL), false);
    assert.equal(detected(ISSUES_REAL), false);
  });

  const variants: Record<string, string> = {
    "python3 sem o -": "python3 <<'EOF'\ns = `a ${'`'}`\nEOF",
    "node -": "cd /wt && node - <<'EOF'\nconst x = `a ${`b ${`c`}`}`;\nEOF\nnpx tsx --test test/a.test.ts",
    "python com prefixo de atribuição": "P=scripts/a.ts; python3 - <<'EOF'\nprint(open('scripts/a.ts').read())\nEOF",
    "cd X && S=…; cat (ordem cd → atribuição com &&)": `cd /wt && S=${S}; cat > $S/a-12619.md <<'EOF'\ncita \`${MERGE} 5\`\nEOF\ngh issue comment 1 --body-file $S/a-12619.md`,
    "dois blocos sem atribuição, com helper e commit": `cat > /tmp/a.md <<'EOF'\n\`${MERGE} 5\`\nEOF\nnpx tsx scripts/gh-pr-review-api.ts comment --pr 1 --path a.ts --line 1 --body-file /tmp/a.md\ncat > /tmp/b.md <<'EOF'\nx\nEOF\ngit commit -F /tmp/b.md`,
  };
  for (const [name, cmd] of Object.entries(variants)) {
    it(name, () => {
      assert.equal(isMerge(cmd), false, cmd);
      assert.equal(detected(cmd), false, cmd);
    });
  }
});

describe("#12619 — merge real continua bloqueado", () => {
  const bypasses: Record<string, string> = {
    "merge simples": `${MERGE} 5 --squash`,
    "merge depois do script Python": `python3 - <<'EOF'\nprint(1)\nEOF\n${MERGE} 5`,
    "merge na linha do cabeçalho do Python": `python3 - <<'EOF' && ${MERGE} 5\nprint(1)\nEOF`,
    "delimitador sem aspas (o bash expande o corpo)": `python3 - <<EOF\n$(${MERGE} 5)\nEOF`,
    "bash - <<'EOF' não é interpretador da whitelist": `bash - <<'EOF'\n${MERGE} 5\nEOF`,
    "fecho antecipado e merge": `python3 - <<'EOF'\nprint(1)\nEOF )\n${MERGE} 5\nEOF`,
    "atribuição perigosa antes do python": `GIT_EDITOR='${MERGE} 5'; python3 - <<'EOF'\nprint(1)\nEOF`,
    "2º bloco cat seguido de execução do arquivo": `cat > /tmp/a.md <<'EOF'\nx\nEOF\ncat > /tmp/x.sh <<'EOF'\n${MERGE} 5\nEOF\nbash /tmp/x.sh`,
    "2º bloco seguido de merge": `cat > /tmp/a.md <<'EOF'\nx\nEOF\ncat > /tmp/b.md <<'EOF'\ny\nEOF\n${MERGE} 5`,
    "linha entre blocos que executa o 1º arquivo": `cat > /tmp/a.md <<'EOF'\n${MERGE} 5\nEOF\nsh /tmp/a.md\ncat > /tmp/b.md <<'EOF'\ny\nEOF`,
    "atribuição no 2º bloco restringe o consumidor do 1º (git commit)": `cat > x.md <<'EOF'\n${MERGE} 5\nEOF\ngit commit -F x.md\nS=/tmp; cat > $S/b.md <<'EOF'\ny\nEOF`,
    "atribuição perigosa no 2º bloco": `cat > a.md <<'EOF'\nx\nEOF\nBROWSER='sh a.md'; cat > b.md <<'EOF'\n${MERGE} 5\nEOF\ngh pr create --body-file b.md`,
    "cd com ; antes de atribuição perigosa": `cd /wt; GIT_EDITOR='sh x.md'; cat > x.md <<'EOF'\n${MERGE} 5\nEOF\ngit commit`,
  };
  for (const [name, cmd] of Object.entries(bypasses)) {
    it(name, () => {
      assert.equal(isMerge(cmd), true, cmd);
      assert.equal(detected(cmd), true, cmd);
    });
  }
});

/**
 * Script que CHAMA o merge pelo interpretador (`subprocess`, `execSync`,
 * `curl …/merge`) é limite conhecido do detector desde antes do #12619 (o
 * mesmo de `python3 -c '…'`, topo do módulo): lido como shell, o corpo não
 * vira merge, nem antes nem depois. O que este bloco trava é que a forma do
 * #12619 NÃO se aplica a ele — o corpo continua na leitura fail-closed, e
 * qualquer melhoria futura do detector o alcança.
 */
describe("#12619 — corpo que cita gh/merge, ou interpretador fora da forma, segue na leitura fail-closed", () => {
  const kept: Record<string, string> = {
    "script Python que chama o merge": `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(["gh", "pr", "merge", "5"])\nEOF`,
    "script Node que chama o merge por execSync": `node - <<'EOF'\nrequire("child_process").execSync("${MERGE} 5");\nEOF`,
    "script Python com curl de merge REST": `python3 - <<'EOF'\nimport os\nos.system("curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge")\nEOF`,
    "gh.exe citado": `python3 - <<'EOF'\nrun("gh.exe")\nEOF`,
    "saída do Python num shell": `python3 - <<'EOF' | sh\nprint('x')\nEOF`,
    "python com argumento depois do heredoc": `python3 - <<'EOF' x\nprint(1)\nEOF`,
    "delimitador sem aspas": `python3 - <<EOF\nprint(1)\nEOF`,
    "sem fecho": `python3 - <<'EOF'\nprint(1)`,
  };
  for (const [name, cmd] of Object.entries(kept)) {
    it(name, () => assert.equal(stripInterpreterHeredocBody(cmd), null, cmd));
  }

  it("menção a gh-pr-safe-edit.ts (nome de arquivo) não conta como gh", () => {
    const cmd = "python3 - <<'EOF'\nprint('scripts/lib/gh-pr-safe-edit.ts')\nEOF";
    assert.equal(stripInterpreterHeredocBody(cmd), "python3 - <<'EOF'\nEOF");
  });
});
