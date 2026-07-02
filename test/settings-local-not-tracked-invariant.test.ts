/**
 * test/settings-local-not-tracked-invariant.test.ts (#2825)
 *
 * Regression test: `.claude/settings.local.json` NUNCA deve estar rastreado
 * pelo git. É o arquivo de allowlist de permissões machine-local por
 * convenção do Claude Code (documentação oficial: settings.local.json é o
 * settings pessoal/local, análogo a `.env.local`) — nunca deveria ter ido
 * pro repo.
 *
 * Incidente (#2825, detectado 260702): o PR #2824 incluiu um commit
 * modificando `.claude/settings.local.json` porque um subagente overnight
 * herdou o arquivo no worktree e um `git add` amplo (não por caminho
 * explícito) o levou junto. Conteúdo vazado era só allowlist de permissões
 * (curls da clarice-dashboard) — sem segredos — mas a classe do problema é
 * ruim: o arquivo nunca deveria ser versionado, independente do conteúdo.
 *
 * Fix: `git rm --cached .claude/settings.local.json` (preserva o arquivo
 * local de cada máquina) + entrada em `.gitignore`. Este teste garante que a
 * regressão não volte — se alguém rodar `git add -A`/`git add .claude` e
 * commitar de novo, este teste falha na próxima run do CI.
 *
 * Nota: `git rm --cached` não apaga o conteúdo do histórico (ok — sem
 * segredos vazados) nem o arquivo do working tree de quem já tinha —
 * intencional, documentado no corpo da issue #2825.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRACKED_PATH = ".claude/settings.local.json";

function gitLsFiles(pattern: string): string[] {
  const out = execFileSync("git", ["ls-files", pattern], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("settings.local.json não-rastreado invariant (#2825)", () => {
  it("`.claude/settings.local.json` não aparece em `git ls-files`", () => {
    const tracked = gitLsFiles(TRACKED_PATH);
    assert.deepEqual(
      tracked,
      [],
      `${TRACKED_PATH} está rastreado pelo git (${JSON.stringify(tracked)}). ` +
        `Esse arquivo é machine-local por convenção do Claude Code e nunca deve ` +
        `ser commitado (#2825) — rode "git rm --cached ${TRACKED_PATH}" (preserva ` +
        `o arquivo local) e confirme que a entrada segue em .gitignore.`,
    );
  });

  it("`.claude/settings.local.json` está listado no .gitignore", () => {
    // `git check-ignore -q` sai com exit 0 se o path é ignorado, exit 1 se
    // não é (execFileSync lança nesse caso — capturamos pra dar assert claro
    // em vez de deixar a stack trace do child_process vazar).
    let ignored = true;
    try {
      execFileSync("git", ["check-ignore", "-q", TRACKED_PATH], { cwd: ROOT });
    } catch {
      ignored = false;
    }
    assert.ok(
      ignored,
      `${TRACKED_PATH} não está coberto por nenhuma regra do .gitignore — ` +
        `adicione a entrada (ver #2825).`,
    );
  });
});
