import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  findProtectedPathWrite,
  isProtectedPath,
  codeWritesProtectedPath,
  shouldBlockProtectedPathWrite,
  protectedPathWriteReason,
} from "../scripts/lib/protected-path-bash-write.mjs";

// #12009 — overnight 261103, unidade #11990: o dev-implementador alterou
// `.claude/skills/diaria-video-montagem/SKILL.md` por script Python no Bash,
// contornando a checagem de caminho protegido do Edit/Write.

const ROOT = join(import.meta.dirname, "..");
const HOOK = join(ROOT, ".claude", "hooks", "block-bash-protected-path-write.mjs");
const CWD = "/home/u/diaria-studio/.claude/worktrees/agent-x";
const SKILL = ".claude/skills/diaria-video-montagem/SKILL.md";

const find = (cmd: string, opts: Record<string, unknown> = {}) => findProtectedPathWrite(cmd, { cwd: CWD, ...opts });
const blocks = (cmd: string, opts: Record<string, unknown> = {}) => assert.notEqual(find(cmd, opts), null, `devia bloquear: ${cmd}`);
const passes = (cmd: string, opts: Record<string, unknown> = {}) =>
  assert.equal(find(cmd, opts), null, `devia passar: ${cmd} → ${JSON.stringify(find(cmd, opts))}`);

describe("isProtectedPath (#12009)", () => {
  it("skills/agents/hooks/settings sob .claude/ são protegidos, relativos ou absolutos", () => {
    assert.ok(isProtectedPath(SKILL, CWD));
    assert.ok(isProtectedPath("./.claude/agents/writer.md", CWD));
    assert.ok(isProtectedPath(".claude/hooks/x.mjs"));
    assert.ok(isProtectedPath(".claude/settings.json"));
    assert.ok(isProtectedPath(".claude/settings.local.json"));
    assert.ok(isProtectedPath("/home/u/diaria-studio/.claude/skills/a/SKILL.md"));
    assert.ok(isProtectedPath("$CLAUDE_PROJECT_DIR/.claude/settings.json"));
    assert.ok(isProtectedPath("~/.claude/skills/humanizador/SKILL.md"));
    assert.ok(isProtectedPath("C:\\Users\\v\\diaria-studio\\.claude\\agents\\x.md"));
    assert.ok(isProtectedPath(".claude/skills/*/SKILL.md"), "glob dentro de entrada protegida");
    assert.ok(isProtectedPath(".claude/*"), "glob na entrada");
    assert.ok(isProtectedPath(".claude/"), "o próprio .claude/ como destino");
    assert.ok(isProtectedPath(".mcp.json"));
    assert.ok(isProtectedPath(".git/hooks/pre-commit"));
  });
  it("relativo dentro de cwd protegido conta", () => {
    assert.ok(isProtectedPath("SKILL.md", "/r/.claude/skills/foo"));
  });
  it("worktree, memória e o resto ficam livres; .claude aninhado no worktree volta a ser protegido", () => {
    assert.equal(isProtectedPath("scripts/lib/x.ts", CWD), false);
    assert.equal(isProtectedPath("/r/.claude/worktrees/agent-x"), false);
    assert.equal(isProtectedPath(".claude/worktrees/agent-*"), false);
    assert.equal(isProtectedPath("~/.claude/projects/p/memory/MEMORY.md"), false);
    assert.equal(isProtectedPath("/tmp/claude-1000/scratch/body.md"), false);
    assert.equal(isProtectedPath(".git/index.lock"), false, "limpeza de lock órfão segue livre");
    assert.equal(isProtectedPath("docs/.claude-notes.md"), false);
    assert.ok(isProtectedPath(".claude/skills/x/SKILL.md", CWD), "o .claude/ do próprio worktree é protegido");
    assert.ok(isProtectedPath("../../skills/x/SKILL.md", CWD), "`..` saindo do worktree para .claude/skills");
  });
});

describe("findProtectedPathWrite — escrita bloqueada (#12009)", () => {
  it("cenário da issue: python heredoc lendo e reescrevendo o SKILL.md", () => {
    blocks(`python3 - <<'EOF'\np = "${SKILL}"\ns = open(p).read()\ns = s.replace("a", "b")\nopen(p, "w").write(s)\nEOF`);
    blocks(`python3 <<EOF\nfrom pathlib import Path\nPath("${SKILL}").write_text("x")\nEOF`);
  });
  it("python -c / node -e / perl -e / tsx -e", () => {
    blocks(`python3 -c "open('${SKILL}','w').write('x')"`);
    blocks(`python -c 'import pathlib; pathlib.Path(".claude/settings.json").write_text("{}")'`);
    blocks(`node -e "require('fs').writeFileSync('.claude/agents/writer.md', 'x')"`);
    blocks(`node --eval="fs.appendFileSync('.claude/hooks/x.mjs','')"`);
    blocks(`npx tsx -e "import {writeFileSync} from 'node:fs'; writeFileSync('.claude/skills/a/SKILL.md','')"`);
    blocks(`perl -e 'open(my $f, ">", ".claude/skills/a/SKILL.md"); print $f "x"'`);
    blocks(`ruby -e 'File.write(".claude/skills/a/SKILL.md", "x")'`);
    blocks(`python3 -c "import os; os.replace('/tmp/x', os.path.join('.', '.claude', 'skills', 'a', 'SKILL.md'))"`);
    blocks(`python3 <<< "open('.claude/settings.json','a').write('x')"`);
  });
  it("sed -i, perl -pi, awk -i inplace", () => {
    blocks(`sed -i 's/a/b/' ${SKILL}`);
    blocks(`sed -i.bak -e 's/a/b/' ${SKILL}`);
    blocks(`sed -Ei 's/a/b/' ${SKILL}`);
    blocks(`sed --in-place=.orig 's/a/b/' .claude/agents/writer.md`);
    blocks(`perl -pi -e 's/a/b/' ${SKILL}`);
    blocks(`perl -pie 's/a/b/' ${SKILL}`);
    blocks(`gawk -i inplace '{print}' .claude/agents/writer.md`);
  });
  it("redirecionamentos e tee", () => {
    blocks(`echo x > ${SKILL}`);
    blocks(`echo x >> .claude/settings.json`);
    blocks(`cat /tmp/new.md 1> .claude/agents/writer.md`);
    blocks(`printf x &> .claude/hooks/x.mjs`);
    blocks(`cat > .claude/skills/a/SKILL.md <<'EOF'\nconteúdo\nEOF`);
    blocks(`cat /tmp/new.md | tee ${SKILL} >/dev/null`);
    blocks(`cat /tmp/new.md | tee -a .claude/settings.json`);
    blocks(`echo '{}' >| $CLAUDE_PROJECT_DIR/.claude/settings.local.json`);
  });
  it("cp/mv/install/rsync/ln, rm/touch/truncate/mkdir, dd", () => {
    blocks(`cp /tmp/SKILL.md ${SKILL}`);
    blocks(`cp -f /tmp/SKILL.md .claude/skills/a/`);
    blocks(`cp -t .claude/agents /tmp/writer.md`);
    blocks(`mv /tmp/x.md .claude/agents/writer.md`);
    blocks(`mv .claude/agents/writer.md /tmp/`);
    blocks(`install -m 644 /tmp/x .claude/hooks/x.mjs`);
    blocks(`rsync -a /tmp/skills/ .claude/skills/`);
    blocks(`ln -sf /tmp/x .claude/settings.json`);
    blocks(`rm -f .claude/hooks/block-gh-pr-merge-subagent.mjs`);
    blocks(`truncate -s 0 .claude/settings.json`);
    blocks(`touch .claude/skills/nova/SKILL.md`);
    blocks(`mkdir -p .claude/skills/nova`);
    blocks(`dd if=/tmp/x of=.claude/settings.json`);
  });
  it("find -exec/-delete e xargs sobre caminho protegido", () => {
    blocks(`find .claude/skills -name SKILL.md -exec sed -i 's/a/b/' {} +`);
    blocks(`find .claude/agents -name '*.bak' -delete`);
    blocks(`ls .claude/skills/*/SKILL.md | xargs sed -i 's/a/b/'`);
  });
  it("wrappers, prefixos, cadeias, subshell, cd e bash -c", () => {
    blocks(`cd /tmp && FOO=1 timeout 30 sed -i 's/a/b/' /home/u/r/.claude/skills/a/SKILL.md`);
    blocks(`cd .claude/skills/diaria-video-montagem && sed -i 's/a/b/' SKILL.md`);
    blocks(`true; (echo x > .claude/settings.json)`);
    blocks(`x=$(sed -i 's/a/b/' ${SKILL})`);
    blocks(`bash -c "sed -i 's/a/b/' ${SKILL}"`);
    blocks(`bash -lc 'echo x > .claude/settings.json'`);
    blocks(`eval "echo x > .claude/settings.json"`);
    blocks(`bash <<'EOF'\ncp /tmp/x .claude/agents/writer.md\nEOF`);
    blocks(`sudo -u root tee .claude/settings.json < /tmp/x`);
    blocks(`env -i sed -i 's/a/b/' ${SKILL}`);
  });
  it("script fora do projeto (/tmp/fix.py) é lido; dentro do projeto fica opaco", () => {
    const files: Record<string, string> = {
      "/tmp/fix.py": `p = "${SKILL}"\nopen(p, "w").write("x")\n`,
      [`${CWD}/scripts/fix.py`]: `p = "${SKILL}"\nopen(p, "w").write("x")\n`,
    };
    const readFile = (p: string) => files[p] ?? null;
    blocks(`python3 /tmp/fix.py`, { readFile, projectDirs: ["/home/u/diaria-studio"] });
    passes(`python3 scripts/fix.py`, { readFile, projectDirs: ["/home/u/diaria-studio"] });
    passes(`python3 /tmp/fix.py`, {}); // sem leitor, script em arquivo é opaco
  });
});

describe("findProtectedPathWrite — leitura e escrita alheia passam (#12009)", () => {
  it("leitura de caminho protegido", () => {
    passes(`cat ${SKILL}`);
    passes(`grep -n "Etapa" .claude/skills/*/SKILL.md`);
    passes(`sed -n '1,40p' ${SKILL}`);
    passes(`sed 's/a/b/' ${SKILL} > /tmp/out.md`);
    passes(`head -50 .claude/settings.json | jq .hooks`);
    passes(`wc -l .claude/hooks/*.mjs`);
    passes(`ls .claude/hooks/`);
    passes(`diff ${SKILL} /tmp/SKILL.md`);
    passes(`cp ${SKILL} /tmp/SKILL.md`, {}); // copiar DE protegido para fora
    passes(`python3 -c "print(open('.claude/settings.json').read())"`);
    passes(`node -e "console.log(require('fs').readFileSync('.claude/settings.json','utf8'))"`);
    passes(`find .claude/skills -name SKILL.md`);
  });
  it("git: diff, show, log, add, commit (mensagem que cita escrita)", () => {
    passes(`git diff -- ${SKILL}`);
    passes(`git show HEAD:${SKILL}`);
    passes(`git log -p -- ${SKILL}`);
    passes(`git add ${SKILL} .claude/settings.json`);
    passes(`git commit -m "fix: sed -i em ${SKILL} > .claude/settings.json"`);
    passes(`git commit -F /tmp/msg-12009.md`);
  });
  it("texto citado e heredoc de dados não contam", () => {
    passes(`gh pr create --title "x (#12009)" --body "python3 -c \\"open('.claude/x','w')\\" e echo > .claude/settings.json"`);
    passes(`cat > /tmp/pr-body-12009.md <<'EOF'\nsed -i 's/a/b/' ${SKILL}\necho x > .claude/settings.json\nEOF`);
    passes(`echo "rode: echo x > .claude/settings.json"`);
    passes(`# echo x > .claude/settings.json`);
  });
  it("escrita em outros caminhos", () => {
    passes(`echo x > /tmp/out.txt`);
    passes(`sed -i 's/a/b/' scripts/lib/x.ts`);
    passes(`npm ci --prefer-offline > /tmp/npmci.log 2>&1`);
    passes(`npx tsx --test test/x.test.ts 2>&1 | tail -40`);
    passes(`rm -rf /home/u/diaria-studio/.claude/worktrees/agent-old`);
    passes(`rm -f .git/index.lock`);
    passes(`python3 - <<'EOF'\nopen("/tmp/out.json", "w").write("{}")\nEOF`);
    passes(`cp /tmp/x.md docs/x.md`);
    passes(`echo x 2>&1 >&2`);
    passes(`mkdir -p /tmp/claude-1000/scratch`);
    passes(`npx tsx scripts/lib/gh-pr-safe-edit.ts --pr 1 --verify-body --issues 12009 --worktree ${CWD}`);
    passes(`git diff --shortstat master...HEAD`);
    passes(`npx tsx scripts/gh-pr-review-api.ts comment --pr 1 --path .claude/hooks/x.mjs --line 3 --body-file /tmp/f.md`);
  });
  it("python que só LÊ o protegido e escreve fora passa? não: co-ocorrência bloqueia (limite aceito)", () => {
    // Sem análise de fluxo de dados, citar o protegido + escrever em outro
    // arquivo no mesmo código bloqueia. Fica registrado como comportamento.
    assert.equal(
      codeWritesProtectedPath(`s = open(".claude/settings.json").read()\nopen("/tmp/o", "w").write(s)`),
      true,
    );
    assert.equal(codeWritesProtectedPath(`print(open(".claude/settings.json").read())`), false);
    assert.equal(codeWritesProtectedPath(`s.replace(".claude/skills", "x")`), false, "str.replace não é escrita");
  });
});

describe("shouldBlockProtectedPathWrite / hook (#12009)", () => {
  it("só olha Bash e usa o cwd do payload", () => {
    assert.equal(shouldBlockProtectedPathWrite({ tool_name: "Edit", tool_input: { command: `echo x > ${SKILL}` } }), null);
    const f = shouldBlockProtectedPathWrite({
      tool_name: "Bash",
      cwd: "/r/.claude/skills/a",
      tool_input: { command: "sed -i 's/x/y/' SKILL.md" },
    });
    assert.ok(f);
    assert.match(protectedPathWriteReason(f), /#12009/);
  });

  const run = (payload: unknown) => spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  it("processo do hook: nega a escrita, cala na leitura, fail-open em JSON inválido", () => {
    const deny = run({ tool_name: "Bash", cwd: CWD, tool_input: { command: `sed -i 's/a/b/' ${SKILL}` } });
    assert.equal(deny.status, 0);
    const out = JSON.parse(deny.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /caminho protegido/);
    const read = run({ tool_name: "Bash", cwd: CWD, tool_input: { command: `cat ${SKILL}` } });
    assert.equal(read.status, 0);
    assert.equal(read.stdout, "");
    const bad = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8" });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, "");
  });
  it("armado no .claude/settings.json (PreToolUse/Bash, exec form)", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));
    const bash = settings.hooks.PreToolUse.filter((g: { matcher: string }) => g.matcher === "Bash");
    const armed = bash.some((g: { hooks: Array<{ command: string; args?: string[] }> }) =>
      g.hooks.some((h) => h.command === "node" && (h.args ?? []).some((a) => a.endsWith("/.claude/hooks/block-bash-protected-path-write.mjs"))),
    );
    assert.ok(armed, "hook não registrado no settings.json");
  });
});
