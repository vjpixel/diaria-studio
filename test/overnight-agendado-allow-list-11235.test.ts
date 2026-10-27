/**
 * test/overnight-agendado-allow-list-11235.test.ts
 *
 * Regressão do #11235: o overnight agendado (`claude --print --permission-mode
 * acceptEdits`, `scripts/overnight/run-nightly-chain.ts`) teve `git add`,
 * `git commit`, `git fetch`/`git pull`, `npm ci` e `npx tsc` negados nas
 * rodadas 261026 e 261027, porque nenhum casava com `permissions.allow` de
 * `.claude/settings.json` e não havia quem aprovasse. As duas noites saíram
 * com 0 PRs.
 *
 * O teste cruza a lista canônica de comandos do fluxo
 * (`scripts/lib/overnight-required-bash-commands.ts`) com o allow list, usando
 * um matcher que imita a semântica de prefixo/curinga das regras `Bash(...)`.
 * Também confere que cada comando ainda é citado no documento do fluxo e que
 * nenhuma regra ampla entrou no lugar das estreitas: em vez de comparar strings
 * (`Bash(git *)`), passa comandos-sonda proibidos (`git rebase`, `git branch -D`,
 * `gh api ... -X DELETE`, mutation GraphQL arbitrária...) ao matcher e exige
 * que nenhuma regra case (`OVERNIGHT_FORBIDDEN_BASH_PROBES`). A prova real é a
 * 1ª rodada agendada depois do merge.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OVERNIGHT_FORBIDDEN_BASH_PROBES,
  OVERNIGHT_REQUIRED_BASH_COMMANDS,
  bashRuleMatches,
  findMatchingBashRule,
  normalizeWhitespace,
} from "../scripts/lib/overnight-required-bash-commands.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadPermissions(): { allow: string[]; deny: string[] } {
  const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, ".claude/settings.json"), "utf8")) as {
    permissions?: { allow?: string[]; deny?: string[] };
  };
  return { allow: parsed.permissions?.allow ?? [], deny: parsed.permissions?.deny ?? [] };
}

describe("bashRuleMatches (semântica das regras Bash do Claude Code)", () => {
  it("` *` no fim casa com argumentos e com o comando sem argumentos", () => {
    assert.equal(bashRuleMatches("Bash(ls *)", "ls -la"), true);
    assert.equal(bashRuleMatches("Bash(ls *)", "ls"), true);
    assert.equal(bashRuleMatches("Bash(ls *)", "lsof"), false);
    assert.equal(bashRuleMatches("Bash(ls*)", "lsof"), true);
  });

  it("regra sem curinga é exata; `:*` equivale a ` *`", () => {
    assert.equal(bashRuleMatches("Bash(npm install)", "npm install"), true);
    assert.equal(bashRuleMatches("Bash(npm install)", "npm install foo"), false);
    assert.equal(bashRuleMatches("Bash(npm ci:*)", "npm ci"), true);
    assert.equal(bashRuleMatches("Bash(npm ci:*)", "npm ci --prefer-offline"), true);
  });

  it("o prefixo antes do `*` é literal: `git commit *` não casa `git -C x commit`", () => {
    assert.equal(bashRuleMatches("Bash(git commit *)", "git commit -m x"), true);
    assert.equal(bashRuleMatches("Bash(git commit *)", "git -C . commit -m x"), false);
    assert.equal(bashRuleMatches("Bash(git push *)", "git pull"), false);
  });

  it("curinga no meio casa `/` e espaço", () => {
    assert.equal(bashRuleMatches("Bash(npx tsx scripts/*.ts *)", "npx tsx scripts/lib/a.ts --x 1"), true);
    assert.equal(bashRuleMatches("Bash(gh api repos/vjpixel/*/pulls/*)", "gh api repos/vjpixel/diaria-studio/pulls/1/comments"), true);
    assert.equal(bashRuleMatches("Bash(gh api repos/vjpixel/*/pulls/*)", "gh api repos/vjpixel/diaria-studio/issues/1"), false);
  });

  it("ignora regra que não é de Bash", () => {
    assert.equal(bashRuleMatches("Read", "ls"), false);
  });
});

describe("allow list do overnight agendado (#11235)", () => {
  const { allow, deny } = loadPermissions();

  for (const c of OVERNIGHT_REQUIRED_BASH_COMMANDS) {
    it(`permite: ${c.command}`, () => {
      assert.ok(
        findMatchingBashRule(allow, c.command),
        `'${c.command}' não casa com nenhuma regra de permissions.allow em .claude/settings.json — ` +
          `o overnight agendado (acceptEdits, sem aprovador) vai negar esse comando (#11235)`,
      );
      assert.equal(findMatchingBashRule(deny, c.command), null, `'${c.command}' casa com uma regra de deny`);
    });
  }

  it("cada comando canônico continua citado no documento do fluxo", () => {
    const cache = new Map<string, string>();
    for (const c of OVERNIGHT_REQUIRED_BASH_COMMANDS) {
      if (!cache.has(c.source)) cache.set(c.source, readFileSync(resolve(REPO_ROOT, c.source), "utf8"));
      assert.ok(
        normalizeWhitespace(cache.get(c.source)!).includes(normalizeWhitespace(c.mention)),
        `'${c.mention}' sumiu de ${c.source} — revisar a lista de #11235`,
      );
    }
  });

  it("os comandos negados nas rodadas 261026/261027 estão cobertos", () => {
    for (const cmd of ["git add -A", "git commit -m x", "git fetch origin", "git pull", "npm ci", "npx tsc --noEmit"]) {
      assert.ok(findMatchingBashRule(allow, cmd), `'${cmd}' segue fora do allow list`);
    }
  });

  it("comando que o fluxo roda puro tem também a regra exata (não depende do ` *` casar o puro)", () => {
    for (const bare of ["git pull", "npm ci", "git worktree prune", "git worktree list", "gh auth status"]) {
      assert.ok(allow.includes(`Bash(${bare})`), `faltando a regra exata 'Bash(${bare})'`);
    }
  });

  it("nenhuma regra libera os comandos-sonda proibidos", () => {
    assert.ok(!allow.includes("Bash"), "`Bash` sem padrão libera tudo");
    for (const probe of OVERNIGHT_FORBIDDEN_BASH_PROBES) {
      const hit = findMatchingBashRule(allow, probe.command);
      if (probe.knownMatchBy) {
        // Limitação conhecida: regra anterior ao #11235 (ex.: `Bash(git push *)`
        // casa `git push --force`). Registrada, não alterada por esta issue.
        assert.equal(hit, probe.knownMatchBy, `'${probe.command}': limitação conhecida mudou (${hit})`);
        continue;
      }
      assert.equal(hit, null, `'${probe.command}' é permitido por '${hit}'`);
    }
  });
});
