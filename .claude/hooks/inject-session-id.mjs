// PreToolUse hook — injeta `--session-id {payload.session_id}` em chamadas
// standalone de `scripts/overnight-session-marker.ts` (--start/--phase/--end),
// `scripts/lib/session-registry.ts` (register/heartbeat/end/claim-issue/
// unclaim-issue/is-claimed/merge-lock-acquire/merge-lock-release),
// `scripts/resolve-develop-plan-path.ts` e `scripts/resolve-overnight-
// plan-path.ts` (incondicional pros 2 últimos — o script inteiro exige a
// flag, sem noção de subcomando) que ainda não trazem a flag (#5156;
// `is-claimed` adicionado no #5161 fleet review item 4 — ver nota abaixo
// sobre `INJECTABLE_SUBCOMMANDS`; `resolve-develop-plan-path.ts` adicionado
// no #6259/#6265; `resolve-overnight-plan-path.ts` adicionado no #6328;
// `unclaim-issue` adicionado no #6317, mesmo motivo — ver `SESSION_ID_TARGETS`).
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
// Escopo deliberadamente estreito: só INJETA pra uma chamada STANDALONE (sem
// `&&`/`;`/`|`/newline embutido — mesmo espírito do "START-ANCHORED prefix" de
// `pr-create-review.mjs` pro `gh pr create*`) contendo um dos dois scripts-alvo
// com um subcomando reconhecido em `INJECTABLE_SUBCOMMANDS`. Nunca mexe em
// `list-active` (leitura pura, sem noção de "sessão atual" nenhuma) nem em
// qualquer outro comando.
//
// #7212: uma chamada ENCADEADA que casaria com o mesmo alvo/subcomando NÃO
// é ignorada em silêncio — é BLOQUEADA (`permissionDecision: "deny"`, ver
// `detectChainedSessionIdRisk`). Antes do #7212, o hook só se recusava a
// injetar (`needsSessionId` já tinha o early-return de `isChainedCommand`) e
// deixava a chamada seguir sem a flag; o subcomando falhava alto do lado de
// dentro (`requireSessionId`, exit 1), mas esse erro competia por atenção
// com a saída de outros comandos do mesmo bloco — ou era engolido por
// completo quando o bloco redirecionava (`> /dev/null 2>&1`). Um `deny` de
// `PreToolUse` não tem como ser engolido: a chamada nem chega a rodar, e o
// motivo aparece pro chamador ali mesmo, não no meio de outra saída. Isto
// NÃO afrouxa `isChainedCommand` nem permite injeção em comando encadeado
// (#5751 item 18 segue valendo) — só troca "deixar passar sem a flag,
// torcendo pra alguém notar o exit 1" por "recusar a chamada, na hora".
//
// #7264/#7281: o #7212 casava o NOME do script em qualquer posição da
// string (`command.includes(...)`) — inclusive dentro de prosa (`gh issue
// create --body "... cita session-registry.ts ..."`, #7264) ou como
// caminho de arquivo num comando de leitura pura (`git show
// "rev:scripts/lib/session-registry.ts" | grep ...`, #7281), casos em que
// não há invocação nenhuma. `isScriptInvoked` (perto de
// `matchesInjectableTarget` abaixo) restringe o match a "nome do script
// logo depois de `npx tsx`/`tsx`/`node`" — invocação de verdade, não
// menção — pra QUALQUER caminho que decida se um alvo foi citado (injeção
// standalone E bloqueio de comando encadeado, os dois passam por
// `matchesInjectableTarget`). Continua bloqueando o caso real do #7212
// (script realmente invocado dentro de um bloco encadeado); só deixou de
// bloquear citação em texto.
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
// `scripts/lib/session-registry.ts`). A premissa original era que o hook
// roda como processo filho direto do processo da sessão Claude Code
// corrente (spawnado pelo harness a cada PreToolUse), logo `process.ppid`
// seria o pid dessa sessão. **#6294 mediu essa premissa como FALSA pelo
// menos uma vez ao vivo**: numa sessão `overnight` demonstravelmente ativa,
// o `pid` gravado por esta linha já não correspondia a processo nenhum —
// `process.ppid`, neste harness, aponta pra um processo efêmero que morre
// quase imediatamente, não pro processo persistente da sessão. Não dá pra
// confirmar a partir deste repo se isso é sempre assim ou específico de
// uma topologia do harness (camada opaca, não verificável daqui) — por
// isso `decideSessionGc` não trata mais "pid morto" como sinal de remoção
// (só "pid vivo" continua protegendo, erra sempre pro lado seguro). Mesma
// disciplina fail-open do `--session-id`: `--pid` já presente no comando
// nunca é sobrescrito.

import { pathToFileURL } from "node:url";

// #7836 P0 (revertido em produção no mesmo dia, achado ao vivo) — a 1ª
// versão deste fix importava `scripts/lib/session-id-required-subcommands.ts`
// direto, apostando que "Node 22.18+ resolve import de .ts via type-stripping
// nativo sem flag" bastava. A aposta era falsa PRA ESTE HOOK especificamente:
// `.claude/settings.json` spawna este arquivo com o binário `node` cru,
// resolvido pelo PATH do processo que dispara o PreToolUse — não pelo `node`
// que uma sessão Bash prefixa manualmente. Nesta máquina (e em qualquer outra
// sem Node 22.18+ como `node` default do PATH do harness), isso é o `node`
// do sistema/distro — medido ao vivo: v20.20.2, sem type-stripping nativo. O
// `import` de `.ts` lança ERR_UNKNOWN_FILE_EXTENSION NA CARGA DO MÓDULO,
// antes de qualquer linha deste arquivo rodar — não é um erro capturável
// pelo try/catch runtime lá embaixo, é falha de RESOLUÇÃO do processo Node
// inteiro. Resultado: TODA injeção de --session-id parou de funcionar em
// produção (não só self-authorize-merge) até os merges travarem.
//
// Fix real: a lista volta a ser um literal PLANO neste arquivo (zero import,
// zero dependência de versão de Node) — o padrão "duplica em JS puro" que os
// hooks irmãos já seguem. `test/session-id-required-subcommands-hook-sync.
// test.ts` trava esta lista contra a exportada por
// session-id-required-subcommands.ts (rodando via `npx tsx`, que SIM garante
// Node 22.18+) — divergência futura entre as duas cópias falha CI, mesma
// garantia de antes, sem o import em runtime do hook.
const SESSION_ID_REQUIRED_SUBCOMMANDS = [
  "register",
  "heartbeat",
  "end",
  "claim-issue",
  "unclaim-issue",
  "is-claimed",
  "conflicts",
  "grant-merge",
  "check-merge-grant",
  "consume-merge-grant",
  "merge-lock-acquire",
  "merge-lock-release",
  "merge-lock-renew",
  "self-authorize-merge",
];

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
// #7304: `cleanup-merged-worktrees.ts` é o 5º alvo. Diferente dos anteriores,
// a flag aqui é OPCIONAL pro script (ele roda sem ela, com o comportamento
// pré-#7304) — mas sem a injeção a sessão chamadora se conta como "outra
// sessão ativa" e preserva os próprios worktrees, que é justamente o bug.
// Incondicional: o script não tem subcomando.
const TARGET_CLEANUP_WORKTREES = "cleanup-merged-worktrees.ts";
// #9527 (review do PR #9529): `effective-model-probe.ts` é o 6º alvo. Sem a
// injeção, a sonda da Fase 0 do overnight não sabe qual transcript é o DELA
// (não há env `CLAUDE_SESSION_ID`) e o fallback por mtime podia ler o de outra
// sessão no mesmo checkout. Com `--transcript` explícito (uso do relatório,
// um arquivo por subagente) a flag injetada é inócua: `--transcript` vence.
const TARGET_EFFECTIVE_MODEL_PROBE = "effective-model-probe.ts";
// #10309: `edition-lock.ts` é o 7º alvo — a trava por edição do Stage 4
// identifica o detentor pelo `session_id` (um fork de sessão ganha id novo).
// Incondicional: acquire/release exigem a flag; `status` a ignora.
const TARGET_EDITION_LOCK = "edition-lock.ts";
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
// #6317: `unclaim-issue` entra pelo mesmo motivo que `claim-issue` — precisa
// da flag pra saber DE QUEM remover (`requireSessionId`, mesma disciplina de
// falha alta e cedo do subcomando irmão).
// #6334: `merge-lock-renew` entra pelo mesmo motivo que `merge-lock-acquire`/
// `merge-lock-release` — precisa da flag pra saber de quem é o hold a renovar.
//
// #7836: esta lista deixou de ser mantida à mão aqui — `self-authorize-merge`
// (#7303) ficou de fora por 6 dias porque era uma 2ª lista, divergente desta,
// e ninguém lembrou de atualizar as duas juntas (mesmo modo de falha de
// `unclaim-issue`/#6317 e `merge-lock-renew`/#6334, cada um "adicionado
// depois, um de cada vez" — ver a issue). Agora importa de
// `scripts/lib/session-id-required-subcommands.ts`, que `session-registry.ts`
// TAMBÉM importa — uma lista só, não duas envelhecendo em paralelo.
// `test/session-id-required-subcommands.test.ts` trava essa lista contra os
// `case "X":` reais do switch de `session-registry.ts` (ver docblock do
// módulo importado pro porquê de não ser 100% derivável do código sozinho).
const INJECTABLE_SUBCOMMANDS = new RegExp(`\\b(${SESSION_ID_REQUIRED_SUBCOMMANDS.join("|")})\\b`);
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
    // #9419: `--end` entra junto com `--start`/`--phase` — desde o #9347 o
    // marker é POR SESSÃO (`.active-session-{tag}.{sid}.json`) e `endSession`
    // sem id só apaga o legado anônimo; sem a injeção aqui o `--end` da Fase 2
    // deixava o marker da rodada vivo (`phase:"autonomous"`, AskUserQuestion
    // negado na sessão por até 24h).
    needsSessionId: (command) =>
      /--start\b/.test(command) || /--phase\b/.test(command) || /--end\b/.test(command),
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
  {
    match: TARGET_CLEANUP_WORKTREES,
    needsSessionId: () => true,
  },
  {
    match: TARGET_EFFECTIVE_MODEL_PROBE,
    needsSessionId: () => true,
  },
  {
    match: TARGET_EDITION_LOCK,
    needsSessionId: () => true,
  },
];

/**
 * Heurística de "comando encadeado" — nunca injeta no meio de um `&&`/`;`/`|`
 * nem quando o comando alvo não é a ÚLTIMA linha de um script multi-linha
 * (#5161 fleet review item 6): sem checar `\n` aqui, um heredoc/script Bash
 * de várias linhas com `session-registry.ts register ...` numa linha que não
 * é a última faz o hook anexar `--session-id` no FIM da string inteira (na
 * última linha, não na linha do `register`) — flag mal-direcionada, o
 * subcomando real ainda falha por falta dela.
 *
 * #8346: até aqui, a checagem era uma regex sobre a string CRUA — sem noção
 * de citação, um metacaractere DENTRO de aspas (`--reason "…; …"`, prosa
 * livre de `self-authorize-merge`/`grant-merge`) era lido como encadeamento
 * e a chamada standalone legítima era recusada (3ª instância da família do
 * #7264/#7281, agora aqui em vez de em `isScriptInvoked`). Fix: percorre o
 * comando caractere a caractere rastreando aspas simples/duplas — só conta
 * um metacaractere quando ele aparece FORA de qualquer aspa. Mesmo espírito
 * dos dois fixes irmãos: reconhecer citação, não afrouxar a detecção — um
 * comando genuinamente encadeado (metacaractere fora de aspas) continua
 * batendo `true`, igual antes.
 *
 * Regras de aspas/escape (decisão explícita, não dedutível da regex antiga):
 * - Aspas simples: tudo dentro é literal (inclusive `\`, igual ao shell
 *   POSIX) — só uma outra aspa simples fecha.
 * - Aspas duplas: `\` escapa o próximo caractere (inclusive a própria aspa
 *   dupla, `\"`) e não fecha a citação sozinho.
 * - Fora de aspas: `\;`, `\|` etc. também contam como escapado — `\` consome
 *   o caractere seguinte sem disparar a detecção. Não é o caso do #8346 (que
 *   é sempre dentro de aspas), mas mantém a mesma leitura de "escape suprime
 *   o metacaractere" nos dois contextos, em vez de uma regra só pra dentro
 *   de aspas.
 * - Aspa não fechada até o fim da string: comando malformado — tratado como
 *   ENCADEADO (fail-closed). Nunca abrir a porta por causa de uma aspa
 *   órfã; na pior hipótese um comando standalone legítimo mas mal-escapado
 *   simplesmente não recebe a injeção automática (mesmo modo de falha
 *   fail-open de sempre — ver o `try/catch` no entrypoint do hook), nunca
 *   pior que isso.
 * - `&` sozinho (background, sem par) nunca contou como encadeamento nesta
 *   heurística (a regex antiga só casava `&&`) — preservado aqui.
 */
export function isChainedCommand(command) {
  if (typeof command !== "string") return false;
  const { stoppedAt, unclosed } = scanShell(command, (i, ch, kind) => {
    if (kind !== "plain") return false;
    if (ch === "\n" || ch === "\r") return true;
    if (ch === ";") return true;
    if (ch === "|") return true; // cobre `|` e `||` — ambos disparam
    return ch === "&" && command[i + 1] === "&";
  });
  if (stoppedAt !== -1) return true;
  // Aspa não fechada: comando malformado, fail-closed.
  return unclosed;
}

/**
 * #12050: scanner de aspas/escape/comentário compartilhado por
 * `isChainedCommand` e por `stripSafeDataHeredocBodies`. As regras de aspas e
 * escape são as documentadas em `isChainedCommand` acima (extraídas dele sem
 * mudança); comentário é opcional (`comments: true`) porque `isChainedCommand`
 * nunca reconheceu `#` e continua sem reconhecer.
 *
 * `visit(i, ch, kind)` é chamado para cada caractere visto, com `kind`:
 * - `plain`: fora de aspas, sem escape (é onde metacaractere vale);
 * - `quote`: a própria aspa que abre ou fecha uma citação;
 * - `single` / `double`: conteúdo de aspas simples / duplas;
 * - `escape`: a `\` (fora de aspas ou dentro de aspas duplas);
 * - `escaped`: o caractere consumido por essa `\`;
 * - `comment`: o `#` que abre um comentário e o texto até a quebra de linha
 *   (a `\n` que fecha o comentário volta como `plain`).
 * Retornar `true` de `visit` para a varredura. Devolve `stoppedAt` (índice
 * onde parou, ou -1) e `unclosed` (terminou dentro de aspas).
 */
function scanShell(command, visit, { start = 0, end = command.length, comments = false } = {}) {
  let mode = "plain"; // plain | single | double | comment
  const stopped = (i) => ({ stoppedAt: i, unclosed: false });
  for (let i = start; i < end; i++) {
    const ch = command[i];
    if (mode === "comment") {
      if (ch === "\n") {
        mode = "plain";
        if (visit(i, ch, "plain")) return stopped(i);
      } else if (visit(i, ch, "comment")) return stopped(i);
      continue;
    }
    if (mode === "single") {
      const kind = ch === "'" ? "quote" : "single";
      if (ch === "'") mode = "plain";
      if (visit(i, ch, kind)) return stopped(i);
      continue;
    }
    if (ch === "\\") {
      // Fora de aspas ou dentro de aspas duplas: consome o próximo caractere.
      if (visit(i, ch, "escape")) return stopped(i);
      i++;
      if (i < end && visit(i, command[i], "escaped")) return stopped(i);
      continue;
    }
    if (mode === "double") {
      const kind = ch === '"' ? "quote" : "double";
      if (ch === '"') mode = "plain";
      if (visit(i, ch, kind)) return stopped(i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      mode = ch === "'" ? "single" : "double";
      if (visit(i, ch, "quote")) return stopped(i);
      continue;
    }
    if (comments && ch === "#" && (i === start || /[\s;&|()]/.test(command[i - 1]))) {
      mode = "comment";
      if (visit(i, ch, "comment")) return stopped(i);
      continue;
    }
    if (visit(i, ch, "plain")) return stopped(i);
  }
  return { stoppedAt: -1, unclosed: mode === "single" || mode === "double" };
}

/**
 * #12050: quebra a linha de abertura de um heredoc em palavras e operadores
 * de redirecionamento, com as regras de `scanShell`. Devolve `null` (não dá
 * para afirmar que é um comando simples de dados) quando aparece qualquer
 * coisa fora do caso trivial: `;`, `|`, `&`, `(`, `)`, `$(`/crase (inclusive
 * dentro de aspas duplas, onde o shell ainda executa), aspa não fechada ou
 * quebra de linha (continuação com `\`).
 */
function tokenizeHeredocOpening(line) {
  if (line.includes("\n")) return null;
  const tokens = [];
  let word = null;
  let denied = false;
  let lastOpIndex = -2;
  const flush = () => {
    if (word) tokens.push(word);
    word = null;
  };
  const ensureWord = () => {
    if (!word) word = { type: "word", raw: "", value: "" };
    return word;
  };
  const { unclosed } = scanShell(
    line,
    (i, ch, kind) => {
      if (kind === "comment") {
        flush();
        return false;
      }
      if ((kind === "plain" || kind === "double") && (ch === "`" || (ch === "$" && line[i + 1] === "("))) {
        denied = true;
        return true;
      }
      if (kind === "plain") {
        if (ch === " " || ch === "\t") {
          flush();
          return false;
        }
        if (/[;|&()]/.test(ch)) {
          denied = true;
          return true;
        }
        const last = tokens[tokens.length - 1];
        if (ch === "<" || ch === ">" || (ch === "-" && !word && last?.type === "op" && last.value === "<<" && lastOpIndex === i - 1)) {
          if (!word && last?.type === "op" && lastOpIndex === i - 1) {
            last.value += ch;
          } else {
            flush();
            tokens.push({ type: "op", value: ch });
          }
          lastOpIndex = i;
          return false;
        }
        const w = ensureWord();
        w.raw += ch;
        w.value += ch;
        return false;
      }
      const w = ensureWord();
      w.raw += ch;
      if (kind !== "quote" && kind !== "escape") w.value += ch;
      return false;
    },
    { comments: true },
  );
  flush();
  if (denied || unclosed) return null;
  return tokens;
}

const HEREDOC_TAG_QUOTED = /^(['"])([A-Za-z0-9_.-]+)\1$/;
const UNSAFE_PATH_CHARS = /[$*?[\]{}~`]/;

/**
 * #12050: decide se a linha de abertura `line` é um heredoc de DADOS cujo
 * corpo pode sair da checagem. Devolve `{ tag, dashed, paths }` ou `null`.
 * Condições (as do contrato da issue, condições 2 e 4; a 1 é de quem chama):
 * - delimitador inteiro entre aspas (`<<'TAG'`/`<<"TAG"`): sem aspas, o shell
 *   expande `$(...)` e crase no corpo;
 * - consumidor numa allowlist curta: `cat` sem argumentos (com ou sem `>`/`>>`
 *   para arquivo), `tee [-a] arquivo…`, `gh … --body-file -` / `-F -`;
 * - `paths`: arquivos escritos, para a condição 5 (ninguém executa depois).
 */
function analyzeDataHeredocOpening(line) {
  const tokens = tokenizeHeredocOpening(line);
  if (!tokens) return null;
  const opIndexes = tokens.flatMap((t, idx) => (t.type === "op" && t.value.startsWith("<<") ? [idx] : []));
  if (opIndexes.length !== 1) return null;
  const opIdx = opIndexes[0];
  const op = tokens[opIdx].value;
  if (op !== "<<" && op !== "<<-") return null;
  const delim = tokens[opIdx + 1];
  if (!delim || delim.type !== "word") return null;
  const tagMatch = HEREDOC_TAG_QUOTED.exec(delim.raw);
  if (!tagMatch) return null;
  const rest = tokens.filter((_, idx) => idx !== opIdx && idx !== opIdx + 1);
  const argv = [];
  const paths = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t.type === "op") {
      if (t.value !== ">" && t.value !== ">>") return null;
      const target = rest[k + 1];
      if (!target || target.type !== "word" || target.value === "" || UNSAFE_PATH_CHARS.test(target.value)) {
        return null;
      }
      paths.push(target.value);
      k++;
      continue;
    }
    argv.push(t.value);
  }
  const [cmd, ...args] = argv;
  if (cmd === "cat") {
    if (args.length !== 0) return null;
  } else if (cmd === "tee") {
    const files = args.filter((a) => a !== "-a" && a !== "--append");
    if (files.length === 0) return null;
    for (const f of files) {
      if (f.startsWith("-") || UNSAFE_PATH_CHARS.test(f)) return null;
      paths.push(f);
    }
  } else if (cmd === "gh") {
    const readsStdin = args.some(
      (a, idx) => a === "--body-file=-" || ((a === "--body-file" || a === "-F") && args[idx + 1] === "-"),
    );
    if (!readsStdin) return null;
  } else {
    return null;
  }
  return { tag: tagMatch[2], dashed: op === "<<-", paths };
}

/**
 * #12050 condição 5: `true` se `rest` (o comando depois do terminador)
 * referencia algum arquivo escrito pelo heredoc em posição que não seja
 * `--body-file P` / `--body-file=P` / `-F P`. Conservador de propósito:
 * qualquer outra menção (`bash P`, `source P`, `. P`, `node P`, `chmod +x P`,
 * `./P`, `cat P | sh`, só o nome do arquivo depois de um `cd`) conta como uso
 * do arquivo, e o corpo fica na checagem.
 */
function restUsesWrittenFile(rest, paths) {
  for (const p of paths) {
    const base = p.split("/").pop();
    if (!base) return true;
    let from = 0;
    for (;;) {
      const at = rest.indexOf(base, from);
      if (at === -1) break;
      from = at + base.length;
      let wordStart = at;
      while (wordStart > 0 && !/\s/.test(rest[wordStart - 1])) wordStart--;
      const word = rest.slice(wordStart, from + (rest.slice(from).match(/^\S*/)?.[0].length ?? 0));
      if (word.startsWith("--body-file=")) continue;
      const before = rest.slice(0, wordStart).trimEnd();
      const prevWord = before.slice(before.search(/\S*$/));
      if (prevWord === "--body-file" || prevWord === "-F") continue;
      return true;
    }
  }
  return false;
}

/**
 * #12050: devolve `command` sem o CORPO dos heredocs de dados — só para a
 * checagem de `detectChainedSessionIdRisk`, nunca para executar nem para
 * injetar. Um corpo que só cita o nome de um alvo (`cat > /tmp/x.md
 * <<'EOF'` … `session-registry.ts` … `EOF`) deixa de ser lido como invocação.
 *
 * Fail-closed em todo caso fora do contrato: qualquer heredoc do comando que
 * não satisfaça TODAS as condições faz a função devolver `command` intacto
 * (nenhum corpo removido, nem o de outro heredoc seguro). As condições:
 * 1. o `<<` está fora de aspas e de comentário (`scanShell`);
 * 2. delimitador entre aspas (`analyzeDataHeredocOpening`);
 * 3. o terminador existe numa linha que é exatamente a TAG (com tabs iniciais
 *    no `<<-`);
 * 4. consumidor de dados na allowlist (`analyzeDataHeredocOpening`), sem `|`
 *    na abertura;
 * 5. nada depois do terminador usa o arquivo escrito (`restUsesWrittenFile`);
 * 6. a linha seguinte ao terminador não começa com `|`.
 * Mais um: se o resto do comando define função ou alias (`cat() {`,
 * `alias cat=…`, `function …`), o consumidor pode não ser o `cat`/`tee`/`gh`
 * de verdade, e nada é removido.
 *
 * Linha de abertura, linha do terminador e o resto do comando permanecem —
 * uma invocação real do alvo fora do corpo continua sendo vista.
 */
export function stripSafeDataHeredocBodies(command) {
  if (typeof command !== "string" || !command.includes("<<")) return command;
  const out = [];
  let pos = 0;
  let stripped = false;
  while (pos < command.length) {
    const heredocOps = [];
    const { stoppedAt } = scanShell(
      command,
      (i, ch, kind) => {
        if (kind !== "plain") return false;
        if (ch === "\n") return true;
        if (ch === "<" && command[i + 1] === "<" && command[i - 1] !== "<" && command[i + 2] !== "<") {
          heredocOps.push(i);
        }
        return false;
      },
      { start: pos, comments: true },
    );
    const lineEnd = stoppedAt === -1 ? command.length : stoppedAt;
    const line = command.slice(pos, lineEnd);
    if (heredocOps.length === 0) {
      out.push(command.slice(pos, Math.min(lineEnd + 1, command.length)));
      pos = lineEnd + 1;
      continue;
    }
    if (heredocOps.length !== 1 || stoppedAt === -1) return command;
    const opening = analyzeDataHeredocOpening(line);
    if (!opening) return command;
    // Condição 3: o terminador existe.
    let cursor = lineEnd + 1;
    let terminatorEnd = -1;
    while (cursor <= command.length) {
      const nl = command.indexOf("\n", cursor);
      const end = nl === -1 ? command.length : nl;
      const bodyLine = command.slice(cursor, end);
      const candidate = opening.dashed ? bodyLine.replace(/^\t+/, "") : bodyLine;
      if (candidate === opening.tag) {
        terminatorEnd = end;
        break;
      }
      if (nl === -1) break;
      cursor = nl + 1;
    }
    if (terminatorEnd === -1) return command;
    const rest = command.slice(terminatorEnd);
    // Condição 6: pipe logo depois do terminador.
    if (/^\n[ \t]*\|/.test(rest)) return command;
    // Condição 5: o arquivo escrito não é usado depois.
    if (restUsesWrittenFile(rest, opening.paths)) return command;
    out.push(line + "\n" + command.slice(cursor, terminatorEnd) + (terminatorEnd < command.length ? "\n" : ""));
    stripped = true;
    pos = terminatorEnd + 1;
  }
  if (!stripped) return command;
  const result = out.join("");
  if (/(?:^|[\s;&|(])(?:alias|function)\s/.test(result) || /(?:^|[\s;&|(])(?:cat|tee|gh)\s*\(\s*\)/.test(result)) {
    return command;
  }
  return result;
}

/**
 * #7264/#7281: heurística "invocação vs menção". `command.includes(nome)`
 * (comportamento anterior a este fix) casava o nome do script em QUALQUER
 * posição da string — inclusive dentro de prosa citando o script (corpo de
 * `gh issue create --body "... a docstring de session-registry.ts proíbe
 * ..."`, #7264) ou como caminho de arquivo em comando de leitura pura
 * (`git show "origin/master:scripts/lib/session-registry.ts" | grep ...`,
 * `grep -rn "session-registry.ts" scripts/`, #7281). Nenhum dos dois
 * EXECUTA o script — não há chamada nenhuma pra `--session-id` proteger.
 *
 * Heurística mínima sugerida em ambas as issues, aplicada aqui: só conta
 * como invocação quando o nome do arquivo aparece logo depois de um
 * executor conhecido (`npx tsx`, `tsx` ou `node`) — é assim que TODA
 * chamada real a estes scripts aparece no repo (ver skills `/diaria-*`).
 * Não blinda contra todo texto adversarial possível (uma citação em prosa
 * que reproduzisse literalmente "npx tsx .../session-registry.ts" ainda
 * casaria) — aceito: o alvo é precisão nos casos reais batidos ao vivo,
 * não uma blindagem completa contra qualquer string (mesmo trade-off que
 * as duas issues descrevem — não afrouxar o guard, só o critério de match).
 */
function isScriptInvoked(command, targetName) {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[\\s;&|])(?:npx\\s+tsx|tsx|node)\\s+\\S*${escaped}`, "i");
  return pattern.test(command);
}

/**
 * Casa `command` contra `SESSION_ID_TARGETS` e decide se PRECISARIA de
 * `--session-id` — independente de o comando estar encadeado ou não.
 * Extraído de `needsSessionId` (#7212) porque a checagem de bloqueio
 * (`detectChainedSessionIdRisk` abaixo) precisa da MESMA lógica de
 * casamento de alvo, mas justamente no caso em que `isChainedCommand`
 * é `true` — o oposto do early-return que `needsSessionId` aplica.
 *
 * #7264/#7281: o gate de entrada usa `isScriptInvoked` (posição de
 * execução), não mais `command.includes` (substring em qualquer posição) —
 * `target.needsSessionId(command)` continua varrendo o comando INTEIRO em
 * busca do subcomando (isso nunca foi o problema; o problema era casar o
 * NOME do script fora de posição de chamada).
 */
function matchesInjectableTarget(command) {
  return matchedInjectableTargets(command).length > 0;
}

/**
 * #12029: nomes (`target.match`) de TODOS os alvos de `SESSION_ID_TARGETS`
 * invocados em `command` com subcomando/flag que exige `--session-id`. Fonte
 * única da mensagem de bloqueio de `detectChainedSessionIdRisk` — antes a
 * mensagem era uma string fixa que citava só 4 dos 7 alvos (um
 * `cleanup-merged-worktrees.ts … | tail` era barrado com uma mensagem que
 * falava de session-registry/marker/resolve-*-plan-path).
 *
 * Varre todos os alvos em vez de parar no primeiro invocado (comportamento
 * anterior de `matchesInjectableTarget`): um bloco com
 * `session-registry.ts list-active` (leitura, não exige a flag) seguido de
 * `cleanup-merged-worktrees.ts` retornava `false` no 1º alvo e nunca olhava
 * o 2º — falso negativo, o lado errado para este guard.
 */
function matchedInjectableTargets(command) {
  const names = [];
  for (const target of SESSION_ID_TARGETS) {
    if (isScriptInvoked(command, target.match) && target.needsSessionId(command)) {
      names.push(target.match);
    }
  }
  return names;
}

/** Decide se `command` é candidato a injeção — script-alvo + subcomando reconhecido. */
export function needsSessionId(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (isChainedCommand(command)) return false;
  return matchesInjectableTarget(command);
}

/** `true` se o comando já traz `--session-id` explicitamente — nunca sobrescrever. */
export function alreadyHasSessionId(command) {
  return typeof command === "string" && /--session-id\b/.test(command);
}

/**
 * #7212: detecta o caso em que um comando ENCADEADO (`&&`/`;`/`|`/multi-linha)
 * invoca um dos scripts-alvo com um subcomando/flag que exige `--session-id`,
 * sem já trazer a flag explícita. Diferente de `needsSessionId` (que decide
 * SE injeta em comando standalone — nunca em encadeado, de propósito, #5751
 * item 18: não há como saber a qual comando do bloco a flag pertence), esta
 * função decide se a chamada deve ser BLOQUEADA em vez de deixada passar.
 *
 * Motivação (incidente ao vivo #7212, 02/09/2026): sem este guard, o
 * subcomando roda sem `--session-id`, falha alto (`requireSessionId`, exit
 * 1) — mas esse erro pode se perder no meio da saída de outros comandos do
 * mesmo bloco (`git checkout … | git pull … ; npx tsx …`), ou ser engolido
 * por completo quando o bloco redireciona (`> /dev/null 2>&1`, caso real:
 * `for i in …; do npx tsx scripts/lib/session-registry.ts unclaim-issue … >
 * /dev/null 2>&1; echo "unclaim $i"; done` — as três chamadas falharam em
 * silêncio, e a única saída visível foi a do `echo`, indistinguível de
 * sucesso). Um `PreToolUse` `deny` aqui é impossível de engolir com
 * redirect — vira o "grito" que a issue pede, em vez de deixar o script
 * gritar sozinho e torcer pra alguém ouvir.
 *
 * Retorna a mensagem de bloqueio (`permissionDecisionReason`) ou `null`
 * quando não há risco — inclui o caso em que o comando encadeado já traz
 * `--session-id` explícito (não depende da injeção automática, roda igual
 * a uma chamada standalone que já tem a flag).
 */
export function detectChainedSessionIdRisk(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (!isChainedCommand(command)) return null;
  // #12050: corpo de heredoc de DADOS (delimitador citado, consumidor
  // cat/tee/gh --body-file -, ninguém executa o arquivo depois) não é
  // invocação — sai da checagem. O `--session-id` também é procurado só fora
  // desse corpo: uma menção à flag no texto não cobre a chamada real.
  const checked = stripSafeDataHeredocBodies(command);
  if (alreadyHasSessionId(checked)) return null;
  const matched = matchedInjectableTargets(checked);
  if (matched.length === 0) return null;
  return (
    "Comando encadeado (&&, ;, |, ||, ou múltiplas linhas) contém uma chamada a " +
    `${matched.join(" / ")} ` +
    "que exige --session-id. O hook de injeção automática (#5156) só atua em " +
    "comando STANDALONE — encadeado, a chamada sairia com '--session-id ausente' " +
    "(exit 1), erro que pode se perder no meio da saída do bloco ou ser engolido " +
    "por um redirect (> /dev/null, 2>&1) sem sinal nenhum de falha (#7212). " +
    "Rode essa chamada isolada, numa invocação de Bash separada — ou, se genuinamente " +
    "precisar encadear, passe --session-id explícito você mesmo."
  );
}

/**
 * Decide se `command` é candidato a injeção de `--pid` — só o subcomando
 * `register` de `session-registry.ts` (#6160). Mesma restrição de comando
 * encadeado que `needsSessionId` já aplica: nunca injeta no meio de um
 * `&&`/`;`/`|`/script multi-linha.
 *
 * #7264/#7281 fleet review: usa `isScriptInvoked` (invocação de verdade,
 * não `command.includes` bruto) pelo MESMO motivo que `matchesInjectableTarget`
 * mudou — sem isso, um comando que apenas MENCIONA "session-registry.ts" e
 * a palavra "register" em prosa (ex: `gh issue create --title "Fix
 * session-registry.ts register bug" --body "..."`) ainda anexaria `--pid`
 * ao comando, corrompendo-o — a mesma classe de falso positivo que este
 * fix resolveu pro `--session-id`, só que no caminho irmão.
 */
export function needsPid(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (isChainedCommand(command)) return false;
  return isScriptInvoked(command, TARGET_REGISTRY) && REGISTER_SUBCOMMAND.test(command);
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
  // #9197: path com espaço/não-ASCII chega percent-encoded em import.meta.url
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
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
      // #7212: bloqueia ANTES de sequer tentar injetar — comando encadeado
      // que precisaria de --session-id nunca recebe a flag (isChainedCommand
      // segue rejeitando #5751 item 18), e deixá-lo passar sem a flag
      // reproduz o incidente (erro real perdido no meio de outra saída, ou
      // engolido por um redirect). Deny é impossível de engolir.
      const chainedRisk = detectChainedSessionIdRisk(command);
      if (chainedRisk) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: chainedRisk,
            },
          }),
        );
        return;
      }
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
