// PreToolUse hook — bloqueia `AskUserQuestion` durante a Fase autônoma do
// `/diaria-overnight` (#4450).
//
// Incidente de origem: rodada 260801/02 — o coordenador (sessão top-level, não
// um subagente) disparou um `AskUserQuestion` com conteúdo literalmente
// placeholder (`question: "placeholder", header: "x", options: [a, b]`) no
// meio da Fase 1 (autônoma), violando a Regra 1 (HARD RULE) de
// `.claude/skills/diaria-overnight/SKILL.md` — "zero perguntas pós-briefing".
// Diferente do #3038 (decisão de raciocínio ruim, resolvida com reforço de
// texto na regra), este incidente não foi uma decisão: o conteúdo da pergunta
// não é produto de raciocínio identificável, é indistinguível de um
// rascunho/template de tool-call vazando como chamada real — reforçar o texto
// da regra (que já estava lá, explícito) não teria evitado isso. Precisa de
// um guard MECÂNICO que não dependa do coordenador "lembrar" da regra.
//
// Mecanismo: `scripts/overnight-session-marker.ts` grava
// `data/overnight/.active-session-{hostname}.json` com um campo `phase`
// (`"briefing"` | `"autonomous"`) — `"briefing"` no `--start` (Fase 0 passo 1),
// `"autonomous"` no `--phase autonomous` (Fase 0 passo 8, ao entrar na Fase 1).
// Este hook lê SÓ esse marker (nunca escreve) e nega qualquer `AskUserQuestion`
// enquanto `phase` for `"autonomous"` — cobre Fase 1, re-scans, mini-rodadas e
// Fase 1.5 igualmente, sem exigir que cada um desses pontos "lembre" de checar
// a regra.
//
// Escopo deliberadamente estreito: só olha o marker do OVERNIGHT
// (`data/overnight/.active-session-*.json`), nunca um marker genérico de
// "sessão automatizada". `/diaria-develop` nunca escreve esse marker (só o
// overnight grava/remove o seu — ver `.claude/skills/diaria-develop/SKILL.md`,
// "Exceção ao verbatim — fleet review pré-merge", que documenta essa mesma
// assimetria do lado do hook de review), então esta guard nunca dispara lá —
// perguntar no develop continua permitido e central por design.
//
// Fail-open por construção: marker ausente, `phase: "briefing"`, marker de
// OUTRA máquina/tag, marker stale (mais velho que `MAX_SESSION_AGE_MS`),
// `started_at` no futuro (clock skew/corrupção), JSON malformado, ou
// QUALQUER exceção neste hook → sempre permite a chamada. Nunca bloquear por
// engano fora da Fase autônoma do overnight — um falso positivo aqui travaria
// literalmente qualquer outra skill/sessão que use `AskUserQuestion`
// (`/diaria-develop`, gates do dia-a-dia, etc.).
//
// #5156: marker COM `session_id` só bloqueia quando a chamada ATUAL pertence
// à MESMA sessão que gravou o marker (`payload.session_id === marker.session_id`)
// — permite que outra sessão (ex: `/diaria-develop` rodando em paralelo na
// mesma máquina) nunca seja bloqueada por um overnight alheio em Fase
// autônoma. Marker SEM `session_id` (formato antigo) preserva o
// comportamento pré-#5156 (bloqueia por máquina, sem distinguir chamador) —
// ver `shouldBlockAskUserQuestion` pro racional completo.
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada em
// `.claude/hooks/pr-create-review.mjs` — um import estático de `.ts` executa
// antes de qualquer try/catch deste arquivo e pode derrubar o hook inteiro
// (silenciosamente, zero stdout) num Node sem type-stripping nativo. A lógica
// de path (`activeSessionPath`/`localMachineTag`/`resolveMainRepoRoot`) é
// DUPLICADA — não importada — do write-side em `scripts/overnight-session-marker.ts`
// e do read-side irmão em `pr-create-review.mjs`; os três têm teste próprio
// (`test/overnight-session-marker.test.ts`, `test/pr-create-review-hook.test.ts`,
// `test/block-askuserquestion-overnight-autonomous.test.ts`) — uma divergência
// acidental de path quebra pelo menos um dos três.
//
// Schema do hook `PreToolUse` (confirmado contra a doc oficial do harness,
// `docs.claude.com/en/docs/claude-code/hooks` → redireciona pra
// `code.claude.com/docs/en/hooks`, 260802, reconfirmado no #5156): input é
// JSON no stdin com `session_id`/`tool_name`/`tool_input`/`tool_use_id` (entre
// outros campos comuns); pra bloquear com uma razão visível
// ao modelo, a saída é `{ hookSpecificOutput: { hookEventName: "PreToolUse",
// permissionDecision: "deny", permissionDecisionReason: "..." } }` em stdout
// com exit 0 (o método "JSON output", que dá controle total — o método
// alternativo por exit code 2 + stderr também bloqueia, mas não é necessário
// aqui). Para permitir, basta não emitir esse payload (equivalente a
// `permissionDecision: "defer"` — cai no fluxo normal de permissão).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Mesmo valor de `pr-create-review.mjs` (`isOvernightRoundActive`) — uma
// rodada abandonada/crashada não deve deixar a Fase autônoma "ativa" pra
// sempre; 24h é confortavelmente acima da rodada mais longa observada (~16h).
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
export function localMachineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repo — nunca a raiz de um worktree
 * vinculado. Ver o comentário equivalente em `pr-create-review.mjs` pro
 * racional completo (`git rev-parse --git-common-dir` é compartilhado entre
 * todos os worktrees; derivar de `import.meta.url` resolveria pra dentro do
 * worktree, que não tem a junction `data/`).
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

export function activeSessionPath(repoRoot, tag) {
  return join(repoRoot, "data", "overnight", `.active-session-${tag}.json`);
}

/**
 * Lê o marker de sessão overnight desta máquina do disco. Retorna o objeto
 * parseado, ou `null` em QUALQUER falha (ausente, JSON malformado, I/O) — o
 * caller (`shouldBlockAskUserQuestion`) trata `null` como "sem marker",
 * sempre fail-open.
 */
export function readActiveMarker(repoRoot = resolveMainRepoRoot(), machineTag = localMachineTag()) {
  try {
    const markerPath = activeSessionPath(repoRoot, machineTag);
    if (!existsSync(markerPath)) return null;
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Função pura (#4450, session-aware desde #5156) — decide se um
 * `AskUserQuestion` deve ser bloqueado, dado o ESTADO já lido do marker
 * (objeto parseado, ou `null`/`undefined` se ausente/ilegível) e o
 * `session_id` da chamada ATUAL (`callerSessionId`, do payload do próprio
 * hook — sempre disponível, é campo padrão de todo `PreToolUse`). Sem I/O,
 * 100% testável com fixtures em memória — mesmo padrão de `shouldWakeCheck`
 * em `scripts/lib/overnight-fallback-wake.ts`.
 *
 * Bloqueia SÓ quando TODAS as condições valem simultaneamente:
 *   1. o marker existe;
 *   2. `marker.phase === "autonomous"` (nunca `"briefing"`, nunca um valor
 *      desconhecido/ausente — marker de rodada anterior ao #4450 não tem
 *      `phase` nenhum, e o fail-open aqui é deliberado: uma rodada pré-#4450
 *      em andamento não deve começar a bloquear no meio, sem aviso);
 *   3. `started_at` é uma data válida cuja idade cai dentro de
 *      `[0, MAX_SESSION_AGE_MS]` — mesmo guard de staleness/clock-skew de
 *      `isOvernightRoundActive` em `pr-create-review.mjs` (#3322): marker
 *      stale ou com timestamp no futuro nunca conta como "ativo";
 *   4. **(#5156) identidade de sessão**, com duas sub-regras:
 *      - `marker.session_id` AUSENTE (formato antigo, pré-#5156 — inclusive
 *        QUALQUER rodada overnight já em progresso no momento em que este
 *        campo foi introduzido) → **preserva o comportamento pré-#5156**:
 *        basta estar ativo nesta máquina, bloqueia independente de quem
 *        chama. Nunca quebrar uma rodada em voo mudando a regra debaixo dela.
 *      - `marker.session_id` PRESENTE → só bloqueia quando
 *        `callerSessionId === marker.session_id`, ou seja, quando a chamada
 *        pertence à PRÓPRIA sessão overnight autônoma que gravou o marker.
 *        Uma sessão `/diaria-develop` (ou qualquer outra) rodando em
 *        paralelo na MESMA máquina, com `session_id` diferente, nunca é
 *        bloqueada por um overnight alheio — é exatamente o cenário que a
 *        issue #5156 pede ("overnight autônomo ativo + chamada vinda de
 *        OUTRA sessão → permitido").
 *
 * Qualquer uma das condições falhando → `false` (permite a pergunta). Nunca lança.
 *
 * **#5161 fleet review item 5:** quando o marker TEM `session_id` mas o
 * `callerSessionId` da chamada atual está ausente (`undefined`/`null`) — o
 * docblock acima supõe que isso "nunca" acontece, sem garantia real disso —
 * a comparação `callerSessionId === marker.session_id` resolve pra `false`
 * (permite), que é a direção de fail-open PERIGOSA especificamente pra este
 * guard: permitir `AskUserQuestion` durante a Fase autônoma do overnight é
 * exatamente o cenário que trava a rodada (#4450). Mantemos o fail-open (não
 * dá pra confirmar com segurança que a chamada pertence à MESMA sessão sem o
 * dado), mas o estado degradado agora é LOGADO (stderr), não silencioso.
 */
export function shouldBlockAskUserQuestion(marker, now = Date.now(), callerSessionId = undefined) {
  if (!marker || marker.phase !== "autonomous") return false;
  const startedAtMs = Date.parse(marker.started_at);
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = now - startedAtMs;
  if (!(ageMs >= 0 && ageMs <= MAX_SESSION_AGE_MS)) return false;
  if (marker.session_id === undefined || marker.session_id === null) return true;
  if (callerSessionId === undefined || callerSessionId === null) {
    try {
      process.stderr.write(
        "block-askuserquestion-overnight-autonomous: aviso — marker overnight ativo tem session_id " +
          `("${marker.session_id}") mas o payload da chamada ATUAL não trouxe session_id; PERMITINDO ` +
          "o AskUserQuestion por fail-open (não dá pra confirmar se pertence à mesma sessão overnight " +
          "autônoma ou a outra sessão rodando em paralelo nesta máquina). Se isto se repetir, investigar " +
          "por que o harness não populou session_id neste PreToolUse (#5161 item 5).\n",
      );
    } catch {
      // Nunca deixar o log quebrar o fail-open — mesmo contrato do resto do hook.
    }
    return false;
  }
  return callerSessionId === marker.session_id;
}

/** Mensagem mostrada ao coordenador quando a chamada é negada (#4450). */
export const BLOCK_REASON =
  "AskUserQuestion bloqueado pelo guard mecânico do overnight (#4450): há uma rodada /diaria-overnight " +
  "ativa nesta máquina em Fase autônoma (data/overnight/.active-session-*.json com phase: \"autonomous\"). " +
  "Regra 1 (HARD RULE) de .claude/skills/diaria-overnight/SKILL.md proíbe QUALQUER AskUserQuestion depois " +
  "do briefing da Fase 0 — nenhuma exceção por fase (Fase 1, re-scans, mini-rodadas, Fase 1.5). " +
  "Issue ou finding ambíguo agora: marque status \"pulada\" e comente na issue explicando exatamente qual " +
  "decisão falta (vira pergunta do briefing da PRÓXIMA rodada) — nunca pergunte ao editor. Decisão reversível " +
  "de baixo blast radius (criar issue com prioridade justificada, escolher entre implementações tecnicamente " +
  "equivalentes): aja direto, a pergunta \"devo fazer X?\" já é a resposta \"sim\".";

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/block-askuserquestion-overnight-autonomous.test.ts).
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
      // Defensivo: o matcher em .claude/settings.json já restringe este hook
      // a `AskUserQuestion`, mas confirmar aqui custa nada e documenta a
      // invariante — nunca decide bloqueio pra outra tool por engano.
      if (payload.tool_name && payload.tool_name !== "AskUserQuestion") return;
      const marker = readActiveMarker();
      if (shouldBlockAskUserQuestion(marker, Date.now(), payload.session_id)) {
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
      // Sem bloqueio: não emitir nada — cai no fluxo normal de permissão
      // (equivalente a `permissionDecision: "defer"`).
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar AskUserQuestion
      // fora da Fase autônoma do overnight (que é justamente o único cenário
      // em que perguntar tem que ser impossível).
    }
  });
}
