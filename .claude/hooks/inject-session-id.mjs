// PreToolUse hook — injeta `--session-id {payload.session_id}` em chamadas
// standalone de `scripts/overnight-session-marker.ts` (--start/--phase) e
// `scripts/lib/session-registry.ts` (register/heartbeat/end/claim-issue/
// merge-lock-acquire/merge-lock-release) que ainda não trazem a flag (#5156).
//
// Wired in .claude/settings.json under hooks.PreToolUse, matcher "Bash".
//
// Por quê este hook existe: `session_id` é o campo que distingue "esta sessão
// overnight/develop" de "qualquer outra sessão rodando em paralelo na mesma
// máquina" (#5156 item 1 e afins) — mas o harness só expõe `session_id` no
// payload JSON que CADA hook recebe via stdin; não há env var
// `CLAUDE_SESSION_ID` nem qualquer jeito de a sessão RODANDO (o coordenador,
// não um hook) descobrir o próprio `session_id` (confirmado contra a doc
// oficial, `code.claude.com/docs/en/hooks`, ao desenhar este PR — ver também
// o docblock de `scripts/lib/session-registry.ts`). A skill nunca pode
// simplesmente "passar `--session-id X`" porque ela não sabe X.
//
// Solução: este hook injeta o valor automaticamente. `scripts/overnight-session-marker.ts
// --start` (ou `--phase ...`) e `scripts/lib/session-registry.ts register`
// (ou os demais subcomandos de escrita) chamados SEM `--session-id` recebem a
// flag anexada ANTES da execução real, via `hookSpecificOutput.updatedInput.command`
// — o mesmo mecanismo documentado pra `PreToolUse` (`updatedInput` modifica o
// `tool_input` antes do tool rodar, sem exigir `permissionDecision`).
//
// Escopo deliberadamente estreito: só dispara pra uma chamada STANDALONE (sem
// `&&`/`;`/`|` — mesmo espírito do "START-ANCHORED prefix" de `pr-create-review.mjs`
// pro `gh pr create*`) contendo um dos dois scripts-alvo com um subcomando de
// escrita reconhecido. Nunca mexe em `list-active`/`is-claimed` (leitura, não
// precisam de identidade de sessão) nem em qualquer outro comando.
//
// Fail-open por construção: `session_id` ausente do payload, comando já com
// `--session-id`, comando encadeado, JSON malformado, ou QUALQUER exceção
// neste hook → não emite nada (equivalente a não modificar/não bloquear) —
// o comando roda exatamente como foi chamado, e os dois scripts-alvo já
// tratam `--session-id` ausente como "formato antigo, comportamento pré-#5156"
// (ver docblock de `overnight-session-marker.ts` e `session-registry.ts`).

const TARGET_MARKER = "overnight-session-marker.ts";
const TARGET_REGISTRY = "session-registry.ts";
const WRITE_SUBCOMMANDS = /\b(register|heartbeat|end|claim-issue|merge-lock-acquire|merge-lock-release)\b/;

/** Heurística de "comando encadeado" — nunca injeta no meio de um `&&`/`;`/`|`. */
export function isChainedCommand(command) {
  return /&&|\|\||;|\|(?!\|)/.test(command);
}

/** Decide se `command` é candidato a injeção — script-alvo + subcomando de escrita reconhecido. */
export function needsSessionId(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (isChainedCommand(command)) return false;
  if (command.includes(TARGET_MARKER)) {
    return /--start\b/.test(command) || /--phase\b/.test(command);
  }
  if (command.includes(TARGET_REGISTRY)) {
    return WRITE_SUBCOMMANDS.test(command);
  }
  return false;
}

/** `true` se o comando já traz `--session-id` explicitamente — nunca sobrescrever. */
export function alreadyHasSessionId(command) {
  return typeof command === "string" && /--session-id\b/.test(command);
}

/** Escapa `sessionId` pra uso seguro dentro de aspas simples no shell POSIX. */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Função pura (mesmo padrão dos hooks irmãos, #4450/#3322) — decide o comando
 * modificado, ou `null` quando nenhuma injeção deve ocorrer. Sem I/O,
 * 100% testável.
 */
export function buildUpdatedCommand(command, sessionId) {
  if (!sessionId) return null;
  if (!needsSessionId(command)) return null;
  if (alreadyHasSessionId(command)) return null;
  return `${command} --session-id ${shellSingleQuote(sessionId)}`;
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/inject-session-id-hook.test.ts).
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
      const updated = buildUpdatedCommand(command, payload.session_id);
      if (updated) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              updatedInput: { command: updated },
            },
          }),
        );
      }
      // Sem injeção: não emitir nada — comando roda como veio.
    } catch {
      // Fail-open, sempre: uma falha aqui nunca pode bloquear/alterar o Bash
      // que o coordenador estava tentando rodar.
    }
  });
}
