// De qual repositório é o PR de um `gh pr create`/`gh pr merge`? (#10618)
//
// Desde que as rodadas passaram a trabalhar issues do `vjpixel/diaria-design`,
// os hooks de `.claude/hooks/` disparavam também em PR do outro repo: o guard
// do snapshot procurou `test/orchestrator-prompt.test.ts` dentro do
// diaria-design e bloqueou (vjpixel/diaria-design#23), e o merge do
// diaria-design esperou o merge lock do diaria-studio. Decisão do editor
// (20/10/2026, #10618) e do coordenador (review da PR #10668):
//
//   - PULAM PR de outro repo (regra específica do diaria-studio):
//     snapshot do orchestrator, tsc e test-runner deste repo, e o conserto
//     de `Closes #N` do `pr-create-review.mjs`;
//   - POR REPO (lido no repo do PR): merge lock, concessão de janela
//     (`merge_grant`) e auto-autorização (`self_authorized_merge`);
//   - VALEM EM TODO REPO: o review automatizado, a identidade do guard do
//     #5716 (quem é coordenadora) e o guard de PII/artefato de runtime.
//
// Resolução, por SEGMENTO `gh pr <sub>` do comando (todos, não só o último —
// um `gh pr merge 1 && gh pr merge 2 -R outro` mexe em dois repos):
//   1. `-R`/`--repo`, URL de PR como argumento e `GH_REPO=` no prefixo. Valor
//      presente mas ilegível (`$REPO`, `ghe.host/o/r`, conflito entre -R e
//      URL) → ESTRITO: diaria-studio, nunca cai pro cwd.
//   2. Sem nada explícito: `origin` do diretório de um `cd X` anterior no
//      comando, senão do cwd. É HEURÍSTICA — o `gh` também respeita
//      `gh repo set-default` e remote `upstream`, que este helper ignora.
//      Quando o comando tem `cd` (o guard de merge passa `cdStrict`), o lock
//      do diaria-studio também entra na conta.
//   3. ALLOWLIST: um repo só é tratado como "de fora" se estiver em
//      `platform.config.json → issue_repos`. Qualquer outro (typo, fork,
//      origin renomeado) recebe as regras do diaria-studio.
//
// Self-contained (só `node:*`), como os outros módulos de `hooks/lib/`. A
// constante do repo default, `normalizeRepoSlug` e o nome do arquivo de lock
// são espelho de `scripts/lib/issue-repos.ts`, paridade travada por
// `test/issue-repos-10618.test.ts`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const DIARIA_STUDIO_REPO = "vjpixel/diaria-studio";

const REPO_SLUG_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/** Mesmo contrato de `normalizeRepoSlug` em `scripts/lib/issue-repos.ts`:
 * `OWNER/REPO` ou `github.com/OWNER/REPO` (URL https e `.git` aceitos). Owner
 * com `--` interno é recusado (o GitHub não aceita). */
export function normalizeRepoSlug(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "") return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^(?:www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = REPO_SLUG_RE.exec(s);
  if (!m || m[1].includes("--")) return null;
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

/** Raiz do checkout do diaria-studio de onde este arquivo foi carregado. */
const HOOK_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const allowedCache = new Map();

/**
 * Repos de FORA que as rodadas atendem: `platform.config.json → issue_repos`
 * menos o default. Config ausente/ilegível → conjunto vazio (tudo vira
 * diaria-studio, que é o lado estrito). Cacheado por raiz.
 */
export function loadAllowedForeignRepos(root = HOOK_REPO_ROOT) {
  if (allowedCache.has(root)) return allowedCache.get(root);
  const out = new Set();
  try {
    const cfg = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
    for (const item of Array.isArray(cfg?.issue_repos) ? cfg.issue_repos : []) {
      const slug = normalizeRepoSlug(typeof item === "string" ? item : "");
      if (slug && slug !== DIARIA_STUDIO_REPO) out.add(slug);
    }
  } catch {
    // sem config: nenhum repo de fora
  }
  allowedCache.set(root, out);
  return out;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "\n"]);

/**
 * Quebra um comando shell em palavras, respeitando aspas simples/duplas e
 * escapes, e emitindo os separadores de comando (`&&`, `||`, `;`, `|`,
 * newline) como tokens próprios — só fora de aspas. Não expande variável:
 * `$REPO` fica literal (e é recusado como slug). Não é um parser de shell
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
        // Como no bash: dentro de aspas duplas a barra só escapa $ ` " \ e
        // newline — `"C:\Users\x"` (path do Windows) fica intacto.
        if (command[j] === "\\" && j + 1 < n && '$`"\\\n'.includes(command[j + 1])) {
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

/** Flags de `gh pr create|merge` que consomem o token seguinte como VALOR —
 * o valor delas nunca é lido como `-R`/URL (ex: `--body "veja -R x/y"`). */
const VALUE_FLAGS = new Set([
  "-b", "--body", "-t", "--title", "--subject", "-F", "--body-file", "--match-head-commit",
  "-A", "--author-email", "-H", "--head", "-B", "--base", "-l", "--label", "-a", "--assignee",
  "-r", "--reviewer", "-m", "--milestone", "-p", "--project", "-T", "--template",
]);

/**
 * Lê os segmentos `gh pr <sub>` do comando. Pra cada um: `{ repo, source,
 * cd }` — `source` ∈ `flag`|`pr-url`|`gh-repo-env` (repo explícito),
 * `unparseable` (havia valor explícito mas ilegível, ou -R e URL
 * discordam: `repo: null`) ou `null` (nada explícito). `cd` é o alvo cru do
 * último `cd X` anterior no comando (ou `null`).
 */
export function ghPrSegments(command, subcommands = ["create", "merge"]) {
  const words = splitShellWords(command);
  const out = [];
  let lastCd = null;
  let segStart = 0;
  for (let i = 0; i <= words.length; i++) {
    if (i < words.length && !SEPARATORS.has(words[i])) continue;
    const seg = words.slice(segStart, i);
    segStart = i + 1;
    if (seg[0] === "cd") {
      lastCd = seg[1] ?? null;
      continue;
    }
    const ghAt = seg.findIndex((w, k) => w === "gh" && seg[k + 1] === "pr" && subcommands.includes(seg[k + 2]));
    if (ghAt === -1) continue;
    let flagRepo = null;
    let urlRepo = null;
    let envRepo = null;
    let bad = false;
    const take = (current, raw) => {
      const slug = normalizeRepoSlug(raw ?? "");
      if (!slug) {
        bad = true;
        return current;
      }
      if (current !== null && current !== slug) bad = true;
      return slug;
    };
    for (let k = ghAt + 3; k < seg.length; k++) {
      const w = seg[k];
      if (VALUE_FLAGS.has(w)) {
        k++;
        continue;
      }
      if (w === "-R" || w === "--repo") {
        flagRepo = take(flagRepo, seg[k + 1]);
        k++;
        continue;
      }
      const eq = /^(?:-R|--repo)=(.*)$/.exec(w) ?? /^-R(.+)$/.exec(w);
      if (eq) {
        flagRepo = take(flagRepo, eq[1]);
        continue;
      }
      const url = PR_URL_RE.exec(w);
      if (url) urlRepo = take(urlRepo, url[1]);
    }
    for (let k = 0; k < ghAt; k++) {
      const env = /^GH_REPO=(.*)$/.exec(seg[k]);
      if (env) envRepo = take(envRepo, env[1]);
    }
    if (flagRepo !== null && urlRepo !== null && flagRepo !== urlRepo) bad = true;
    if (bad) {
      out.push({ repo: null, source: "unparseable", cd: lastCd });
      continue;
    }
    if (urlRepo) out.push({ repo: urlRepo, source: "pr-url", cd: lastCd });
    else if (flagRepo) out.push({ repo: flagRepo, source: "flag", cd: lastCd });
    else if (envRepo) out.push({ repo: envRepo, source: "gh-repo-env", cd: lastCd });
    else out.push({ repo: null, source: null, cd: lastCd });
  }
  return out;
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
 * Repos afetados por um comando `gh pr <sub>`, já com a allowlist aplicada:
 * lista de `{ repo, source }` (deduplicada por repo), sempre com `repo`
 * preenchido — o que não dá pra afirmar que é de fora vira o diaria-studio.
 *
 * Opções: `execFn` (teste), `subcommands`, `allowed` (Set de repos de fora;
 * default = `issue_repos` do config), `cdStrict` (guard de merge: com `cd` e
 * sem repo explícito, inclui o diaria-studio além do origin do diretório) e
 * `cwdAlreadyResolved` (hooks de `gh pr create`, que já passam como `cwd` a
 * raiz do alvo do `cd` — aí o `cd` não é reaplicado).
 */
export function resolveGhTargets(command, cwd, opts = {}) {
  const { execFn = execFileSync, subcommands, allowed = loadAllowedForeignRepos(), cdStrict = false, cwdAlreadyResolved = false } = opts;
  const targets = [];
  const add = (repo, source) => {
    const slug = normalizeRepoSlug(repo ?? "");
    const isForeign = slug !== null && slug !== DIARIA_STUDIO_REPO && allowed.has(slug);
    const final = isForeign ? slug : DIARIA_STUDIO_REPO;
    const why = isForeign || slug === DIARIA_STUDIO_REPO || slug === null ? source : `${source}:fora-da-allowlist`;
    if (!targets.some((t) => t.repo === final)) targets.push({ repo: final, source: why });
  };
  for (const seg of ghPrSegments(command, subcommands)) {
    if (seg.source === "unparseable") {
      add(DIARIA_STUDIO_REPO, "unparseable");
      continue;
    }
    if (seg.repo) {
      add(seg.repo, seg.source);
      continue;
    }
    const useCd = seg.cd !== null && !cwdAlreadyResolved;
    let dir = cwd;
    if (useCd) {
      try {
        dir = resolvePath(typeof cwd === "string" && cwd !== "" ? cwd : process.cwd(), seg.cd);
      } catch {
        dir = null;
      }
    }
    const origin = repoFromCwdOrigin(dir, execFn);
    add(origin, origin ? (useCd ? "cd-origin" : "cwd-origin") : null);
    if (useCd && cdStrict) add(DIARIA_STUDIO_REPO, "cd-strict");
  }
  return targets;
}

/**
 * Compat: um único `{ repo, source }`. Mais de um repo envolvido →
 * `{ repo: null, source: "mixed" }`; nenhum segmento → indeterminado.
 */
export function resolveGhTargetRepo(command, cwd, opts = {}) {
  const targets = resolveGhTargets(command, cwd, opts);
  if (targets.length === 0) return { repo: null, source: null };
  if (targets.length > 1) return { repo: null, source: "mixed" };
  return targets[0];
}

/**
 * `true` só quando `repo` é um repo de FORA permitido (`issue_repos`, não o
 * default). Indeterminado, typo, fork → `false` (regras do diaria-studio).
 */
export function isForeignRepo(repo, allowed = loadAllowedForeignRepos()) {
  const slug = normalizeRepoSlug(repo ?? "");
  return slug !== null && slug !== DIARIA_STUDIO_REPO && allowed.has(slug);
}

/**
 * Hooks de `gh pr create`: `true` quando TODO segmento do comando mira um
 * repo de fora permitido. `cwd` é a raiz já resolvida pelo hook (inclui o
 * alvo de `cd`).
 */
export function isForeignRepoGhCommand(command, cwd, opts = {}) {
  const targets = resolveGhTargets(command, cwd, { cwdAlreadyResolved: true, ...opts });
  return targets.length > 0 && targets.every((t) => t.repo !== DIARIA_STUDIO_REPO);
}
