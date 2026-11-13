// PreToolUse hook — recusa `git checkout -b`/`git switch -c` (criação de
// branch) quando a chamada roda no checkout PRINCIPAL compartilhado (não um
// worktree de subagente) E existe uma rodada coordenadora
// overnight/develop/continuo ATIVA cujo `session_id` não é o desta chamada
// (#6509). Desde a #12165 também recusa, nas mesmas condições, trocar o
// checkout principal para uma branch existente que não seja master
// (`changesBranch`) — inclusive o par `git branch X && git checkout X` citado
// abaixo como contorno. Desde a #12308 inclui `gh pr checkout` (alvo cwd/cd).
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
// por `session-beacon.mjs` (`isLinkedWorktree`), mas a partir de
// `payload.cwd` (o cwd REAL da chamada que disparou o hook), subindo até
// achar `.git` (`findGitRootNoSpawn`) — NUNCA a partir de
// `import.meta.url`/`hookDir` (achado #8937, 28/09/2026, mesma classe do
// #7712 já corrigido em `session-beacon.mjs`).
//
// **Por que NÃO `import.meta.url`:** `${CLAUDE_PROJECT_DIR}` em
// `.claude/settings.json` é fixado na raiz do checkout PRINCIPAL da sessão
// no momento em que ela começou — e continua apontando pra lá mesmo quando
// o hook dispara dentro de um worktree de subagente (`isolation:
// "worktree"`). A premissa do comentário anterior ("cada worktree tem sua
// PRÓPRIA cópia deste arquivo, então `hookDir` resolve pro PRÓPRIO
// worktree") nunca foi verdadeira na prática: medição direta documentada em
// `session-beacon.mjs` (`findGitRootNoSpawn`, #7712) mostrou que o arquivo
// que de fato roda é SEMPRE a cópia do checkout principal, porque é o
// caminho fixo em `settings.json` que o harness invoca — `import.meta.url`
// dentro dele reflete essa raiz fixa, não o cwd real da chamada. Resultado:
// `isLinkedWorktree(checkoutRoot)` com `checkoutRoot` derivado de
// `import.meta.url` nunca reconhecia um subagente de worktree como tal, e o
// guard bloqueava `git checkout -b`/`git switch -c` dentro do PRÓPRIO
// worktree isolado do subagente (`.git` ali é ARQUIVO, não diretório) toda
// vez que havia uma rodada coordenadora ativa — falso positivo relatado ao
// vivo em 28/09/2026, contornável com `git branch X && git checkout X`
// (mesmo comando, sem o `-b`, nunca detectado por `isBranchCreateCheckoutCommand`).
//
// `data/sessions/` mora sob o checkout PRINCIPAL (junction OneDrive) — como
// só prosseguimos além do `isLinkedWorktree` check quando o checkout É o
// principal, a raiz resolvida (`cwdRoot`, agora a partir de `payload.cwd`)
// já é a raiz certa para achar `data/sessions/`, sem precisar de `git
// rev-parse --git-common-dir` (que `block-gh-pr-merge-subagent.mjs`
// precisa, porque aquele hook roda de QUALQUER worktree e sempre precisa
// achar o principal indiretamente).
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos: um import estático de `.ts` quebra o hook inteiro,
// silenciosamente, num Node sem type-stripping nativo. A leitura de
// `data/sessions/*.json` e a detecção de worktree são DUPLICADAS (não
// importadas) de `session-registry.ts`/`session-beacon.mjs` —
// versões mínimas, só o necessário para este guard.
//
// #12165 (decisão do editor, 05/11/2026) REVOGA o 1º item abaixo: trocar o
// checkout principal para uma branch existente que não seja master
// (`git -C <principal> switch X`, `cd <principal> && git checkout X`, ou o
// mesmo comando com cwd no principal) agora conta como `checkout -b` —
// `changesBranch`. Voltar para master/main segue livre; restauração de
// arquivo (`checkout -- f`, `checkout <ref> <paths>`) fica de fora — e, desde
// a #12286, também `checkout X` quando X existe no disco relativo ao alvo
// (`Makefile`, `scripts`) e não é branch local nem tag. Também desde a #12286
// o corpo de heredoc não é lido como comando quando quem o lê é um
// consumidor de texto conhecido (`cat`, `gh`, `npx tsx`, `git commit -F`);
// qualquer outro leitor (`bash`, `timeout 30 bash`, `| sh`) mantém o corpo
// tokenizado (fail-closed). O texto
// abaixo fica como registro do porquê de ter ficado fora até ali.
//
// Escopo explicitamente FORA (#6509, reconfirmado no #8937):
//   - `git checkout <branch-existente>` sem `-b` — cenário distinto, blast
//     radius maior (bloquear TODO checkout no diretório principal, inclusive
//     de volta pra `master`, que é exatamente o caso QUE ESTE GUARD PRECISA
//     PERMITIR pra `context/overnight-dispatch-rules.md` funcionar — a
//     coordenadora e qualquer sessão precisam poder `git checkout master`
//     livremente). O #8937 considerou estender o bloqueio a esse par
//     (`git branch X && git checkout X`, o contorno relatado ali), mas
//     decidiu não fazê-lo: o par SÓ é equivalente a `checkout -b` quando o
//     branch acabou de ser criado (`git branch X`) — indistinguível, sem
//     spawnar `git`, de um `git checkout <branch-JÁ-existente>` legítimo
//     (voltar pra uma feature branch em andamento), que este guard não deve
//     bloquear. Resolver isso corretamente exigiria inspecionar o estado do
//     branch (novo vs. já existente), não só o texto do comando — mudança
//     de escopo maior, fora do que o #8937 pediu (só a detecção de worktree
//     estava quebrada, não a superfície de comandos cobertos).
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
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, hostname } from "node:os";
import { stripQuotedSpans } from "./lib/shell-quote-strip.mjs";

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
  ".claude/worktrees/ e rode o git checkout -b ali. O alvo é lido do próprio comando (#12165): cwd da " +
  "sessão, `cd <dir>` anterior e `git -C <dir>`; alvo com variável definida fora do comando ou " +
  "substituição (`cd $W` sem `W=/caminho` antes no mesmo comando, `git -C \"$(...)\"`) não é resolvido e " +
  "conta como checkout principal — use o caminho literal do worktree. " +
  "Trocar o checkout principal para uma branch existente (`git -C <principal> switch X`, `cd <principal> && " +
  "git checkout X`) também é bloqueado, exceto para master pelo nome (`git checkout master`, não `-`/`@{-1}`; " +
  "#12165). `gh pr checkout` também troca a branch local e é bloqueado (#12308). Restaurar arquivo: `git checkout -- <path>` ou `git restore <path>`. " +
  "Se você é a coordenadora e está vendo este bloqueio por " +
  "engano (ex: seu próprio registro expirou por staleness), rode `npx tsx scripts/lib/session-registry.ts " +
  "register --kind {overnight|develop|continuo}` (o SEU kind) para renovar o registro que já era seu, e " +
  "tente de novo.";

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles — inclusive newlines. Duplicado de
 * `block-gh-pr-merge-subagent.mjs` (`stripQuotedSpans`), mesma razão
 * self-contained.
 */
export { stripQuotedSpans };

/**
 * `true` se `command` contém `git checkout -b <nome>` OU `git switch
 * -c|--create <nome>` — ou, desde a #12165, um `switch`/`checkout` para
 * branch que não seja master (`changesBranch`) — como um comando REAL (segmento entre separadores de
 * comando `&&`/`;`/`|`/`\n`), depois de remover o conteúdo de qualquer aspas
 * (mesma proteção de `isGhPrMergeCommand` contra citação dentro de um
 * `--body`/string — #5787 Defeito 3/#5805).
 *
 * Detecção por TOKEN (não regex gulosa sobre a string inteira) — divide cada
 * segmento em tokens por espaço e procura `-b`/`-c`/`--create` como token
 * exato depois de `git checkout`/`git switch`, nunca como substring de outra
 * flag (`--builder` não casa).
 */
export function isBranchCreateCheckoutCommand(command, baseCwd = null) {
  if (typeof command !== "string") return false;
  // #12165: reconhece também opções globais antes do subcomando (`git -C
  // <dir> switch -c X`, `git -c k=v checkout -b X`) e `VAR=x git ...` — o
  // tokenizer de `resolveBranchCreateTargets` mantém o conteúdo entre aspas
  // num token só, então um `git checkout -b` citado num `--body` segue fora.
  // #12286: sem `baseCwd`, `git checkout Makefile` não tem como ser conferido
  // no disco e segue contando como troca; com ele, path existente é restauração.
  return resolveBranchCreateTargets(command, baseCwd).length > 0;
}

// ---------------------------------------------------------------------------
// Alvo do comando (#12165): o diretório em que o `git` de fato roda.
//
// Até o #12165 a raiz era resolvida só a partir de `payload.cwd` (o cwd da
// SESSÃO). Dois defeitos, achados ao vivo em 04/11/2026 (#12092):
//   1. falso positivo — `cd <worktree linkado> && git switch -c X` rodado de
//      uma sessão no checkout principal era bloqueado, embora o alvo fosse
//      o worktree;
//   2. furo — `git -C <checkout principal> switch -c X` rodado de um worktree
//      linkado passava (o `-C` nem era reconhecido: `tokens[1]` era `-C`, não
//      `switch`), trocando a branch do checkout PRINCIPAL sem bloqueio.
//
// Agora o alvo é derivado do próprio comando: parte de `payload.cwd`, aplica
// cada `cd`/`pushd` anterior ao `git` (na ordem; `( ... )` isola o `cd` como
// o shell faz) e depois cada `-C <path>` do `git` (cumulativos, como no git).
// `$HOME`, `~` e variáveis atribuídas com valor literal ANTES no mesmo
// comando (`W=/abs/wt; cd $W && ...`, a forma do caso real) são expandidos.
// Quando o alvo não dá para resolver (`cd $W` com `W` de fora do comando,
// `cd -`, `popd`, `git -C "$(...)"`, `--git-dir`/`--work-tree`), o segmento é
// tratado como checkout
// PRINCIPAL — fail-closed (#12165): um alvo desconhecido nunca libera sozinho.
// Isso só morde quando há coordenadora ativa e a chamada não é dela, então
// o comando comum de subagente (`git checkout -b X` com cwd no próprio
// worktree, ou `cd /abs/worktree && ...`) continua passando.
// ---------------------------------------------------------------------------

/** Marcador de alvo não resolvido (fail-closed). */
export const UNRESOLVED = null;

/**
 * Tokeniza `command` em segmentos de comando preservando o VALOR entre aspas,
 * dividindo nos separadores de shell FORA de aspas (`&&`, `||`, `|`, `;`,
 * `&`, newline) e emitindo `(`/`)` como segmentos próprios (subshell, para
 * isolar `cd`). Cada token é `{ value, dynamic }`: `dynamic` = contém
 * expansão que o hook não avalia (`$VAR`, `$(...)`, crase, glob) fora de
 * aspas simples. `~`/`$HOME` no início viram o home do usuário.
 *
 * Self-contained de propósito (mesma razão do topo do arquivo).
 */
export function tokenizeShellSegments(command, home = safeHomedir()) {
  const segments = [];
  if (typeof command !== "string") return segments;
  let tokens = [];
  let value = "";
  let dynamic = false;
  let inToken = false;
  let rawStart = true; // token começa sem aspas (para expandir `~`)
  // Um item por `(` aberto: `null` = subshell comum; objeto = `$(` (estado do
  // token/segmento de fora, retomado no `)` correspondente — #12214).
  const parenStack = [];
  const pushToken = () => {
    if (!inToken) return;
    let v = value;
    if (rawStart && (v === "~" || v.startsWith("~/"))) {
      if (home) v = home + v.slice(1);
      else dynamic = true;
    }
    tokens.push({ value: v, dynamic });
    value = "";
    dynamic = false;
    inToken = false;
    rawStart = true;
  };
  // Índices (em `segments`) dos segmentos que recebem stdin de um `|` (#12286).
  const pipedSegs = new Set();
  let pipeNext = false;
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) {
      if (pipeNext) pipedSegs.add(segments.length);
      segments.push(tokens);
    }
    pipeNext = false;
    tokens = [];
  };
  const n = command.length;
  // #12286: heredocs abertos na linha corrente (`<<EOF`, `<<'EOF'`, `<<-EOF`,
  // `<<END-OF-X`), em ordem. O corpo começa na linha seguinte e só deixa de
  // virar segmento quando quem lê o stdin é um consumidor de TEXTO conhecido
  // (`heredocBodyIsText`) — senão uma linha do corpo de `gh-pr-review-api.ts
  // reply --body-file - <<'EOF'` que começasse com `git checkout x` era lida
  // como comando. Fail-closed: qualquer outro leitor (`bash`, `timeout 30
  // bash`, `source /dev/stdin`, `| sh`) mantém o corpo tokenizado, e um
  // delimitador que o hook não reconhece não abre heredoc nenhum.
  let pendingHeredocs = [];
  let lineSegStart = 0; // índice em `segments` do 1º segmento da linha corrente
  let i = 0;
  while (i < n) {
    const ch = command[i];
    if (ch === "#" && !inToken) {
      // Comentário: vai até o fim da linha e nada dentro dele é tokenizado —
      // nem aspas (#12512: `# it's ok` abria uma aspa simples que só fechava
      // no apóstrofo do comentário seguinte, engolindo o `git checkout` das
      // linhas do meio), nem `\` + newline (o bash não continua comentário),
      // nem `<<` (não abre heredoc, #12286). O `\n` é tratado no laço.
      const end = command.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (
      ch === "<" &&
      command[i + 1] === "<" &&
      command[i + 2] !== "<" &&
      command[i - 1] !== "<" &&
      !insideArithmetic(command, i)
    ) {
      const open = parseHeredocOpen(command, i);
      if (open) {
        pushToken();
        // Segmento a que o heredoc pertence: o corrente, ainda não empurrado.
        // `inSubst`: aberto dentro de `$(...)`/`<(...)`/`( ... )` — a saída
        // pode virar comando (`eval $(cat <<EOF`, `bash <(cat <<EOF`), então o
        // corpo segue tokenizado (review da PR #12433).
        pendingHeredocs.push({
          delim: open.delim,
          dash: open.dash,
          seg: segments.length,
          inSubst: parenStack.length > 0,
        });
        i = open.end;
        continue;
      }
    }
    if (ch === "\n" && pendingHeredocs.length > 0) {
      // `cat <<EOF |` + newline: o pipeline continua DEPOIS do corpo.
      const lineEndsInPipe = pipeNext && tokens.length === 0 && !inToken;
      pushSegment();
      const keepBody =
        lineEndsInPipe ||
        !pendingHeredocs.every((h) => !h.inSubst && heredocBodyIsText(segments, pipedSegs, h.seg));
      let j = i + 1;
      for (const h of pendingHeredocs) {
        // Cada heredoc consome as linhas até o seu terminador, na ordem.
        while (j < n) {
          const end = command.indexOf("\n", j);
          const line = command.slice(j, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
          if ((h.dash ? line.replace(/^\t+/, "") : line).replace(/[ \t]+$/, "") === h.delim) break;
        }
      }
      pendingHeredocs = [];
      lineSegStart = segments.length;
      // Corpo que pode ser comando: segue tokenizando a partir da linha
      // seguinte. Corpo de texto: retoma no terminador (ou no fim).
      i = keepBody ? i + 1 : j;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      if (command[i + 1] !== "\n") {
        if (!inToken) rawStart = false;
        inToken = true;
        value += command[i + 1];
      }
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushToken();
      i++;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      pushSegment();
      if (ch === "\n") lineSegStart = segments.length;
      // `|` (e `|&`) sozinho é pipe: o próximo segmento lê o stdout deste.
      if (ch === "|" && command[i + 1] !== "|") {
        pipeNext = true;
        if (command[i + 1] === "&") i++;
        i++;
        continue;
      }
      // `&&`, `||`, `;;` contam como um separador só.
      if ((ch === "&" || ch === "|" || ch === ";") && command[i + 1] === ch) i++;
      i++;
      continue;
    }
    if (ch === "(") {
      if (inToken && value.endsWith("$")) {
        // `$(` é substituição de comando (#12214): o conteúdo interno é
        // emitido como subshell (o `cd` lá dentro não vaza, e um `git switch
        // -c` lá dentro segue detectado), mas o token corrente e o SEGMENTO
        // corrente continuam depois do `)` correspondente — `git -C
        // $(git rev-parse --show-toplevel) switch -c X` fica um segmento só,
        // com o valor do `-C` dinâmico (alvo não resolvido = fail-closed).
        // Antes, o `(` encerrava o segmento e o resto (`switch -c X`) virava
        // um segmento que não começava com `git`, liberando o comando.
        parenStack.push({ tokens, value, rawStart, start: i });
        tokens = [];
        value = "";
        dynamic = false;
        inToken = false;
        rawStart = true;
      } else {
        parenStack.push(null);
        pushSegment();
      }
      segments.push([{ value: "(", dynamic: false, paren: true }]);
      i++;
      continue;
    }
    if (ch === ")") {
      const frame = parenStack.length > 0 ? parenStack.pop() : null;
      pushSegment();
      segments.push([{ value: ")", dynamic: false, paren: true }]);
      if (frame) {
        tokens = frame.tokens;
        value = frame.value + command.slice(frame.start, i + 1);
        dynamic = true;
        inToken = true;
        rawStart = frame.rawStart;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      if (!inToken) rawStart = false;
      inToken = true;
      let j = i + 1;
      while (j < n && command[j] !== "'") value += command[j++];
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      if (!inToken) rawStart = false;
      inToken = true;
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        // #12544: entre aspas duplas o bash só trata `\` como escape antes de
        // `$`, crase, `"`, `\` e newline; nos outros casos a barra fica. Antes
        // ela sumia sempre, e `cd "C:\Users\x\wt"` (forma comum no Git Bash
        // do Windows) virava `C:Usersxwt`, um caminho relativo ao drive: o
        // guard decidia sobre outro diretório.
        if (command[j] === "\\" && j + 1 < n && DQUOTE_ESCAPABLE.has(command[j + 1])) {
          if (command[j + 1] !== "\n") value += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === "$" || command[j] === "`") dynamic = true;
        value += command[j++];
      }
      i = j + 1;
      continue;
    }
    if (ch === "$" || ch === "`" || ch === "*" || ch === "?" || ch === "[") dynamic = true;
    inToken = true;
    value += ch;
    i++;
  }
  pushSegment();
  return segments;
}

/** Caracteres que `\` escapa dentro de aspas duplas no bash (#12544). */
const DQUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/** Caracteres que encerram a palavra do delimitador fora de aspas. */
const HEREDOC_WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

/**
 * Lê a abertura de heredoc que começa em `command[i]` (`<<`): `-` opcional,
 * brancos e a PALAVRA inteira do delimitador, como o bash (#12286): `END-OF-X`,
 * `EOF.x`, `'EOF'`, `"END-MSG"`, `E'O'F` e `\EOF` viram o delimitador sem as
 * aspas. Devolve `{ delim, dash, end }` (`end` = índice depois da palavra) ou
 * `null` quando não há palavra reconhecível (`<<` no fim, aspa sem fechar,
 * delimitador vazio) — aí o `<<` não abre heredoc e o resto segue lido como
 * comando (fail-closed).
 */
function parseHeredocOpen(command, i) {
  const n = command.length;
  let j = i + 2;
  const dash = command[j] === "-";
  if (dash) j++;
  while (command[j] === " " || command[j] === "\t") j++;
  let delim = "";
  while (j < n && !HEREDOC_WORD_END.has(command[j])) {
    const c = command[j];
    if (c === "'") {
      const close = command.indexOf("'", j + 1);
      if (close === -1) return null;
      delim += command.slice(j + 1, close);
      j = close + 1;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      while (k < n && command[k] !== '"') {
        if (command[k] === "\\" && k + 1 < n && '"\\$`'.includes(command[k + 1])) k++;
        delim += command[k++];
      }
      if (k >= n) return null;
      j = k + 1;
      continue;
    }
    if (c === "\\") {
      if (j + 1 >= n || command[j + 1] === "\n") return null;
      delim += command[j + 1];
      j += 2;
      continue;
    }
    delim += c;
    j++;
  }
  if (delim === "") return null;
  return { delim, dash, end: j };
}

/**
 * `true` só quando o corpo do heredoc aberto no segmento `segIdx` é TEXTO com
 * certeza (#12286, fail-closed): o comando que o lê é um consumidor de texto
 * conhecido (`isHeredocTextConsumer`), e todo segmento que recebe esse stdout
 * por pipe na mesma linha também é. Subshell/substituição de processo depois
 * do heredoc (`| (bash)`, `tee >(sh)`) ou segmento inexistente → `false`, e o
 * corpo segue tokenizado como comando.
 */
function heredocBodyIsText(segments, pipedSegs, segIdx) {
  if (!isHeredocTextConsumer(segments[segIdx])) return false;
  for (let k = segIdx + 1; k < segments.length; k++) {
    const seg = segments[k];
    if (seg.length === 1 && seg[0].paren) return false;
    if (pipedSegs.has(k) && !isHeredocTextConsumer(seg)) return false;
  }
  return true;
}

/** Comandos que só leem o stdin como texto/dado, nunca como comando de shell. */
const HEREDOC_TEXT_CONSUMERS = new Set(["gh", "node"]);
/** `cat`/`tee` só contam como texto quando escrevem no stdout (review da PR
 * #12433): com arquivo (`tee /tmp/f.sh`, `cat > /tmp/f.sh`) o corpo pode
 * virar script executado depois (`sh /tmp/f.sh`). */
const HEREDOC_STDOUT_ONLY_CONSUMERS = new Set(["cat", "tee"]);

/** `true` quando o segmento começa (fora atribuições `VAR=x`) por um
 * consumidor de texto: `cat`/`tee` sem arquivo nem redirecionamento de
 * saída, `gh`, `node`, `npx tsx` ou `git commit -F|--file`. Prefixo
 * (`timeout`, `sudo`, `env`), interpretador (`bash`, `source`, `.`), token
 * dinâmico ou qualquer outro comando → `false`. */
function isHeredocTextConsumer(seg) {
  if (!Array.isArray(seg) || seg.length === 0 || seg[0].paren) return false;
  const k = skipAssignments(seg);
  const head = seg[k];
  if (!head || head.dynamic) return false;
  const name = head.value.replace(/^.*[\\/]/, "");
  if (HEREDOC_STDOUT_ONLY_CONSUMERS.has(name)) {
    return seg.slice(k + 1).every((t) => !t.dynamic && t.value.startsWith("-") && !t.value.includes(">"));
  }
  if (HEREDOC_TEXT_CONSUMERS.has(name)) return true;
  if (name === "npx") return seg[k + 1]?.value === "tsx" && !seg[k + 1].dynamic;
  if (name !== "git") return false;
  let j = k + 1;
  while (j < seg.length && seg[j].value.startsWith("-")) j += seg[j].value === "-C" || seg[j].value === "-c" ? 2 : 1;
  if (seg[j]?.value !== "commit") return false;
  return seg.slice(j + 1).some((t) => /^-F/.test(t.value) || t.value === "--file" || t.value.startsWith("--file="));
}

/** true quando `index` cai dentro de `((...))`/`$((...))` aberto na mesma
 * linha — ali `<<` é shift aritmético, não heredoc (#9214). Cópia de
 * `block-npm-install-node-modules-symlink.mjs` (self-contained). */
function insideArithmetic(command, index) {
  const lineStart = command.lastIndexOf("\n", index - 1) + 1;
  const before = command.slice(lineStart, index);
  const open = before.lastIndexOf("((");
  return open !== -1 && before.indexOf("))", open) === -1;
}

/**
 * Expande `$NOME`/`${NOME}` de um token dinâmico com as variáveis CONHECIDAS
 * (`vars`: `HOME` + atribuições literais anteriores no MESMO comando, ex.
 * `W=/abs/wt; cd $W && git switch -c X` — a forma do caso real da #12165).
 * Devolve o token resolvido (`dynamic: false`) ou o próprio token quando
 * sobra qualquer expansão desconhecida (`$OUTRA`, `$(...)`, crase, glob).
 */
function expandKnownVars(token, vars) {
  if (!token || !token.dynamic) return token;
  let unknown = false;
  const value = token.value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a, b) => {
    const name = a ?? b;
    if (vars.has(name)) return vars.get(name);
    unknown = true;
    return m;
  });
  if (unknown || /[$`*?[]/.test(value)) return token;
  return { value, dynamic: false };
}

/** `true` quando o segmento é SÓ atribuições (`W=/x`, `export W=/x`). */
function recordAssignments(seg, vars) {
  const start = seg[0]?.value === "export" ? 1 : 0;
  if (seg.length <= start) return false;
  for (let k = start; k < seg.length; k++) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k].value)) return false;
  }
  for (let k = start; k < seg.length; k++) {
    const eq = seg[k].value.indexOf("=");
    const name = seg[k].value.slice(0, eq);
    const resolved = expandKnownVars({ value: seg[k].value.slice(eq + 1), dynamic: seg[k].dynamic }, vars);
    if (resolved.dynamic) vars.delete(name);
    else vars.set(name, resolved.value);
  }
  return true;
}

function safeHomedir() {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

/**
 * #12544: no Windows, o Git Bash monta cada drive em `/<letra>` (`/c/Users/x`
 * = `C:\Users\x`). O `path` do Node lê `/c/Users/x` como `C:\c\Users\x`, um
 * diretório que não existe, e o guard caía no fallback (o checkout principal
 * da sessão) mesmo quando o `cd` ia para um worktree linkado. Converte só
 * `/<uma letra>` seguido de `/` ou fim; fora do win32 devolve o valor intacto.
 */
export function msysDrivePathToNative(v, platform = process.platform) {
  if (platform !== "win32" || typeof v !== "string") return v;
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(v);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : v;
}

/** Resolve `arg` contra `cwd`; `UNRESOLVED` se qualquer um dos dois for. */
function resolveDir(cwd, rawToken, vars) {
  const token = expandKnownVars(rawToken, vars);
  if (!token || token.dynamic) return UNRESOLVED;
  const v = msysDrivePathToNative(token.value);
  if (v === "" || v === "-") return UNRESOLVED;
  if (isAbsolute(v)) return resolvePath(v);
  if (cwd === UNRESOLVED) return UNRESOLVED;
  return resolvePath(cwd, v);
}

/** Pula atribuições `VAR=valor` no início do segmento (`FOO=1 git ...`). */
function skipAssignments(seg) {
  let k = 0;
  while (k < seg.length && !seg[k].dynamic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k].value)) k++;
  return k;
}

/** Opções globais do git que consomem o token seguinte como valor. */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(["-c", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);
/** Opções globais que trocam o alvo de um jeito que este hook não modela. */
const GIT_TARGET_OVERRIDE_OPTS = ["--git-dir", "--work-tree"];

/**
 * Para cada `git checkout -b`/`git switch -c|--create` REAL em `command`,
 * devolve o diretório-alvo em que ele roda (`string`) ou `UNRESOLVED`
 * (`null`) quando não dá para resolver — ver o bloco de comentário acima.
 * `baseCwd` é o cwd da sessão (`payload.cwd`); se ausente, o alvo de um
 * comando sem `cd`/`-C` absoluto fica `UNRESOLVED`.
 *
 * Lista vazia = o comando não cria branch (nada a decidir).
 */
export function resolveBranchCreateTargets(command, baseCwd, home = safeHomedir()) {
  const targets = [];
  let cwd = typeof baseCwd === "string" && baseCwd.trim() !== "" ? resolvePath(baseCwd) : UNRESOLVED;
  const stack = [];
  let vars = new Map(home ? [["HOME", home]] : []);
  const segments = tokenizeShellSegments(command, home);
  // Review da PR #12433: se o mesmo comando cria/atualiza refs (`git branch
  // docs && git checkout docs`), o estado do disco lido agora não vale para
  // o checkout — o disco não é consultado e `checkout X` conta como troca.
  const refsMayChange = segments.some(segmentMutatesRefs);
  for (const seg of segments) {
    if (seg.length === 1 && seg[0].paren) {
      // Subshell: `cd` e atribuições lá dentro não vazam para fora.
      if (seg[0].value === "(") stack.push({ cwd, vars: new Map(vars) });
      else if (stack.length > 0) ({ cwd, vars } = stack.pop());
      continue;
    }
    if (recordAssignments(seg, vars)) continue;
    const k = skipAssignments(seg);
    const head = seg[k];
    if (!head) continue;
    if (head.value === "cd" || head.value === "pushd") {
      const args = seg.slice(k + 1).filter((t) => t.dynamic || (t.value !== "--" && !/^-[LPe@]+$/.test(t.value)));
      cwd = args.length === 0 ? (head.value === "cd" && home ? home : UNRESOLVED) : resolveDir(cwd, args[0], vars);
      continue;
    }
    if (head.value === "popd") {
      cwd = UNRESOLVED;
      continue;
    }
    // #12308: gh troca a branch local mesmo com -R apontando para outro repo.
    // As opções globais podem aparecer antes de `pr` ou entre `pr` e `checkout`.
    if (head.value === "gh") {
      let j = k + 1;
      const skipRepoFlags = () => {
        while (j < seg.length) {
          const v = seg[j].value;
          if (v === "-R" || v === "--repo") j += 2;
          else if (v.startsWith("--repo=") || (v.startsWith("-R") && v.length > 2)) j++;
          else break;
        }
      };
      skipRepoFlags();
      if (seg[j]?.value === "pr") {
        j++;
        skipRepoFlags();
        if (seg[j]?.value === "checkout") targets.push(cwd);
      }
      continue;
    }
    if (head.value !== "git") continue;
    // Opções globais entre `git` e o subcomando.
    let target = cwd;
    let j = k + 1;
    while (j < seg.length) {
      const t = seg[j];
      const v = t.value;
      if (v === "-C") {
        target = resolveDir(target, seg[j + 1], vars);
        j += 2;
        continue;
      }
      if (GIT_TARGET_OVERRIDE_OPTS.some((o) => v === o || v.startsWith(o + "="))) {
        target = UNRESOLVED;
        j += v.includes("=") ? 1 : 2;
        continue;
      }
      if (GIT_GLOBAL_OPTS_WITH_VALUE.has(v)) {
        j += 2;
        continue;
      }
      if (t.dynamic) {
        // `git $OPTS switch -c X`: a expansão pode conter `-C <dir>`.
        target = UNRESOLVED;
        j += 1;
        continue;
      }
      if (v.startsWith("-")) {
        j += 1;
        continue;
      }
      break;
    }
    const sub = seg[j]?.value;
    const rest = seg.slice(j + 1).map((t) => t.value);
    if (changesBranch(sub, rest, refsMayChange ? null : target)) targets.push(target);
  }
  return targets;
}

/** Subcomandos do git que criam ou movem refs (review da PR #12433). */
const REF_MUTATING_GIT_SUBS = new Set(["branch", "fetch", "update-ref", "pull", "tag"]);

/** `true` quando o segmento roda `git branch|fetch|update-ref|pull|tag` ou
 * `git worktree add` (opções globais entre `git` e o subcomando puladas). */
function segmentMutatesRefs(seg) {
  if (seg.length === 1 && seg[0].paren) return false;
  const k = skipAssignments(seg);
  if (seg[k]?.value !== "git") return false;
  let j = k + 1;
  while (j < seg.length && seg[j].value.startsWith("-")) {
    const v = seg[j].value;
    j += v === "-C" || GIT_GLOBAL_OPTS_WITH_VALUE.has(v) || GIT_TARGET_OVERRIDE_OPTS.includes(v) ? 2 : 1;
  }
  const sub = seg[j]?.value;
  if (sub === undefined || seg[j].dynamic) return sub !== undefined;
  if (REF_MUTATING_GIT_SUBS.has(sub)) return true;
  return sub === "worktree" && seg[j + 1]?.value === "add";
}

/** Branches para as quais trocar o checkout principal é sempre livre (#12165,
 * decisão do editor 05/11/2026): voltar para master é o caso que o guard
 * precisa permitir. */
export const FREE_SWITCH_TARGETS = new Set(["master", "main", "origin/master", "origin/main"]);

/** Flag de criação de branch (`-b`/`-B`/`--orphan` no checkout, `-c`/`-C`/
 * `--create`/`--force-create`/`--orphan` no switch), inclusive colada
 * (`-bfoo`, `--create=foo`, `--orphan=x`). */
function isCreateFlag(sub, t) {
  if (sub === "checkout") return /^-[bB]/.test(t) || t === "--orphan" || t.startsWith("--orphan=");
  return /^-[cC]/.test(t) || /^--(?:create|force-create|orphan)(?:=|$)/.test(t);
}

/** Opções de `checkout` que só operam em arquivo, nunca trocam de branch: com
 * elas o posicional é path (`--ours f`, `-p HEAD`). `-m`/`--merge` ficam de
 * fora de propósito: com branch (`checkout -m feat`) são troca levando as
 * mudanças locais, e o `looksLikePath` decide o caso com path. */
const CHECKOUT_PATH_MODE_FLAGS = new Set(["--ours", "--theirs", "-p", "--patch"]);

/** Argumento posicional de `git checkout` com cara de caminho de arquivo, não
 * de branch: `.`, `./x`, `../x`, `dir/` ou extensão que começa por letra
 * (`scripts/foo.ts`). `release/v1.2` e `fix-1-sonnet-5.5` seguem branch. */
function looksLikePath(arg) {
  return arg === "." || arg.startsWith("./") || arg.startsWith("../") || arg.endsWith("/") || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(arg);
}

/** Tira os redirecionamentos do shell (`2>&1`, `>/dev/null`, `> f`, `<f`) dos
 * argumentos — senão `git checkout feat 2>&1` contava 2 posicionais e
 * passava como restauração de arquivo (review da PR #12247). */
function stripRedirections(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (/^\d*(?:>>?|<)$/.test(t) || /^&>>?$/.test(t)) {
      i += 1; // operador solto: o próximo token é o alvo do redirecionamento
      continue;
    }
    if (/^\d*(?:>>?|<)/.test(t) || /^&>/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * `true` quando `git {sub} {rest}` cria branch OU troca a branch do checkout
 * para uma que não seja master (#12165, decisão do editor 05/11/2026: no
 * checkout principal, switch/checkout só passa se o alvo for master).
 * Restauração de arquivo (`checkout -- f`, `checkout <ref> <paths>`,
 * `checkout ./f`, `checkout --ours f`) não troca branch e fica de fora;
 * `checkout X --`, sem nada depois do `--`, é troca de branch.
 *
 * #12286: `targetDir` (diretório em que o git roda, quando resolvido) desfaz a
 * ambiguidade de `git checkout X` com X sem cara de path: se `targetDir/X`
 * existe (`Makefile`, `scripts`) e X não é branch local nem tag no repo do
 * alvo (`isKnownNotRef`), é restauração de arquivo/pasta. Alvo não
 * resolvido (`null`) não consulta o disco e segue contando como troca
 * (fail-closed). `git switch` nunca restaura arquivo, então não consulta.
 */
export function changesBranch(sub, rawRest, targetDir = null) {
  if (sub !== "checkout" && sub !== "switch") return false;
  const rest = stripRedirections(rawRest);
  if (rest.some((t) => isCreateFlag(sub, t))) return true;
  let args = rest;
  if (sub === "checkout") {
    const dd = rest.indexOf("--");
    if (dd !== -1) {
      if (dd < rest.length - 1) return false; // `checkout [ref] -- <paths>`
      args = rest.slice(0, dd);
    }
    if (args.some((t) => CHECKOUT_PATH_MODE_FLAGS.has(t))) return false;
  }
  const positional = args.filter((t) => !t.startsWith("-") || t === "-");
  if (positional.length !== 1) return false; // nenhum alvo, ou `<ref> <paths>`
  const name = positional[0];
  if (FREE_SWITCH_TARGETS.has(name)) return false;
  if (sub === "checkout" && looksLikePath(name)) return false;
  if (sub === "checkout" && isExistingPath(targetDir, name) && isKnownNotRef(targetDir, name)) return false;
  return true;
}

/** `true` quando `name` é um arquivo/pasta existente relativo a `dir`
 * (#12286). `-` e `@{-N}` são sintaxe de branch anterior, nunca path. */
function isExistingPath(dir, name) {
  if (typeof dir !== "string" || dir === "" || name === "-" || name.startsWith("@{")) return false;
  try {
    return existsSync(resolvePath(dir, name));
  } catch {
    return false;
  }
}

/**
 * `true` só quando dá para afirmar, sem spawnar git, que `name` NÃO é branch
 * local nem tag no repo de `dir` (#12286, review da PR #12433): com a branch
 * `docs` e a pasta `docs`, `git checkout docs` troca de branch — o git
 * prefere o ref. Lê `refs/<name>`, `refs/{heads,tags,remotes}/<name>` e
 * `packed-refs` no diretório COMUM do repo (worktree linkado: `gitdir:` do
 * arquivo `.git` e o `commondir` dele). Repo ou gitdir que não dá para ler,
 * ou repo em reftable → `false` (fail-closed: na dúvida, conta como troca).
 */
function isKnownNotRef(dir, name) {
  try {
    if (name.split("/").some((p) => p === "" || p === "." || p === "..")) return false;
    const commonDir = gitCommonDirOf(dir);
    if (commonDir === null) return false;
    // reftable: refs num formato binário que este hook não lê → na dúvida, ref.
    if (existsSync(join(commonDir, "reftable"))) return false;
    const parts = name.split("/");
    // `refs/<name>` (ex.: `stash`), `refs/{heads,tags}/<name>` e
    // `refs/remotes/<name>` (remoto inteiro, `git checkout origin` → HEAD dele).
    for (const ns of [[], ["heads"], ["tags"], ["remotes"]]) {
      if (existsSync(join(commonDir, "refs", ...ns, ...parts))) return false;
    }
    const packed = join(commonDir, "packed-refs");
    if (existsSync(packed)) {
      const wanted = new Set([`refs/${name}`, `refs/heads/${name}`, `refs/tags/${name}`, `refs/remotes/${name}`]);
      const remotePrefix = `refs/remotes/${name}/`;
      for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
        const ref = line.split(" ")[1]?.trim();
        if (ref !== undefined && (wanted.has(ref) || ref.startsWith(remotePrefix))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Diretório git COMUM (onde ficam `refs/` e `packed-refs`) do repo que
 * contém `dir`, sem spawnar git; `null` se não der para resolver. */
function gitCommonDirOf(dir) {
  const root = findGitRootNoSpawn(dir, 32);
  if (root === null) return null;
  const gitPath = join(root, ".git");
  if (statIsDirectory(gitPath)) return gitPath;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitPath, "utf8"));
  if (!m) return null;
  const gitdir = isAbsolute(m[1]) ? m[1] : resolvePath(root, m[1]);
  const commondirFile = join(gitdir, "commondir");
  if (existsSync(commondirFile)) {
    const rel = readFileSync(commondirFile, "utf8").trim();
    return rel === "" ? null : isAbsolute(rel) ? rel : resolvePath(gitdir, rel);
  }
  // Sem `commondir`: `.../<principal>/.git/worktrees/<nome>` → `.../.git`.
  const wt = /^(.*[\\/]\.git)[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
  return wt ? wt[1] : gitdir;
}

/**
 * Raiz do checkout PRINCIPAL a partir da raiz de um worktree linkado (lê o
 * `gitdir:` do arquivo `.git`, `.../<principal>/.git/worktrees/<nome>`).
 * Para o checkout principal devolve a própria raiz. `null` se não der.
 * Usado só para achar `data/sessions/` quando o alvo é `UNRESOLVED` e a
 * sessão está num worktree.
 */
export function mainCheckoutRootOf(root) {
  try {
    if (typeof root !== "string" || root === "") return null;
    const gitPath = join(root, ".git");
    if (!existsSync(gitPath)) return null;
    if (statIsDirectory(gitPath)) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitPath, "utf8"));
    if (!m) return null;
    const gitdir = isAbsolute(m[1]) ? m[1] : resolvePath(root, m[1]);
    const wt = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
    return wt ? wt[1] : null;
  } catch {
    return null;
  }
}

/**
 * Para cada alvo devolvido por `resolveBranchCreateTargets`, a raiz do
 * checkout PRINCIPAL que ele atinge (onde ler `data/sessions/`), ou nada
 * quando o alvo é um worktree linkado. `UNRESOLVED` → principal de
 * `fallbackRoot` (fail-closed). Alvo resolvido fora de qualquer repo →
 * `fallbackRoot` também (o git falharia de qualquer jeito; errar para
 * "principal" mantém o guard armado).
 *
 * Devolve a lista (sem repetição) de raízes principais atingidas.
 */
export function mainRootsHitByTargets(targets, fallbackRoot) {
  const roots = new Set();
  for (const target of targets) {
    if (target === UNRESOLVED) {
      roots.add(mainCheckoutRootOf(fallbackRoot) ?? fallbackRoot);
      continue;
    }
    const root = findGitRootNoSpawn(target, 32);
    if (root === null) {
      roots.add(mainCheckoutRootOf(fallbackRoot) ?? fallbackRoot);
      continue;
    }
    if (isLinkedWorktree(root)) continue; // worktree linkado: nunca bloqueia
    roots.add(root);
  }
  return [...roots];
}

/**
 * Sobe de `startDir` procurando o primeiro ancestral com `.git` (arquivo OU
 * diretório) — sem spawnar processo. Duplicado de `session-beacon.mjs`
 * (`findGitRootNoSpawn`, #7712) — mesma razão self-contained dos hooks
 * irmãos, e mesmo motivo de existir: `payload.cwd` (o cwd REAL da chamada
 * que disparou o hook) é a única forma confiável de achar a raiz do
 * worktree/checkout de quem chamou, porque `import.meta.url`/`hookDir`
 * sempre resolvem pro checkout PRINCIPAL (ver comentário no topo do
 * arquivo, achado #8937). `null` se nada for achado até `maxDepth` níveis
 * ou em qualquer falha de I/O (fail-soft).
 */
export function findGitRootNoSpawn(startDir, maxDepth = 8) {
  try {
    if (typeof startDir !== "string" || startDir.trim() === "") return null;
    let dir = startDir;
    for (let i = 0; i < maxDepth; i++) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null; // raiz do filesystem, sem achar .git
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
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

      // #8937: `payload.cwd` (o cwd REAL da chamada), não `import.meta.url`
      // — ver comentário no topo do arquivo. Fail-soft: sem `payload.cwd`
      // utilizável, ou se a subida não achar `.git`, cai no `hookDir` antigo
      // (comportamento pré-#8937, nunca pior que o que já rodava).
      const hookDir = dirname(fileURLToPath(import.meta.url));
      const hookRoot = join(hookDir, "..", "..");
      const baseCwd = typeof payload.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd : hookRoot;
      const fallbackRoot = findGitRootNoSpawn(baseCwd) ?? hookRoot;

      // #12165: o alvo sai do PRÓPRIO comando (`cd`/`-C`), não só do cwd da
      // sessão. Worktree linkado como alvo → libera; checkout principal ou
      // alvo não resolvido → segue para a checagem de coordenadora.
      const targets = resolveBranchCreateTargets(command, baseCwd);
      if (targets.length === 0) return;
      const mainRoots = mainRootsHitByTargets(targets, fallbackRoot);
      if (mainRoots.length === 0) return; // todos os alvos são worktrees linkados

      const blocked = mainRoots.some((root) =>
        shouldBlockBranchCheckout(readActiveCoordinatorSessionIds(root), payload.session_id),
      );
      if (blocked) {
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
