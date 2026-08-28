// PreToolUse hook — recusa `git checkout -b`/`git switch -c` (criação de
// branch) quando a chamada roda no checkout PRINCIPAL compartilhado (não um
// worktree de subagente) E existe uma rodada coordenadora
// overnight/develop/continuo ATIVA cujo `session_id` não é o desta chamada
// (#6509).
//
// Incidente de origem: achado ao vivo na rodada `/diaria-overnight 260828b`
// (corpo completo em #6481, item 3) — o checkout PRINCIPAL compartilhado foi
// encontrado num branch de feature (`overnight/fix-6443-claim-staleness`) em
// vez de `master`, sem stash e sem perda de trabalho, mas a troca em si já é
// o tipo de corrupção de estado compartilhado que
// `context/overnight-dispatch-rules.md` item 3 documenta como risco
// ("worktree é SEMPRE do subagente implementador — a coordenadora roda no
// checkout principal"). Mesma classe do guard já existente pra `gh pr merge`
// (`block-gh-pr-merge-subagent.mjs`, #5716), mas para branch-switch em vez de
// merge — e deliberadamente MAIS SIMPLES: sem merge lock, sem concessão de
// janela, sem distinção de causa. O trade-off aceito para este guard é
// **fail-open na dúvida** (oposto do guard de merge, que fail-closed quando a
// varredura de sessões é degradada) — o custo de um falso negativo aqui é
// bem menor que o de `gh pr merge` (um `git checkout -b` indevido é
// recuperável com `git checkout master` na sequência; um merge indevido já
// entrou em master).
//
// Discriminador (mesmo de `block-gh-pr-merge-subagent.mjs`, #5716): bloqueia
// quando existe ≥1 sessão coordenadora ativa registrada
// (`data/sessions/*.json`, kind overnight/develop/continuo) E o
// `session_id` da chamada atual não está entre elas. Nenhuma rodada
// coordenadora ativa → nunca bloqueia (sessão interativa comum, #5251). A
// PRÓPRIA coordenadora rodando `git checkout -b`/`git switch -c` no checkout
// principal (ex: para inspecionar um branch antes de dispatchar um
// subagente) não é bloqueada — o guard existe para impedir SUBAGENTES
// implementadores (ou outra sessão não-relacionada) de trocar de branch no
// diretório compartilhado, não para proibir a coordenadora de tudo.
//
// Como detecta "checkout PRINCIPAL vs worktree": mesmo mecanismo já usado
// por `session-beacon.mjs` (`isLinkedWorktree`) — deriva a raiz do checkout
// a partir de ONDE ESTE ARQUIVO DE HOOK MORA (`import.meta.url`), não do
// `cwd` do payload. Cada worktree de subagente (`isolation: "worktree"`) tem
// sua PRÓPRIA cópia deste arquivo sob `<worktree>/.claude/hooks/`, então o
// hook que roda para um subagente sempre resolve a raiz PARA O PRÓPRIO
// worktree — nunca precisa comparar `cwd` contra `.claude/worktrees/`
// textualmente. `.git` é DIRETÓRIO no checkout principal; é um ARQUIVO
// (`gitdir: ...`) num worktree vinculado. Evita spawnar `git
// rev-parse` a cada chamada de `Bash` (mesmo racional de performance do
// `session-beacon.mjs`).
//
// `data/sessions/` mora sob o checkout PRINCIPAL (junction OneDrive) — como
// só prosseguimos além do `isLinkedWorktree` check quando o checkout É o
// principal, a raiz resolvida (`checkoutRoot`) já é a raiz certa para achar
// `data/sessions/`, sem precisar de `git rev-parse --git-common-dir` (que
// `block-gh-pr-merge-subagent.mjs` precisa, porque aquele hook roda de
// QUALQUER worktree e sempre precisa achar o principal indiretamente).
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos: um import estático de `.ts` quebra o hook inteiro,
// silenciosamente, num Node sem type-stripping nativo. A leitura de
// `data/sessions/*.json` e a detecção de worktree são DUPLICADAS (não
// importadas) de `session-registry.ts`/`session-beacon.mjs` —
// versões mínimas, só o necessário para este guard.
//
// Escopo explicitamente FORA (#6509):
//   - `git checkout <branch-existente>` sem `-b` — cenário distinto, blast
//     radius maior (bloquear TODO checkout no diretório principal), não
//     coberto aqui.
//   - Coordenação cross-máquina via OneDrive duas máquinas fazendo isso ao
//     mesmo tempo — mesma limitação advisory já documentada em
//     `session-registry.ts` (#6182) para o merge lock; este guard só
//     protege contra sessões da MESMA máquina (filtra `record.machineTag`),
//     porque `git checkout` só afeta o filesystem local.
//
// Schema do hook `PreToolUse`: mesmo contrato dos hooks irmãos — JSON no
// stdin com `session_id`/`tool_name`/`tool_input`, saída
// `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision:
// "deny", permissionDecisionReason: "..." } }` em stdout com exit 0 para
// bloquear; nenhuma saída para permitir (equivalente a "defer").

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

/** Duplicado de `MAX_SESSION_AGE_MS` em `block-gh-pr-merge-subagent.mjs`/
 * `session-registry.ts` — uma rodada abandonada/crashada não deve manter
 * este guard armado para sempre. */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Duplicado de `SOFT_STALE_MS` — 90 min sem heartbeat = sessão coordenadora
 * morta para efeito deste guard, mesmo dentro da janela de 24h. */
export const SOFT_STALE_MS = 90 * 60 * 1000;

/** Mesmo conjunto de `COORDINATOR_KINDS` dos hooks irmãos — sessões
 * `interactive` (beacon) nunca contam como coordenadora aqui. */
export const COORDINATOR_KINDS = new Set(["overnight", "develop", "continuo"]);

/**
 * Mensagem mostrada quando o `git checkout -b`/`git switch -c` é negado.
 */
export const BLOCK_REASON =
  "git checkout -b/git switch -c bloqueado no checkout PRINCIPAL compartilhado pelo guard mecânico do " +
  "overnight/develop (#6509): há uma rodada /diaria-overnight, /diaria-develop ou /diaria-continuo ativa " +
  "nesta máquina (data/sessions/*.json) e esta chamada não pertence à sessão coordenadora registrada. " +
  "context/overnight-dispatch-rules.md item 3: worktree é SEMPRE do subagente implementador — a " +
  "coordenadora roda no checkout principal, mas troca de branch nele é reservada à própria coordenadora, " +
  "nunca a um subagente. Se você é o subagente implementador: seu trabalho deve rodar dentro do PRÓPRIO " +
  "worktree (isolation: \"worktree\"), não no checkout principal — confira se o dispatch te deu um path sob " +
  ".claude/worktrees/ e rode o git checkout -b ali. Se você é a coordenadora e está vendo este bloqueio por " +
  "engano (ex: seu próprio registro expirou por staleness), rode `npx tsx scripts/lib/session-registry.ts " +
  "register --kind {overnight|develop|continuo}` (o SEU kind) para renovar o registro que já era seu, e " +
  "tente de novo.";

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles — inclusive newlines. Duplicado de
 * `block-gh-pr-merge-subagent.mjs` (`stripQuotedSpans`), mesma razão
 * self-contained.
 */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

const SEPARATOR_RE = /(?:&&|;|\|\||\||\n)/;

/**
 * `true` se `command` contém `git checkout -b <nome>` OU `git switch
 * -c|--create <nome>` como um comando REAL (segmento entre separadores de
 * comando `&&`/`;`/`|`/`\n`), depois de remover o conteúdo de qualquer aspas
 * (mesma proteção de `isGhPrMergeCommand` contra citação dentro de um
 * `--body`/string — #5787 Defeito 3/#5805).
 *
 * Detecção por TOKEN (não regex gulosa sobre a string inteira) — divide cada
 * segmento em tokens por espaço e procura `-b`/`-c`/`--create` como token
 * exato depois de `git checkout`/`git switch`, nunca como substring de outra
 * flag (`--builder` não casa).
 */
export function isBranchCreateCheckoutCommand(command) {
  if (typeof command !== "string") return false;
  const stripped = stripQuotedSpans(command);
  for (const rawSegment of stripped.split(SEPARATOR_RE)) {
    const tokens = rawSegment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;
    if (tokens[0] !== "git") continue;
    const sub = tokens[1];
    const rest = tokens.slice(2);
    if (sub === "checkout" && rest.includes("-b")) return true;
    if (sub === "switch" && (rest.includes("-c") || rest.includes("--create"))) return true;
  }
  return false;
}

/** `statSync(...).isDirectory()` que nunca lança. Duplicado de
 * `session-beacon.mjs`. */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `true` quando `startDir` é um worktree VINCULADO (`.git` é ARQUIVO com
 * `gitdir:`), `false` quando é o checkout principal (`.git` é DIRETÓRIO) ou
 * quando não dá para determinar. Duplicado de `session-beacon.mjs`
 * (`isLinkedWorktree`) — mesmo racional/fail-direction documentado lá:
 * errar para "não é worktree" (`false`) na dúvida é o lado seguro AQUI
 * também, porque este guard só age quando `false` (checkout principal) —
 * uma leitura ambígua nunca aciona o bloqueio sozinha.
 */
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

/** Duplicado de `machineTag()` — mesma razão self-contained dos hooks irmãos. */
export function machineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Varredura de `data/sessions/*.json` — devolve o `Set` de `sessionId` de
 * sessões COORDENADORAS ativas (kind overnight/develop/continuo, mesma
 * máquina, heartbeat dentro de `SOFT_STALE_MS`/`MAX_SESSION_AGE_MS`).
 *
 * Deliberadamente FAIL-OPEN em toda falha (diretório ausente, erro de
 * leitura do diretório, entrada individual corrompida) — devolve `Set`
 * vazio, nunca lança. Diferente da varredura irmã em
 * `block-gh-pr-merge-subagent.mjs` (que sinaliza `degraded` e o guard de
 * merge FAIL-CLOSED sobre isso): aqui o custo de um falso negativo
 * (permitir um `git checkout -b` que devia ser bloqueado) é bem menor que o
 * custo de travar QUALQUER `git checkout -b` legítimo por um soluço de I/O
 * transitório do OneDrive — trade-off documentado explicitamente na issue
 * de origem (#6509).
 */
export function readActiveCoordinatorSessionIds(repoRoot, now = Date.now()) {
  const ids = new Set();
  const dir = sessionsDir(repoRoot);
  let entries;
  try {
    if (!existsSync(dir)) return ids;
    entries = readdirSync(dir);
  } catch {
    return ids;
  }
  const myTag = machineTag();
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".") || name.includes("-safeBackup-")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!record || typeof record !== "object") continue;
      if (!COORDINATOR_KINDS.has(record.kind)) continue;
      if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
      // data/sessions/ é compartilhado via OneDrive entre máquinas — uma
      // coordenadora de OUTRA máquina não pode ter causado um `git checkout`
      // neste checkout local (#6509 escopo FORA — cross-máquina).
      if (typeof record.machineTag !== "string" || record.machineTag !== myTag) continue;
      const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
      const heartbeatMs = Date.parse(heartbeatIso ?? "");
      if (!Number.isFinite(heartbeatMs)) continue;
      const ageMs = now - heartbeatMs;
      if (ageMs < 0 || ageMs > MAX_SESSION_AGE_MS) continue;
      if (ageMs > SOFT_STALE_MS) continue;
      ids.add(record.sessionId);
    } catch {
      // Entrada corrompida — ignora só ela, segue as demais. Fail-open.
    }
  }
  return ids;
}

/**
 * Função pura — decide se um `git checkout -b`/`git switch -c` no checkout
 * principal deve ser bloqueado, dado o conjunto de `sessionId`s de
 * coordenadoras ativas já lido e o `session_id` da chamada ATUAL.
 *
 * Bloqueia quando: existe ≥1 rodada coordenadora ativa registrada E o
 * `session_id` da chamada não é o de nenhuma delas. `session_id` ausente do
 * payload → fail-open (`false`), sempre — não dá para comparar contra nada.
 */
export function shouldBlockBranchCheckout(activeCoordinatorSessionIds, callerSessionId) {
  if (typeof callerSessionId !== "string" || callerSessionId === "") return false;
  const coordinators = activeCoordinatorSessionIds ?? new Set();
  if (coordinators.size === 0) return false;
  return !coordinators.has(callerSessionId);
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/block-branch-checkout-main-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (!isBranchCreateCheckoutCommand(command)) return;

      const hookDir = dirname(fileURLToPath(import.meta.url));
      const checkoutRoot = join(hookDir, "..", "..");
      if (isLinkedWorktree(checkoutRoot)) return; // worktree de subagente: nunca bloqueia

      const coordinators = readActiveCoordinatorSessionIds(checkoutRoot);
      if (shouldBlockBranchCheckout(coordinators, payload.session_id)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: BLOCK_REASON,
            },
          }),
        );
      }
      // Sem bloqueio: não emitir nada — cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `git checkout`
      // legítimo de uma sessão coordenadora ou interativa comum.
    }
  });
}
