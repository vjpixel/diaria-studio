/**
 * #12780 — o hook de caminho protegido (#12009) negou um `node -e` que gravava
 * `data/overnight/.../plan.json` porque o campo `nota` do plano citava
 * `.claude/hooks` em prosa (overnight 261110e). O alvo da escrita era o
 * plano; o caminho protegido só aparecia dentro de uma string de texto.
 *
 * Cada caso liberado vem com as escritas reais que a mudança não pode soltar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codeWritesProtectedPath, findProtectedPathWrite } from "../scripts/lib/protected-path-bash-write.mjs";

const CWD = "/home/u/diaria-studio/.claude/worktrees/agent-x";
const find = (cmd: string) => findProtectedPathWrite(cmd, { cwd: CWD });
const PLAN = "data/overnight/261110e/plan.json";
const HOOKS = [".claude", "hooks"].join("/");

describe("#12780 — caminho protegido só em string de prosa não bloqueia", () => {
  it("cenário da issue: node -e grava plan.json com nota citando .claude/hooks", () => {
    const cmd =
      `node -e "const fs=require('fs');const p='${PLAN}';const j=JSON.parse(fs.readFileSync(p,'utf8'));` +
      `j.issues[0].nota='hook em ${HOOKS}/block-x.mjs precisa distinguir alvo de texto';` +
      `fs.writeFileSync(p,JSON.stringify(j,null,2))"`;
    assert.equal(find(cmd), null, JSON.stringify(find(cmd)));
  });

  const passing: Record<string, string> = {
    "aspas duplas dentro de node heredoc": `node - <<'EOF'\nconst fs = require("fs");\nconst j = { nota: "corrigir o guard em ${HOOKS}/x.mjs depois" };\nfs.writeFileSync("${PLAN}", JSON.stringify(j));\nEOF`,
    "python -c com nota": `python3 -c "import json; d={'nota': 'ver ${HOOKS} e .claude/skills na próxima'}; open('${PLAN}','w').write(json.dumps(d))"`,
    ".claude/settings.json citado em prosa": `node -e "require('fs').writeFileSync('/tmp/o-12780.json', JSON.stringify({m: 'mexer em .claude/settings.json pelo Edit'}))"`,
  };
  for (const [name, cmd] of Object.entries(passing)) {
    it(name, () => assert.equal(find(cmd), null, `${cmd} → ${JSON.stringify(find(cmd))}`));
  }
});

describe("#12780 — escrita real em caminho protegido continua bloqueada", () => {
  const blocked: Record<string, string> = {
    "node -e grava no hook (literal sem espaço)": `node -e "require('fs').writeFileSync('${HOOKS}/x.mjs','x')"`,
    "nota em prosa + escrita no hook": `node -e "const n='hook em ${HOOKS}/x.mjs'; require('fs').writeFileSync('${HOOKS}/x.mjs', n)"`,
    "caminho com espaço no nome": `node -e "require('fs').writeFileSync('${HOOKS}/a b.mjs','x')"`,
    "caminho absoluto com espaço no nome": `node -e "require('fs').writeFileSync('/home/u/r/${HOOKS}/a b.mjs','x')"`,
    "string com sed -i (API de escrita dentro da string)": `node -e "require('child_process').execSync('sed -i s/a/b/ ${HOOKS}/x.mjs'); require('fs').writeFileSync('/tmp/a','')"`,
    "string que é comando de shell escrevendo no protegido": `node -e "require('child_process').execSync('cp /tmp/x ${HOOKS}/x.mjs'); require('fs').writeFileSync('/tmp/a','')"`,
    "string com redirect para o protegido": `python3 -c "import os; os.system('echo x > .claude/settings.json'); open('/tmp/a','w').write('')"`,
    "python heredoc: variável com o caminho + open w": `python3 - <<'EOF'\np = ".claude/skills/a/SKILL.md"\nnota = "ajuste em ${HOOKS} depois"\nopen(p, "w").write(nota)\nEOF`,
    "os.path.join com partes": `python3 -c "import os; open(os.path.join('.', '.claude', 'hooks', 'x.mjs'), 'w').write('a b c')"`,
  };
  for (const [name, cmd] of Object.entries(blocked)) {
    it(name, () => assert.notEqual(find(cmd), null, cmd));
  }

  it("template literal não é tratado como prosa (pode ter ${})", () => {
    assert.equal(codeWritesProtectedPath("const n = `hook em " + HOOKS + " x`; writeFileSync('/tmp/a', n)"), true);
  });

  it("co-ocorrência ler protegido + escrever fora segue bloqueando (limite do #12009)", () => {
    assert.equal(codeWritesProtectedPath(`s = open(".claude/settings.json").read()\nopen("/tmp/o", "w").write(s)`), true);
  });
});
