/**
 * #11501 — dois atritos do guard do #5716 (`block-gh-pr-merge-subagent.mjs`)
 * achados no /diaria-develop 261028:
 *
 * 1. Merge de um repo FORA de `platform.config.json → issue_repos`
 *    (`gh pr merge 2 -R vjpixel/fluxo-criativo`) só passava com o lock do
 *    diaria-studio, e a mensagem era a genérica de "forma que o guard não
 *    consegue provar" — o caminho foi descoberto por tentativa. Decisão: o
 *    guard SEGUE exigindo o lock do studio (#10618 D: typo, fork ou nome
 *    antigo de repo renomeado, que o GitHub redireciona, podem cair no
 *    studio), mas a recusa agora diz exatamente qual lock falta e o comando.
 * 2. Comando que só CITA um merge no corpo de um heredoc gravado em arquivo
 *    (`S=…; cat > $S/x.md <<'EOF'` + `gh issue create --body-file $S/x.md`)
 *    era lido como merge: a whitelist de heredoc-como-dado do #11325 não
 *    aceitava a atribuição antes nem `$S` no caminho.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withIsolatedGhConfig } from "./helpers/isolated-gh-config.ts";
import { resolveMergeTargets } from "../.claude/hooks/lib/gh-target-repo.mjs";
import { isGhPrMergeCommand, isHeredocDataCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";
import { machineTag } from "../scripts/lib/session-registry.ts";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  buildRepoHint: (targets: string[], complex?: boolean, unlisted?: { repo: string; pr: number | null } | null) => string;
};

const STUDIO = "vjpixel/diaria-studio";
const DESIGN = "vjpixel/diaria-design";
const FLUXO = "vjpixel/fluxo-criativo";
const allowed = new Set([DESIGN]);
const studioOrigin = (() => `https://github.com/${STUDIO}.git`) as never;

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmpRoot(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), `merge-guard-11501-${prefix}-`));
  roots.push(r);
  return r;
}

describe("#11501 — merge de repo fora de issue_repos", () => {
  it("resolução: segue estrita com o lock do studio, mas marca o repo fora da allowlist", () => {
    const r = resolveMergeTargets(`gh pr merge 2 --squash -R ${FLUXO}`, "/x", { allowed, execFn: studioOrigin });
    assert.equal(r.mode, "strict");
    assert.ok(r.targets.includes(STUDIO), "lock do studio continua conferido (#10618 D)");
    assert.equal(r.grantRepo, null, "nenhuma concessão conta");
    assert.equal(r.mode === "strict" ? r.unlistedRepo : undefined, FLUXO);
    assert.equal(r.pr, 2);
  });

  it("URL canônica de repo fora da allowlist também marca", () => {
    const r = resolveMergeTargets(`gh pr merge https://github.com/${FLUXO}/pull/2`, "/x", { allowed, execFn: studioOrigin });
    assert.equal(r.mode === "strict" ? r.unlistedRepo : undefined, FLUXO);
  });

  it("repo da allowlist e studio não mudam; forma complexa não marca", () => {
    assert.equal(resolveMergeTargets(`gh pr merge 2 -R ${DESIGN}`, "/x", { allowed, execFn: studioOrigin }).mode, "foreign-whitelist");
    assert.equal(resolveMergeTargets(`gh pr merge 2 -R ${STUDIO}`, "/x", { allowed, execFn: studioOrigin }).mode, "studio-plain");
    const complex = resolveMergeTargets(`gh pr merge 2 -R ${FLUXO} && echo ok`, "/x", { allowed, execFn: studioOrigin });
    assert.equal(complex.mode, "strict");
    assert.equal(complex.mode === "strict" ? complex.unlistedRepo : "x", null, "fora da whitelist: mensagem genérica");
  });

  it("mensagem: nomeia o lock do studio e o comando, sem a frase de 'forma que não consegue provar'", () => {
    const hint = guard.buildRepoHint([STUDIO], true, { repo: FLUXO, pr: 2 });
    assert.match(hint, /#11501/);
    assert.match(hint, /vjpixel\/fluxo-criativo, que está FORA de platform\.config\.json → issue_repos/);
    assert.match(hint, /merge-lock-acquire --pr 2`, SEM --repo/);
    assert.doesNotMatch(hint, /forma que o guard consegue provar/);
    // Sem `unlisted`, a mensagem antiga continua.
    assert.match(guard.buildRepoHint([STUDIO], true), /forma que o guard consegue provar/);
  });

  it("e2e: lock do studio preso por outra sessão → deny com a mensagem do #11501", () => {
    const HOOK = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
    const root = tmpRoot("e2e");
    const dir = join(root, "data", "sessions");
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    const tag = machineTag();
    const nowIso = new Date().toISOString();
    writeFileSync(
      join(dir, `overnight-${tag}-coord-A.json`),
      JSON.stringify({ kind: "overnight", sessionId: "coord-A", machineTag: tag, startedAt: nowIso, lastHeartbeat: nowIso }),
    );
    writeFileSync(join(dir, ".merge-lock.json"), JSON.stringify({ heldBy: "outra-sessao", acquiredAt: nowIso }));
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: JSON.stringify({
        session_id: "coord-A",
        tool_name: "Bash",
        cwd: root,
        tool_input: { command: `gh pr merge 2 --squash -R ${FLUXO}` },
      }),
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: withIsolatedGhConfig(),
    });
    assert.match(r.stdout, /"permissionDecision":"deny"/);
    assert.match(r.stdout, /#11501/);
    assert.match(r.stdout, /merge-lock-acquire --pr 2/);
  });
});

describe("#11501 — heredoc que só cita um merge não é merge", () => {
  const noAliases = { aliases: new Map<string, string>() };
  const isMerge = (cmd: string) => isGhPrMergeCommand(cmd, noAliases);
  const BODY = [
    "## Achado",
    `Mergear exigiu \`gh pr merge 2 --squash -R ${FLUXO}\` com dois locks.`,
    "Mesmo padrão dos guards de `gh pr merge` #5716.",
  ].join("\n");
  const S = "/tmp/claude-1000/x/scratchpad";

  const dataCases: Record<string, string> = {
    "caso real: S=…; cat > $S/x.md <<'EOF' + gh issue create --body-file $S/x.md": `S=${S}; cat > $S/marker.md <<'EOF'\n${BODY}\nEOF\ngh issue create --title "Guard de merge (#5716)" --label bug --label P3 --body-file $S/marker.md`,
    "atribuição com && e ${S}": `S=${S} && cat > \${S}/m.md <<'EOF'\n${BODY}\nEOF\ngh issue comment 11501 --body-file \${S}/m.md`,
    "$RANDOM no nome do arquivo entre aspas": `cat > "/tmp/pr-body-11501-$RANDOM.md" <<'EOF'\n${BODY}\nEOF`,
  };
  for (const [name, cmd] of Object.entries(dataCases)) {
    it(name, () => {
      assert.equal(isHeredocDataCommand(cmd), true, cmd);
      assert.equal(isMerge(cmd), false, cmd);
    });
  }

  const bypasses: Record<string, string> = {
    "merge depois do consumidor": `S=${S}; cat > $S/m.md <<'EOF'\nx\nEOF\ngh issue create --body-file $S/m.md; gh pr merge 5`,
    "merge numa linha depois do fecho": `S=${S}; cat > $S/m.md <<'EOF'\nx\nEOF\ngh pr merge 5`,
    "atribuição com substituição": `S=$(gh pr merge 5); cat > $S/m.md <<'EOF'\nx\nEOF`,
    "consumidor com substituição": `S=${S}; cat > $S/m.md <<'EOF'\nx\nEOF\ngh issue create --body-file $(gh pr merge 5)`,
    "expansão com operador no caminho": `cat > \${S:-$(gh pr merge 5)}/m.md <<'EOF'\nx\nEOF`,
    "arquivo executado na mesma chamada": `S=${S}; cat > $S/m.md <<'EOF'\ngh pr merge 5\nEOF\nbash $S/m.md`,
    "corpo pra um shell (sem whitelist)": `S=${S}; bash <<'EOF'\ngh pr merge 5\nEOF`,
  };
  for (const [name, cmd] of Object.entries(bypasses)) {
    it(`bypass continua merge: ${name}`, () => {
      assert.equal(isMerge(cmd), true, cmd);
    });
  }
});
