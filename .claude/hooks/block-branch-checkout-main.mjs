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
  // #12165: reconhece também opções globais antes do subcomando (`git -C
  // <dir> switch -c X`, `git -c k=v checkout -b X`) e `VAR=x git ...` — o
  // tokenizer de `resolveBranchCreateTargets` mantém o conteúdo entre aspas
  // num token só, então um `git checkout -b` citado num `--body` segue fora.
  return resolveBranchCreateTargets(command, null).length > 0;
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
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i];
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
        if (command[j] === "\\" && j + 1 < n) {
          value += command[j + 1];
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

/** Resolve `arg` contra `cwd`; `UNRESOLVED` se qualquer um dos dois for. */
function resolveDir(cwd, rawToken, vars) {
  const token = expandKnownVars(rawToken, vars);
  if (!token || token.dynamic) return UNRESOLVED;
  const v = token.value;
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
  for (const seg of tokenizeShellSegments(command, home)) {
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
    const creates =
      (sub === "checkout" && rest.includes("-b")) ||
      (sub === "switch" && (rest.includes("-c") || rest.includes("--create")));
    if (creates) targets.push(target);
  }
  return targets;
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
