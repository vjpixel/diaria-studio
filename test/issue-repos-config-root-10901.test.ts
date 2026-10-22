/**
 * test/issue-repos-config-root-10901.test.ts (#10901)
 *
 * Os gates de PR que autorizam merge resolviam a allowlist `issue_repos` pelo
 * cwd: rodados fora da raiz do studio (subdiretório, checkout do diaria-design,
 * worktree sem `platform.config.json`) recusavam `--repo vjpixel/diaria-design`
 * como "fora da allowlist". Agora resolvem pela raiz do próprio módulo
 * (`ISSUE_REPOS_CONFIG_ROOT`), como o `gh-pr-safe-edit.ts` já fazia.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ISSUE_REPOS_CONFIG_ROOT, loadIssueRepos } from "../scripts/lib/issue-repos.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATES = ["check-pr-checks-gate.ts", "check-pr-retido-gate.ts", "check-pr-review-authenticity.ts"];

describe("#10901 — gates de PR resolvem issue_repos pela raiz do módulo", () => {
  it("ISSUE_REPOS_CONFIG_ROOT é a raiz do checkout (tem platform.config.json)", () => {
    assert.equal(ISSUE_REPOS_CONFIG_ROOT, ROOT);
    assert.ok(existsSync(join(ISSUE_REPOS_CONFIG_ROOT, "platform.config.json")));
  });

  for (const gate of GATES) {
    it(`${gate} não passa process.cwd() pro resolvePrTargetRepo`, () => {
      const src = readFileSync(join(ROOT, "scripts", gate), "utf8");
      assert.match(src, /resolvePrTargetRepo\(values, flags, ISSUE_REPOS_CONFIG_ROOT\)/);
      assert.doesNotMatch(src, /resolvePrTargetRepo\([^)]*process\.cwd\(\)/);
    });
  }

  it(
    "rodado de um cwd sem platform.config.json, --repo do design não vira erro de allowlist",
    { skip: process.platform === "win32" || !loadIssueRepos(ROOT).includes("vjpixel/diaria-design") },
    () => {
      const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-10901-"));
      try {
        // `gh` falso que falha: o gate segue até a leitura do PR (erro de gh,
        // não de uso) sem tocar a rede.
        const gh = join(cwd, "gh");
        writeFileSync(gh, "#!/usr/bin/env bash\necho 'gh falso: offline' >&2\nexit 1\n");
        chmodSync(gh, 0o755);
        const tsx = join(ROOT, "node_modules", ".bin", "tsx");
        const r = spawnSync(tsx, [join(ROOT, "scripts", "check-pr-retido-gate.ts"), "--pr", "5", "--repo", "vjpixel/diaria-design"], {
          cwd,
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH ?? ""}` },
        });
        assert.doesNotMatch(r.stderr, /fora de platform\.config\.json/, r.stderr);
        assert.notEqual(r.status, 0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
