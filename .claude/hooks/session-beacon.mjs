// PreToolUse hook — mantém um "beacon" de atividade por sessão em
// `data/sessions/`, escrito AUTOMATICAMENTE a cada chamada de ferramenta
// (#6168 Parte B).
//
// Wired em .claude/settings.json sob hooks.PreToolUse, matcher
// "Bash|Edit|Write|NotebookEdit".
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUE ISTO É UM HOOK, E NÃO UM PASSO DE SKILL
// ─────────────────────────────────────────────────────────────────────────
//
// O argumento central de desenho da #6168 é uma observação sobre o próprio
// repo: **o que depende de skill lembrar, não acontece.** Três mecanismos
// corretos, testados e inertes provaram isso:
//
//   - #5156 item 6 — `heartbeat --active-worktrees N` nunca foi chamado por
//     skill nenhuma. O read-path existe e é testado; o campo fica `undefined`
//     pra sempre, há meses.
//   - #6160 — `register` nunca recebia `--pid` de overnight/develop, então o
//     branch "processo vivo protege o registro" do GC era inalcançável
//     justamente pros 2 kinds que mais rodam. Fechado por HOOK
//     (`inject-session-id.mjs`), não por skill.
//   - #5156 item 11 — `plan.session_id` tem rollout pendente; nenhuma skill
//     grava.
//
// Por isso o beacon roda no `PreToolUse`, que o harness executa em TODA
// chamada de ferramenta de TODA sessão — registrada ou não, skill ou
// conversa comum. Nenhuma skill precisa cooperar, e é essa propriedade que
// fecha o buraco 3 da issue (sessão interativa invisível ao registro —
// incidente #5751, em que o `helios` segurava #5738 em `claimed_issues`
// enquanto uma sessão interativa a implementava e mergeava em paralelo).
//
// ─────────────────────────────────────────────────────────────────────────
// A OBJEÇÃO QUE QUASE DERRUBOU ISTO, E COMO ELA FOI RESPONDIDA
// ─────────────────────────────────────────────────────────────────────────
//
// Uma sessão peer, ao ser convidada a se registrar, RECUSOU de propósito, com
// um argumento correto: "esta sessão não emite heartbeat depois que a conversa
// termina" — registrar deixaria uma claim órfã, trocando risco de colisão por
// risco de bloqueio permanente, "que é pior porque não se resolve sozinho".
//
// Metade da objeção morre com o próprio hook: o heartbeat é automático
// ENQUANTO a sessão está viva, sem ninguém lembrar de nada. A outra metade é
// real — quando a conversa acaba, as chamadas param e o registro sobrevive —
// e foi respondida em `scripts/lib/session-registry.ts` com janelas próprias
// pro kind `interactive`: `INTERACTIVE_SOFT_STALE_MS` (15 min, contra 90) e
// `GC_INTERACTIVE_MAX_AGE_MS` (2h, contra 7 dias). Sem essas duas constantes,
// este hook PIORARIA o problema que existe pra resolver.
//
// ─────────────────────────────────────────────────────────────────────────
// BLAST RADIUS (decisões explícitas, não efeitos colaterais)
// ─────────────────────────────────────────────────────────────────────────
//
// Registrar sessões interativas muda o significado de "existe sessão ativa"
// pra três consumidores. Cada um foi tratado, e `test/session-beacon-*.test.ts`
// trava os três:
//
//   1. `scripts/cleanup-merged-worktrees.ts` → `shouldSkipForSharedSession`
//      pulava a varredura se QUALQUER sessão estivesse ativa. Com interativas
//      registrando, passaria a pular SEMPRE. Corrigido lá: filtra por kind
//      coordenador.
//   2. `.claude/hooks/block-gh-pr-merge-subagent.mjs` → `COORDINATOR_KINDS`
//      NÃO recebe o kind novo. Interativa não é coordenadora e não vira uma
//      por relabel; o caminho legítimo dela pro merge é a concessão de janela
//      (#6296), nunca o kind.
//   3. `isIssueClaimedByOther` → claim de interativa BLOQUEIA overnight/
//      develop. É premissa deliberada: é literalmente o caso do #5751.
//
// ─────────────────────────────────────────────────────────────────────────
// CUSTO E FAIL-OPEN
// ─────────────────────────────────────────────────────────────────────────
//
// Roda em toda chamada de ferramenta, então não pode custar caro: nenhum
// subprocesso (a branch sai de ler `.git/HEAD`; a raiz do checkout principal
// sai de ler `.git`), e um throttle de `MIN_WRITE_INTERVAL_MS` evita reescrever
// o arquivo quando nada mudou — `data/sessions/` vive numa junction OneDrive,
// e escrita de alta frequência ali é exatamente o que gera cópia de conflito
// `-safeBackup-NNNN` (#5427/#6130).
//
// Fail-open TOTAL, sem exceção: este hook NUNCA emite saída (não altera nem
// bloqueia nada) e engole toda exceção. Um beacon quebrado pode custar
// visibilidade; nunca pode custar uma chamada de ferramenta do editor.
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada em
// `pr-create-review.mjs` e `block-gh-pr-merge-subagent.mjs` — um import
// estático de `.ts` quebra o hook inteiro, em silêncio, num Node sem
// type-stripping nativo. As constantes duplicadas aqui são travadas contra a
// fonte em `test/session-beacon-hook.test.ts`.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

/** Kind das sessões registradas por este hook. Nunca coordenador — ver blast radius 2. */
export const BEACON_KIND = "interactive";

/** Duplicado de `TOUCHED_PATHS_CAP` em session-registry.ts (hook self-contained). */
export const TOUCHED_PATHS_CAP = 200;

/**
 * Não reescreve o registro se o último write foi há menos que isto E nada
 * mudou (nenhum caminho novo, mesma branch, mesmo verbo). Ver "CUSTO" acima.
 */
export const MIN_WRITE_INTERVAL_MS = 5000;

/** Sanitiza o hostname pra nome de arquivo seguro. Nunca lança. */
export function machineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a raiz do checkout PRINCIPAL **sem spawnar processo** — os hooks
 * irmãos usam `git rev-parse --git-common-dir`, que é correto mas custa um
 * subprocesso; aqui isso rodaria a cada chamada de ferramenta.
 *
 * Regras, todas por leitura de arquivo:
 *   - `<dir>/.git` é DIRETÓRIO  → `<dir>` já é o checkout principal.
 *   - `<dir>/.git` é ARQUIVO    → conteúdo `gitdir: <main>/.git/worktrees/<nome>`;
 *     subir 3 níveis a partir dali devolve `<main>`.
 * Devolve `null` quando não dá pra determinar — o caller então não faz nada
 * (fail-open).
 */
export function resolveMainRepoRootNoSpawn(startDir, fs = { existsSync, readFileSync, statIsDirectory }) {
  try {
    const gitPath = join(startDir, ".git");
    if (!fs.existsSync(gitPath)) return null;
    if (fs.statIsDirectory(gitPath)) return startDir;
    const raw = fs.readFileSync(gitPath, "utf8");
    const match = /gitdir:\s*(.+)/.exec(raw);
    if (!match) return null;
    const gitDir = resolvePath(startDir, match[1].trim());
    // .../<main>/.git/worktrees/<nome>  →  sobe worktrees/<nome> e o .git
    const worktreesDir = dirname(gitDir);
    if (dirname(worktreesDir).endsWith(".git") || /[\\/]\.git$/.test(dirname(worktreesDir))) {
      return dirname(dirname(worktreesDir));
    }
    return null;
  } catch {
    return null;
  }
}

/** Helper injetável — `statSync(...).isDirectory()` sem importar statSync no contrato público. */
function statIsDirectory(path) {
  try {
    // eslint-disable-next-line no-undef
    return require("node:fs").statSync(path).isDirectory();
  } catch {
    try {
      // ESM: readdirSync lança ENOTDIR em arquivo, o que responde a mesma pergunta.
      readdirSync(path);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Lê a branch corrente a partir de `.git/HEAD` (do worktree, quando for um).
 * `null` em detached HEAD ou qualquer falha — nunca lança, nunca spawna.
 */
export function readCurrentBranch(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return null;
    let gitDir = gitPath;
    if (!statIsDirectory(gitPath)) {
      const match = /gitdir:\s*(.+)/.exec(readFileSync(gitPath, "utf8"));
      if (!match) return null;
      gitDir = resolvePath(startDir, match[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : null; // detached HEAD → null, de propósito
  } catch {
    return null;
  }
}

/** Normaliza caminho pra comparação cross-máquina. Espelha `normalizeBeaconPath`. */
export function normalizePath(path) {
  return String(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Extrai o(s) caminho(s) que a chamada de ferramenta vai tocar, relativos à
 * raiz. Só Edit/Write/NotebookEdit têm `file_path` — para `Bash` retorna
 * vazio de propósito: parsear caminho de linha de comando é frágil, e o sinal
 * que interessa do Bash é o VERBO (ver `sniffVerb`), não os arquivos.
 */
export function extractTouchedPaths(toolName, toolInput, repoRoot) {
  const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
  if (!filePath) return [];
  if (!["Edit", "Write", "NotebookEdit"].includes(toolName)) return [];
  try {
    const rel = relative(repoRoot, resolvePath(String(filePath)));
    // Fora do repo (scratchpad, /tmp) não interessa a nenhum peer.
    if (rel.startsWith("..") || rel === "") return [];
    return [normalizePath(rel)];
  } catch {
    return [];
  }
}

/**
 * Verbo curto a partir de um comando Bash. Deliberadamente uma lista pequena
 * de verbos que MUDAM estado compartilhado — não é um parser de shell, e não
 * precisa ser: o valor está em distinguir "commitou e abriu PR" de "editou e
 * foi dormir" (evidência 2 da #6168), não em classificar todo comando.
 */
export function sniffVerb(command) {
  if (typeof command !== "string") return null;
  if (/\bgit\s+commit\b/.test(command)) return "commit";
  if (/\bgit\s+(checkout|switch)\b/.test(command)) return "checkout";
  if (/\bgit\s+push\b/.test(command)) return "push";
  if (/\bgh\s+pr\s+create\b/.test(command)) return "pr-create";
  if (/\bgh\s+pr\s+merge\b/.test(command)) return "pr-merge";
  if (/\bgit\s+worktree\s+add\b/.test(command)) return "worktree-open";
  return null;
}

/**
 * Aplica o teto colapsando pra prefixo de diretório em vez de truncar.
 * Espelha `collapseTouchedPaths` de session-registry.ts.
 */
export function collapsePaths(paths, cap = TOUCHED_PATHS_CAP) {
  let current = [...new Set(paths.map(normalizePath))].filter((p) => p !== "");
  if (current.length <= cap) return current.sort();
  const maxDepth = Math.max(...current.map((p) => p.split("/").length));
  for (let depth = maxDepth - 1; depth >= 1; depth--) {
    current = [
      ...new Set(
        current.map((p) => {
          const parts = p.split("/");
          return parts.length > depth ? parts.slice(0, depth).join("/") : p;
        }),
      ),
    ];
    if (current.length <= cap) break;
  }
  return current.sort().slice(0, cap);
}

/**
 * Função PURA — dado o registro anterior (ou `null`) e o que aconteceu agora,
 * devolve o registro novo, ou `null` quando nada mudou o bastante pra
 * justificar um write (throttle).
 *
 * `git commit` ZERA `dirty_paths`: é o que faz o campo significar "trabalho
 * não commitado" em vez de "arquivos que a sessão já tocou alguma vez" —
 * exatamente a distinção que a evidência 2 da issue pedia (um tick terminou
 * deixando 4 arquivos sem commit em `master` num checkout compartilhado e
 * reportou "concluído"; qualquer sessão que rodasse `git add -A` no intervalo
 * publicaria trabalho de outra frente na PR errada).
 */
export function buildBeaconRecord(previous, event) {
  const { kind, machineTag: tag, sessionId, branch, newPaths, verb, nowIso, pid } = event;
  const nowMs = Date.parse(nowIso);

  const prevTouched = previous?.touched_paths ?? [];
  const prevDirty = previous?.dirty_paths ?? [];
  const added = newPaths.filter((p) => !prevTouched.includes(p));

  const branchChanged = Boolean(branch) && previous?.branch !== branch;
  const verbChanged = Boolean(verb) && previous?.last_action?.verb !== verb;
  const nothingNew = added.length === 0 && !branchChanged && !verbChanged;

  if (previous && nothingNew) {
    const lastMs = Date.parse(previous.lastHeartbeat ?? "");
    if (Number.isFinite(lastMs) && Number.isFinite(nowMs) && nowMs - lastMs < MIN_WRITE_INTERVAL_MS) {
      return null; // throttle: nada novo e o último write foi agora há pouco
    }
  }

  const record = {
    ...(previous ?? {}),
    kind: previous?.kind ?? kind,
    machineTag: previous?.machineTag ?? tag,
    sessionId,
    startedAt: previous?.startedAt ?? nowIso,
    lastHeartbeat: nowIso,
    claimed_issues: previous?.claimed_issues ?? [],
    touched_paths: collapsePaths([...prevTouched, ...newPaths]),
    // `git commit` zera o não-commitado; qualquer outra coisa acumula.
    dirty_paths: verb === "commit" ? [] : collapsePaths([...prevDirty, ...newPaths]),
  };
  if (branch) record.branch = branch;
  if (verb) record.last_action = { verb, at: nowIso };
  if (previous?.pid === undefined && pid !== undefined) record.pid = pid;
  return record;
}

/**
 * Localiza o arquivo de registro DESTA sessão em `data/sessions/`, qualquer
 * que seja o kind. Uma sessão coordenadora (`overnight`/`develop`/`continuo`)
 * já tem registro próprio, escrito pela skill dela — o beacon deve ENRIQUECER
 * esse registro, nunca criar um `interactive-*` paralelo pro mesmo
 * `sessionId` (isso a faria aparecer duas vezes em `list-active` e contar
 * duplicado em todo consumidor).
 */
export function findExistingSessionFile(sessionsDir, sessionId, fs = { existsSync, readdirSync }) {
  try {
    if (!fs.existsSync(sessionsDir)) return null;
    const suffix = `-${sessionId}.json`;
    const match = fs
      .readdirSync(sessionsDir)
      .filter((n) => n.endsWith(suffix) && !n.startsWith(".") && !n.includes("-safeBackup-"))
      .sort();
    return match.length > 0 ? match[0] : null;
  } catch {
    return null;
  }
}

/** Write atômico (write-then-rename), mesmo padrão de `writeFileAtomic` — ver #6130 item 4. */
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

// #2019-style CLI guard — só roda o corpo quando este arquivo é o entrypoint
// (nunca ao ser importado por test/session-beacon-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      const sessionId = payload.session_id;
      if (!sessionId) return; // sem identidade não há beacon possível

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const cwdRoot = join(hookDir, "..", "..");
      const mainRoot = resolveMainRepoRootNoSpawn(cwdRoot) ?? cwdRoot;
      const sessionsDir = join(mainRoot, "data", "sessions");
      // `data/` é junction do OneDrive e NÃO existe num clone fresco nem num
      // worktree — sem ela não há registro compartilhado pra alimentar.
      if (!existsSync(join(mainRoot, "data"))) return;

      const tag = machineTag();
      const existing = findExistingSessionFile(sessionsDir, sessionId);
      const path = existing
        ? join(sessionsDir, existing)
        : join(sessionsDir, `${BEACON_KIND}-${tag}-${sessionId}.json`);

      let previous = null;
      try {
        if (existsSync(path)) previous = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        previous = null; // ilegível/parcial — trata como novo, nunca lança
      }

      const record = buildBeaconRecord(previous, {
        kind: BEACON_KIND,
        machineTag: tag,
        sessionId,
        branch: readCurrentBranch(cwdRoot),
        newPaths: extractTouchedPaths(payload.tool_name, payload.tool_input, cwdRoot),
        verb: sniffVerb(payload.tool_input?.command),
        nowIso: new Date().toISOString(),
        // process.ppid é o PID da sessão Claude Code corrente (o harness
        // spawna o hook como filho direto dela) — mesmo racional do #6160.
        pid: process.ppid,
      });
      if (record) writeJsonAtomic(path, record);
      // Nunca emitir saída: este hook não altera nem bloqueia a chamada.
    } catch {
      // Fail-open total — ver "CUSTO E FAIL-OPEN" no topo.
    }
  });
}
