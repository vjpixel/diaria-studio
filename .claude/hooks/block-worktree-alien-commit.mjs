// PreToolUse hook — recusa `git commit` quando a sessão que está commitando
// não é a dona do claim de worktree para este diretório, ou quando a branch
// do HEAD diverge do que `git worktree list` reporta para este path (#7722
// item 4, "corrigindo #7806 stub que sempre retornava blocked:false").
//
// Cenário: outra sessão adota/mexe num worktree que não é dela e troca a
// branch por baixo (`git checkout master` no meio de um worktree que tinha
// `fix/7707-...` checked out) — a sessão DONA do worktree, sem saber disso,
// segue trabalhando e commita ali. Este guard barra o `git commit` quando
// há evidência de que outra sessão reivindicou este mesmo worktree path
// (`data/sessions/.worktree-claims/<hash>.json`, #7892/#7903 — arquivo
// autoritativo indexado por path, não o mirror) por um `session_id`
// diferente do que está commitando, ou quando o branch atual do HEAD não
// bate com o `branch` gravado nesse mesmo claim no momento em que foi feito.
//
// #7895 (achado da Fase 1.5, rodada overnight 260909-260910): a versão
// entregue no #7810 nunca lia o payload `PreToolUse` — rodava sua lógica
// incondicionalmente em CADA invocação (spawn de `git` a cada chamada),
// independente de o comando ser ou não `git commit`, e nunca foi registrada
// em `.claude/settings.json`. Corrigido aqui: só roda quando o `Bash`
// invocado contém de fato um `git commit` (detecção por token, mesma
// convenção dos hooks irmãos), e só emite output quando bloqueia — mesmo
// protocolo JSON (`hookSpecificOutput.permissionDecision: "deny"`) que
// `block-worktree-bare-push.mjs`/`block-branch-checkout-main.mjs` usam,
// substituindo o `process.exit(1)`/`console.error` da versão anterior, que
// não é o contrato que o harness lê para bloquear um `PreToolUse`.
//
// #7903 (achado do review consolidado diário, PR #7899): a versão acima
// tinha 2 defeitos que a deixavam praticamente inerte. (1) A checagem de
// claim lia só o MIRROR (`data/sessions/*.json` → `worktree_claim`), nunca
// o arquivo indexado por path (`data/sessions/.worktree-claims/<hash>.json`)
// que o #7892 tornou a fonte de verdade — o mirror é last-writer-wins POR
// SESSÃO (uma sessão que reivindica vários worktrees sobrescreve o próprio
// mirror a cada claim novo), então uma claim antiga continuava viva no
// arquivo autoritativo sem o mirror refletir isso: falso-negativo. Corrigido
// lendo `worktreeClaimFilePath` diretamente (cópia self-contained da mesma
// chave de `session-registry.ts`). (2) `BLOCK_REASON_BRANCH_DIVERGE` nunca
// disparava — comparava `git rev-parse --abbrev-ref HEAD` deste worktree com
// a branch que `git worktree list --porcelain` reporta PARA O MESMO path:
// as duas vêm do mesmo HEAD, então são sempre iguais por construção, código
// morto que parecia proteção. Corrigido comparando contra o `branch`
// gravado NO MOMENTO DO CLAIM (`claimWorktree` ganhou esse parâmetro) — só
// isso detecta de fato uma troca de branch por baixo depois do claim.
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos: import estático de `.ts` quebra o hook inteiro, em
// silêncio, num Node sem type-stripping nativo.
//
// Fail-open sempre: um hook quebrado, ou estado ambíguo (sem `session_id`
// no payload, `data/sessions/` ausente, JSON corrompido), nunca deve travar
// um `git commit` legítimo.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripQuotedSpans } from "./lib/shell-quote-strip.mjs";
import { normalizeMsysPath } from "./block-pr-create-pii-runtime-artifacts.mjs";

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles. Duplicado dos hooks irmãos (self-contained).
 */
export { stripQuotedSpans };

/**
 * Comando shell em entradas na ordem em que aparecem (#14321):
 * `{ type: "seg", words }` para cada comando simples (separados por `&&`,
 * `||`, `;`, `|`, `&` e newline), e `{ type: "open" }`/`{ type: "close" }`
 * para `(`/`)` de subshell, que delimitam o alcance de um `cd`.
 *
 * Diferente de `stripQuotedSpans` (que APAGA o conteúdo entre aspas), aqui o
 * conteúdo citado fica dentro da palavra, sem as aspas: o diretório de
 * `git -C "C:/com espaço" commit` ou de `cd "x y"` precisa do texto. Texto
 * citado nunca vira separador nem comando (`echo "git commit"` é uma palavra
 * só). Regras de escape iguais às do tokenizer compartilhado: `\x` fora de
 * aspas é literal, `\<newline>` é continuação, `$'...'` aceita `\'`.
 */
export function shellEntries(command) {
  const entries = [];
  if (typeof command !== "string") return entries;
  let words = [];
  let word = "";
  let inWord = false;
  const pushWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const pushSeg = () => {
    pushWord();
    if (words.length > 0) entries.push({ type: "seg", words });
    words = [];
  };
  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i];
    const next = command[i + 1];
    if (ch === "\\" && i + 1 < n) {
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (ch === "$" && next === "'") {
      let j = i + 2;
      while (j < n && command[j] !== "'") {
        if (command[j] === "\\" && j + 1 < n) {
          word += command[j + 1];
          j += 2;
          continue;
        }
        word += command[j];
        j++;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") word += command[j++];
      inWord = true;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < n && '"\\$`'.includes(command[j + 1])) {
          word += command[j + 1];
          j += 2;
          continue;
        }
        word += command[j];
        j++;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      pushSeg();
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      pushSeg();
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      pushSeg();
      entries.push({ type: ch === "(" ? "open" : "close" });
      i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i++;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  pushSeg();
  return entries;
}

/** Opções globais do git que consomem o argumento seguinte (`-C dir`, `-c k=v`). */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

/**
 * Lê uma invocação do git a partir das palavras de um comando simples
 * (#14321): pula as opções globais antes do subcomando (`-C <dir>`,
 * `-c chave=valor`, `--git-dir`, `--no-pager`, `--git-dir=x`…) e devolve o
 * subcomando, os `-C` na ordem e o `--work-tree`. `null` se não é git.
 * Até o #14321 o guard exigia `tokens[1] === "commit"`, e `git -C <wt>
 * commit` passava direto.
 */
export function parseGitInvocation(words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  // `{ git commit; }`: a chave do agrupamento é palavra própria no bash.
  let start = 0;
  while (words[start] === "{" || words[start] === "}") start++;
  const bin = words[start]?.toLowerCase();
  if (bin !== "git" && bin !== "git.exe") return null;
  const cDirs = [];
  let workTree = null;
  let i = start + 1;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    const eq = w.indexOf("=");
    const name = w.startsWith("--") && eq > 0 ? w.slice(0, eq) : w;
    if (GIT_GLOBAL_OPTS_WITH_VALUE.has(name)) {
      let value;
      if (name !== w) value = w.slice(eq + 1);
      else {
        value = words[i + 1];
        i++;
      }
      if (name === "-C" && typeof value === "string") cDirs.push(value);
      if (name === "--work-tree" && typeof value === "string") workTree = value;
    }
    i++;
  }
  const sub = words[i];
  return { subcommand: typeof sub === "string" ? sub.toLowerCase() : null, cDirs, workTree };
}

/** `true` quando `tokens` é um segmento `git commit` real (token exato, não
 * substring de outro subcomando como `git commit-graph`), com ou sem opções
 * globais antes do subcomando (#14321). */
export function isGitCommitCommand(tokens) {
  return parseGitInvocation(tokens)?.subcommand === "commit";
}

/** `true` se `command` contém algum `git commit` como comando real. */
export function commandHasGitCommit(command) {
  return shellEntries(command).some((e) => e.type === "seg" && isGitCommitCommand(e.words));
}

/** Caminho como o shell o entenderia: `~` expandido, `/c/...` do Git Bash. */
function shellPath(p, platform) {
  let out = p;
  if (out === "~" || out.startsWith("~/")) out = homedir() + out.slice(1);
  return normalizeMsysPath(out, platform);
}

/**
 * Diretório em que cada `git commit` do comando de fato roda (#14321), na
 * ordem: parte de `baseCwd` (o `payload.cwd`), aplica os `cd`/`pushd` da
 * cadeia (escopados a subshell `( … )`), depois os `-C` do próprio git (cada
 * um relativo ao anterior, como o git faz) e por fim o `--work-tree`. Antes
 * o guard julgava `cd <wt> && git commit` pelo `payload.cwd`, que é o
 * diretório de ANTES do `cd`: o `PreToolUse` dispara antes do comando rodar.
 *
 * Aproximação deliberada: `cd` sem argumento vai para o home; `cd -` e
 * `$(...)`/variáveis não são resolvidos (o diretório fica como estava). Erro
 * para o lado de olhar o diretório errado é o mesmo fail-open de sempre.
 */
export function commitTargetDirs(command, baseCwd, platform = process.platform) {
  const out = [];
  let cwd = baseCwd;
  const stack = [];
  for (const entry of shellEntries(command)) {
    if (entry.type === "open") {
      stack.push(cwd);
      continue;
    }
    if (entry.type === "close") {
      if (stack.length > 0) cwd = stack.pop();
      continue;
    }
    const words = entry.words;
    let start = 0;
    while (words[start] === "{" || words[start] === "}") start++;
    const bin = words[start];
    if (bin === "cd" || bin === "pushd") {
      const target = words.slice(start + 1).find((w) => !w.startsWith("-") || w === "-");
      if (target === undefined) cwd = homedir();
      else if (target !== "-" && !target.includes("$")) {
        try {
          cwd = resolvePath(cwd, shellPath(target, platform));
        } catch {
          // caminho que o Node não resolve: fica no diretório anterior
        }
      }
      continue;
    }
    const inv = parseGitInvocation(words);
    if (inv?.subcommand !== "commit") continue;
    let dir = cwd;
    try {
      for (const d of inv.cDirs) if (d !== "") dir = resolvePath(dir, shellPath(d, platform));
      if (inv.workTree) dir = resolvePath(dir, shellPath(inv.workTree, platform));
    } catch {
      // fail-open: julga pelo diretório já resolvido
    }
    out.push(dir);
  }
  return out;
}

/**
 * Raiz do worktree quando `git rev-parse --show-toplevel` falha ou estoura o
 * timeout (#14321). Antes o hook usava o `payload.cwd` cru, e a chave da
 * claim (hash do path) só batia se a grafia coincidisse com a do git. Aqui o
 * caminho é normalizado como o git o devolveria: `/c/...` do Git Bash vira
 * `C:/...`, `realpath` nativo dá a caixa real das pastas no Windows, a
 * subpasta sobe até o diretório que tem `.git` (o toplevel) e a letra do
 * drive fica maiúscula.
 */
export function fallbackCheckoutRoot(probeCwd, platform = process.platform) {
  let dir = resolvePath(normalizeMsysPath(probeCwd, platform));
  try {
    dir = realpathSync.native(dir);
  } catch {
    // diretório inexistente ou ilegível: segue com o resolvido
  }
  for (let cur = dir; ; ) {
    if (existsSync(join(cur, ".git"))) {
      dir = cur;
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (platform === "win32") dir = dir.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  return dir;
}

/** Duplicado de `isLinkedWorktree` dos hooks irmãos. */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isLinkedWorktree(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return false;
    return !statIsDirectory(gitPath);
  } catch {
    return false;
  }
}

export function sessionsDir(repoRoot) {
  return join(repoRoot, "data", "sessions");
}

/**
 * Cópia self-contained de `worktreeClaimKey`/`worktreeClaimFilePath`
 * (`scripts/lib/session-registry.ts`, #7892) — a chave do arquivo
 * autoritativo de claim é um hash estável do path normalizado. Duplicado
 * (não importado) pela mesma razão documentada no topo do arquivo: hooks
 * self-contained não importam `.ts`.
 */
function worktreeClaimKey(path) {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

function worktreeClaimFilePath(repoRoot, path) {
  return join(repoRoot, "data", "sessions", ".worktree-claims", `${worktreeClaimKey(path)}.json`);
}

/**
 * Lê o registro autoritativo de claim (`data/sessions/.worktree-claims/
 * <hash>.json`, gravado por `session-registry.ts` `claimWorktree`) para
 * `checkoutRoot`. Devolve o record parseado (`{ path, sessionId, branch,
 * claimed_at, expires_at }`) quando o arquivo existe e está vivo (`now` <
 * `expires_at`), ou `null` — arquivo ausente, malformado, ou claim expirada
 * (fail-open em todos os casos ambíguos).
 *
 * **#7903**: substitui a varredura de `data/sessions/*.json` (mirror) que
 * este hook usava antes — o mirror é last-writer-wins POR SESSÃO (uma
 * sessão que reivindica vários worktrees em sequência sobrescreve o próprio
 * mirror a cada claim novo), então uma claim antiga podia seguir viva no
 * arquivo autoritativo sem o mirror refletir isso. O arquivo indexado por
 * path é a fonte de verdade desde o #7892; ler só ele fecha esse
 * falso-negativo.
 */
export function readWorktreeClaimRecord(repoRoot, checkoutRoot, now = Date.now()) {
  const claimFile = worktreeClaimFilePath(repoRoot, resolvePath(checkoutRoot));
  let record;
  try {
    if (!existsSync(claimFile)) return null;
    record = JSON.parse(readFileSync(claimFile, "utf8"));
  } catch {
    return null;
  }
  if (!record || typeof record !== "object") return null;
  const expiresAt = record.expires_at ?? record.expiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now) return null; // claim expirada
  return record;
}

/**
 * `session_id` de quem reivindica um worktree via `record` (já lido —
 * `readWorktreeClaimRecord`), quando é uma sessão DIFERENTE de
 * `callerSessionId`. `null` — sem claim viva, claim é da própria sessão, ou
 * estado ambíguo (fail-open). Variante que não faz I/O — usada pelo caminho
 * de runtime (que já leu `record` uma vez pra reusar no check de branch
 * também); `findConflictingClaimSessionId` abaixo é o wrapper que lê +
 * checa numa chamada só, mantido para os chamadores/testes existentes.
 */
export function findConflictingClaimSessionIdFromRecord(record, callerSessionId) {
  // Self-review (#7899 finding 8): sem `callerSessionId` não dá pra distinguir
  // "é a própria sessão" de "é outra sessão" — nunca sinalizar conflito nesse
  // estado (fail-open), senão o claim da PRÓPRIA sessão (bem provável de
  // existir, dado que o convencional é reivindicar o worktree antes de
  // trabalhar nele) seria lido como alheio.
  if (typeof callerSessionId !== "string" || callerSessionId === "") return null;
  if (!record) return null;
  // Mesma cadeia de fallback de `session-registry.ts` (`claimWorktree`:
  // `other.session_id ?? other.id ?? other.sessionId`) — um record que só
  // carrega `id` não pode ser silenciosamente pulado (falso-negativo,
  // #7899 finding 7, preservado na migração pro arquivo autoritativo).
  const recordSessionId = record.session_id ?? record.id ?? record.sessionId;
  if (typeof recordSessionId !== "string" || recordSessionId === "") return null;
  if (recordSessionId === callerSessionId) return null; // é a própria sessão
  return recordSessionId;
}

/**
 * `session_id` de quem reivindica `checkoutRoot` HOJE via o registro
 * autoritativo (`readWorktreeClaimRecord`), quando é uma sessão DIFERENTE
 * de `callerSessionId`. `null` — sem claim viva, claim é da própria sessão,
 * ou estado ambíguo (fail-open). Lê + checa numa chamada só; ver
 * `findConflictingClaimSessionIdFromRecord` para a variante sem I/O.
 */
export function findConflictingClaimSessionId(repoRoot, checkoutRoot, callerSessionId, now = Date.now()) {
  const record = readWorktreeClaimRecord(repoRoot, checkoutRoot, now);
  return findConflictingClaimSessionIdFromRecord(record, callerSessionId);
}

/**
 * Estado do HEAD do worktree (`cwd: checkoutRoot`), separando os três casos
 * que o check de branch trata de forma diferente (#14214, review da PR #14303):
 * - `{ kind: "branch", name }`: HEAD numa branch;
 * - `{ kind: "detached" }`: `git rev-parse --abbrev-ref HEAD` devolveu o
 *   literal `"HEAD"` (rebase com conflito, bisect, cherry-pick, ou checkout
 *   destacado de propósito);
 * - `{ kind: "error" }`: o git falhou ou estourou o timeout — fail-open.
 */
export function getHeadState(checkoutRoot) {
  try {
    // windowsHide (#7959): sem isso, este `execFileSync("git", ...)` aloca
    // console próprio no Windows a cada `git commit` interceptado.
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    }).trim();
    if (out === "") return { kind: "error" };
    if (out === "HEAD") return { kind: "detached" };
    return { kind: "branch", name: out };
  } catch {
    return { kind: "error" };
  }
}

/** Branch do HEAD atual do worktree, `null` em erro ou HEAD destacado. */
export function getHeadBranch(checkoutRoot) {
  const state = getHeadState(checkoutRoot);
  return state.kind === "branch" ? state.name : null;
}

/** Marcadores de operação em curso que deixam o HEAD destacado de forma legítima
 * (merge, revert e `sequencer` desde o #14321, por consistência). */
export const IN_PROGRESS_GIT_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "BISECT_LOG",
  "MERGE_HEAD",
  "REVERT_HEAD",
  "sequencer",
];

/**
 * `true` quando há rebase, cherry-pick, bisect, merge ou revert em curso no
 * worktree (algum `git rev-parse --git-path X` existe). É o que libera o
 * commit com HEAD destacado: o commit do próprio rebase com conflito. Uma
 * chamada só ao git para todos os marcadores (#14321; eram 4). Falha do git,
 * ou saída com número de linhas diferente do de marcadores, conta como "em
 * curso" (fail-open, mesma regra do resto do hook).
 */
export function hasOperationInProgress(checkoutRoot) {
  let lines;
  try {
    lines = execFileSync("git", ["rev-parse", ...IN_PROGRESS_GIT_PATHS.flatMap((m) => ["--git-path", m])], {
      cwd: checkoutRoot,
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "");
  } catch {
    return true;
  }
  if (lines.length !== IN_PROGRESS_GIT_PATHS.length) return true;
  return lines.some((gitPath) => existsSync(resolvePath(checkoutRoot, gitPath)));
}

export const BLOCK_REASON_CLAIM =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4: este worktree tem um claim ativo " +
  "(`data/sessions/.worktree-claims/<hash>.json`, #7892) de uma sessão DIFERENTE da que está tentando " +
  "commitar agora. Provável cenário: outra sessão adotou/mexeu neste worktree e trocou a branch por " +
  "baixo — commitar aqui pode ir parar num branch/PR que não é o seu. Releia os registros em " +
  "`data/sessions/.worktree-claims/` pra identificar a sessão reivindicante " +
  "antes de prosseguir — `session-registry.ts is-claimed` é sobre claims de ISSUE, não de worktree, " +
  "não serve pra confirmar este caso (#7899 finding 4).";

export const BLOCK_REASON_BRANCH_DIVERGE =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4 (#7903): a branch do HEAD deste worktree " +
  "diverge da branch registrada NO MOMENTO DO CLAIM (`data/sessions/.worktree-claims/<hash>.json` → " +
  "`branch`) — sinal de que a branch foi trocada por baixo deste worktree entre o claim e agora. " +
  "Confirme com `git status`/`git branch` antes de commitar.";

export const BLOCK_REASON_DETACHED =
  "`git commit` bloqueado pelo guard mecânico #7722 item 4 (#14214): o HEAD deste worktree está DESTACADO, " +
  "sem rebase/cherry-pick/bisect em curso, e a claim (`data/sessions/.worktree-claims/<hash>.json`) gravou a " +
  "branch `branch` — um commit aqui fica fora da branch da unidade. Faça o checkout da branch da claim antes " +
  "de commitar (ou, se trocou de propósito, `session-registry.ts claim-worktree --rebind` já na branch nova).";

/**
 * Filtro do despachante único (#14045): o mesmo primeiro filtro do `runHook`
 * abaixo (tool Bash + `git commit` no comando), antes de qualquer git ou
 * leitura de `data/sessions/`. Puro; o despachante só roda o hook, em
 * processo próprio, quando dá `true`.
 */
export function appliesTo(payload) {
  if (payload.tool_name && payload.tool_name !== "Bash") return false;
  return commandHasGitCommit(payload.tool_input?.command);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  // #9197: path com espaço/não-ASCII chega percent-encoded em import.meta.url
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => runHook(data));
}

/**
 * Corpo do hook (#14045): recebe o stdin cru do PreToolUse e escreve a saída
 * JSON por `write`. O despachante único dos guards de Bash
 * (`pretooluse-bash-dispatch.mjs`) chama esta função no próprio processo; o
 * CLI acima passa o `process.stdout.write` de sempre. O corpo mantém a
 * indentação de antes do #14045 para o diff ficar só nas bordas.
 */
export function runHook(data, write = (s) => process.stdout.write(s)) {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (!commandHasGitCommit(command)) return;

      // Self-review (#7899 finding 1): NUNCA derivar o cwd real da chamada a
      // partir de `import.meta.url`/`dirname` do ARQUIVO deste hook — medição
      // ao vivo documentada em `block-gh-pr-merge-subagent.mjs` (#7712)
      // mostrou que, para uma sessão spawnada com `isolation: "worktree"`, o
      // harness carrega o hook a partir de `${CLAUDE_PROJECT_DIR}`, que fica
      // FIXO na raiz da sessão original — não acompanha o worktree. Só
      // `payload.cwd` reflete o cwd de fato da chamada `Bash` que disparou
      // este hook. Fallback pro path do próprio arquivo só quando `cwd`
      // vem ausente do payload (nunca deveria acontecer em uso real, mas
      // mantém o hook testável/funcional fora do harness).
      const payloadCwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
      const baseCwd = payloadCwd ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
      // #14321: o diretório de cada `git commit` sai da própria cadeia
      // (`cd X && git commit`, `git -C X commit`), não só do `payload.cwd`.
      // Sem nenhum resolvido (não deveria acontecer, já que o filtro acima
      // achou o commit), cai no `baseCwd` de antes.
      const targets = commitTargetDirs(command, baseCwd);
      const callerSessionId = payload.session_id;
      for (const probeCwd of new Set(targets.length > 0 ? targets : [baseCwd])) {
        const reason = denyReasonForCommitAt(probeCwd, callerSessionId);
        if (reason) {
          write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
              },
            }),
          );
          return;
        }
      }
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `git commit` legítimo.
    }
}

/**
 * Motivo para negar um `git commit` que roda em `probeCwd`, ou `null`
 * (#14321: extraído do `runHook` para julgar cada commit da cadeia no
 * diretório em que ele de fato roda). Fail-open em qualquer estado ambíguo.
 */
export function denyReasonForCommitAt(probeCwd, callerSessionId) {
      // `probeCwd` pode ser uma SUBPASTA do worktree (a sessão pode ter
      // dado `cd` antes do `git commit`), não necessariamente a raiz — usa
      // `git rev-parse --show-toplevel` pra resolver a raiz de verdade, que
      // é o que `worktree_claim.path`/`isLinkedWorktree` (checagem de
      // `.git` DIRETO sob o path) esperam.
      let checkoutRoot;
      try {
        // windowsHide (#7959): mesma razão de getHeadBranch acima.
        const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: probeCwd,
          encoding: "utf8",
          timeout: 1000,
          windowsHide: true,
        }).trim();
        checkoutRoot = toplevel || fallbackCheckoutRoot(probeCwd);
      } catch {
        // #14321: sem o git, normaliza como o git faria (a chave da claim é
        // o hash do caminho, e grafia diferente não acharia a claim).
        checkoutRoot = fallbackCheckoutRoot(probeCwd);
      }
      if (!isLinkedWorktree(checkoutRoot)) return null; // fora de escopo: só worktree (mesmo escopo de block-worktree-bare-push.mjs)

      // git-common-dir (repo root para data/sessions) — cada worktree tem seu
      // próprio checkoutRoot, mas data/sessions/ vive só no checkout principal.
      // Self-review (#7899 finding 2): `git rev-parse --git-common-dir`
      // devolve um path ABSOLUTO — `resolvePath(commonDir, "..")` re-raiza
      // corretamente nele; `join(checkoutRoot, commonDir, "..")` (bug
      // anterior) faz concatenação de string e produz um path inexistente
      // quando `commonDir` já é absoluto (reproduzido ao vivo neste worktree).
      let repoRoot = checkoutRoot;
      try {
        // windowsHide (#7959): mesma razão de getHeadBranch acima.
        const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: checkoutRoot,
          encoding: "utf8",
          timeout: 1000,
          windowsHide: true,
        }).trim();
        if (commonDir) repoRoot = resolvePath(commonDir, "..");
      } catch {
        // fail-open: usa checkoutRoot mesmo
      }

      // Lido uma vez, reusado pelos dois checks abaixo (claim conflitante +
      // divergência de branch) — evita 2 leituras do mesmo arquivo.
      const claimRecord = readWorktreeClaimRecord(repoRoot, checkoutRoot);
      if (findConflictingClaimSessionIdFromRecord(claimRecord, callerSessionId)) return BLOCK_REASON_CLAIM;

      // #7903: compara contra a branch gravada NO MOMENTO DO CLAIM (não
      // mais contra `git worktree list --porcelain` — ambos os dois lados
      // dessa comparação vinham do MESMO HEAD deste worktree, então nunca
      // podiam divergir por construção, código morto que parecia proteção).
      const claimedBranch = typeof claimRecord?.branch === "string" ? claimRecord.branch : null;
      if (!claimedBranch) return null;
      // #14214: HEAD destacado só passa com rebase/cherry-pick/bisect/merge/
      // revert em curso; destacado sem operação, com claim de branch, é
      // negado com motivo próprio. Falha do git (timeout) segue fail-open.
      const head = getHeadState(checkoutRoot);
      if (head.kind === "branch" && head.name !== claimedBranch) return BLOCK_REASON_BRANCH_DIVERGE;
      if (head.kind === "detached" && !hasOperationInProgress(checkoutRoot)) return BLOCK_REASON_DETACHED;
      return null;
}
