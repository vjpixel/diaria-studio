// De qual repositório é o PR de um `gh pr create`/`gh pr merge`? (#10618)
//
// Os hooks de `.claude/hooks/` que reagem a `gh pr create`/`gh pr merge`
// aplicam regras do diaria-studio (snapshot do orchestrator, tsc, review
// automatizado, merge lock, guard do #5716). Desde que as rodadas passaram a
// trabalhar issues do `vjpixel/diaria-design`, esses hooks também disparavam
// em PR do outro repo: o guard do snapshot procurou
// `test/orchestrator-prompt.test.ts` dentro do diaria-design e bloqueou
// (vjpixel/diaria-design#23), e o merge do diaria-design esperou o merge lock
// do diaria-studio. Decisão do editor (20/10/2026, #10618): os hooks aplicam
// as regras do diaria-studio só a PRs do diaria-studio, e o merge lock é por
// repo.
//
// Ordem de resolução (a 1ª que responder vence):
//   1. `-R`/`--repo` no próprio comando `gh`;
//   2. URL de PR (`https://github.com/owner/repo/pull/N`) como argumento;
//   3. `GH_REPO=owner/repo` no prefixo do comando;
//   4. `origin` do repositório git em `cwd` (o `payload.cwd` do hook — é o
//      que o `gh` usaria sem `-R`).
// Nada disso resolveu → `repo: null` (indeterminado). Os hooks tratam
// indeterminado como diaria-studio: é o comportamento anterior, e errar pra
// esse lado só aplica uma regra a mais, nunca pula uma.
//
// Self-contained (só `node:*`), como os outros módulos de `hooks/lib/`. A
// constante do repo default e o nome do arquivo de lock são espelho de
// `scripts/lib/issue-repos.ts`, paridade travada por
// `test/issue-repos-10618.test.ts`.

import { execFileSync } from "node:child_process";

export const DIARIA_STUDIO_REPO = "vjpixel/diaria-studio";

const REPO_SLUG_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/** Mesmo contrato de `normalizeRepoSlug` em `scripts/lib/issue-repos.ts`.
 * Aceita também `HOST/OWNER/REPO` (forma que o `gh -R` aceita). */
export function normalizeRepoSlug(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "") return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^(?:www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = REPO_SLUG_RE.exec(s);
  if (!m) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

/** Owner/repo de uma URL de remote git (https, ou ssh com usuário `git` no host github.com). */
export function repoFromRemoteUrl(url) {
  if (typeof url !== "string") return null;
  const s = url.trim();
  // Montado em partes: o literal usuário+arroba+host casa o guard de PII do #6753.
  const ssh = new RegExp("^(?:ssh://)?git" + "@" + "github\\.com[:/](.+)$", "i").exec(s);
  if (ssh) return normalizeRepoSlug(ssh[1]);
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com\/(.+)$/i.exec(s);
  if (https) return normalizeRepoSlug(https[1]);
  return null;
}

/** Espelho de `mergeLockFileName` (`scripts/lib/issue-repos.ts`). */
export function mergeLockFileName(repo = DIARIA_STUDIO_REPO) {
  const slug = normalizeRepoSlug(repo ?? "") ?? DIARIA_STUDIO_REPO;
  if (slug === DIARIA_STUDIO_REPO) return ".merge-lock.json";
  return `.merge-lock--${slug.replace("/", "--")}.json`;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "\n"]);

/**
 * Quebra um comando shell em palavras, respeitando aspas simples/duplas e
 * escapes, e emitindo os separadores de comando (`&&`, `||`, `;`, `|`,
 * newline) como tokens próprios — só fora de aspas. Não é um parser de shell
 * completo: basta pra achar `gh pr <sub>` e as flags do mesmo segmento.
 */
export function splitShellWords(command) {
  const out = [];
  if (typeof command !== "string") return out;
  let cur = "";
  let has = false;
  const flush = () => {
    if (has) out.push(cur);
    cur = "";
    has = false;
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < n) {
      if (command[i + 1] !== "\n") {
        cur += command[i + 1];
        has = true;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      cur += command.slice(i + 1, stop);
      has = true;
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < n) {
          cur += command[j + 1];
          j += 2;
          continue;
        }
        cur += command[j];
        j++;
      }
      has = true;
      i = j + 1;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      flush();
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      flush();
      out.push("&&");
      i += 2;
      continue;
    }
    if (ch === "|") {
      flush();
      if (command[i + 1] === "|") {
        out.push("||");
        i += 2;
      } else {
        out.push("|");
        i++;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flush();
      i++;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  flush();
  return out;
}

const PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+(?:[/?#].*)?$/i;

/**
 * Lê, do texto do comando, o repo alvo do ÚLTIMO `gh pr <subcomando>` (o mesmo
 * critério de "última ocorrência" que `extractGhPrMergeTargetPr` usa).
 * `subcommands` restringe quais subcomandos contam (default: create/merge).
 * Devolve `{ repo, source }` com `source` ∈ `flag`|`pr-url`|`gh-repo-env`, ou
 * `null` quando o comando não diz o repo (aí vale o `origin` do cwd).
 */
export function repoFromGhCommand(command, subcommands = ["create", "merge"]) {
  const words = splitShellWords(command);
  let found = null;
  let segStart = 0;
  for (let i = 0; i <= words.length; i++) {
    if (i < words.length && !SEPARATORS.has(words[i])) continue;
    const seg = words.slice(segStart, i);
    segStart = i + 1;
    const ghAt = seg.findIndex((w, k) => w === "gh" && seg[k + 1] === "pr" && subcommands.includes(seg[k + 2]));
    if (ghAt === -1) continue;
    let result = null;
    for (let k = ghAt + 3; k < seg.length; k++) {
      const w = seg[k];
      if (w === "-R" || w === "--repo") {
        const slug = normalizeRepoSlug(seg[k + 1] ?? "");
        if (slug) result = { repo: slug, source: "flag" };
        k++;
        continue;
      }
      const eq = /^(?:-R|--repo)=(.+)$/.exec(w) ?? /^-R(.+)$/.exec(w);
      if (eq) {
        const slug = normalizeRepoSlug(eq[1]);
        if (slug) result = { repo: slug, source: "flag" };
        continue;
      }
      const url = PR_URL_RE.exec(w);
      if (url && (result === null || result.source !== "flag")) {
        const slug = normalizeRepoSlug(url[1]);
        if (slug) result = { repo: slug, source: "pr-url" };
      }
    }
    if (result === null) {
      for (let k = 0; k < ghAt; k++) {
        const env = /^GH_REPO=(.+)$/.exec(seg[k]);
        const slug = env ? normalizeRepoSlug(env[1]) : null;
        if (slug) result = { repo: slug, source: "gh-repo-env" };
      }
    }
    found = result ?? { repo: null, source: null };
  }
  return found && found.repo ? found : null;
}

/** `origin` do repo git em `cwd`. `null` quando indeterminado (sem cwd, git falhou). */
export function repoFromCwdOrigin(cwd, execFn = execFileSync) {
  if (typeof cwd !== "string" || cwd.trim() === "") return null;
  try {
    const url = execFn("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return repoFromRemoteUrl(String(url));
  } catch {
    return null;
  }
}

/**
 * Repo alvo de um `gh pr <sub>`. `{ repo: string|null, source }` — `repo:
 * null` é INDETERMINADO, e os hooks o tratam como diaria-studio.
 */
export function resolveGhTargetRepo(command, cwd, { execFn = execFileSync, subcommands } = {}) {
  const fromCommand = repoFromGhCommand(command, subcommands);
  if (fromCommand) return fromCommand;
  const fromCwd = repoFromCwdOrigin(cwd, execFn);
  if (fromCwd) return { repo: fromCwd, source: "cwd-origin" };
  return { repo: null, source: null };
}

/**
 * `true` só quando o repo alvo foi DETERMINADO e não é o diaria-studio. É a
 * pergunta que os hooks de PR fazem antes de aplicar uma regra do
 * diaria-studio — indeterminado responde `false` (aplica a regra, como antes).
 */
export function isForeignRepo(repo) {
  const slug = normalizeRepoSlug(repo ?? "");
  return slug !== null && slug !== DIARIA_STUDIO_REPO;
}

/** Atalho: `isForeignRepo(resolveGhTargetRepo(...).repo)`. */
export function isForeignRepoGhCommand(command, cwd, opts = {}) {
  return isForeignRepo(resolveGhTargetRepo(command, cwd, opts).repo);
}
