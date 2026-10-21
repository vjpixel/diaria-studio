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
// MERGE — ÔNUS DA PROVA INVERTIDO (re-verificação da PR #10668): os hooks de
// merge usam `resolveMergeTargets`, não `resolveGhTargets`. O lock do
// diaria-studio entra SEMPRE, salvo quando o comando inteiro casa a whitelist
// estrita de `parseStrictMerge` (um único `gh pr merge N|<URL canônica>` com
// flags booleanas conhecidas e `-R`/`--repo` canônico, opcionalmente
// `cd /abs && ` e `2>&1 | tail -N`). Fora dela, concessão nenhuma conta.
// As regras abaixo (`resolveGhTargets`) seguem valendo pros hooks de create.
//
// FAIL-CLOSED (verificação da PR #10668): o resolver só confia num comando
// em FORMA SIMPLES — palavras + separadores `&&` `;` `||` `|` newline, `cd X`
// opcional, `-R`/`--repo`/URL. Qualquer `&` solto, `|&`, `#`, `(` `)` `{` `}`,
// `$(`, crase, `<<`, pushd/popd, eval, `bash -c`/`sh -c`, xargs, ou prefixo
// antes do `gh` (atribuição de env, `env`, `command`, caminho até o gh, flag
// global antes de `pr merge`) torna o comando COMPLEXO: o alvo vira o
// diaria-studio + todo repo permitido que o comando possa mencionar (texto,
// `origin` do cwd e de cada `cd`/`pushd`), e quem chama confere TODOS os locks
// e ignora concessão/auto-autorização. Detectar SE o comando é um merge é
// outra função (`isGhPrMergeCommand`, #10681/#10688) — aqui só se decide QUAL
// repo ele toca.
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
  // `ssh://git@github.com[:porta]/o/r` e `ssh://git@ssh.github.com:443/o/r`.
  const sshUrl = new RegExp("^ssh://git" + "@" + "(?:ssh\\.)?github\\.com(?::\\d+)?/(.+)$", "i").exec(s);
  if (sshUrl) return normalizeRepoSlug(sshUrl[1]);
  // Forma scp: `git` + arroba + `github.com:o/r` ou `ssh.github.com:o/r`.
  const scp = new RegExp("^git" + "@" + "(?:ssh\\.)?github\\.com:(.+)$", "i").exec(s);
  if (scp) return normalizeRepoSlug(scp[1]);
  const https = /^https?:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/(.+)$/i.exec(s);
  if (https) return normalizeRepoSlug(https[1]);
  // Alias de host (`github-work:o/r` do ~/.ssh/config) ou qualquer outro: null
  // — quem decide trata origin desconhecido como NÃO provado (estrito).
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

const SEPARATORS = new Set(["&&", "||", ";", "|", "\n", "&", "|&"]);

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
    if (ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) {
      // Redirecionamento (`2>&1`, `<&3`, `&>arq`), não background: fica na palavra.
      cur += ch;
      has = true;
      i++;
      continue;
    }
    if (ch === "&") {
      // `&&`, ou `&` solto (background) — os dois separam comandos.
      flush();
      if (command[i + 1] === "&") {
        out.push("&&");
        i += 2;
      } else {
        out.push("&");
        i++;
      }
      continue;
    }
    if (ch === "|") {
      flush();
      if (command[i + 1] === "&") {
        out.push("|&");
        i += 2;
      } else if (command[i + 1] === "|") {
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

/** Flags que consomem o token seguinte como VALOR, POR SUBCOMANDO — o valor
 * delas nunca é lido como `-R`/URL (ex: `--body "veja -R x/y"`). No `merge`,
 * `-m`/`-r`/`-s` são booleanos (--merge/--rebase/--squash), no `create` não. */
const VALUE_FLAGS = {
  merge: new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit"]),
  create: new Set([
    "-b", "--body", "-F", "--body-file", "-t", "--title", "-H", "--head", "-B", "--base", "-l", "--label",
    "-a", "--assignee", "-r", "--reviewer", "-m", "--milestone", "-p", "--project", "-T", "--template", "--recover",
  ]),
};

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
      if ((VALUE_FLAGS[seg[ghAt + 2]] ?? VALUE_FLAGS.create).has(w)) {
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

/** Palavras que, em posição de comando, tiram o `gh` da forma simples. */
const COMPLEX_COMMAND_WORDS = new Set(["pushd", "popd", "eval", "xargs", "env", "command", "exec", "sudo", "nohup", "time", "timeout", "source", "."]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Motivos pelos quais o comando NÃO está na forma simples (lista vazia =
 * simples). Varre fora de aspas simples; dentro de aspas duplas só `$(` e
 * crase contam (são executados ali também).
 */
export function commandComplexity(command) {
  const reasons = new Set();
  if (typeof command !== "string") return [];
  let i = 0;
  const n = command.length;
  let atWordStart = true;
  while (i < n) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      atWordStart = false;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? n : end + 1;
      atWordStart = false;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        else if (command[j] === "`") reasons.add("crase");
        else if (command[j] === "$" && command[j + 1] === "(") reasons.add("$(");
        j++;
      }
      i = j + 1;
      atWordStart = false;
      continue;
    }
    if (ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) {
      i++; // redirecionamento (`2>&1`, `&>arq`), não background
      atWordStart = false;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") i += 2;
      else {
        reasons.add("& solto");
        i++;
      }
      atWordStart = true;
      continue;
    }
    if (ch === "|" && command[i + 1] === "&") reasons.add("|&");
    if (ch === "#" && atWordStart) reasons.add("#");
    if ("(){}".includes(ch)) reasons.add(ch);
    if (ch === "`") reasons.add("crase");
    if (ch === "$" && command[i + 1] === "(") reasons.add("$(");
    if (ch === "<" && command[i + 1] === "<") reasons.add("<<");
    atWordStart = ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "|";
    i++;
  }
  const words = splitShellWords(command);
  let segStart = 0;
  for (let k = 0; k <= words.length; k++) {
    if (k < words.length && !SEPARATORS.has(words[k])) continue;
    const seg = words.slice(segStart, k);
    segStart = k + 1;
    if (seg.length === 0) continue;
    const first = seg[0];
    if (COMPLEX_COMMAND_WORDS.has(first)) reasons.add(first);
    if (SHELLS.has(first.replace(/^.*[\\/]/, "").replace(/\.exe$/i, ""))) reasons.add("shell");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) reasons.add("env=");
    seg.forEach((w, idx) => {
      const isGhWord = w === "gh" || /[\\/]gh(?:\.exe)?$/i.test(w) || /^gh\.exe$/i.test(w);
      if (!isGhWord) return;
      if (idx !== 0 || w !== "gh") reasons.add("prefixo antes do gh");
      else if (seg[1] !== "pr" || (seg[2] ?? "").startsWith("-")) reasons.add("flag global do gh");
    });
  }
  return [...reasons];
}

const SLUG_IN_TEXT_RE = /(?:github\.com[/:])?([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/g;
const API_REPOS_PATH_RE = /\brepos\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)/gi;

/** Repos PERMITIDOS que aparecem em qualquer lugar do texto do comando. */
export function reposMentioned(command, allowed = loadAllowedForeignRepos()) {
  const out = new Set();
  if (typeof command !== "string") return out;
  const add = (raw) => {
    const slug = normalizeRepoSlug(raw);
    if (slug && (slug === DIARIA_STUDIO_REPO || allowed.has(slug))) out.add(slug);
  };
  for (const m of command.matchAll(SLUG_IN_TEXT_RE)) add(m[1]);
  // #10689: caminho da API (`gh api -X PUT repos/o/r/pulls/5/merge`) — o
  // regex acima consome `repos/o` e nunca enxerga o `o/r` que vem depois.
  for (const m of command.matchAll(API_REPOS_PATH_RE)) add(m[1]);
  return out;
}

/**
 * Caminho MSYS/Git Bash (`/c/Users/...`) → caminho nativo do Windows
 * (`C:\\Users\\...`), só em win32 — o Node leria `/c/...` como `C:\\c\\...`
 * e o `origin` sairia indeterminado. Em outra plataforma (ou outro formato)
 * devolve o próprio caminho.
 */
export function toNativePath(path, platform = process.platform) {
  if (platform !== "win32" || typeof path !== "string") return path;
  const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(path);
  if (!m) return path;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replaceAll("/", "\\")}`;
}

/** `origin` do repo git em `cwd`. `null` quando indeterminado (sem cwd, git falhou). */
export function repoFromCwdOrigin(cwd, execFn = execFileSync) {
  if (typeof cwd !== "string" || cwd.trim() === "") return null;
  try {
    const url = execFn("git", ["remote", "get-url", "origin"], {
      cwd: toNativePath(cwd),
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
  const complexReasons = commandComplexity(command);
  if (complexReasons.length > 0) {
    // FAIL-CLOSED: diaria-studio + tudo que o comando possa tocar. Quem chama
    // confere todos os locks e ignora concessões (ver `isComplexTarget`).
    const source = `complex:${complexReasons.join(",")}`;
    const repos = new Set([DIARIA_STUDIO_REPO, ...reposMentioned(command, allowed)]);
    const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
    const dirs = [cwd];
    const words = splitShellWords(command).map((w) => w.replace(/^[({]+|[)}]+$/g, ""));
    words.forEach((w, k) => {
      if ((w === "cd" || w === "pushd") && words[k + 1]) {
        try {
          dirs.push(resolvePath(toNativePath(base), toNativePath(words[k + 1])));
        } catch {
          // diretório ilegível: o studio já está no conjunto
        }
      }
    });
    for (const d of dirs) {
      const origin = repoFromCwdOrigin(d, execFn);
      if (origin && allowed.has(origin)) repos.add(origin);
    }
    return [...repos].map((repo) => ({ repo, source }));
  }
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
        dir = resolvePath(toNativePath(typeof cwd === "string" && cwd !== "" ? cwd : process.cwd()), toNativePath(seg.cd));
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

// ─── Merge: ônus da prova invertido (re-verificação da PR #10668) ──────────
//
// Pra `gh pr merge`, o diaria-studio está SEMPRE no conjunto de alvos — e a
// concessão só conta pro diaria-studio — a menos que o comando inteiro case
// uma WHITELIST estrita que PROVA ser um único merge de outro repo. Nada de
// tokenizar shell aqui: a whitelist é uma regex por token sobre o texto cru,
// e qualquer coisa fora dela (aspas, `$`, controle, clusters de flag, `--`,
// URL não canônica, outro separador...) cai no modo ESTRITO.

const PIPE_SUFFIX_RE = /^(.*?)(?: 2>&1)? \| (?:tail|head)(?: -\d+)?$/s;
// Caminho absoluto sem aspas, espaço, `$`, `~` nem metacaractere (Windows ou POSIX).
const CD_PREFIX_RE = /^cd ((?:[A-Za-z]:)?[\\/][A-Za-z0-9_.\\/:-]*) && (.*)$/s;
const CANONICAL_PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/;
const SLUG_TOKEN_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Slug só vale na forma CANÔNICA literal (minúsculo, sem sufixo de remote):
 * qualquer variação que o gh normalizaria sozinho fica fora da whitelist. */
function canonicalSlugToken(v) {
  if (!SLUG_TOKEN_RE.test(v)) return null;
  const slug = normalizeRepoSlug(v);
  return slug === v ? slug : null;
}
const MERGE_BOOL_FLAGS = new Set(["--squash", "--merge", "--rebase", "-s", "-m", "-r", "--delete-branch", "-d", "--auto", "--admin"]);

// #10716: `--subject`/`--body` (e `-t`/`-b`) com argumento ENTRE ASPAS — a
// forma que `.claude/skills/diaria-overnight/SKILL.md` manda usar no merge.
// O valor é só texto da mensagem de commit: não muda o repo-alvo do gh, então
// sai do comando ANTES da whitelist por token (e não entra na varredura de
// repos citados). Só a forma cujo quoting é inequívoco:
//   - aspas duplas sem `"`, `$`, crase nem `\` seguido de `"$\`\\` (sem
//     expansão, sem fechar a aspa antes do que a regex enxerga — `\n` literal
//     passa, como no SKILL.md);
//   - aspas simples sem `'`;
//   - em ambas, sem `;`, `&` nem `|` — defesa em profundidade: valor que
//     parece encadear outro comando (caso "J && entre aspas" do
//     test/issue-repos-10618.test.ts) segue estrito, mesmo com o quoting
//     correto.
// Precedido por espaço e seguido de espaço/fim. Qualquer outra forma (`=`,
// sem aspas, `$(...)`, aspas aninhadas) fica no texto e cai no modo ESTRITO.
// Prova de que a remoção não muda o parsing do shell: depois de remover, o
// restante não pode ter aspa nenhuma (a whitelist por token recusa), então
// toda aspa do comando estava num trecho removido — e cada trecho abre e
// fecha a aspa exatamente onde o shell abre e fecha.
const MERGE_MESSAGE_FLAG_RE = / (?:--subject|--body|-t|-b) (?:"(?:[^"$`\\;&|]|\\[^"$`\\;&|])*"|'[^';&|]*')(?= |$)/g;

/**
 * Lê `gh pr merge` na forma EXATA da whitelist. Devolve `{ repo, pr, cd }`
 * (`repo` = do -R/--repo ou da URL canônica; `null` se nenhum dos dois) ou
 * `null` quando QUALQUER token foge do formato.
 */
export function parseStrictMerge(command) {
  if (typeof command !== "string" || command.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(command)) return null; // \r, \n, \t, ...
  let core = command;
  const pipe = PIPE_SUFFIX_RE.exec(core);
  if (pipe) core = pipe[1];
  let cd = null;
  const cdm = CD_PREFIX_RE.exec(core);
  if (cdm) {
    cd = cdm[1];
    core = cdm[2];
  }
  // #10716: remove `--subject "…"`/`--body "…"` (ver MERGE_MESSAGE_FLAG_RE) só
  // do trecho do `gh` — depois do `cd`, cujo caminho aceita `\` e poderia
  // escapar o espaço antes do flag. O restante segue pela whitelist por token,
  // que recusa qualquer aspa ou `\` que tenha sobrado.
  core = core.replace(MERGE_MESSAGE_FLAG_RE, "");
  const tokens = core.split(" ");
  if (tokens[0] !== "gh" || tokens[1] !== "pr" || tokens[2] !== "merge") return null;
  let pr = null;
  let urlRepo = null;
  let flagRepo = null;
  for (let k = 3; k < tokens.length; k++) {
    const t = tokens[k];
    if (/^\d+$/.test(t)) {
      if (pr !== null) return null;
      pr = Number(t);
      continue;
    }
    const url = CANONICAL_PR_URL_RE.exec(t);
    if (url) {
      if (pr !== null) return null;
      pr = Number(url[2]);
      urlRepo = canonicalSlugToken(url[1]);
      if (!urlRepo) return null;
      continue;
    }
    if (MERGE_BOOL_FLAGS.has(t)) continue;
    if (t === "-R" || t === "--repo") {
      const v = tokens[k + 1] ?? "";
      if (flagRepo !== null) return null;
      flagRepo = canonicalSlugToken(v);
      if (!flagRepo) return null;
      k++;
      continue;
    }
    const eq = /^--repo=(.+)$/.exec(t);
    if (eq) {
      if (flagRepo !== null) return null;
      flagRepo = canonicalSlugToken(eq[1]);
      if (!flagRepo) return null;
      continue;
    }
    return null; // token fora do formato (vazio = espaço duplo, cluster, --, aspas...)
  }
  if (pr === null) return null;
  if (urlRepo && flagRepo && urlRepo !== flagRepo) return null;
  return { repo: flagRepo ?? urlRepo, pr, cd };
}

/**
 * Alvos de um `gh pr merge` (ônus da prova invertido). Devolve
 * `{ mode, targets, grantRepo, pr }`:
 *   - `foreign-whitelist`: o comando PROVA ser um único merge de um repo de
 *     fora permitido → `targets = [esse repo]`, concessão desse repo conta;
 *   - `studio-plain`: forma estrita com `-R`/URL do studio, ou sem repo e com
 *     o `origin` do cwd (ou do `cd`) PROVADAMENTE o diaria-studio (e sem
 *     `GH_REPO` herdado) → `targets = [diaria-studio]`, concessão do studio conta;
 *   - `strict`: qualquer outra coisa → diaria-studio + todo repo permitido
 *     que o comando possa tocar; NENHUMA concessão conta (`grantRepo: null`).
 */
export function resolveMergeTargets(command, cwd, opts = {}) {
  const { execFn = execFileSync, allowed = loadAllowedForeignRepos(), env = process.env } = opts;
  const parsed = parseStrictMerge(command);
  if (parsed) {
    const { repo, cd, pr } = parsed;
    if (repo !== null && repo !== DIARIA_STUDIO_REPO) {
      // Repo de fora: só vale se permitido e, com `cd`, se o diretório é dele.
      if (allowed.has(repo) && (cd === null || repoFromCwdOrigin(cd, execFn) === repo)) {
        return { mode: "foreign-whitelist", targets: [repo], grantRepo: repo, pr, explicitRepo: repo };
      }
    } else if (repo === DIARIA_STUDIO_REPO) {
      return { mode: "studio-plain", targets: [DIARIA_STUDIO_REPO], grantRepo: DIARIA_STUDIO_REPO, pr, explicitRepo: repo };
    } else if (!(typeof env?.GH_REPO === "string" && env.GH_REPO !== "")) {
      // Sem -R/URL o gh mira o repo do DIRETÓRIO (ou o `GH_REPO` herdado do
      // ambiente — aí não há prova, estrito). Forma simples do studio só com
      // PROVA POSITIVA: o `origin` do diretório tem que ser o diaria-studio.
      // Indeterminado (sem cwd, git falhou, alias de host, caminho ilegível)
      // NUNCA conta como "não é de fora".
      const o = repoFromCwdOrigin(cd ?? cwd, execFn);
      if (o === DIARIA_STUDIO_REPO) {
        return { mode: "studio-plain", targets: [DIARIA_STUDIO_REPO], grantRepo: DIARIA_STUDIO_REPO, pr, explicitRepo: repo };
      }
    }
  }
  // ESTRITO: studio + tudo que o comando possa tocar.
  const repos = new Set([DIARIA_STUDIO_REPO, ...reposMentioned(command, allowed)]);
  const base = typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
  const dirs = [cwd];
  for (const m of String(command).matchAll(/(?:^|[\s;&|(){}!])(?:cd|pushd)\s+([^\s;&|()]+)/g)) {
    try {
      dirs.push(resolvePath(toNativePath(base), toNativePath(m[1].replace(/^['"]|['"]$/g, ""))));
    } catch {
      // diretório ilegível: o studio já está no conjunto
    }
  }
  for (const d of dirs) {
    const o = repoFromCwdOrigin(d, execFn);
    if (o && allowed.has(o)) repos.add(o);
  }
  return { mode: "strict", targets: [...repos], grantRepo: null, pr: parsed?.pr ?? null, explicitRepo: null };
}

/** `true` quando a resolução caiu no modo COMPLEXO (fail-closed). */
export function isComplexTarget(targets) {
  return Array.isArray(targets) && targets.some((t) => typeof t.source === "string" && t.source.startsWith("complex:"));
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
  // Comando COMPLEXO (ex: o habitual `--body "$(cat <<'EOF' ...)"`): decide
  // pelo checkout em `cwd` — de onde o `gh pr create` sai — e só pula se ele
  // é um repo de fora permitido E o texto não menciona o diaria-studio.
  // Tratar todo create complexo como diaria-studio reabriria o bloqueio do
  // vjpixel/diaria-design#23; sem lock em jogo aqui, o checkout basta.
  if (commandComplexity(command).length > 0) {
    const allowed = opts.allowed ?? loadAllowedForeignRepos();
    const origin = repoFromCwdOrigin(cwd, opts.execFn ?? execFileSync);
    return isForeignRepo(origin, allowed) && !reposMentioned(command, allowed).has(DIARIA_STUDIO_REPO);
  }
  const targets = resolveGhTargets(command, cwd, { cwdAlreadyResolved: true, ...opts });
  return targets.length > 0 && targets.every((t) => t.repo !== DIARIA_STUDIO_REPO);
}
