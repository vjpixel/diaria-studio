// PreToolUse hook — injeta `--session-id {payload.session_id}` em chamadas
// standalone de `scripts/overnight-session-marker.ts` (--start/--phase),
// `scripts/lib/session-registry.ts` (register/heartbeat/end/claim-issue/
// is-claimed/merge-lock-acquire/merge-lock-release),
// `scripts/resolve-develop-plan-path.ts` e `scripts/resolve-overnight-
// plan-path.ts` (incondicional pros 2 últimos — o script inteiro exige a
// flag, sem noção de subcomando) que ainda não trazem a flag (#5156;
// `is-claimed` adicionado no #5161 fleet review item 4 — ver nota abaixo
// sobre `INJECTABLE_SUBCOMMANDS`; `resolve-develop-plan-path.ts` adicionado
// no #6259/#6265; `resolve-overnight-plan-path.ts` adicionado no #6328,
// mesmo motivo — ver `SESSION_ID_TARGETS`).
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
//
// #6160: além de `--session-id`, injeta `--pid {process.ppid}` em chamadas
// standalone de `session-registry.ts register` sem a flag. Nenhuma das
// skills overnight/develop chama `register` com `--pid` nem chama
// `heartbeat` (só o kind `continuo` faz as duas coisas hoje) — sem `pid`
// gravado, `decideSessionGc` nunca alcança o branch "processo vivo protege
// incondicionalmente" pra essas sessões, caindo direto na janela
// conservadora de 7 dias por tempo (ver docblock de `decideSessionGc` em
// `scripts/lib/session-registry.ts`). O hook roda como processo filho
// direto do processo da sessão Claude Code corrente (spawnado pelo harness
// a cada PreToolUse) — `process.ppid`, portanto, É o PID dessa sessão, o
// mesmo processo que `defaultIsPidAlive`/`process.kill(pid, 0)` precisa
// checar depois pra decidir se o registro ainda está "vivo". Mesma
// disciplina fail-open do `--session-id`: `--pid` já presente no comando
// nunca é sobrescrito.

const TARGET_MARKER = "overnight-session-marker.ts";
const TARGET_REGISTRY = "session-registry.ts";
// #6259/#6265: `resolve-develop-plan-path.ts` é o 3º alvo — diferente dos
// outros dois, não tem noção de subcomando: o script INTEIRO exige
// `--session-id` (ele mesmo aborta com exit 2 se ausente, ver seu próprio
// `--session-id ausente` guard), então "precisa de --session-id" é
// incondicional pra qualquer chamada standalone que cite o script.
const TARGET_RESOLVE_PLAN_PATH = "resolve-develop-plan-path.ts";
// #6328: `resolve-overnight-plan-path.ts` é o 4º alvo, irmão direto do
// anterior — mesmo script genérico (`scripts/lib/plan-path-resolution.ts`)
// por trás, mesma regra incondicional de `--session-id`. Nome distinto o
// suficiente (`overnight` vs `develop`) pra `command.includes(...)` nunca
// confundir os dois.
const TARGET_RESOLVE_OVERNIGHT_PLAN_PATH = "resolve-overnight-plan-path.ts";
// #5161 item 4: renomeada de WRITE_SUBCOMMANDS — is-claimed é leitura, mas
// ainda precisa da flag injetada (ver comentário acima). "Escrita" deixou de
// descrever o conjunto inteiro.
// #6168/#6296: `conflicts`, `grant-merge`, `check-merge-grant` e
// `consume-merge-grant` entram pelo MESMO motivo que `is-claimed` entrou no
// #5161 item 4 — todos recebem `--session-id` como a identidade de quem
// pergunta. O modo de falha SEM a flag injetada não é uniforme entre os 4
// (achado do fleet review #6303 — a versão anterior deste comentário dizia
// "degradam em silêncio" pros 4, o que só é verdade pro primeiro):
//   - `conflicts` usa `values["session-id"] ?? ""` direto, sem passar por
//     `requireSessionId` — sem a flag, degrada EM SILÊNCIO: não consegue se
//     auto-excluir dos peers, e a própria sessão aparece como conflito
//     consigo mesma;
//   - `grant-merge`, `check-merge-grant` e `consume-merge-grant` chamam
//     `requireSessionId(values)`, que FALHA ALTO E CEDO (erro explícito
//     "--session-id ausente…", nunca um resultado incorreto silencioso) —
//     mesmo assim vale injetar aqui, porque o erro evitável (subcomando
//     abortando por falta da flag) é o que a injeção existe pra prevenir,
//     não porque o resultado errado seria silencioso.
const INJECTABLE_SUBCOMMANDS =
  /\b(register|heartbeat|end|claim-issue|is-claimed|conflicts|grant-merge|check-merge-grant|consume-merge-grant|merge-lock-acquire|merge-lock-release)\b/;
// #6160: só o subcomando `register` aceita `--pid` (ver CLI de
// scripts/lib/session-registry.ts) — os demais subcomandos não têm parâmetro
// homônimo, então a injeção de `--pid` é restrita a este subcomando.
const REGISTER_SUBCOMMAND = /\bregister\b/;

// #6259/#6265: tabela de alvos pra `needsSessionId` — generalizado de "2
// constantes + 2 `if`s" pra uma lista, porque um 3º alvo com regra PRÓPRIA
// (incondicional, sem subcomando) deixaria o padrão anterior repetitivo.
// Cada entrada decide, a partir do `command` JÁ sabido conter `match`, se a
// flag é necessária — mantém as regras de `overnight-session-marker.ts` e
// `session-registry.ts` byte-a-byte idênticas ao comportamento anterior
// (mesmas regexes, mesma ordem de checagem), só movidas pra dentro da tabela.
// `needsPid` NÃO usa esta tabela de propósito — `--pid` continua exclusivo
// de `session-registry.ts register` (nenhum outro alvo aceita o parâmetro).
const SESSION_ID_TARGETS = [
  {
    match: TARGET_MARKER,
    needsSessionId: (command) => /--start\b/.test(command) || /--phase\b/.test(command),
  },
  {
    match: TARGET_REGISTRY,
    needsSessionId: (command) => INJECTABLE_SUBCOMMANDS.test(command),
  },
  {
    match: TARGET_RESOLVE_PLAN_PATH,
    needsSessionId: () => true,
  },
  {
    match: TARGET_RESOLVE_OVERNIGHT_PLAN_PATH,
    needsSessionId: () => true,
  },
];

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
  for (const target of SESSION_ID_TARGETS) {
    if (command.includes(target.match)) return target.needsSessionId(command);
  }
  return false;
}

/** `true` se o comando já traz `--session-id` explicitamente — nunca sobrescrever. */
export function alreadyHasSessionId(command) {
  return typeof command === "string" && /--session-id\b/.test(command);
}

/**
 * Decide se `command` é candidato a injeção de `--pid` — só o subcomando
 * `register` de `session-registry.ts` (#6160). Mesma restrição de comando
 * encadeado que `needsSessionId` já aplica: nunca injeta no meio de um
 * `&&`/`;`/`|`/script multi-linha.
 */
export function needsPid(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (isChainedCommand(command)) return false;
  return command.includes(TARGET_REGISTRY) && REGISTER_SUBCOMMAND.test(command);
}

/** `true` se o comando já traz `--pid` explicitamente — nunca sobrescrever. */
export function alreadyHasPid(command) {
  return typeof command === "string" && /--pid\b/.test(command);
}

/** Escapa `sessionId` pra uso seguro dentro de aspas simples no shell POSIX. */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Função pura (mesmo padrão dos hooks irmãos, #4450/#3322) — decide o comando
 * modificado, ou `null` quando nenhuma injeção deve ocorrer. Sem I/O,
 * 100% testável.
 *
 * #6160: além de `--session-id`, injeta `--pid {pid}` em chamadas standalone
 * de `session-registry.ts register` que ainda não trazem a flag — mesmo
 * padrão de injeção automática, dessa vez fechando o branch de
 * `decideSessionGc` que protege incondicionalmente um registro com processo
 * vivo (só alcançável hoje pelo kind `continuo`, que já passa `--pid` à
 * mão). `pid` é opcional e independente de `sessionId`: um comando que já
 * tem `--session-id` mas ainda não tem `--pid` (ou vice-versa) recebe só a
 * flag que falta.
 */
export function buildUpdatedCommand(command, sessionId, pid) {
  const wantsSessionId = Boolean(sessionId) && needsSessionId(command) && !alreadyHasSessionId(command);
  const wantsPid = (pid !== undefined && pid !== null) && needsPid(command) && !alreadyHasPid(command);
  if (!wantsSessionId && !wantsPid) return null;
  let updated = command;
  if (wantsSessionId) updated += ` --session-id ${shellSingleQuote(sessionId)}`;
  if (wantsPid) updated += ` --pid ${pid}`;
  return updated;
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
      // #6160: process.ppid é o PID do processo pai deste hook — o processo
      // da própria sessão Claude Code corrente, que o spawna a cada
      // PreToolUse (ver docblock acima). Sempre definido (Node garante
      // process.ppid), então pid nunca é undefined aqui — mas o parâmetro
      // continua opcional em buildUpdatedCommand pra manter a função pura
      // testável sem depender de process.*.
      const updated = buildUpdatedCommand(command, payload.session_id, process.ppid);
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
