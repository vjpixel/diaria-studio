// .claude/hooks/lib/studio-checkout.mjs (#12951)
//
// Os hooks de `gh pr create` que aplicam regra do diaria-studio (snapshot do
// orquestrador #8732, typecheck #8482, import do test runner) decidiam "é PR
// de outro repo?" só por `isForeignRepoGhCommand`, que lê o alvo pelo `-R` ou
// pelo `origin` do checkout. Quando o `origin` não diz nada (clone local,
// remote ilegível), o alvo fica indeterminado e o hook cai no lado estrito: na
// /diaria-develop 261112 o guard do snapshot rodou no worktree do
// vjpixel/dossiemaster e bloqueou a PR por não achar
// `test/orchestrator-prompt.test.ts`, que só existe no studio. E o registro do
// bloqueio foi para `data/run-log.jsonl` DENTRO do worktree externo: o arquivo
// não rastreado travou o `git worktree remove` e a linha se perdeu no
// `--force`.
//
// Este módulo responde as duas perguntas pelo próprio checkout, sem depender
// do `origin`:
//   - `isStudioCheckout`: o checkout de onde o `gh pr create` sai é do studio?
//     Sim quando compartilha o `.git` com o checkout do hook (worktree do
//     studio) ou quando traz a infraestrutura de hooks do studio (clone
//     próprio, item 33 das regras de dispatch). `null` = indeterminado (git
//     falhou): o chamador mantém a regra, como antes.
//   - `studioLogRoot`: raiz do checkout PRINCIPAL do studio, onde mora o
//     `data/` real. Derivada do diretório do hook, nunca do cwd do comando.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Arquivo que só um checkout do diaria-studio tem (a lib de alvo dos hooks). */
export const STUDIO_SIGNATURE_FILE = join(".claude", "hooks", "lib", "gh-target-repo.mjs");

/** `.git` comum (o do checkout principal) do repo em `dir`, absoluto; `null` se o git falhar. */
export function gitCommonDir(dir, execFn = execFileSync) {
  if (typeof dir !== "string" || dir.trim() === "") return null;
  try {
    const out = String(
      execFn("git", ["rev-parse", "--git-common-dir"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
    if (out === "") return null;
    return resolve(dir, out).replaceAll("\\", "/").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Raiz do checkout principal do studio, a partir do diretório do hook
 * (`.claude/hooks` do studio, ou de um worktree dele). Fallback: `hookDir/../..`.
 */
export function studioLogRoot(hookDir, execFn = execFileSync) {
  const common = gitCommonDir(hookDir, execFn);
  if (common) return dirname(common);
  return join(hookDir, "..", "..");
}

/**
 * `true` = `cwd` é checkout do studio; `false` = é checkout de OUTRO repo (o
 * `.git` comum difere do do hook e a assinatura do studio não está lá);
 * `null` = não deu pra saber (git falhou em algum dos dois).
 */
export function isStudioCheckout(cwd, hookDir, { execFn = execFileSync, exists = existsSync } = {}) {
  const target = gitCommonDir(cwd, execFn);
  const own = gitCommonDir(hookDir, execFn);
  if (!target || !own) return null;
  if (target === own) return true;
  return exists(join(cwd, STUDIO_SIGNATURE_FILE));
}
