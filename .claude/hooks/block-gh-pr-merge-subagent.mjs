// PreToolUse hook — bloqueia `gh pr merge` quando a chamada vem de um
// SUBAGENTE implementador de `/diaria-overnight`/`/diaria-develop`/
// `/diaria-continuo`, nunca do coordenador top-level dessas rodadas (#5716).
//
// Incidente de origem (2ª ocorrência — a 1ª foi #4740, incidente 260806b):
// sessão `/diaria-develop 260819d`, PR #5713. O subagente implementador leu
// a Regra 11 de `context/overnight-dispatch-rules.md` ("nenhum subagente
// implementador espera CI, roda fleet review, ou chama `gh pr merge` por
// conta própria — isso é trabalho do coordenador top-level"), e a violou
// mesmo assim: mergeou o próprio PR enquanto um fixer despachado pelo
// coordenador ainda escrevia o teste de regressão que fechava o último
// achado do fleet review. O fix entrou em master sem cobertura. A regra
// existia só como prosa — nenhum hook impedia a chamada. Este hook fecha essa
// lacuna mecanicamente.
//
// Mecanismo: `scripts/lib/session-registry.ts` (write-side usado pelas 3
// skills via `register --kind overnight|develop|continuo`) grava um arquivo
// por sessão COORDENADORA ativa em `data/sessions/{kind}-{tag}-{sessionId}.json`.
// Subagentes implementadores despachados via `Agent` NUNCA chamam esse
// `register` (não são as skills `/diaria-overnight`/`/diaria-develop`/
// `/diaria-continuo` — são subagentes ad-hoc lendo um prompt de dispatch) e
// rodam com `session_id` PRÓPRIO, diferente do coordenador que os despachou
// (mesmo fato que `block-askuserquestion-overnight-autonomous.mjs` e
// `pr-create-review.mjs` já assumem ao comparar `payload.session_id` contra
// o `session_id` gravado por quem escreveu o marker/registro).
//
// Esse fato dá o discriminador: se existe pelo menos uma rodada
// overnight/develop/continuo ATIVA registrada (`data/sessions/*.json`) e o
// `session_id` da chamada ATUAL não é o de NENHUMA dessas sessões
// registradas, a chamada não pode ser do coordenador dessa(s) rodada(s) — só
// pode ser um subagente despachado por ela (ou, no pior caso, outra sessão
// interativa não-relacionada rodando em paralelo na mesma máquina, ver
// "Trade-off aceito" abaixo). Bloqueia.
//
// Nenhuma rodada ativa registrada → nunca bloqueia: é o caminho de uma sessão
// interativa comum, que o #5251 já autoriza a mergear sozinha sem confirmação
// (`gh pr merge` de sessão interativa nunca passa por `register`).
//
// `session_id` da chamada ATUAL bate com algum registro ativo → é o próprio
// coordenador mergeando (ex: overnight/develop encerrando um ciclo depois do
// Gate 2) → permite.
//
// Trade-off aceito (documentado, não escondido): este guard não distingue
// "subagente desta rodada" de "outra sessão interativa não-relacionada rodando
// em paralelo na mesma máquina enquanto uma rodada overnight/develop está
// ativa" — ambas têm `session_id` ausente do registro. Diferente dos hooks
// irmãos (que preferem fail-open sempre — permitir na dúvida), este guard
// prefere bloquear na dúvida: o custo de um falso positivo aqui é a PR ficar
// aberta esperando um merge manual (retomável, sem dano); o custo de um falso
// negativo é exatamente o incidente que gerou a #5716 (merge sem review do
// coordenador, dano real e mensurável). Ver item 2 da issue #5716 ("expor
// subagente ainda vivo") — não implementado aqui, seria mitigação
// complementar, não substituto deste guard.
//
// Fail-open só nos casos onde não dá pra avaliar o risco de forma alguma:
// `session_id` da chamada ausente do payload (não dá pra comparar contra
// nada — bloquear aqui seria travar QUALQUER Bash sem session_id, inclusive
// de sessões legítimas), leitura de `data/sessions/` falhando (diretório
// ausente, erro de I/O, JSON malformado — cai em "nenhuma rodada ativa
// detectada", que já é fail-open por construção), ou qualquer exceção neste
// hook.
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada
// em `pr-create-review.mjs` — um import estático de `.ts` quebra o hook
// inteiro, silenciosamente, num Node sem type-stripping nativo. A leitura de
// `data/sessions/*.json` é DUPLICADA (não importada) de
// `scripts/lib/session-registry.ts` (`listActiveSessions`) — versão mínima,
// só o necessário pra este guard (ignora `stale`/heartbeat soft-threshold,
// campos de fase, merge lock; usa só `kind`+`sessionId`+idade absoluta).
//
// Schema do hook `PreToolUse`: mesmo contrato dos hooks irmãos — JSON no
// stdin com `session_id`/`tool_name`/`tool_input`, saída
// `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision:
// "deny", permissionDecisionReason: "..." } }` em stdout com exit 0 pra
// bloquear; nenhuma saída pra permitir (equivalente a "defer").

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

// Mesmo valor usado em `session-registry.ts`/`pr-create-review.mjs`/
// `block-askuserquestion-overnight-autonomous.mjs` — uma rodada
// abandonada/crashada não deve manter este guard armado pra sempre.
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

// #5787 Defeito 1: janela de liveness PRÁTICA (não só a janela absoluta de
// 24h). Uma sessão coordenadora VIVA bata heartbeat de minutos em minutos —
// 90 min de silêncio já é morte para efeito deste guard. O custo de errar
// pra permissivo aqui é limitado: sessão sem heartbeat há 90 min não tem
// subagente ativo pra proteger.
const SOFT_STALE_MS = 90 * 60 * 1000;

// #6168: o kind `interactive` (escrito automaticamente pelo beacon,
// `.claude/hooks/session-beacon.mjs`) NÃO entra aqui, e isso é uma decisão,
// não um esquecimento — uma sessão interativa não despacha subagente
// implementador nem decide quando entra merge, então promovê-la a
// coordenadora por relabel furaria exatamente o que este guard protege.
// O caminho legítimo dela pro merge é a concessão de janela (#6296, ver
// `readLiveMergeGrantFor` abaixo). `test/session-beacon-blast-radius.test.ts`
// trava que este conjunto continua com 3 kinds.
export const COORDINATOR_KINDS = new Set(["overnight", "develop", "continuo"]);

/** TTL da concessão de janela (#6296) — duplicado de `MERGE_GRANT_TTL_MS` em
 * session-registry.ts, porque este hook é self-contained (sem import de `.ts`). */
const MERGE_GRANT_TTL_MS = 10 * 60 * 1000;

/** TTL do merge lock (#5156 item 4) — duplicado de `MERGE_LOCK_TTL_MS`. */
const MERGE_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Lê `data/sessions/.merge-lock.json` e devolve quem o segura AGORA (#6296
 * defeito 1).
 *
 * Três retornos distintos, e a distinção é o miolo da correção:
 *   - `string`      — `sessionId` que segura o lock, dentro do TTL;
 *   - `null`        — o arquivo NÃO existe: ninguém segura (estado conhecido);
 *   - `undefined`   — não deu pra determinar (erro de I/O, JSON corrompido,
 *                     `data/` ausente). **Nunca** é tratado como `null`.
 *
 * Por que a distinção importa: o critério de aceite da #6296 diz
 * "coordenadora sem lock não mergeia", mas ler isso literalmente sobre um
 * estado INDETERMINADO transformaria uma falha transitória do OneDrive
 * (EBUSY/EPERM, que `session-registry.ts` já documenta como realista aqui) em
 * bloqueio de merge legítimo. Estado desconhecido nunca bloqueia; estado
 * conhecido, sim.
 */
export function readMergeLockHolder(repoRoot, now = Date.now()) {
  const path = join(sessionsDir(repoRoot), ".merge-lock.json");
  try {
    if (!existsSync(path)) return null;
  } catch {
    return undefined;
  }
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!record || typeof record.heldBy !== "string" || record.heldBy === "") return undefined;
    const acquiredMs = Date.parse(record.acquiredAt);
    if (!Number.isFinite(acquiredMs)) return undefined;
    const ageMs = now - acquiredMs;
    // Expirado (TTL) = ninguém segura de fato; `session-registry.ts` já trata
    // lock além do TTL como abandonado e roubável.
    if (ageMs > MERGE_LOCK_TTL_MS) return null;
    return record.heldBy;
  } catch {
    return undefined;
  }
}

/**
 * Procura, entre as sessões COORDENADORAS ativas desta máquina, uma concessão
 * de janela de merge viva emitida para `sessionId` (#6296).
 *
 * Duplicado (não importado) de `findLiveMergeGrant`/`isMergeGrantLive` de
 * `scripts/lib/session-registry.ts` — mesma razão self-contained do resto
 * deste arquivo. As duas cópias são travadas por teste.
 *
 * Invariantes que NÃO podem afrouxar aqui:
 *   - só coordenadora concede (`COORDINATOR_KINDS`);
 *   - `grantedTo === grantedBy` nunca vale, mesmo gravado à mão — auto-
 *     concessão é justamente o contorno que esta feature existe pra não abrir;
 *   - concessão consumida (`consumedAt`) não vale: uso único;
 *   - fora do TTL não vale.
 */
export function readLiveMergeGrantFor(repoRoot, sessionId, now = Date.now()) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const dir = sessionsDir(repoRoot);
  let entries;
  try {
    if (!existsSync(dir)) return null;
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".") || name.includes("-safeBackup-")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!record || !COORDINATOR_KINDS.has(record.kind)) continue;
      const grant = record.merge_grant;
      if (!grant || grant.grantedTo !== sessionId) continue;
      if (grant.consumedAt) continue;
      if (grant.grantedTo === grant.grantedBy) continue;
      const grantedMs = Date.parse(grant.grantedAt);
      if (!Number.isFinite(grantedMs)) continue;
      const ageMs = now - grantedMs;
      if (ageMs < 0 || ageMs > MERGE_GRANT_TTL_MS) continue;
      return grant;
    } catch {
      // Entrada corrompida — ignora só ela, segue as demais.
    }
  }
  return null;
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repo — nunca a raiz de um worktree
 * vinculado. Mesmo racional/implementação dos hooks irmãos: `data/sessions/`
 * mora na junction compartilhada, só visível a partir da raiz principal.
 */
export function resolveMainRepoRoot(execFn = execFileSync) {
  try {
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return dirname(resolvePath(gitDir));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

export function sessionsDir(repoRoot) {
  return join(repoRoot, "data", "sessions");
}

/**
 * Lê `data/sessions/*.json` e retorna os `sessionId` de sessões COORDENADORAS
 * (`kind` em overnight/develop/continuo) que são:
 *   (a) de MESMA MÁQUINA que o hook roda (`record.machineTag` bate com o
 *       hostname atual — #5787 Defeito 2: `data/sessions/` é compartilhado
 *       entre máquinas via OneDrive, e um coordenador em outra máquina não
 *       pode despachar subagente deste checkout);
 *   (b) com heartbeat recente (`now - lastHeartbeat ≤ SOFT_STALE_MS`, 90 min —
 *       #5787 Defeito 1: janela de liveness prática, não só o teto absoluto
 *       de 24h. Uma sessão que morreu sem chamar `end` não armava o guard
 *       por 24h inteiro).
 *
 * Fail-soft em qualquer ponto: diretório ausente, erro de leitura, JSON
 * malformado, ou entrada sem os campos esperados são simplesmente ignorados —
 * nunca lança.
 */
export function readActiveCoordinatorSessionIds(repoRoot, now = Date.now()) {
  const dir = sessionsDir(repoRoot);
  const ids = new Set();
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
      // #5787 Defeito 2: ignora sessões de outras máquinas — `data/sessions/`
      // é compartilhado via OneDrive, e um coordenador em outra máquina não
      // pode despachar subagente deste checkout.
      if (typeof record.machineTag !== "string" || record.machineTag !== myTag) continue;
      const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
      const heartbeatMs = Date.parse(heartbeatIso ?? "");
      if (!Number.isFinite(heartbeatMs)) continue;
      const ageMs = now - heartbeatMs;
      if (ageMs < 0 || ageMs > MAX_SESSION_AGE_MS) continue;
      // #5787 Defeito 1: janela de liveness prática (90 min). Uma sessão que
      // não bateu heartbeat há mais de SOFT_STALE_MS está morta para efeito
      // deste guard — não tem subagente ativo pra proteger.
      if (ageMs > SOFT_STALE_MS) continue;
      ids.add(record.sessionId);
    } catch {
      // Entrada individual corrompida/ilegível — ignora só ela, segue as demais.
    }
  }
  return ids;
}

/** Resolve a tag de máquina atual — mesma função usada em `session-registry.ts`
 * (`machineTag()`), duplicada aqui porque o hook é self-contained (sem import
 * de `.ts`). #5787 Defeito 2: preciso comparar `record.machineTag` contra a
 * máquina onde o hook roda, já que `data/sessions/` é compartilhado via
 * OneDrive entre helios/Neo.
 */
export function machineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles — inclusive newlines. Usado para que `gh pr merge`
 * aparecendo dentro de uma string entre aspas (single-line OU multi-line,
 * ex: um `--body "...\ngh pr merge...\n..."`) nunca seja visto pelo matcher
 * de separadores de comando (#5805 — ver docstring de `isGhPrMergeCommand`).
 *
 * Aspas simples: sem escape interno (semântica de shell — `\` dentro de
 * `'...'` é literal). Aspas duplas: `\"` escapada não fecha o span. Aspa não
 * fechada até o fim da string: tudo dali em diante é tratado como dentro do
 * span (mesmo trade-off de "comando malformado degrada pra fail-closed
 * nessa cauda" já aceito pelo restante do guard — ver topo do arquivo).
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

/** `true` se `command` contém `gh pr merge` como um comando REAL — só no
 * início da string ou depois de separador de comando (`&&`/`;`/`|`/`||`/
 * newline).
 *
 * #5787 Defeito 3: o regex antigo `/\\bgh\\s+pr\\s+merge\\b/` rodava sobre a
 * string inteira e casava com a CITAÇÃO da mensagem de erro dentro do corpo
 * de uma issue — qualquer comando que MENCIONASSE a expressão era negado.
 * O fix casou só no início do comando ou depois de um separador, quando é de
 * fato um comando que o shell executaria.
 *
 * #5805: o conjunto de separadores declarado no comentário ("&& ; | ||
 * newline") nunca incluiu newline no regex — `^` sem a flag `m` ancora só no
 * início da STRING inteira, não de cada linha, então um comando Bash
 * multi-linha cuja 1ª linha não é `gh pr merge` mas contém a chamada numa
 * linha posterior (ex: heredoc, `cmd1\ncmd2`) passava direto pelo guard.
 * Adicionar `\n` à alternação de separadores sozinho reabriria o Defeito 3
 * em variante multi-linha: um `--body` com newline LITERAL dentro das aspas
 * (`--body "linha1\ngh pr merge citado\nlinha3"`) teria a citação vista como
 * comando real, porque o regex não entende quoting.
 *
 * Por isso o matcher roda sobre `stripQuotedSpans(command)`, não sobre
 * `command` bruto: todo conteúdo entre aspas (single-line OU multi-line) é
 * removido antes do regex de separadores rodar, então `gh pr merge` citado
 * dentro de um `--body`/`--title`/string nunca é visto como comando real —
 * independente de ter newline dentro das aspas ou não — e um `gh pr merge`
 * genuíno depois de um separador (incluindo `\n`) fora de qualquer aspas
 * continua detectado normalmente.
 */
export function isGhPrMergeCommand(command) {
  if (typeof command !== "string") return false;
  const stripped = stripQuotedSpans(command);
  return /^\s*gh\s+pr\s+merge\b|(?:&&|;|\|\||\||\n)\s*gh\s+pr\s+merge\b/.test(stripped);
}

/**
 * Função pura — decide se um `gh pr merge` deve ser bloqueado, dado o
 * conjunto de `sessionId`s de coordenadores ativos já lido e o `session_id`
 * da chamada ATUAL. Sem I/O, 100% testável.
 *
 * Bloqueia quando: existe ≥1 rodada coordenadora ativa registrada E o
 * `session_id` da chamada não é o de nenhuma delas. Ver docblock do topo do
 * arquivo pro racional completo (inclui o trade-off aceito de bloquear, não
 * permitir, na ambiguidade — direção oposta da maioria dos hooks irmãos, de
 * propósito, porque aqui o custo de um falso negativo é maior que o de um
 * falso positivo).
 */
export function shouldBlockGhPrMerge(activeCoordinatorSessionIds, callerSessionId, ctx = {}) {
  if (!activeCoordinatorSessionIds || activeCoordinatorSessionIds.size === 0) return false;
  if (callerSessionId === undefined || callerSessionId === null || callerSessionId === "") return false;

  // #6296 — DEFEITO 2: a janela concedida por conversa ganha representação
  // mecânica. Medido ao vivo em 260826: o protocolo inteiro da Parte F do
  // #6168 rodou (peer achado, SendMessage entregue, colisão por arquivo
  // conferida nos 3 PRs dele, janela concedida, merge lock adquirido) e o
  // `gh pr merge` foi bloqueado assim mesmo, porque este guard só olhava
  // `session_id` contra o registro. A conversa chegou a acordo e não teve
  // efeito nenhum sobre o mecanismo.
  //
  // A concessão NÃO afrouxa o guard: continua sendo a COORDENADORA quem
  // decide que um merge entra (ela é a única que concede, e nunca a si
  // mesma), com TTL curto e uso único. O que muda é que a decisão dela agora
  // é legível por este hook em vez de existir só no transcript de duas
  // sessões.
  if (ctx.hasLiveGrant === true) return false;

  const isCoordinator = activeCoordinatorSessionIds.has(callerSessionId);
  if (!isCoordinator) return true; // comportamento pré-#6296, inalterado

  // #6296 — DEFEITO 1: dois mecanismos governavam a mesma ação sem se
  // compor. `grep -c 'mergeLock\|merge-lock\|\.merge-lock'` neste arquivo
  // devolvia 0: o guard nunca consultava o lock, então "quem tem direito de
  // mergear" e "a janela de merge está livre agora" eram perguntas
  // respondidas por mecanismos que não se falavam.
  //
  // Leitura deliberadamente mais ESTREITA que a letra do critério de aceite
  // ("coordenadora sem lock não mergeia"), e o motivo é a direção do
  // fail-safe:
  //   - lock seguro por OUTRA sessão   → bloqueia (é o dano real: dois
  //     merges concorrentes em master);
  //   - lock ausente E há OUTRA coordenadora ativa → bloqueia (há contenção
  //     de verdade; pegar o lock deixa de depender de a skill lembrar);
  //   - lock ausente E esta é a ÚNICA coordenadora → PERMITE. Não há com
  //     quem serializar, e bloquear aqui quebraria toda rodada solo — que é
  //     o caso comum — sem prevenir dano nenhum;
  //   - estado do lock INDETERMINADO (`undefined`: I/O do OneDrive,
  //     JSON corrompido) → PERMITE. Nunca transformar falha transitória de
  //     leitura em bloqueio de merge legítimo.
  const holder = ctx.mergeLockHolder;
  if (typeof holder === "string" && holder !== callerSessionId) return true;
  if (holder === null && activeCoordinatorSessionIds.size > 1) return true;
  return false;
}

/** Mensagem mostrada ao subagente quando a chamada é negada (#5716). */
export const BLOCK_REASON =
  "gh pr merge bloqueado pelo guard mecânico do overnight/develop (#5716): há uma rodada " +
  "/diaria-overnight, /diaria-develop ou /diaria-continuo ativa nesta máquina (data/sessions/*.json) " +
  "e esta chamada não pertence à sessão coordenadora registrada. Regra 11 de " +
  "context/overnight-dispatch-rules.md: nenhum subagente implementador espera CI, roda fleet review, " +
  "ou mergeia o próprio PR — isso é trabalho exclusivo do coordenador top-level, depois do fleet review " +
  "pré-merge e do Gate 2. Se você é o subagente implementador: pare aqui, faça o self-review (regra 7), " +
  "e retorne o número do PR + \"self-review: N findings\" ao coordenador — nunca chame gh pr merge você " +
  "mesmo. Se você é de fato o coordenador vendo este bloqueio por engano (ex: sessão registrada expirou " +
  "por staleness), rode `npx tsx scripts/lib/session-registry.ts register --kind {overnight|develop|continuo}` " +
  "pra renovar o registro e tente de novo.";

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/block-gh-pr-merge-subagent-hook.test.ts).
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
      if (!isGhPrMergeCommand(command)) return;
      const repoRoot = resolveMainRepoRoot();
      const activeIds = readActiveCoordinatorSessionIds(repoRoot);
      const ctx = {
        // #6296: os dois sinais que o guard passou a compor — a janela
        // concedida por uma coordenadora, e quem segura o merge lock agora.
        hasLiveGrant: readLiveMergeGrantFor(repoRoot, payload.session_id) !== null,
        mergeLockHolder: readMergeLockHolder(repoRoot),
      };
      if (shouldBlockGhPrMerge(activeIds, payload.session_id, ctx)) {
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
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr merge`
      // legítimo de uma sessão coordenadora ou interativa comum.
    }
  });
}
