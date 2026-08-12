// PreToolUse hook — injeta `--session-id {payload.session_id}` em chamadas
// standalone de `scripts/overnight-session-marker.ts` (--start/--phase) e
// `scripts/lib/session-registry.ts` (register/heartbeat/end/claim-issue/
// is-claimed/merge-lock-acquire/merge-lock-release) que ainda não trazem a
// flag (#5156; `is-claimed` adicionado no #5161 fleet review item 4 — ver
// nota abaixo sobre `INJECTABLE_SUBCOMMANDS`).
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
// `&&`/`;`/`|`/newline embutido — mesmo espírito do "START-ANCHORED prefix" de
// `pr-create-review.mjs` pro `gh pr create*`) contendo um dos dois scripts-alvo
// com um subcomando reconhecido em `INJECTABLE_SUBCOMMANDS`. Nunca mexe em
// `list-active` (leitura pura, sem noção de "sessão atual" nenhuma) nem em
// qualquer outro comando.
//
// #5161 fleet review item 4: `is-claimed` ENTRA em `INJECTABLE_SUBCOMMANDS`
// (renomeada de `WRITE_SUBCOMMANDS` — deixou de ser só sobre escrita) mesmo
// sendo leitura, porque ela recebe `--session-id` como `excludeSessionId`
// (ver `requireSessionId`/case "is-claimed" em `scripts/lib/session-registry.ts`):
// sem a flag injetada, `excludeSessionId` fica vazio e uma sessão que
// reavalia `is-claimed` numa onda posterior pra uma issue que ELA MESMA já
// reivindicou vê `claimed: true` apontando pra si própria, rotulado como "é
// outra sessão" — pula o próprio trabalho em andamento por engano. Injetar
// aqui não muda NADA do comportamento de leitura em si (o subcomando não
// escreve nada) — só corrige a auto-exclusão.
//
// Fail-open por construção: `session_id` ausente do payload, comando já com
// `--session-id`, comando encadeado, JSON malformado, ou QUALQUER exceção
// neste hook → não emite nada (equivalente a não modificar/não bloquear) —
// o comando roda exatamente como foi chamado, e os dois scripts-alvo já
// tratam `--session-id` ausente como "formato antigo, comportamento pré-#5156"
// (ver docblock de `overnight-session-marker.ts` e `session-registry.ts`).

const TARGET_MARKER = "overnight-session-marker.ts";
const TARGET_REGISTRY = "session-registry.ts";
// #5161 item 4: renomeada de WRITE_SUBCOMMANDS — is-claimed é leitura, mas
// ainda precisa da flag injetada (ver comentário acima). "Escrita" deixou de
// descrever o conjunto inteiro.
const INJECTABLE_SUBCOMMANDS = /\b(register|heartbeat|end|claim-issue|is-claimed|merge-lock-acquire|merge-lock-release)\b/;

/**
 * Heurística de "comando encadeado" — nunca injeta no meio de um `&&`/`;`/`|`
 * nem quando o comando alvo não é a ÚLTIMA linha de um script multi-linha
 * (#5161 fleet review item 6): sem o `\n` aqui, um heredoc/script Bash de
 * várias linhas com `session-registry.ts register ...` numa linha que não é
 * a última faz o hook anexar `--session-id` no FIM da string inteira (na
 * última linha, não na linha do `register`) — flag mal-direcionada, o
 * subcomando real ainda falha por falta dela.
 */
export function isChainedCommand(command) {
  return /&&|\|\||;|\|(?!\|)|\r?\n/.test(command);
}

/** Decide se `command` é candidato a injeção — script-alvo + subcomando reconhecido. */
export function needsSessionId(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (isChainedCommand(command)) return false;
  if (command.includes(TARGET_MARKER)) {
    return /--start\b/.test(command) || /--phase\b/.test(command);
  }
  if (command.includes(TARGET_REGISTRY)) {
    return INJECTABLE_SUBCOMMANDS.test(command);
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
