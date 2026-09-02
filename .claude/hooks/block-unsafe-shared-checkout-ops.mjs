// PreToolUse hook — dois guards mecânicos distintos sobre `Bash`, empacotados
// juntos por decisão explícita de dispatch (#6982 + #6971, lote
// `guards-de-subagente`, 01/09/2026): "prefira UM hook coeso a dois hooks
// quase iguais, contanto que nenhuma das duas regras fique mais fraca".
// Nenhum dos dois guards compartilha lógica de detecção de comando — eles só
// compartilham arquivo/infra de teste. Ver o docblock de cada guard abaixo
// para a issue de origem e o raciocínio completo.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

// ---------------------------------------------------------------------------
// Utilitários compartilhados (parsing de comando) — duplicados de
// `block-branch-checkout-main.mjs` por decisão de "self-contained" já
// documentada nos hooks irmãos (nenhum import estático de `.ts`, quebra em
// Node sem type-stripping nativo).
// ---------------------------------------------------------------------------

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles. Duplicado de `block-branch-checkout-main.mjs`.
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

/** Divide `command` (já sem aspas) em segmentos de comando REAL, cada um
 * já tokenizado por espaço. */
function commandSegments(command) {
  if (typeof command !== "string") return [];
  const stripped = stripQuotedSpans(command);
  return stripped
    .split(SEPARATOR_RE)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

// ---------------------------------------------------------------------------
// Guard 1 — `taskkill /IM` (#6982)
//
// Incidente de origem: subagente da #6976 (01/09/2026) subiu um servidor
// HTTP local pra checagem visual e, ao limpar, rodou
// `taskkill /F /IM python.exe` — mata por NOME DE IMAGEM, não por PID: matou
// 9 processos `python.exe` alheios numa máquina compartilhada (o editor
// trabalha nela, há sessões paralelas do Claude Code e tarefas agendadas).
// A memória do projeto já documentava esse anti-padrão para `node.exe`
// (`context/overnight-dispatch-rules.md` item 12, #5432) — mas o subagente
// lidava com `python.exe` e não se reconheceu no padrão porque a prosa citava
// só o binário do incidente original, não a classe inteira. Subagente com
// `isolation: worktree` recebe o prompt da tarefa, não o inventário de
// memórias do editor — "o agente vai lembrar" é frágil por construção, a
// mesma conclusão que o #6864/#6941 já registraram para outras classes de
// instrução em prosa.
//
// Detecção: `taskkill` (comando real, primeiro token do segmento, aceita
// path completo tipo `C:\Windows\System32\taskkill.exe`) seguido de QUALQUER
// token que seja a flag `/IM`/`-IM`/`--IM`/`//IM` (case-insensitive, 1-2
// prefixos de `/` ou `-`, MSYS costuma duplicar a barra — ver o próprio
// incidente do #5432: `taskkill //F //IM node.exe //T`). `taskkill /PID N`
// (o uso CORRETO, mata por processo específico) nunca casa — não há token
// `/IM` na chamada.
export function isTaskkillByImageCommand(command) {
  for (const tokens of commandSegments(command)) {
    const cmdToken = tokens[0].toLowerCase();
    const isTaskkill = cmdToken === "taskkill" || /[\\/]taskkill(\.exe)?$/i.test(cmdToken);
    if (!isTaskkill) continue;
    const hasImFlag = tokens.slice(1).some((t) => /^[\/-]{1,2}im$/i.test(t));
    if (hasImFlag) return true;
  }
  return false;
}

export const TASKKILL_BLOCK_REASON =
  "taskkill /IM (mata por NOME DE IMAGEM) bloqueado pelo guard mecânico do overnight/develop (#6982): " +
  "isso encerra TODO processo com esse nome na máquina, incluindo os de outras sessões concorrentes " +
  "(overnight, develop, continuo, sessão interativa do editor, Studio server, tarefas agendadas) — nunca " +
  "só o seu. Guarde o PID do processo que VOCÊ mesmo iniciou (retorno de spawn/exec, ou `$!` no shell) e " +
  "mate só ele: `taskkill /F /PID {pid}` no Windows, `kill {pid}` no Unix. Nunca `/IM {nome}` (nem " +
  "variantes `-IM`/`--IM`/`//IM`) sem escopo ao PID/árvore do chamador. Ver " +
  "context/overnight-dispatch-rules.md item 12.";

// ---------------------------------------------------------------------------
// Guard 2 — `rm` em caminho dentro do checkout PRINCIPAL compartilhado,
// enquanto uma rodada coordenadora (overnight/develop/continuo) ativa não é
// a chamadora (#6971)
//
// Incidente de origem: frota de review da PR #6969 (01/09/2026) — um agente
// despachado com instrução EXPLÍCITA de somente-leitura ("No file edits, no
// git checkout/switch/stash/reset/add/commit") rodou
// `rm -f /home/vjpixel/diaria-studio/.pr6950-review.md` como "limpeza". O
// arquivo era UNTRACKED — nada em git pra restaurar; recuperado só por sorte
// (cópia solta em /tmp). A #6971 concluiu, na mesma linha do #6864/#6941,
// que "instrução em prosa não é guard" e pediu restringir MECANICAMENTE.
//
// ESCOPO HONESTO DESTE GUARD (documentado explicitamente porque é mais
// estreito que o pedido literal da issue — ver PR body do lote
// `guards-de-subagente` para a análise completa):
//
//   Direção (1) da issue ("restringir as ferramentas do agente de review, não
//   instruí-lo") NÃO é implementável a partir deste hook nem deste repo: o
//   agente `pr-review-toolkit:code-reviewer` (e os demais da frota —
//   `silent-failure-hunter`, `pr-test-analyzer`, `comment-analyzer`,
//   `type-design-analyzer`) é definido pelo PLUGIN do marketplace
//   (`pr-review-toolkit@claude-plugins-official`), fora deste repo — seu
//   `Tools:` declarado é "All tools" e não há parâmetro na ferramenta `Agent`
//   pra sobrescrever o toolset de um `subagent_type` já registrado no
//   dispatch. O tratamento que o #6941 aplicou ao lane GLM (`--tools`
//   explícito) só é possível ali porque aquele lane spawna o binário `claude`
//   diretamente via `dispatch-glm-lane-unit.sh` — um caminho de execução que
//   este repo controla; a frota de review roda pela ferramenta `Agent`
//   embutida, sem esse controle.
//
//   Direção (2) ("hook `PreToolUse` sobre `Bash` que recuse `rm` ... quando a
//   sessão é subagente de review") também não é implementável NA FORMA
//   LITERAL: o payload que este hook recebe (`session_id`, `tool_name`,
//   `tool_input`) não carrega nenhum campo que identifique "esta chamada
//   pertence a um subagente de REVIEW especificamente" — confirmado por
//   varredura dos hooks irmãos (nenhum consome `agent_type`/`subagent_type`
//   no payload de `Bash`; esse campo só aparece em prosa de playbook, nunca
//   no schema do hook). Subagentes despachados via `Agent` têm `session_id`
//   PRÓPRIO (fato já usado por `block-gh-pr-merge-subagent.mjs`), mas nada
//   marca QUAL subagente é "de review" vs. qualquer outro subagente ad-hoc.
//
//   O que ESTE guard cobre de fato: reusa o mesmo discriminador já
//   estabelecido em `block-branch-checkout-main.mjs` (#6509) — bloqueia `rm`
//   em caminho dentro do checkout PRINCIPAL (não um worktree vinculado)
//   quando existe ≥1 rodada coordenadora (overnight/develop/continuo) ATIVA
//   registrada em `data/sessions/*.json` e o `session_id` da chamada atual
//   não é o dela. Isso protege o subconjunto real do risco em que a frota de
//   review roda DENTRO de uma rodada `/diaria-overnight`/`/diaria-develop`/
//   `/diaria-continuo` já registrada (Fase 1.5, ou hook `pr-create-review.mjs`
//   disparado por um subagente implementador dessas rodadas) — mas NÃO cobre
//   uma frota de review dispatchada por uma sessão interativa comum sem
//   nenhuma rodada coordenadora registrada (o cenário mais provável do
//   incidente de origem da #6971, já que não há evidência de rodada ativa
//   nesse relato). Esse gap fica documentado aqui e no PR — entregar esta
//   cobertura parcial, honesta, é preferível a fingir que o hook resolve a
//   classe inteira quando não resolve (mesmo critério aplicado pela ressalva
//   da #6956 no mesmo lote).
//
//   Mitigação parcial para o gap acima: direção (3) da issue ("parar de usar
//   o checkout como área de rascunho entre sessões") — ver nota em
//   `context/overnight-dispatch-rules.md` adicionada no mesmo PR. Não impede
//   o `rm`, mas remove parte do alvo (rascunhos de PR/review passam a viver
//   fora da árvore por convenção) — foi exatamente o que salvou o incidente
//   original (cópia em `/tmp`).
//
//   #7055 (fail-closed, 02/09/2026): dentro do escopo que o guard JÁ cobre
//   (rodada coordenadora ativa registrada), havia um 2º gap — `session_id`
//   ausente/vazio na chamada saía por uma porta antecipada em
//   `shouldBlockSharedCheckoutRm` e LIBERAVA o `rm` mesmo com coordenadora
//   ativa e path dentro do checkout. Reincidência medida do MESMO incidente
//   1h após este guard estar mergeado — mesmos 3 arquivos apagados por um
//   agente de review dispatchado por uma sessão `/diaria-develop` já
//   registrada. `session_id` ausente agora é tratado como "não é a
//   coordenadora" (bloqueia), não mais como um passe livre — ver
//   `shouldBlockSharedCheckoutRm` abaixo.

export const RM_MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
export const RM_SOFT_STALE_MS = 90 * 60 * 1000;
export const RM_COORDINATOR_KINDS = new Set(["overnight", "develop", "continuo"]);

/**
 * `true` se `command` contém um `rm` real (segmento de comando, não citado
 * dentro de aspas) como primeiro token do segmento.
 */
export function isRmCommand(command) {
  return commandSegments(command).some((tokens) => {
    const cmdToken = tokens[0].toLowerCase();
    return cmdToken === "rm" || /[\\/]rm$/i.test(cmdToken);
  });
}

/**
 * Extrai os argumentos de PATH (tokens que não começam com `-`) de toda
 * invocação `rm` encontrada em `command`. Não resolve/normaliza — devolve os
 * tokens crus, na ordem em que aparecem.
 */
export function extractRmTargetPaths(command) {
  const paths = [];
  for (const tokens of commandSegments(command)) {
    const cmdToken = tokens[0].toLowerCase();
    const isRm = cmdToken === "rm" || /[\\/]rm$/i.test(cmdToken);
    if (!isRm) continue;
    for (const t of tokens.slice(1)) {
      if (t.startsWith("-")) continue; // flag: -f, -rf, --force, etc.
      paths.push(t);
    }
  }
  return paths;
}

/**
 * `true` quando `targetPath` (token cru de um argumento `rm`) resolve para
 * DENTRO de `checkoutRoot`. Caminho relativo é resolvido contra
 * `checkoutRoot` (mesma suposição de "cwd ≈ raiz do checkout" já feita pelos
 * hooks irmãos, que também não recebem `cwd` no payload). Nunca lança.
 */
export function isPathInsideCheckout(targetPath, checkoutRoot) {
  try {
    if (typeof targetPath !== "string" || targetPath === "") return false;
    const resolved = isAbsolute(targetPath) ? resolvePath(targetPath) : resolvePath(checkoutRoot, targetPath);
    const rootResolved = resolvePath(checkoutRoot);
    if (resolved === rootResolved) return true;
    return resolved.startsWith(rootResolved + sep);
  } catch {
    return false;
  }
}

/** `statSync(...).isDirectory()` que nunca lança. Duplicado dos hooks irmãos. */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Duplicado de `block-branch-checkout-main.mjs` (`isLinkedWorktree`). */
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

/** Duplicado de `machineTag()` dos hooks irmãos. */
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
 * máquina, heartbeat dentro de `RM_SOFT_STALE_MS`/`RM_MAX_SESSION_AGE_MS`).
 * Duplicado de `readActiveCoordinatorSessionIds` em
 * `block-branch-checkout-main.mjs` — fail-open em toda falha, mesma razão
 * documentada lá (custo de falso negativo aqui é bem menor que travar um
 * `rm` legítimo por soluço de I/O do OneDrive).
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
      if (!RM_COORDINATOR_KINDS.has(record.kind)) continue;
      if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
      if (typeof record.machineTag !== "string" || record.machineTag !== myTag) continue;
      const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
      const heartbeatMs = Date.parse(heartbeatIso ?? "");
      if (!Number.isFinite(heartbeatMs)) continue;
      const ageMs = now - heartbeatMs;
      if (ageMs < 0 || ageMs > RM_MAX_SESSION_AGE_MS) continue;
      if (ageMs > RM_SOFT_STALE_MS) continue;
      ids.add(record.sessionId);
    } catch {
      // Entrada corrompida — ignora só ela, segue as demais. Fail-open.
    }
  }
  return ids;
}

/**
 * Função pura — decide se um `rm` visando `targetPaths` deve ser bloqueado,
 * dado `checkoutRoot`, se ele É um worktree vinculado, o conjunto de
 * coordenadoras ativas já lido, e o `session_id` da chamada ATUAL.
 *
 * Bloqueia quando: (a) `checkoutRoot` é o checkout PRINCIPAL (não um
 * worktree — subagentes implementadores rodam em worktree próprio, nunca
 * bloqueado aqui); (b) existe ≥1 coordenadora ativa registrada; (c) ≥1
 * targetPath resolve para DENTRO do checkout; (d) o `session_id` da chamada
 * NÃO é o de nenhuma coordenadora — o que inclui `session_id`
 * ausente/vazio.
 *
 * **#7055 (fail-closed, corrige fail-open do #6971/#6982):** antes desta
 * mudança, `session_id` ausente/vazio saía por uma porta antecipada e
 * LIBERAVA o `rm` incondicionalmente — mesmo com coordenadora ativa e path
 * dentro do checkout. Um subagente dispatchado sem esse campo no payload (ou
 * herdando um valor vazio) caía nessa porta e o guard nunca chegava a
 * avaliar path/coordenadora. Reincidência medida do MESMO incidente que o
 * guard foi escrito pra impedir, 1h depois de mergeado (#7055): mesmos 3
 * arquivos apagados por um agente de review dispatchado por uma sessão
 * `/diaria-develop` já registrada. A ausência do discriminador agora é
 * tratada como "não é a coordenadora" — mesmo destino de um `session_id`
 * genuinamente diferente — em vez de um passe livre.
 */
export function shouldBlockSharedCheckoutRm({
  targetPaths,
  checkoutRoot,
  isWorktree,
  activeCoordinatorSessionIds,
  callerSessionId,
}) {
  if (isWorktree) return false; // worktree de subagente: rm no próprio worktree é normal
  const coordinators = activeCoordinatorSessionIds ?? new Set();
  if (coordinators.size === 0) return false; // sem rodada ativa: fora do escopo deste guard
  const paths = targetPaths ?? [];
  const targetsInsideCheckout = paths.some((p) => isPathInsideCheckout(p, checkoutRoot));
  if (!targetsInsideCheckout) return false;
  const isCoordinatorCall =
    typeof callerSessionId === "string" && callerSessionId !== "" && coordinators.has(callerSessionId);
  if (isCoordinatorCall) return false; // a própria coordenadora
  // session_id ausente/vazio OU diferente de toda coordenadora, com rodada
  // ativa e path dentro do checkout: bloquear (#7055 — antes era fail-open
  // no caso ausente/vazio).
  return true;
}

export const RM_BLOCK_REASON =
  "rm em caminho dentro do checkout PRINCIPAL compartilhado bloqueado pelo guard mecânico do " +
  "overnight/develop/continuo (#6971): há uma rodada ativa registrada nesta máquina " +
  "(data/sessions/*.json) e esta chamada não pertence à sessão coordenadora registrada — só um " +
  "subagente (implementador, review, ou qualquer outro dispatch ad-hoc) faria essa chamada nesse " +
  "estado. O checkout é compartilhado por várias sessões concorrentes; arquivo untracked apagado ali " +
  "não tem desfazer (não há `git checkout --` que salve). Se você é subagente implementador: seu " +
  "trabalho roda no PRÓPRIO worktree (isolation: \"worktree\"), rode o rm ali, não no checkout " +
  "principal. Se você é um agente de REVIEW: você não tem razão legítima pra apagar nada — se o " +
  "arquivo era um rascunho seu, deixe-o (a coordenadora decide o que fazer) ou escreva rascunhos fora " +
  "da árvore (/tmp, scratchpad) da próxima vez. Se você é a coordenadora vendo isto por engano, rode " +
  "`npx tsx scripts/lib/session-registry.ts register --kind {overnight|develop|continuo}` para renovar " +
  "seu próprio registro e tente de novo. Cobertura HONESTA deste guard: só protege enquanto uma rodada " +
  "coordenadora está registrada — uma frota de review dispatchada por sessão interativa comum, sem " +
  "rodada registrada, não é coberta por este hook (ver docblock do arquivo). Evite `rm` em caminho do " +
  "checkout compartilhado por padrão, coberto ou não.";

// ---------------------------------------------------------------------------
// Entry point CLI
// ---------------------------------------------------------------------------

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
      if (typeof command !== "string") return;

      // Guard 1: taskkill /IM — universal, independe de rodada ativa.
      if (isTaskkillByImageCommand(command)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: TASKKILL_BLOCK_REASON,
            },
          }),
        );
        return;
      }

      // Guard 2: rm no checkout principal compartilhado, sem ser a coordenadora.
      if (isRmCommand(command)) {
        const hookDir = dirname(fileURLToPath(import.meta.url));
        const checkoutRoot = join(hookDir, "..", "..");
        const worktree = isLinkedWorktree(checkoutRoot);
        const targetPaths = extractRmTargetPaths(command);
        const coordinators = worktree ? new Set() : readActiveCoordinatorSessionIds(checkoutRoot);
        if (
          shouldBlockSharedCheckoutRm({
            targetPaths,
            checkoutRoot,
            isWorktree: worktree,
            activeCoordinatorSessionIds: coordinators,
            callerSessionId: payload.session_id,
          })
        ) {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: RM_BLOCK_REASON,
              },
            }),
          );
          return;
        }
      }
      // Sem bloqueio: não emitir nada — cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
    }
  });
}
