/**
 * git-identity-guard.ts (#13259)
 *
 * Na rodada overnight 261115f o git do `300` tinha `user.name=Test` /
 * `user.email=test@test.com` (global e `.git/config` do checkout real) e os
 * commits da noite saíram com essa autoria, inclusive os merges do trem. A
 * mesma identidade já tinha assinado commits em 21/09/2026 (#8636). O vetor
 * não foi achado: nenhum teste do repo grava `user.*` fora de um repo
 * temporário (todos fazem `git init` num `mkdtemp` antes do `git config`), e
 * nenhum transcript local tem o comando. Por isso o guard é sobre o ESTADO, não
 * sobre o vetor: antes de criar commits (trem de merge, Fase 0 do overnight),
 * conferir que a identidade efetiva do checkout não é placeholder de teste.
 *
 * Worktrees herdam o `.git/config` do checkout principal, então conferir a
 * identidade no cwd de qualquer worktree enxerga a mesma config dos commits.
 */

import { spawnSync } from "node:child_process";

/** E-mails de placeholder que os testes do repo e os exemplos de doc usam. */
const PLACEHOLDER_EMAILS: ReadonlySet<string> = new Set([
  "test@test.com",
  "test@example.com",
  "t@example.com",
  "t@t",
  "you@example.com",
  "other@example.com",
]);

/** Domínios reservados (RFC 2606/6761) ou de teste: nunca são autoria real. */
const PLACEHOLDER_EMAIL_DOMAINS: readonly string[] = ["example.com", "example.org", "example.net", "test.com", "test", "localhost", "invalid"];

/** Nomes de placeholder dos testes (`Test`, `test`, `T`, `t`, `Other Session`). */
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(["test", "t", "other session"]);

export type GitIdentityVerdict =
  | { ok: true; name: string; email: string }
  | { ok: false; name: string; email: string; problems: string[] };

/**
 * Avalia `user.name`/`user.email` efetivos (strings vazias quando ausentes).
 * @pure
 */
export function evaluateGitIdentity(rawName: string | null | undefined, rawEmail: string | null | undefined): GitIdentityVerdict {
  const name = (rawName ?? "").trim();
  const email = (rawEmail ?? "").trim();
  const problems: string[] = [];

  if (email === "") {
    problems.push("user.email vazio");
  } else {
    const lower = email.toLowerCase();
    const domain = lower.includes("@") ? lower.slice(lower.lastIndexOf("@") + 1) : "";
    if (PLACEHOLDER_EMAILS.has(lower)) {
      problems.push(`user.email é placeholder de teste (${email})`);
    } else if (domain === "" || PLACEHOLDER_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      problems.push(`user.email em domínio de teste/reservado (${email})`);
    }
  }

  if (name === "") {
    problems.push("user.name vazio");
  } else if (PLACEHOLDER_NAMES.has(name.toLowerCase())) {
    problems.push(`user.name é placeholder de teste (${name})`);
  }

  return problems.length === 0 ? { ok: true, name, email } : { ok: false, name, email, problems };
}

/** Mensagem de erro com a correção, para CLI e trem de merge. @pure */
export function formatGitIdentityProblem(v: Extract<GitIdentityVerdict, { ok: false }>): string {
  return (
    `identidade git inválida neste checkout (#13259): ${v.problems.join("; ")}. ` +
    `Commits sairiam assinados por "${v.name || "?"} <${v.email || "?"}>". ` +
    `Corrigir em ~/.gitconfig e no .git/config do checkout (git config --show-origin --get-all user.email mostra de onde vem) ` +
    `antes de criar commits; nunca reescrever o histórico já publicado.`
  );
}

/** Lê a identidade efetiva do checkout em `cwd` (config local > global). */
export function readGitIdentity(
  cwd: string,
  run: (args: string[], cwd: string) => string = defaultGitConfigGet,
): { name: string; email: string } {
  return { name: run(["config", "--get", "user.name"], cwd), email: run(["config", "--get", "user.email"], cwd) };
}

function defaultGitConfigGet(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  // `git config --get` sai 1 quando a chave não existe: vira string vazia.
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}
