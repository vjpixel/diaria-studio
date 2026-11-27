/**
 * test/claude-hooks-windowshide.test.ts (#7952)
 *
 * Regressão pro flash de janelas de console no Windows a CADA SessionStart —
 * família irmã de `test/claude-settings-hooks-exec-form.test.ts` (#7106), que
 * travou a forma "exec" dos hooks em `settings.json`. Este guard ataca uma
 * segunda causa, distinta: dentro de um hook `.mjs` já em exec form, um
 * `spawn`/`spawnSync`/`execFile`/`execFileSync` com `detached: true` mas SEM
 * `windowsHide: true` ainda aloca console próprio no Windows (doc do Node:
 * "the child will have its own console window" quando `detached`) — visível
 * como uma janela do Windows Terminal que abre e fecha rápido.
 *
 * Achado ao vivo (#7952, 10/09/2026): `session-start-claude-config-sync.mjs`
 * (este repo) e `~/claude-config/sync-check.cjs` tinham exatamente esse
 * padrão — `spawn(..., { detached: true, stdio: "ignore" })` sem
 * `windowsHide`. Prova medida na issue: script mínimo com/sem `windowsHide`
 * contando `conhost`/`OpenConsole` alocados — BASE 26, DETACHED 27 (+1),
 * HIDDEN 26 (0 a mais).
 *
 * Escopo original: `.claude/hooks/*.mjs` DESTE repo (o `sync-check.cjs`
 * equivalente em `claude-config` não tem CI — mudança lá é tratada à parte,
 * ver corpo da #7952). Desde o #13559 também varre `scripts/` (spawn
 * destacado e os arquivos que rodam dentro de processo destacado — ver o
 * bloco do #13559 mais abaixo).
 *
 * Heurística (não é um parser AST completo — nenhum outro guard de hook
 * deste repo é): pra cada ocorrência de `detached:\s*true`, procura
 * `windowsHide:\s*true` numa JANELA de texto ao redor (mesmo objeto de
 * opções, na prática — objetos de opções de spawn/execFile deste repo nunca
 * passam de ~15 linhas). Falso positivo teórico (um `windowsHide: true` de
 * OUTRA chamada caindo dentro da janela) é aceitável pro custo/benefício de
 * um guard estático simples — nenhum hook real hoje tem duas chamadas
 * spawn/execFile close o bastante pra colidir. **2º modo de falso-negativo,
 * medido ao vivo (achado do fleet review pré-merge, comment-analyzer):** a
 * janela também casa `windowsHide: true` citado em PROSA de comentário (ex:
 * os próprios comentários explicativos que este PR adiciona citam a opção
 * pelo nome) — o guard geral não distingue código de comentário, é texto
 * puro. Mitigado neste arquivo especificamente pelo 2º guard abaixo, que
 * varre só PRA FRENTE a partir da chamada (comentários explicativos ficam
 * ANTES da chamada no estilo deste repo, então saem da janela forward) —
 * mas o guard geral, aplicado aos demais hooks, segue exposto a esse
 * modo. Aceito pelo mesmo custo/benefício acima.
 *
 * **2º guard, mais estrito, só pro arquivo que este PR toca (achado do fleet
 * review pré-merge, silent-failure-hunter):** `detached: true` sozinho NÃO
 * cobre `runBootstrap()`/`cloneRepo()` em `session-start-claude-config-sync.mjs`
 * — as duas chamam `execFile` SEM `detached` (são síncronas do ponto de
 * vista do filho que as invoca), mas ainda alocam console próprio no
 * Windows por rodarem um binário de console (`git`/`powershell.exe`) —
 * é exatamente por isso que a #7952 pediu `windowsHide` nelas também. O
 * guard geral acima nunca as veria (não têm `detached: true` pra ancorar a
 * busca). `findWindowsHideMissingCalls` cobre TODA chamada
 * `execFile`/`execFileSync`/`spawn`/`spawnSync`, com ou sem `detached` — na
 * época do #7952 só era aplicado a `session-start-claude-config-sync.mjs`,
 * porque os outros hooks tinham `execFileSync("git", ...)`/`spawnSync(...)`
 * sem `windowsHide` pré-existentes, fora do escopo daquela issue (#7952
 * mirava especificamente o hook de SessionStart, o de maior frequência — 1x
 * por sessão nova).
 *
 * **Generalizado pelo #7959** (achado no mesmo fleet review pré-merge que
 * motivou o 2º guard acima): `notify-sound.mjs`, `block-pr-create-pii-runtime-artifacts.mjs`
 * e `block-worktree-alien-commit.mjs` tinham exatamente o mesmo padrão —
 * `spawnSync`/`execFileSync` de um binário de console (`powershell`/`git`)
 * sem `windowsHide`. **3º guard** (`findConsoleBinaryCallsMissingWindowsHide`
 * + `fileMentionsConsoleBinary`, definidos mais abaixo): aplica a mesma
 * lógica de `findWindowsHideMissingCalls` a QUALQUER hook do diretório que
 * cite um binário de console conhecido (`git`, `powershell`,
 * `powershell.exe`, `cmd`, `cmd.exe`, `tzutil`, `gh`) em algum lugar do
 * arquivo — não só como primeiro argumento da chamada, porque
 * `notify-sound.mjs` resolve o binário numa função separada e passa por
 * variável no call site (ver docstring de `fileMentionsConsoleBinary`).
 *
 * **#8017 — `findWindowsHideMissingCalls` passou a enxergar a função
 * INJETADA também.** Até esta issue, hooks que despacham processo via
 * parâmetro com default `execFn = execFileSync` (chamado depois como
 * `execFn(...)`, não pelo nome literal do child_process — padrão usado pra
 * permitir mock em teste) ficavam fora do alcance dos 2 guards acima: nenhum
 * casava `execFn(` contra o regex `execFileSync|execFile|spawnSync|spawn`.
 * Confirmado por leitura direta em 7 hooks — `block-gh-pr-merge-subagent.mjs`,
 * `block-askuserquestion-overnight-autonomous.mjs`,
 * `consume-merge-grant-on-merge.mjs`, `notify-continuo-askuserquestion.mjs`,
 * `pr-create-review.mjs`, `subagent-review-registry-start.mjs` (e
 * `subagent-review-registry-stop.mjs`, que só REPASSA `execFileSync` pra
 * `resolveRepoRoot` do arquivo irmão, sem chamada própria) — todos citam
 * `"git"`/`"gh"` como string literal em algum lugar do arquivo (então já
 * passavam pelo portão `fileMentionsConsoleBinary`), mas a chamada real via
 * `execFn(...)` nunca era vista. `findWindowsHideMissingCalls` agora também
 * descobre esses aliases (`\bnome\s*=\s*(?:execFileSync|execFile|spawnSync|
 * spawn)\b`) e checa `windowsHide` na janela ao redor de cada `nome(...)` —
 * com uma diferença: pra chamadas via alias a janela é BIDIRECIONAL (pra trás
 * e pra frente, `WINDOW_CHARS` cada lado), porque é comum um `opts` já
 * montado numa variável declarada 1-2 linhas ANTES da chamada
 * (`const opts = { ..., windowsHide: true }; execFn(..., opts)` —
 * `isCallerInLinkedWorktree` em `block-gh-pr-merge-subagent.mjs`) — uma
 * checagem só-pra-frente nunca veria isso. Chamadas pelo nome LITERAL
 * continuam só-pra-frente, sem mudança de comportamento (evita reabrir o 2º
 * modo de falso-negativo documentado acima — comentário explicativo ANTES da
 * chamada citando "windowsHide" por nome).
 *
 * **#13575 — quatro pontos cegos fechados.** (1) alias com anotação de tipo
 * (`exec: ExecFileSyncFn = execFileSync`) passou a ser descoberto, e achou um
 * ofensor real em `scripts/lib/exec-mode.ts`; (2) nos guards por chamada, o
 * `windowsHide` só conta dentro da própria chamada (até o `)` que a fecha,
 * sem o corpo de chamadas vizinhas ou aninhadas), não numa janela de 600
 * caracteres que emprestava a flag da chamada seguinte; o ramo de alias
 * continua olhando `WINDOW_CHARS` pra trás pelo `opts` solto; (3)
 * `stripComments` usa um lexer mínimo e não lê `/*` ou `//` de dentro de
 * string como comentário; (4) o guard de spawn destacado de `scripts/`
 * ancora em `detached: true` (qualquer binário, não só `process.execPath`),
 * fora binários de GUI (`GUI_BINARY_LITERAL_RE`: `rundll32`, `explorer`,
 * `open`, `xdg-open`, e só sem `shell: true`). O 1º guard
 * (`findDetachedWithoutWindowsHide`, hooks) segue com a janela de 600.
 * Fleet review do PR: o guard de `scripts/` sobe pelos brackets em volta do
 * objeto (bloco de callback não esconde mais o `opts` solto; spread
 * condicional e `Object.assign` dentro do spawn são vistos), o alias volta a
 * ser varrido quando chamado por propriedade (`deps.execFn(`, `this.run(`) e
 * o lexer trata `a++ / 2` como divisão.
 *
 * **#13592 — pontos cegos restantes do review da #13586.** (1)
 * `DETACHED_CHILD_ENTRYPOINTS` é conferida contra os spawns destacados de node
 * reais (`deriveDetachedEntrypoints`); (2) o fecho de imports resolve `..`
 * acima de scripts/, diretório com `index` e `require(…)`, e o import que não
 * resolve reprova em vez de sair em silêncio; (3) `detached` com valor não
 * literal e o shorthand `{ detached }` também ancoram (`findDetachedProps`);
 * (4) mais formas de alias (`import { spawn as sp }`, `{ execFileSync: run }
 * = cp`, `promisify(execFile)`, `run: typeof spawnSync` sem default, anotação
 * em várias linhas, `cp.execSync(` pelo namespace); (5) `windowsHide: true`
 * dentro de string ou de objeto aninhado como valor de propriedade (`env: {
 * … }`) não conta mais. O item 6 (tipos) está em
 * `test/windowshide-exec-types-13592.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(ROOT, ".claude", "hooks");

/** Janela de caracteres usada em quatro lugares: (1) ao redor de cada
 * `detached: true` no 1º guard dos hooks (`findDetachedWithoutWindowsHide`);
 * (2) pra trás de uma chamada via alias, onde o `opts` solto pode estar
 * (#8017); (3) fim de reserva de uma chamada cujo `)` não fecha
 * (`collectCallSites`); (4) janela de reserva do guard de `scripts/` quando
 * o `detached: true` não está dentro de um objeto. Generosa o bastante pra
 * cobrir um objeto de opções multi-linha inteiro (chamadas reais deste repo
 * não passam de ~600 chars entre `detached:` e o fechamento do objeto). */
const WINDOW_CHARS = 600;

/** Pura — recebe o conteúdo já lido de um arquivo `.mjs`, devolve o offset
 * (não linha — mais barato de calcular, suficiente pra achar no editor) de todo
 * `detached` que pode destacar sem `windowsHide: true` na janela ao redor.
 * Desde o #13592 a âncora não é só o literal `detached: true`: qualquer valor
 * que não seja `false`/`undefined`/`null`/`0` (`detached: !fg`, `detached:
 * isBg`) e o shorthand `{ detached }` contam (`findDetachedProps`), e a janela
 * é lida sem comentários nem strings (um `windowsHide: true` citado em prosa ou
 * dentro de string não satisfaz mais o guard). */
export function findDetachedWithoutWindowsHide(content: string): number[] {
  const masked = maskJs(content, true);
  const offenders: number[] = [];
  for (const idx of findDetachedProps(masked)) {
    const start = Math.max(0, idx - WINDOW_CHARS);
    const end = Math.min(masked.length, idx + WINDOW_CHARS);
    if (!WINDOWS_HIDE_RE.test(masked.slice(start, end))) offenders.push(idx);
  }
  return offenders;
}

/** Segmento léxico de um fonte JS/TS (#13575). `string` cobre aspas simples,
 * duplas e os pedaços de template literal; `regex` cobre literal de regex. */
type LexSegment = { kind: "code" | "string" | "comment" | "regex"; start: number; end: number };

const REGEX_AFTER_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "yield", "await", "else", "do",
]);

/** Lexer mínimo (#13575): separa código de string, template literal, literal
 * de regex e comentário. Não é um parser, só o bastante pra que `/*` ou `//`
 * DENTRO de uma string (ex.: `"scripts/**\/*.ts"`, `"https://x"`) não seja
 * lido como comentário, e pra que parêntese dentro de string não desbalanceie
 * a busca do fim de uma chamada. Template literal com `${…}` aninhado é
 * seguido por pilha. Literal de regex é reconhecido pela heurística clássica
 * (o `/` vem depois de operador, `(`, `,`, `;` ou palavra-chave). Pura. */
function lexJs(src: string): LexSegment[] {
  const segs: LexSegment[] = [];
  const n = src.length;
  const tpl: number[] = []; // profundidade de `{` dentro de cada `${` aberto
  const push = (kind: LexSegment["kind"], start: number, end: number) => {
    if (end > start) segs.push({ kind, start, end });
  };
  const scanTemplate = (from: number): number => {
    let j = from;
    while (j < n) {
      const ch = src[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === "`") return j + 1;
      if (ch === "$" && src[j + 1] === "{") { tpl.push(0); return j + 2; }
      j++;
    }
    return n;
  };
  const scanRegex = (from: number): number => {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const ch = src[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === "\n") return -1;
      if (inClass) {
        if (ch === "]") inClass = false;
      } else if (ch === "[") inClass = true;
      else if (ch === "/") {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  };
  let lastSig = "";
  let lastSigIdx = -1;
  const regexAllowed = (): boolean => {
    if (lastSig === "") return true;
    // `a++ / 2` e `a-- / 2`: o operador pós-fixo fecha um operando, então o
    // `/` seguinte é divisão, não regex (`++/re/` prefixo não é JS válido).
    if ((lastSig === "+" || lastSig === "-") && src[lastSigIdx - 1] === lastSig) return false;
    if ("(,=:[!&|?{};+-*%<>~^".includes(lastSig)) return true;
    if (/[\w$]/.test(lastSig)) {
      let k = lastSigIdx;
      while (k >= 0 && /[\w$]/.test(src[k])) k--;
      return REGEX_AFTER_KEYWORDS.has(src.slice(k + 1, lastSigIdx + 1));
    }
    return false;
  };
  let segStart = 0;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      push("code", segStart, i);
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? n : nl;
      push("comment", i, end);
      i = segStart = end;
      continue;
    }
    if (c === "/" && d === "*") {
      push("code", segStart, i);
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      push("comment", i, end);
      i = segStart = end;
      continue;
    }
    if (c === '"' || c === "'") {
      push("code", segStart, i);
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === "\n") break;
        j++;
      }
      push("string", i, j);
      i = segStart = j;
      lastSig = c;
      lastSigIdx = j - 1;
      continue;
    }
    if (c === "`" || (c === "}" && tpl.length > 0 && tpl[tpl.length - 1] === 0)) {
      if (c === "}") tpl.pop();
      push("code", segStart, i);
      const end = scanTemplate(i + 1);
      push("string", i, end);
      i = segStart = end;
      lastSig = "`";
      lastSigIdx = end - 1;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      const end = scanRegex(i);
      if (end > 0) {
        push("code", segStart, i);
        push("regex", i, end);
        i = segStart = end;
        lastSig = "/";
        lastSigIdx = end - 1;
        continue;
      }
    }
    if (tpl.length > 0) {
      if (c === "{") tpl[tpl.length - 1]++;
      else if (c === "}") tpl[tpl.length - 1]--;
    }
    if (!/\s/.test(c)) {
      lastSig = c;
      lastSigIdx = i;
    }
    i++;
  }
  push("code", segStart, n);
  return segs;
}

/** Remove comentários `//...` e `/* ... *\/` antes da descoberta de alias
 * (achado ao vivo #8017: sem isto, prosa de comentário do tipo "`execFn` é
 * injetável (default = execFileSync real)" — presente em
 * `pr-create-review.mjs` — inventa um alias falso chamado `default`, que
 * depois casa toda ocorrência da palavra "default(" no arquivo como suposta
 * chamada, produzindo dezenas de falsos positivos). Desde o #13575 respeita
 * strings: `/*` dentro de `"scripts/**\/*.ts"` ou `//` dentro de `"https://…"`
 * não abre comentário (a versão por regex comia o código até o próximo `*\/`
 * ou até o fim da linha). Pura. */
export function stripComments(content: string): string {
  return lexJs(content)
    .filter((s) => s.kind !== "comment")
    .map((s) => content.slice(s.start, s.end))
    .join("");
}

/** Mesmo comprimento que `content` (offsets preservados): troca por espaço o
 * conteúdo dos comentários e, com `literals`, também o de strings e regex.
 * Quebras de linha ficam. Pura. */
function maskJs(content: string, literals: boolean): string {
  const out = content.split("");
  for (const s of lexJs(content)) {
    if (s.kind === "code" || (!literals && s.kind !== "comment")) continue;
    for (let k = s.start; k < s.end; k++) if (out[k] !== "\n") out[k] = " ";
  }
  return out.join("");
}

/** Índice logo depois do `)` que fecha o `(` em `open`, num texto já
 * mascarado (sem strings nem comentários). `-1` se não fechar. Pura. */
function findCallClose(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/** Escapa metacaracteres de regex num identificador descoberto antes de
 * interpolá-lo num `new RegExp` (achado do fleet review pré-merge da #8021,
 * `pr-test-analyzer`, P3) — `$` é um caractere legal em identificador JS
 * (`execFn$`) e tem significado especial em regex; sem escapar, um alias com
 * `$` produziria um regex diferente do pretendido em vez de casar o nome
 * literal. Nenhum hook real hoje usa `$` em nome de alias, mas o guard não
 * deveria depender disso silenciosamente. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Descobre nomes de parâmetro/variável usados como alias injetável de
 * `execFileSync`/`execFile`/`spawnSync`/`spawn` (#8017) — o padrão
 * `nome = execFileSync` como default de parâmetro (`function f(execFn =
 * execFileSync)`) ou atribuição de variável. Desde o #13575 aceita anotação
 * de tipo antes do `=` (`exec: ExecFileSyncFn = execFileSync`,
 * `run: typeof spawnSync = spawnSync`), que antes escapava. A anotação tem de
 * caber numa linha e não ter parênteses: tipo de função literal
 * (`(cmd: string) => Buffer`) segue fora (teste "limite documentado: alias
 * com anotação de tipo-FUNÇÃO literal").
 *
 * `(?!\s*\()` no fim (achado do fleet review pré-merge da #8021,
 * `pr-test-analyzer`, P2): sem isso, `const out = execFileSync(...)` — uma
 * atribuição do RESULTADO da chamada, padrão real presente em
 * `block-worktree-alien-commit.mjs` — também casava e descobria `out` como
 * se fosse um alias injetável, quando na verdade `execFileSync` ali já é a
 * chamada literal (já coberta pelo 1º ramo de `findWindowsHideMissingCalls`)
 * e `out` não é uma função chamável em lugar nenhum. O lookahead negativo
 * distingue "atribuição da REFERÊNCIA da função" (nunca seguida de `(`, é o
 * padrão real de alias) de "atribuição do RESULTADO de uma chamada" (sempre
 * seguida de `(`). Pura.
 *
 * **#13592 item 4 — mais formas de alias.** Além do `nome = launcher`:
 *  - anotação de tipo em várias linhas, quebrando em `|`/`&`
 *    (`exec:\n  | A\n  | typeof execFileSync = execFileSync`);
 *  - `nome = promisify(launcher)` (e `util.promisify(…)`);
 *  - `nome = cp.launcher`, com `cp` namespace de `child_process`;
 *  - `import { spawn as sp } from "node:child_process"`;
 *  - `const { execFileSync: run } = cp` / `= require("child_process")`;
 *  - parâmetro ou campo tipado SEM default com o tipo real do launcher:
 *    `run: typeof spawnSync`, ou `run: T` com `type T = typeof spawnSync` no
 *    mesmo arquivo.
 * Fica de fora, de propósito, o parâmetro tipado com um tipo WRAPPER sem
 * objeto de opções (`spawn: SpawnFn` em `git-sync.ts`, `SpawnFn =
 * GitSpawnFn = (cmd, args, timeoutMs?) => SpawnResult`): o chamador não tem
 * onde passar `windowsHide`, quem precisa da flag é a implementação real do
 * wrapper, que chama o launcher pelo nome e já é varrida. A busca é por
 * lookahead (não consome), então um nome espúrio antes do certo (`case A:\n
 * run = spawn`) não esconde o `run`. `launchers` escolhe a família
 * (`CORE_LAUNCHERS` ou `BROAD_LAUNCHERS`). */
function discoverInjectedExecAliases(content: string, launchers: readonly string[] = CORE_LAUNCHERS): string[] {
  const code = maskJs(content, true);
  const withStrings = maskJs(content, false);
  const L = launchers.map(escapeRegExp).join("|");
  const namespaces = discoverChildProcessNamespaces(content);
  const NS = namespaces.length > 0 ? String.raw`(?:(?:${namespaces.map(escapeRegExp).join("|")})\s*\.\s*)?` : "";
  const TOK = String.raw`[\w$.<>[\]]+`;
  const ANN = String.raw`\s*\|?\s*${TOK}(?:(?:[^\S\n]+|\s*[|&]\s*)${TOK})*`;
  const names = new Set<string>();
  const collect = (re: RegExp, src: string, each: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      each(m);
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  // `nome = launcher`, `nome: Tipo = launcher`, `nome = promisify(launcher)`.
  collect(
    new RegExp(
      String.raw`(?<![\w$])([A-Za-z_$][\w$]*)(?=\s*(?:\??:${ANN})?\s*=\s*(?:${NS}(?:${L})\b(?!\s*\()|(?:[\w$]+\s*\.\s*)?promisify\s*\(\s*${NS}(?:${L})\s*\)))`,
      "g",
    ),
    code,
    (m) => names.add(m[1]),
  );
  // Tipo real do launcher: `typeof launcher` direto ou via `type T = typeof launcher`.
  const launcherTypes = new Set<string>();
  collect(new RegExp(String.raw`\btype\s+([\w$]+)\s*=\s*typeof\s+${NS}(?:${L})\b`, "g"), code, (m) => launcherTypes.add(m[1]));
  const typeAlt = [String.raw`typeof\s+${NS}(?:${L})\b`, ...[...launcherTypes].map((t) => `${escapeRegExp(t)}\\b`)].join("|");
  collect(new RegExp(String.raw`(?<![\w$])([A-Za-z_$][\w$]*)(?=\s*\??:\s*(?:${typeAlt}))`, "g"), code, (m) => names.add(m[1]));
  // `import { launcher as nome } from "child_process"`.
  collect(
    new RegExp(String.raw`\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${CHILD_PROCESS_SPEC}`, "g"),
    withStrings,
    (m) => {
      for (const r of m[1].matchAll(/([\w$]+)\s+as\s+([\w$]+)/g)) if (launchers.includes(r[1])) names.add(r[2]);
    },
  );
  // `const { launcher: nome } = cp` / `= require("child_process")`.
  const rhs = [String.raw`require\s*\(\s*${CHILD_PROCESS_SPEC}\s*\)`, ...namespaces.map((n) => `${escapeRegExp(n)}\\b`)].join("|");
  collect(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:${rhs})`, "g"), withStrings, (m) => {
    for (const r of m[1].matchAll(/([\w$]+)\s*:\s*([\w$]+)/g)) if (launchers.includes(r[1])) names.add(r[2]);
  });
  return [...names];
}

/** Especificador de módulo `child_process` (com ou sem `node:`), em texto
 * com strings preservadas. */
const CHILD_PROCESS_SPEC = String.raw`["'](?:node:)?child_process["']`;

/** Nomes ligados ao MÓDULO `child_process` inteiro (#13592 item 4):
 * `import * as cp from …`, `import cp from …`, `const cp = require(…)`,
 * `const cp = await import(…)`. Uma chamada `cp.execSync(` passa a contar
 * no guard amplo. Pura. */
function discoverChildProcessNamespaces(content: string): string[] {
  const src = maskJs(content, false);
  const names = new Set<string>();
  const res = [
    new RegExp(String.raw`\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*${CHILD_PROCESS_SPEC}`, "g"),
    new RegExp(String.raw`\bimport\s+(?!type\b)([\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*${CHILD_PROCESS_SPEC}`, "g"),
    new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:require|(?:await\s+)?import)\s*\(\s*${CHILD_PROCESS_SPEC}\s*\)`, "g"),
  ];
  for (const re of res) for (const m of src.matchAll(re)) names.add(m[1]);
  return [...names];
}

const CORE_LAUNCHERS = ["execFileSync", "execFile", "spawnSync", "spawn"] as const;
const BROAD_LAUNCHERS = [...CORE_LAUNCHERS, "execSync", "exec", "fork"] as const;

const WINDOWS_HIDE_RE = /windowsHide\s*:\s*true/;
const LITERAL_CALL_RE = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(/g;
const BROAD_CALL_RE = /(?<![.\w$])(?:execSync|exec|fork)\s*\(/g;

/** Chamadas `cp.exec(`/`cp.execSync(`/`cp.fork(` pelo namespace de
 * `child_process` (#13592 item 4). `null` sem namespace no arquivo. */
function namespaceBroadCallRe(content: string): RegExp | null {
  const ns = discoverChildProcessNamespaces(content);
  if (ns.length === 0) return null;
  return new RegExp(String.raw`(?<![\w$.])(?:${ns.map(escapeRegExp).join("|")})\s*\.\s*(?:execSync|exec|fork)\s*\(`, "g");
}

/** Nomes de alias que colidem com métodos comuns de outros objetos
 * (`re.exec(`, `db.run(`, `fn.call(`, `map.get(`, `res.send(`…): pra eles,
 * chamada por propriedade só conta como `this.nome(` (#13575). */
const GENERIC_METHOD_ALIAS_NAMES = new Set(["exec", "run", "call", "apply", "bind", "get", "set", "send", "start"]);

/** Regex das chamadas de um alias descoberto: `nome(`, e também por
 * propriedade, `this.nome(`/`deps.nome(`/`deps?.nome(` (como era no master
 * antes do #13575, que tinha deixado a chamada por propriedade de fora).
 * Exceção: alias com nome de método comum (`GENERIC_METHOD_ALIAS_NAMES`) só
 * conta solto ou como `this.nome(`, porque `re.exec(` / `db.run(` são outro
 * objeto, não processo. Pura. */
function aliasCallRe(name: string): RegExp {
  const prop = GENERIC_METHOD_ALIAS_NAMES.has(name)
    ? String.raw`(?<=\bthis\s*\??\.\s*)`
    : String.raw`(?<=[\w$\])?]\s*\.\s*)`;
  return new RegExp(String.raw`(?:(?<![.\w$])|${prop})${escapeRegExp(name)}\s*\(`, "g");
}

/** Uma chamada de processo achada no fonte: do nome até o `)` que a fecha. */
type CallSite = { index: number; open: number; end: number; bidirectional: boolean };

/** Acha, no texto mascarado, as chamadas (`patterns` terminam em `\(`) e as
 * chamadas via alias, e calcula onde cada uma termina (#13575): no `)` que
 * fecha a chamada; se não fechar, na próxima chamada ou em `WINDOW_CHARS`.
 * Pura. */
function collectCallSites(masked: string, patterns: RegExp[], aliases: string[]): CallSite[] {
  const byIndex = new Map<number, { open: number; bidirectional: boolean }>();
  const scan = (re: RegExp, bidirectional: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (!byIndex.has(m.index)) byIndex.set(m.index, { open: m.index + m[0].length - 1, bidirectional });
    }
  };
  for (const re of patterns) scan(re, false);
  for (const name of aliases) scan(aliasCallRe(name), true);
  const starts = [...byIndex.keys()].sort((a, b) => a - b);
  return starts.map((index, k) => {
    const { open, bidirectional } = byIndex.get(index)!;
    const close = findCallClose(masked, open);
    const fallback = Math.min(masked.length, index + WINDOW_CHARS, starts[k + 1] ?? Infinity);
    return { index, open, end: close > 0 ? close : fallback, bidirectional };
  });
}

/** Trecho `[from, to)` de `text` com o corpo das OUTRAS chamadas apagado:
 * o `windowsHide` de uma chamada vizinha ou aninhada não conta pra esta
 * (#13575). A chamada que CONTÉM `me` não é apagada. Pura. */
function sliceWithoutOtherCalls(text: string, from: number, to: number, sites: CallSite[], me: CallSite): string {
  const out = text.slice(from, to).split("");
  for (const o of sites) {
    if (o === me || (o.index <= me.index && o.end >= me.end)) continue;
    const a = Math.max(o.index, from);
    const b = Math.min(o.end, to);
    for (let k = a; k < b; k++) out[k - from] = " ";
  }
  return out.join("");
}

/** `true` quando o `:` em `colon` separa chave e valor de propriedade de
 * objeto (`env: {`, `"env": {`, `[k]: {`), não o `:` de ternário (`a ? b :
 * {`). Texto mascarado: a chave em string virou espaço. Pura. */
function isPropertyColon(masked: string, colon: number): boolean {
  let k = colon - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  if (k >= 0 && masked[k] === "]") return true;
  while (k >= 0 && /[\w$]/.test(masked[k])) k--;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  return k >= 0 && (masked[k] === "{" || masked[k] === ",");
}

/** `true` quando a posição `idx` está dentro de um objeto que é VALOR de
 * propriedade (`{ env: { windowsHide: true } }`), contando só os brackets
 * depois de `stopAt`. Pura. */
function isInsidePropertyValueObject(masked: string, idx: number, stopAt: number): boolean {
  let cur = idx;
  for (;;) {
    const up = findEnclosingBracket(masked, cur);
    if (up < 0 || up <= stopAt) return false;
    if (masked[up] === "{") {
      let k = up - 1;
      while (k >= 0 && /\s/.test(masked[k])) k--;
      if (k >= 0 && masked[k] === ":" && isPropertyColon(masked, k)) return true;
    }
    cur = up;
  }
}

/** `true` quando `masked` (sem comentários NEM strings, #13592 item 5) tem
 * `windowsHide: true` fora de objeto aninhado como valor de propriedade:
 * `{ env: { windowsHide: true } }` não é a flag do spawn, e `"windowsHide:
 * true"` numa string também não. Só os brackets depois de `stopAt` contam
 * pra decidir o aninhamento. Pura. */
function hasOwnWindowsHide(masked: string, stopAt: number): boolean {
  const re = new RegExp(WINDOWS_HIDE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (!isInsidePropertyValueObject(masked, m.index, stopAt)) return true;
  }
  return false;
}

/** Offsets das chamadas sem `windowsHide: true`. Chamada pelo nome literal:
 * só o corpo da própria chamada conta. Chamada via alias: também até
 * `WINDOW_CHARS` pra trás (o `opts` montado numa variável antes da chamada,
 * #8017), sem o corpo de outras chamadas. `masked` sem comentários nem
 * strings (#13592 item 5). Pura. */
function offendersFromSites(masked: string, sites: CallSite[]): number[] {
  const offenders: number[] = [];
  for (const s of sites) {
    const body = sliceWithoutOtherCalls(masked, s.index, s.end, sites, s);
    let ok = hasOwnWindowsHide(body, s.open - s.index);
    if (!ok && s.bidirectional) {
      ok = hasOwnWindowsHide(sliceWithoutOtherCalls(masked, Math.max(0, s.index - WINDOW_CHARS), s.index, sites, s), -1);
    }
    if (!ok) offenders.push(s.index);
  }
  return offenders;
}

/** 2º guard, mais estrito (ver docstring do módulo) — varre TODA chamada
 * `execFile`/`execFileSync`/`spawn`/`spawnSync`, com ou sem `detached`, e
 * confirma `windowsHide: true` no corpo da própria chamada (#13575: antes era
 * uma janela de `WINDOW_CHARS` pra frente, que emprestava o `windowsHide` da
 * chamada seguinte). Desde #8017, também varre chamadas via ALIAS injetado
 * (`execFn = execFileSync` → `execFn(...)`) — ver docstring do módulo pro
 * porquê da janela bidirecional só nesse ramo. Chamada citada em comentário
 * ou string não conta. Offsets no `content` recebido. Pura. */
export function findWindowsHideMissingCalls(content: string): number[] {
  const masked = maskJs(content, true);
  const sites = collectCallSites(masked, [LITERAL_CALL_RE], discoverInjectedExecAliases(content));
  return offendersFromSites(masked, sites);
}

/**
 * 3º guard, GENERALIZADO a todo o diretório de hooks (#7959).
 *
 * Achado no fleet review pré-merge da PR #7953 (silent-failure-hunter +
 * pr-test-analyzer): o mesmo padrão do #7952 (processo de console sem
 * `windowsHide: true`) existia em mais 3 hooks pré-existentes —
 * `notify-sound.mjs` (roda em todo evento Stop/Notification, mais frequente
 * que o SessionStart que motivou o #7952), `block-pr-create-pii-runtime-artifacts.mjs`
 * e `block-worktree-alien-commit.mjs` — mas não bloquearam aquele PR por
 * estarem fora do escopo dele (#7952 mirava só `session-start-claude-config-sync.mjs`).
 * O 2º guard acima (`findWindowsHideMissingCalls`) já existia com a lógica
 * certa, mas só era aplicado a 1 arquivo — este guard generaliza a MESMA
 * lógica pra qualquer hook `.mjs` do diretório. **Até o #8017**, hooks que
 * despacham processo via função INJETADA (ex: `execFn = execFileSync` em
 * `block-gh-pr-merge-subagent.mjs` e afins) escapavam deste guard generalizado
 * pela mesma razão descrita na docstring do módulo — desde o #8017,
 * `findWindowsHideMissingCalls` também descobre e varre essas chamadas via
 * alias, então este guard generalizado agora as alcança sem precisar de
 * lógica própria aqui.
 *
 * **Por que existe um portão (`fileMentionsConsoleBinary`) em vez de aplicar
 * `findWindowsHideMissingCalls` cru a todo arquivo:** o pedido da issue #7959
 * é generalizar por BINÁRIO DE CONSOLE conhecido (`git`, `powershell`,
 * `powershell.exe`, `cmd`, `cmd.exe`, `tzutil`, `gh`), não "toda chamada de
 * processo de qualquer hook, sempre" — um hook hipotético que só spawna um
 * binário não-console (ex: outro processo Node) não precisaria do guard.
 * O portão verifica se o ARQUIVO (não a chamada específica) menciona um
 * desses binários como STRING LITERAL em qualquer lugar — não só como
 * primeiro argumento do call site. Isso é necessário porque
 * `notify-sound.mjs` resolve o binário numa função separada
 * (`resolveSoundCommand`, que retorna `{ command: "powershell", ... }`) e
 * passa por uma VARIÁVEL (`resolved.command`) no ponto de chamada — o
 * literal "powershell" fica páginas antes do `spawnSync`, nunca colado nele.
 * Ancorar a checagem só no argumento literal da chamada perderia
 * exatamente o caso mais urgente dos 3 (maior volume de execuções, citado
 * na própria issue). Uma vez que o arquivo menciona o binário em algum
 * lugar, exigimos `windowsHide: true` em TODA chamada de processo do
 * arquivo — não só na que carrega o literal.
 */
const CONSOLE_BINARY_NAMES = ["git", "powershell.exe", "powershell", "cmd.exe", "cmd", "tzutil", "gh"];
const CONSOLE_BINARY_LITERAL_RE = new RegExp(
  `["'\`](?:${CONSOLE_BINARY_NAMES.map((n) => n.replace(/\./g, "\\.")).join("|")})["'\`]`,
  "i",
);

/** `true` quando `content` cita, em qualquer lugar do arquivo, um dos
 * binários de console conhecidos (`CONSOLE_BINARY_NAMES`) como string
 * literal. Ver docstring de `findConsoleBinaryCallsMissingWindowsHide`
 * acima pro porquê disso ser no nível do ARQUIVO, não da chamada. */
export function fileMentionsConsoleBinary(content: string): boolean {
  return CONSOLE_BINARY_LITERAL_RE.test(content);
}

/** Guard generalizado #7959 — `[]` sem escanear nada se o arquivo não citar
 * nenhum binário de console conhecido; senão reusa `findWindowsHideMissingCalls`
 * (mesma lógica do 2º guard, aplicada aqui a qualquer arquivo). */
export function findConsoleBinaryCallsMissingWindowsHide(content: string): number[] {
  if (!fileMentionsConsoleBinary(content)) return [];
  return findWindowsHideMissingCalls(content);
}

function listHookFiles(): string[] {
  try {
    return readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".mjs"));
  } catch {
    return []; // diretório ausente (clone parcial/worktree isolado) — nada a varrer, não é falha
  }
}

describe("findDetachedWithoutWindowsHide (#7952) — lógica pura", () => {
  it("detached:true sem windowsHide -> 1 ofensor", () => {
    const content = `spawn("node", [], { detached: true, stdio: "ignore" });`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content).length, 1);
  });

  it("detached:true COM windowsHide na mesma chamada -> nenhum ofensor", () => {
    const content = `spawn("node", [], { detached: true, stdio: "ignore", windowsHide: true });`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content), []);
  });

  it("windowsHide em linha separada dentro do objeto multi-linha -> nenhum ofensor", () => {
    const content = [
      "spawn(process.execPath, [path], {",
      "  detached: true,",
      "  stdio: 'ignore',",
      "  windowsHide: true,",
      "  env: {},",
      "});",
    ].join("\n");
    assert.deepEqual(findDetachedWithoutWindowsHide(content), []);
  });

  it("sem detached:true nenhum -> nenhum ofensor (execFile comum sem detach)", () => {
    const content = `execFile("git", ["status"], { timeout: 5000 }, cb);`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content), []);
  });

  it("2 chamadas detached no mesmo arquivo, só 1 sem windowsHide -> 1 ofensor", () => {
    const content = [
      `spawn("a", [], { detached: true, windowsHide: true });`,
      "x".repeat(2000), // separação grande o bastante pra sair da janela da 1ª chamada
      `spawn("b", [], { detached: true, stdio: "ignore" });`,
    ].join("\n");
    assert.deepEqual(findDetachedWithoutWindowsHide(content).length, 1);
  });
});

describe("findWindowsHideMissingCalls (#7952, achado do fleet review) — lógica pura", () => {
  it("execFile SEM detached e SEM windowsHide -> 1 ofensor (era invisível pro 1º guard)", () => {
    const content = `execFile("git", ["clone", url, dir], { timeout: 60000 }, cb);`;
    assert.deepEqual(findWindowsHideMissingCalls(content).length, 1);
  });

  it("execFile SEM detached mas COM windowsHide -> nenhum ofensor", () => {
    const content = `execFile("git", ["clone", url, dir], { timeout: 60000, windowsHide: true }, cb);`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("spawn detached COM windowsHide -> nenhum ofensor (mesma chamada, os 2 guards concordam)", () => {
    const content = `spawn("node", [], { detached: true, windowsHide: true });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("#8017: chamada via alias injetado (execFn = execFileSync) sem windowsHide -> 1 ofensor", () => {
    const content = [
      `function resolveMainRepoRoot(execFn = execFileSync) {`,
      `  return execFn("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content).length, 1);
  });

  it("#8017: chamada via alias injetado COM windowsHide -> nenhum ofensor", () => {
    const content = [
      `function resolveMainRepoRoot(execFn = execFileSync) {`,
      `  return execFn("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true }).trim();`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("#8017: nome de parâmetro sem default de exec (ex: `execFn` genérico não vinculado) -> não vira alias, nenhum ofensor espúrio", () => {
    const content = `function f(execFn) { return execFn("whatever"); }`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("#8021 fleet review (P2, alta confiança): atribuição do RESULTADO de uma chamada literal (`const out = execFileSync(...)`) não vira alias espúrio — padrão real de block-worktree-alien-commit.mjs", () => {
    // Sem o lookahead negativo `(?!\s*\()`, `out` seria descoberto como
    // alias (mesmo regex de "nome = execFileSync" casaria), e qualquer
    // ocorrência de `out(` no resto do arquivo — inclusive coincidência de
    // nome com outra função qualquer — viraria falso positivo/negativo.
    const content = [
      `const out = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });`,
      `function out(x) { return x; }`, // nome coincidente, NUNCA deveria ser tratado como alias de exec
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("#8021 fleet review (P2): mesmo padrão SEM windowsHide na chamada literal -> 1 ofensor (a chamada literal em si), nunca um 2º ofensor fabricado pelo alias espúrio `out`", () => {
    const content = [
      `const out = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });`,
      `function out(x) { return x; }`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content).length, 1);
  });

  it("#8021 fleet review (P3, média confiança): alias com caractere de regex especial ($) é tratado como nome literal, não como metacaractere", () => {
    // `$` é caractere legal em identificador JS. Sem escapar antes de
    // interpolar em `new RegExp`, o guard construiria um regex diferente do
    // pretendido (e no caso de `$` especificamente, ainda funcionaria por
    // coincidência na maioria das posições — o teste prova que o valor
    // correto continua sendo produzido, não que faltava sem o fix).
    const content = [
      `function f(exec$Fn = execFileSync) {`,
      `  return exec$Fn("git", ["status"], { encoding: "utf8" });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content).length, 1);
  });
});

describe("stripComments (#8017/#8021 fleet review P3) — regressão dedicada do achado ao vivo", () => {
  it("prosa de comentário 'default = execFileSync' não inventa um alias chamado 'default'", () => {
    // Reconstitui o achado ao vivo em pr-create-review.mjs: um comentário
    // JSDoc citando a opção por nome ("execFn é injetável (default =
    // execFileSync real)") não pode virar um alias descoberto — senão toda
    // ocorrência de "default(" no resto do arquivo vira falso positivo.
    // Teste SINTÉTICO mínimo, independente da redação atual do comentário
    // real em pr-create-review.mjs (que pode mudar) — cobre o MECANISMO, não
    // o texto específico.
    const content = [
      `/** \`execFn\` é injetável (default = execFileSync real) pra teste. */`,
      `function resolveMainRepoRoot(execFn = execFileSync) {`,
      `  return execFn("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true });`,
      `}`,
      `// nada relacionado a exec, mas contém a palavra "default(" — não deve ser flagado`,
      `function useDefault() { return default(); }`,
    ].join("\n");
    // Só o alias real (`execFn`) deve ser descoberto — 0 ofensores, porque a
    // chamada real já tem windowsHide. Se "default" fosse descoberto como
    // alias espúrio, `default()`/`useDefault` acima geraria ofensor(es)
    // fantasma mesmo sem relação nenhuma com child_process.
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("mesmo comentário, mas a chamada real SEM windowsHide -> exatamente 1 ofensor (o real, não um fabricado por 'default')", () => {
    const content = [
      `/** \`execFn\` é injetável (default = execFileSync real) pra teste. */`,
      `function resolveMainRepoRoot(execFn = execFileSync) {`,
      `  return execFn("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });`,
      `}`,
      `function useDefault() { return default(); }`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content).length, 1);
  });
});

describe("#13575 ponto 1 — alias tipado", () => {
  it("`exec: ExecFileSyncFn = execFileSync` sem windowsHide -> 1 ofensor (antes o alias não era descoberto)", () => {
    const content = [
      `function f(exec: ExecFileSyncFn = execFileSync) {`,
      `  return exec("git", ["status"], { encoding: "utf8" });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`exec("git"`)]);
  });

  it("`const run: typeof spawnSync = spawnSync` sem windowsHide -> 1 ofensor", () => {
    const content = `const run: typeof spawnSync = spawnSync;\nrun("git", ["fetch"], { stdio: "ignore" });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`run("git"`)]);
  });

  it("alias tipado COM windowsHide -> nenhum ofensor", () => {
    const content = [
      `function f(exec: ExecFileSyncFn = execFileSync) {`,
      `  return exec("git", ["status"], { encoding: "utf8", windowsHide: true });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("alias tipado chamado `exec` não confunde `re.exec(...)` de regex com chamada de processo", () => {
    const content = [
      `function f(exec: ExecFileSyncFn = execFileSync) {`,
      `  const m = /x/g.exec(s);`,
      `  return exec("git", ["status"], { windowsHide: true });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("limite documentado: alias com anotação de tipo-FUNÇÃO literal (`(cmd: string) => Buffer`) não é descoberto -> 0 ofensores (falso negativo aceito)", () => {
    // A anotação não pode ter parênteses (ver docstring de
    // discoverInjectedExecAliases). Se um dia o guard passar a cobrir este
    // caso, este teste deve virar `length === 1`.
    const content = [
      `function f(exec: (cmd: string, args: string[]) => Buffer = execFileSync) {`,
      `  return exec("git", ["status"], { encoding: "utf8" });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("fleet review (regressão vs master): alias chamado por propriedade (`deps.execFn(...)`, `this.run(...)`) é varrido", () => {
    const viaDeps = [
      `function f(execFn = execFileSync) {`,
      `  return deps.execFn("git", ["status"], { encoding: "utf8" });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(viaDeps), [viaDeps.indexOf(`execFn("git"`)]);
    const viaThis = `const run = spawnSync;\nclass C { go() { return this.run("git", ["fetch"], {}); } }`;
    assert.deepEqual(findWindowsHideMissingCalls(viaThis), [viaThis.indexOf(`run("git"`)]);
  });

  it("fleet review: alias `exec` chamado como `this.exec(...)` é varrido, `re.exec(...)` não", () => {
    const content = [
      `function f(exec: ExecFileSyncFn = execFileSync) {`,
      `  const m = re.exec(s);`,
      `  return this.exec("git", ["status"], {});`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`exec("git"`)]);
  });

  it("`const out: string = execFileSync(...)` (resultado da chamada) não vira alias", () => {
    const content = [
      `const out: string = execFileSync("git", ["rev-parse", "HEAD"], { windowsHide: true });`,
      `function out2() { return out(1); }`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });
});

describe("#13575 ponto 2 — o windowsHide vale só dentro da própria chamada", () => {
  it("chamada literal sem windowsHide seguida de outra COM -> 1 ofensor (antes a janela de 600 emprestava)", () => {
    const content = [
      `execFileSync("git", ["fetch"], { encoding: "utf8" });`,
      `execFileSync("git", ["status"], { encoding: "utf8", windowsHide: true });`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [0]);
  });

  it("chamada via alias seguida de outra COM windowsHide -> 1 ofensor", () => {
    const content = [
      `function f(execFn = execFileSync) {`,
      `  execFn("git", ["fetch"], { encoding: "utf8" });`,
      `  execFn("git", ["status"], { encoding: "utf8", windowsHide: true });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`execFn("git", ["fetch"]`)]);
  });

  it("alias: windowsHide da chamada ANTERIOR não cobre esta (só opts solto conta pra trás)", () => {
    const content = [
      `function f(execFn = execFileSync) {`,
      `  execFn("git", ["fetch"], { encoding: "utf8", windowsHide: true });`,
      `  execFn("git", ["status"], { encoding: "utf8" });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`execFn("git", ["status"]`)]);
  });

  it("windowsHide de chamada ANINHADA (callback) não cobre a de fora", () => {
    const content = `execFile("git", ["fetch"], {}, () => { spawn("gh", [], { windowsHide: true }); });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [0]);
  });

  it("decisão documentada: chamada LITERAL com opts em variável (`const o = { windowsHide: true }; execFileSync(\"git\", [], o)`) é acusada (falso positivo seguro)", () => {
    // Só a chamada via alias olha pra trás pelo `opts` solto (#8017). Na
    // chamada literal o guard exige a flag no corpo da própria chamada —
    // escrever `{ ...o, windowsHide: true }` ou a flag inline resolve.
    const content = `const o = { windowsHide: true };\nexecFileSync("git", [], o);`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf("execFileSync")]);
  });

  it("parêntese dentro de string não corta a chamada antes do objeto de opções", () => {
    const content = `execFileSync("git", ["log", "--format=%s (%h)", ")"], { encoding: "utf8", windowsHide: true });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("Broad: exec(...) sem windowsHide seguido de execSync COM -> 1 ofensor", () => {
    const code = [`exec("start x", { shell: true });`, `execSync("git worktree prune", { windowsHide: true });`].join("\n");
    assert.deepEqual(findWindowsHideMissingCallsBroad(code), [0]);
  });
});

describe("#13575 ponto 3 — stripComments respeita strings", () => {
  it("`/*` dentro de string não abre comentário", () => {
    const content = `const glob = "scripts/**/*.ts";\nconst run = execFileSync;\nconst tail = "a */ b";`;
    assert.equal(stripComments(content), content);
  });

  it("`//` dentro de string não abre comentário de linha", () => {
    const content = `const url = "https://x.example"; const run = execFileSync;`;
    assert.equal(stripComments(content), content);
  });

  it("comentários de verdade continuam removidos (bloco, linha, depois de string)", () => {
    const content = `const a = "x"; /* bloco */ const b = 1; // linha\nconst c = '//';`;
    assert.equal(stripComments(content), `const a = "x";  const b = 1; \nconst c = '//';`);
  });

  it("template literal com ${…} e regex literal com `/*` não abrem comentário", () => {
    const content = "const t = `a/*${f(`b//`)}c*/`; const re = /\\/\\*/g; const z = 1; // fim";
    assert.equal(stripComments(content), "const t = `a/*${f(`b//`)}c*/`; const re = /\\/\\*/g; const z = 1; ");
  });

  it("fleet review: `/` depois de `a++`/`a--` é divisão, não regex — o comentário seguinte é removido", () => {
    assert.equal(stripComments("const b = a++ / 2; // c\nconst d = 1;"), "const b = a++ / 2; \nconst d = 1;");
    assert.equal(stripComments("const b = a-- / 2; // c\nconst d = 1;"), "const b = a-- / 2; \nconst d = 1;");
  });

  it("guard: alias depois de uma string com `/*` continua descoberto -> 1 ofensor (antes: comido até o `*/`)", () => {
    const content = [
      `const glob = "scripts/*.ts";`,
      `const run = execFileSync;`,
      `run("git", ["status"], { encoding: "utf8" });`,
      `const note = "fim */";`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`run("git"`)]);
  });
});

describe("Regressão #7952 — .claude/hooks/*.mjs reais deste repo", () => {
  const files = listHookFiles();

  it("existe pelo menos 1 hook .mjs pra varrer (sanity — senão o guard não prova nada)", () => {
    assert.ok(files.length > 0, `nenhum .mjs encontrado em ${HOOKS_DIR}`);
  });

  for (const file of files) {
    it(`${file}: todo spawn/spawnSync/execFile/execFileSync com detached:true declara windowsHide:true junto`, () => {
      const content = readFileSync(join(HOOKS_DIR, file), "utf8");
      const offenders = findDetachedWithoutWindowsHide(content);
      assert.deepEqual(
        offenders,
        [],
        `${file}: ${offenders.length} chamada(s) com detached:true sem windowsHide:true na janela ao redor ` +
          `(offsets: ${offenders.join(", ")}) — no Windows isso aloca um console visível a cada SessionStart (#7952).`,
      );
    });
  }
});

describe("Regressão #7952 (guard estrito) — session-start-claude-config-sync.mjs", () => {
  const STRICT_FILE = "session-start-claude-config-sync.mjs";

  it(`${STRICT_FILE}: TODA chamada execFile/execFileSync/spawn/spawnSync declara windowsHide:true, ` +
    "com ou sem detached (os 3 pontos que a #7952 corrigiu — runBootstrap e cloneRepo não têm " +
    "detached, então o guard geral acima nunca os veria)", () => {
    const path = join(HOOKS_DIR, STRICT_FILE);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      assert.fail(`${STRICT_FILE} deveria existir em ${HOOKS_DIR} — este guard é específico dele`);
      return;
    }
    const offenders = findWindowsHideMissingCalls(content);
    assert.deepEqual(
      offenders,
      [],
      `${STRICT_FILE}: ${offenders.length} chamada(s) de processo sem windowsHide:true (offsets: ` +
        `${offenders.join(", ")}) — mesmo sem detached, rodar um binário de console (git/powershell.exe) ` +
        "aloca janela no Windows (#7952).",
    );
  });
});

describe("fileMentionsConsoleBinary / findConsoleBinaryCallsMissingWindowsHide (#7959) — lógica pura", () => {
  it("arquivo sem nenhum binário de console conhecido -> false, guard não escaneia nada", () => {
    const content = `execFile("node", ["script.js"], { timeout: 1000 }, cb);`;
    assert.equal(fileMentionsConsoleBinary(content), false);
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content), []);
  });

  it("literal 'git' em qualquer lugar do arquivo -> true", () => {
    assert.equal(fileMentionsConsoleBinary(`const bin = "git";`), true);
  });

  it("literal 'powershell' (sem .exe) -> true", () => {
    assert.equal(fileMentionsConsoleBinary(`command: "powershell"`), true);
  });

  it("literais 'cmd.exe'/'tzutil'/'gh' -> true cada um", () => {
    assert.equal(fileMentionsConsoleBinary(`spawn("cmd.exe", []);`), true);
    assert.equal(fileMentionsConsoleBinary(`execFileSync("tzutil", ["/g"]);`), true);
    assert.equal(fileMentionsConsoleBinary(`execFileSync("gh", ["pr", "view"]);`), true);
  });

  it("binário resolvido por VARIÁVEL (padrão notify-sound.mjs) — literal longe da chamada ainda é achado", () => {
    // Reconstitui o padrão real do #7959: o literal do binário aparece numa
    // função separada, não colado no spawnSync que de fato precisa de
    // windowsHide.
    const content = [
      `function resolveSoundCommand() { return { command: "powershell", args: [] }; }`,
      "x".repeat(300), // separação — não é o "janela ao redor da chamada" que importa aqui
      `const resolved = resolveSoundCommand();`,
      `spawnSync(resolved.command, resolved.args, { stdio: "ignore", timeout: 10_000 });`,
    ].join("\n");
    assert.equal(fileMentionsConsoleBinary(content), true);
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content).length, 1);
  });

  it("mesmo padrão, COM windowsHide na chamada -> nenhum ofensor (regressão discrimina: sabotar a flag deve falhar)", () => {
    const content = [
      `function resolveSoundCommand() { return { command: "powershell", args: [] }; }`,
      `const resolved = resolveSoundCommand();`,
      `spawnSync(resolved.command, resolved.args, { stdio: "ignore", timeout: 10_000, windowsHide: true });`,
    ].join("\n");
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content), []);
  });

  it("2 chamadas 'git' no mesmo arquivo, ambas sem windowsHide -> 2 ofensores", () => {
    const content = [
      `spawnSync("git", ["rev-parse", "--verify", ref], { timeout: 15000 });`,
      "x".repeat(2000),
      `spawnSync("git", args, { timeout: 30000 });`,
    ].join("\n");
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content).length, 2);
  });

  it("#8017: arquivo que despacha via função INJETADA (execFn = execFileSync) SEM windowsHide -> 1 ofensor", () => {
    // Reconstitui o padrão de block-gh-pr-merge-subagent.mjs e afins: a
    // chamada real é `execFn(...)`, não `execFileSync(...)` literal. Antes do
    // #8017 isto dava 0 ofensores (o regex de chamada de
    // findWindowsHideMissingCalls só casava o nome literal) — desde o #8017,
    // o alias descoberto (`execFn`) também é varrido.
    const content = [
      `export function resolveMainRepoRoot(execFn = execFileSync) {`,
      `  return execFn("git", ["rev-parse", "--show-toplevel"], { cwd });`,
      `}`,
    ].join("\n");
    assert.equal(fileMentionsConsoleBinary(content), true);
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content).length, 1);
  });

  it("#8017: mesmo padrão, COM windowsHide na chamada via alias -> nenhum ofensor", () => {
    const content = [
      `export function resolveMainRepoRoot(execFn = execFileSync) {`,
      `  return execFn("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true });`,
      `}`,
    ].join("\n");
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content), []);
  });

  it("#8017: windowsHide numa variável 'opts' declarada ANTES da chamada via alias -> nenhum ofensor (janela bidirecional)", () => {
    // Reconstitui isCallerInLinkedWorktree em block-gh-pr-merge-subagent.mjs:
    // `opts` é montado numa variável 1 linha antes da chamada via alias — só
    // uma janela bidirecional enxerga o `windowsHide` daqui.
    const content = [
      `export function isCallerInLinkedWorktree(cwd, execFn = execFileSync) {`,
      `  const opts = { encoding: "utf8", timeout: 10000, cwd, windowsHide: true };`,
      `  const gitDir = execFn("git", ["rev-parse", "--git-dir"], opts).trim();`,
      `}`,
    ].join("\n");
    assert.deepEqual(findConsoleBinaryCallsMissingWindowsHide(content), []);
  });
});

describe("Regressão #7959 — .claude/hooks/*.mjs reais deste repo (guard generalizado)", () => {
  const files = listHookFiles();

  it("existe pelo menos 1 hook .mjs pra varrer (sanity — senão o guard não prova nada)", () => {
    assert.ok(files.length > 0, `nenhum .mjs encontrado em ${HOOKS_DIR}`);
  });

  for (const file of files) {
    it(`${file}: se cita binário de console conhecido (git/powershell/cmd/tzutil/gh), toda chamada de processo declara windowsHide:true`, () => {
      const content = readFileSync(join(HOOKS_DIR, file), "utf8");
      const offenders = findConsoleBinaryCallsMissingWindowsHide(content);
      assert.deepEqual(
        offenders,
        [],
        `${file}: ${offenders.length} chamada(s) de processo sem windowsHide:true (offsets: ` +
          `${offenders.join(", ")}) — arquivo cita binário de console conhecido; no Windows isso pode ` +
          "alocar janela mesmo sem detached:true (#7959).",
      );
    });
  }
});

/**
 * #13559 — a mesma classe, fora de `.claude/hooks/`: processos de `scripts/`
 * que rodam DESTACADOS (`detached: true` + `windowsHide: true`) ficam sem
 * console herdável no Windows. Cada filho de console que eles lançam (`gh`,
 * `git`, `node`, `npx` via shell) sem `windowsHide` ganha uma janela própria —
 * medido ao vivo em 18/11/2026: o waiter `publish-edition-site-page.ts
 * --merge-pr` abria uma janela a cada `gh pr view` do polling, por até ~35 min.
 * Os mesmos `gh` chamados em foreground (com console herdado) não piscavam.
 *
 * Dois guards:
 *  1. todo `detached: true` em objeto de opções de processo em `scripts/`
 *     declara `windowsHide` no mesmo objeto, exceto binários de GUI (senão
 *     o próprio filho ganha console visível — o caso de `stage-1-run.ts`
 *     antes do #13559; até o #13575 só ancorava em `spawn(process.execPath`);
 *  2. os arquivos que rodam DENTRO de um processo destacado declaram
 *     `windowsHide` em toda chamada de processo (`exec`/`execSync`/`fork`
 *     incluídos). Os ENTRYPOINTS são uma lista explícita; as libs que eles
 *     importam são achadas seguindo os imports relativos (achado do review do
 *     PR: `lib/shared/gh-run.ts` e `lib/run-tsx.ts` ficavam de fora de uma
 *     lista manual de libs).
 */
const SCRIPTS_DIR = join(ROOT, "scripts");

/** Entrypoints que rodam como filho destacado, sem console (relativos a
 * scripts/). As libs que eles importam (transitivamente, imports relativos)
 * entram sozinhas. Desde o #13592 a lista é conferida contra os spawns
 * destacados reais (`deriveDetachedEntrypoints`): um script novo lançado
 * destacado e fora daqui reprova o teste, e uma entrada que ninguém mais
 * lança destacada também. */
const DETACHED_CHILD_ENTRYPOINTS = [
  "publish-edition-site-page.ts", // waiter --merge-pr (#9593/#9616)
  "eia-compose.ts", // stage-1-run §1d
  "prewarm-verify-cache.ts", // stage-1-run §1e-bis
  "serve-preview.ts", // --detach (#9678)
];

const RELATIVE_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Arquivo achado por `resolveFile`: o caminho real (com extensão, relativo
 * à raiz do repo) e o conteúdo. */
export type ResolvedSource = { path: string; content: string };

/** Resultado do fecho: arquivos alcançados e os imports relativos que não
 * resolveram (#13592 item 2: antes saíam do fecho em silêncio). */
export type ImportClosure = { files: string[]; unresolved: string[] };

/** Junta `baseDir` e `spec` e normaliza `.`/`..`, sem perder `..` que sobe
 * acima da raiz (o `scripts/../workers/...` do #13592 virava
 * `scripts/workers/...`). Pura. */
function joinRel(baseDir: string, spec: string): string {
  const norm: string[] = [];
  for (const p of (baseDir ? `${baseDir}/${spec}` : spec).split("/")) {
    if (p === "." || p === "") continue;
    if (p === ".." && norm.length > 0 && norm[norm.length - 1] !== "..") norm.pop();
    else norm.push(p);
  }
  return norm.join("/");
}

/** Fecho transitivo dos imports relativos de `entry` (caminhos relativos à
 * raiz do repo, ex.: `scripts/eia-compose.ts`). Segue `import … from`,
 * `export … from`, `import("…")` e `require("…")`. `resolveFile` recebe o
 * caminho como escrito no import (sem extensão, `.js` no lugar de `.ts`,
 * diretório com `index`) e devolve o arquivo real, ou `null`. Imports
 * `import type` também entram — inofensivo: só aumenta a varredura. Import
 * que não resolve vai para `unresolved` como `arquivo -> especificador`.
 * Pura sobre o sistema de arquivos. */
export function collectRelativeImportClosure(
  entry: string,
  resolveFile: (rel: string) => ResolvedSource | null,
): ImportClosure {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue: Array<{ rel: string; from: string | null; spec: string }> = [{ rel: entry, from: null, spec: entry }];
  while (queue.length > 0) {
    const { rel, from, spec } = queue.shift()!;
    const found = resolveFile(rel);
    if (found === null) {
      unresolved.push(from === null ? `(entrypoint) ${spec}` : `${from} -> ${spec}`);
      continue;
    }
    if (seen.has(found.path)) continue;
    seen.add(found.path);
    const baseDir = found.path.includes("/") ? found.path.slice(0, found.path.lastIndexOf("/")) : "";
    const code = stripComments(found.content);
    for (const m of code.matchAll(RELATIVE_IMPORT_RE)) {
      queue.push({ rel: joinRel(baseDir, m[1]), from: found.path, spec: m[1] });
    }
  }
  return { files: [...seen], unresolved };
}

/** Candidatos de arquivo pra um import relativo como escrito: o próprio,
 * `.ts`/`.mts` acrescentados, `.js`→`.ts`, `.mjs`→`.mts` e `index.*` de
 * diretório. */
function importCandidates(rel: string): string[] {
  return [
    rel,
    `${rel}.ts`,
    `${rel}.mts`,
    rel.replace(/\.js$/, ".ts"),
    rel.replace(/\.mjs$/, ".mts"),
    rel.replace(/\.cjs$/, ".cts"),
    `${rel}/index.ts`,
    `${rel}/index.js`,
    `${rel}/index.mjs`,
  ];
}

/** Script node destacado: 1º argumento do launcher é `process.execPath` ou
 * um literal `node`/`npx`/`tsx`. */
const NODE_LAUNCH_ARG_RE = /^\s*(?:process\.execPath|["'`](?:node|npx|tsx)(?:\.exe|\.cmd)?["'`])\s*$/;
const SCRIPT_LITERAL_RE = /["'`]((?:\.{0,2}\/)?[\w\-./]+\.(?:ts|mts|js|mjs|cjs))["'`]/g;
const SELF_REF_RE = /\bimport\.meta\.(?:url|filename)\b|\b__filename\b/;
/** Chamada de um wrapper de spawn destacado (nome com `detached`, ex.:
 * `deps.spawnDetached("scripts/eia-compose.ts", …)`) com o script literal. */
const DETACHED_WRAPPER_CALL_RE = /(?<![\w$])[\w$]*detached[\w$]*\s*\(\s*["'`]((?:\.{0,2}\/)?[\w\-./]+\.(?:ts|mts|js|mjs|cjs))["'`]/gi;

/** `scripts/x.ts`, `./x.ts` e `x.ts` viram `x.ts` (relativo a scripts/). */
function normalizeScriptRef(ref: string): string {
  return ref.replace(/^\.\//, "").replace(/^scripts\//, "");
}

/** Nomes das funções (declaração, `const f = …`, método) cujos corpos
 * envolvem `idx`, de dentro pra fora. Pura. */
function enclosingFunctionNames(masked: string, idx: number): string[] {
  const names: string[] = [];
  let cur = idx;
  for (;;) {
    const up = findEnclosingBracket(masked, cur);
    if (up < 0) break;
    if (masked[up] === "{" && isBlockBrace(masked, up)) {
      let s = up - 1;
      while (s >= 0 && !";{}".includes(masked[s])) s--;
      const head = masked.slice(s + 1, up);
      const m =
        /\bfunction\s*\*?\s*([\w$]+)/.exec(head) ??
        /\b(?:const|let|var)\s+([\w$]+)/.exec(head) ??
        /^\s*(?:(?:async|static|public|private|protected)\s+)*([\w$]+)\s*\(/.exec(head);
      if (m) names.push(m[1]);
    }
    cur = up;
  }
  return names;
}

/** Abertura do corpo de bloco mais externo que envolve `idx` (`-1` no topo
 * do arquivo). Pura. */
function outermostBlock(masked: string, idx: number): number {
  let found = -1;
  let cur = idx;
  for (;;) {
    const up = findEnclosingBracket(masked, cur);
    if (up < 0) break;
    if (masked[up] === "{" && isBlockBrace(masked, up)) found = up;
    cur = up;
  }
  return found;
}

/** Deriva, dos spawns destacados reais, os scripts que rodam como filho
 * destacado (#13592 item 1). Para cada `detached` (`findDetachedProps`) que
 * chega a um launcher de node (`NODE_LAUNCH_ARG_RE`), o script lançado é:
 *  - literal de script dentro da própria chamada;
 *  - o próprio arquivo, se a chamada ou o corpo de função mais externo em
 *    volta dela cita `import.meta.url` (auto-relançamento: `serve-preview.ts`
 *    `--detach`, waiter de `publish-edition-site-page.ts`);
 *  - ou, se uma das funções em volta tem `detached` no nome (wrapper como
 *    `realSpawnDetached` de `stage-1-run.ts`), os scripts literais passados
 *    a chamadas `*detached*(…)` em qualquer arquivo.
 * Spawn de node destacado que não cai em nenhum dos três vai para
 * `unclassified` (o teste reprova: classificar à mão ou ajustar a
 * derivação). Pura sobre o conteúdo recebido (`rel` relativo a scripts/). */
export function deriveDetachedEntrypoints(files: Array<{ rel: string; content: string }>): {
  entrypoints: string[];
  unclassified: string[];
} {
  const entrypoints = new Set<string>();
  const unclassified: string[] = [];
  let wrapperSeen = false;
  for (const { rel, content } of files) {
    const masked = maskJs(content, true);
    const noComments = maskJs(content, false);
    for (const idx of findDetachedProps(masked)) {
      const ctx = climbToLauncher(masked, idx);
      if (!ctx || ctx.launcherOpen < 0) continue;
      if (!NODE_LAUNCH_ARG_RE.test(firstArgText(masked, noComments, ctx.launcherOpen, ctx.topObj))) continue;
      const close = findCallClose(masked, ctx.launcherOpen);
      const callText = noComments.slice(ctx.launcherOpen, close > 0 ? close : ctx.objEnd);
      const literals = [...callText.matchAll(SCRIPT_LITERAL_RE)].map((m) => normalizeScriptRef(m[1]));
      if (literals.length > 0) {
        for (const l of literals) entrypoints.add(l);
        continue;
      }
      const outer = outermostBlock(masked, ctx.launcherOpen);
      const body = outer < 0 ? callText : noComments.slice(outer, findBracketClose(masked, outer));
      if (SELF_REF_RE.test(callText) || SELF_REF_RE.test(body)) {
        entrypoints.add(rel);
        continue;
      }
      if (enclosingFunctionNames(masked, ctx.launcherOpen).some((n) => /detached/i.test(n))) {
        wrapperSeen = true;
        continue;
      }
      unclassified.push(`${rel} (offset ${idx})`);
    }
  }
  if (wrapperSeen) {
    for (const { content } of files) {
      for (const m of maskJs(content, false).matchAll(DETACHED_WRAPPER_CALL_RE)) entrypoints.add(normalizeScriptRef(m[1]));
    }
  }
  return { entrypoints: [...entrypoints].sort(), unclassified };
}

/** Como `findWindowsHideMissingCalls`, mas também cobre `exec(`, `execSync(` e
 * `fork(` (achado do review: `execSync("git worktree prune")` e o `exec` do
 * `openInBrowser` passavam). Mesma regra de corpo da chamada do #13575.
 * Offsets no `code` recebido. Pura. */
export function findWindowsHideMissingCallsBroad(code: string): number[] {
  const masked = maskJs(code, true);
  const nsRe = namespaceBroadCallRe(code);
  const patterns = nsRe ? [LITERAL_CALL_RE, BROAD_CALL_RE, nsRe] : [LITERAL_CALL_RE, BROAD_CALL_RE];
  const sites = collectCallSites(masked, patterns, discoverInjectedExecAliases(code, BROAD_LAUNCHERS));
  return offendersFromSites(masked, sites);
}

function listScriptFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...listScriptFiles(dir, relPath));
    } else if (/\.(ts|mjs|js|cjs)$/.test(entry.name)) out.push(relPath);
  }
  return out;
}

/** Binários de GUI ou abridores de URL: um `detached: true` lançando um
 * deles não abre console (rundll32/explorer são GUI no Windows; `open` e
 * `xdg-open` só rodam fora do Windows, onde `windowsHide` não faz nada).
 * Com `shell: true` no objeto de opções a isenção não vale: no Windows o
 * shell é `cmd.exe`, que é console. */
const GUI_BINARY_LITERAL_RE = /["'`](?:rundll32(?:\.exe)?|explorer(?:\.exe)?|open|xdg-open)["'`]/i;

/** `true` quando o 1º argumento da chamada (texto, já sem comentários) é um
 * binário de GUI: literal direto, ou um identificador cujo `const`/`let`
 * no mesmo arquivo só cita binários de GUI. Pura. */
function isGuiBinaryArg(firstArg: string, noComments: string): boolean {
  let text = firstArg.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(text)}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(
      noComments,
    );
    if (!decl) return false;
    text = decl[1];
  }
  return GUI_BINARY_LITERAL_RE.test(text) && !CONSOLE_BINARY_LITERAL_RE.test(text);
}

/** Posição do bracket (`(`, `[` ou `{`) não fechado mais próximo antes de
 * `idx`, de qualquer tipo, num texto já mascarado. `-1` se não houver.
 * Buscar só `(` pulava para um parêntese de fora quando o que envolve `idx`
 * é um `{` de bloco (#13575, fleet review). Pura. */
function findEnclosingBracket(masked: string, idx: number): number {
  let depth = 0;
  for (let k = idx - 1; k >= 0; k--) {
    const ch = masked[k];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

/** Índice logo depois do `}`/`]`/`)` que fecha o bracket em `open`. `-1`
 * se não fechar. Pura. */
function findBracketClose(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/** Palavras que, logo antes de `{`, fazem dele um objeto literal (ou tipo
 * literal) e não um bloco. Qualquer outro identificador antes de `{` indica
 * bloco: `else {`, `try {`, `catch {`, `static {`, `class C {`,
 * `class C extends B {`, `(): void {`, `run(): T {` (#13575). */
const OBJECT_BEFORE_BRACE_KEYWORDS = new Set([
  "return", "yield", "await", "typeof", "in", "of", "instanceof", "new", "delete", "throw", "default", "as", "satisfies",
]);

/** `true` quando o `:` em `colon` fecha um rótulo (`outer:`) ou um `case X:`
 * / `default:` de `switch`, e por isso o `{` depois dele é bloco. Dentro de
 * objeto literal, parêntese ou array, ou depois de um `?` (ternário), não é.
 * Pura. */
function isStatementColon(masked: string, colon: number): boolean {
  const encl = findEnclosingBracket(masked, colon);
  if (encl >= 0 && (masked[encl] !== "{" || !isBlockBrace(masked, encl))) return false;
  let s = colon - 1;
  while (s >= 0 && !";{}".includes(masked[s])) s--;
  const seg = masked.slice(s + 1, colon);
  if (seg.includes("?")) return false;
  if (/^\s*case\b/.test(seg)) return true;
  // Rótulo ou `default`: só a última linha conta (sem `;` antes, por ASI, o
  // trecho traz o fim do statement anterior).
  const lastLine = seg.slice(seg.lastIndexOf("\n") + 1).trim();
  return /^(?:case\b.*|[A-Za-z_$][\w$]*)$/.test(lastLine);
}

/** `true` quando o `{` em `open` abre um BLOCO (corpo de função/arrow/
 * método/classe, `if (…) {`, `else {`, `catch {`, `static {`, bloco solto,
 * rotulado ou de `case`), não um objeto literal. Heurística pelo último
 * caractere significativo antes dele: `)`, `>` (`=>`, `Promise<void> {`),
 * `;`, `{`, `}`, identificador (fora `OBJECT_BEFORE_BRACE_KEYWORDS`) ou
 * início do arquivo = bloco; `:` = bloco só em rótulo/`case`
 * (`isStatementColon`); `(`, `,`, `=`, `?`, `[`, `...`, `return` = objeto.
 * Pura. */
function isBlockBrace(masked: string, open: number): boolean {
  let k = open - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  if (k < 0) return true;
  const ch = masked[k];
  if (ch === ")" || ch === ";" || ch === "{" || ch === "}" || ch === ">") return true;
  if (ch === ":") return isStatementColon(masked, k);
  if (/[\w$]/.test(ch)) {
    let s = k;
    while (s >= 0 && /[\w$]/.test(masked[s])) s--;
    if (/^\d/.test(masked.slice(s + 1, k + 1))) return false;
    return !OBJECT_BEFORE_BRACE_KEYWORDS.has(masked.slice(s + 1, k + 1));
  }
  return false;
}

/** Palavras-chave que precedem `(` sem ser chamada (`if (`, `for (`…): o
 * `(` delas é tratado como parêntese de agrupamento, sem nome. */
const NON_CALL_PAREN_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "void", "await", "yield", "in", "of", "new", "case",
]);

/** Nome da chamada cujo `(` está em `open` (`""` se for parêntese de
 * agrupamento, `(bg ? … : …)`, ou de palavra-chave). Pura. */
function calleeBefore(masked: string, open: number): string {
  const name = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, open - 80), open))?.[1] ?? "";
  return NON_CALL_PAREN_KEYWORDS.has(name) ? "" : name;
}

/** Chamada que lança processo: nome começando com `spawn`/`exec`/`fork`
 * (`spawn`, `spawnFn`, `execFile`, `execFn`…). */
const LAUNCHER_CALLEE_RE = /^(?:spawn|exec|fork)/i;
const SHELL_TRUE_RE = /\bshell\s*:\s*true\b/;

/** Offsets de todo `detached: true` de um objeto de opções de processo sem
 * `windowsHide: true` no MESMO objeto (#13575; até ali o guard só ancorava
 * em `spawn(process.execPath`, e `spawn("node", …)`/`spawn("npx", …)`
 * destacados passavam).
 *
 * A partir do objeto que contém o `detached: true`, sobe pelos brackets que
 * o envolvem (fleet review do #13575): parêntese de agrupamento
 * (`...(bg ? { detached: true } : {})`), array e objeto literal continuam a
 * subida; chamada que não lança processo (`Object.assign(…)`,
 * `JSON.stringify(…)`) também continua; a 1ª chamada lançadora encontrada
 * decide. Um `{` de BLOCO (corpo de arrow/função, `if {}`) ou o topo do
 * arquivo encerram a subida. Fica de fora (não acusa):
 *  - objeto envolvido só por chamadas que não lançam processo, sem nenhuma
 *    lançadora acima (ex.: `JSON.stringify({ ...child, detached: true })` em
 *    `serve-preview.ts`);
 *  - chamada lançadora cujo 1º argumento é binário de GUI
 *    (`GUI_BINARY_LITERAL_RE`: `rundll32`, `explorer`, `open`, `xdg-open`),
 *    por literal ou por `const` no mesmo arquivo — exceto com `shell: true`
 *    no objeto de opções, que no Windows passa por `cmd.exe` (console).
 * Objeto solto (`const opts = { detached: true }`, inclusive dentro do
 * corpo de um callback) é checado. Fail closed: na dúvida, acusa.
 * Limite: `{ ...base, detached: true }` com o `windowsHide` vindo de `base`
 * é acusado (falso positivo seguro: basta repetir a flag). Offsets no
 * `content` recebido. Pura. */
export function findDetachedSpawnsWithoutWindowsHide(content: string): number[] {
  const masked = maskJs(content, true);
  const noComments = maskJs(content, false);
  const offenders: number[] = [];
  for (const idx of findDetachedProps(masked)) {
    const ctx = climbToLauncher(masked, idx);
    if (!ctx) {
      // Sem objeto em volta (texto fora de padrão): janela, fail closed.
      const win = masked.slice(Math.max(0, idx - WINDOW_CHARS), idx + WINDOW_CHARS);
      if (!WINDOWS_HIDE_RE.test(win)) offenders.push(idx);
      continue;
    }
    const { topObj, objEnd, launcherOpen, sawOtherCall } = ctx;
    // #13592 item 5: a flag conta só no próprio objeto de opções, fora de
    // string e de objeto aninhado como valor de propriedade.
    if (hasOwnWindowsHide(masked.slice(topObj, objEnd), 0)) continue;
    if (launcherOpen < 0) {
      if (sawOtherCall) continue; // só chamadas que não lançam processo em volta
      offenders.push(idx); // objeto solto
      continue;
    }
    const gui = isGuiBinaryArg(firstArgText(masked, noComments, launcherOpen, topObj), noComments);
    if (gui && !SHELL_TRUE_RE.test(masked.slice(topObj, objEnd))) continue;
    offenders.push(idx);
  }
  return offenders;
}

/** Contexto de um `detached` dentro de objeto: o objeto literal mais externo
 * atravessado (`topObj`, até `objEnd`), a chamada lançadora que o recebe
 * (`launcherOpen`, `-1` se nenhuma) e se houve chamada não lançadora no
 * caminho. `null` quando o `detached` não está dentro de `{`. Pura. */
function climbToLauncher(
  masked: string,
  idx: number,
): { topObj: number; objEnd: number; launcherOpen: number; sawOtherCall: boolean } | null {
  const encl = findEnclosingBracket(masked, idx);
  if (encl < 0 || masked[encl] !== "{") return null;
  // Sobe pelos objetos literais até a chamada lançadora (ou até um bloco).
  let topObj = encl; // objeto literal mais externo atravessado
  let cur = encl;
  let launcherOpen = -1;
  let sawOtherCall = false;
  for (;;) {
    const up = findEnclosingBracket(masked, cur);
    if (up < 0) break;
    const ch = masked[up];
    if (ch === "{") {
      if (isBlockBrace(masked, up)) break;
      topObj = up;
    } else if (ch === "(") {
      const callee = calleeBefore(masked, up);
      if (LAUNCHER_CALLEE_RE.test(callee)) {
        launcherOpen = up;
        break;
      }
      if (callee) sawOtherCall = true;
    }
    cur = up;
  }
  const close = findBracketClose(masked, topObj);
  return { topObj, objEnd: close > 0 ? close : masked.length, launcherOpen, sawOtherCall };
}

/** Texto (sem comentários) do 1º argumento da chamada aberta em
 * `launcherOpen`. Pura. */
function firstArgText(masked: string, noComments: string, launcherOpen: number, fallbackEnd: number): string {
  const close = findCallClose(masked, launcherOpen);
  const argsEnd = close > 0 ? close - 1 : fallbackEnd;
  let firstArgEnd = argsEnd;
  let depth = 0;
  for (let k = launcherOpen + 1; k < argsEnd; k++) {
    const ch = masked[k];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      firstArgEnd = k;
      break;
    }
  }
  return noComments.slice(launcherOpen + 1, firstArgEnd);
}

/** Valores de `detached:` que com certeza não destacam (#13592 item 3). */
const NON_DETACHING_VALUE_RE = /^(?:false|undefined|null|0)(?![\w$])/;

/** Offsets, num texto mascarado (sem comentários nem strings), de toda
 * propriedade `detached` que PODE destacar (#13592 item 3): `detached:
 * true`, mas também `detached: !fg`, `detached: isBg`, `detached:
 * process.platform !== "win32"` e o shorthand `{ detached }`. Ficam de fora
 * só os valores que certamente não destacam (`false`, `undefined`, `null`,
 * `0`), o acesso `x.detached`, `detached?:` de tipo e o shorthand em padrão
 * de desestruturação (`const { detached } = o`, `({ detached }) =>`,
 * `function f({ detached }) {`). Fail closed: valor não literal conta como
 * destacado. Pura. */
function findDetachedProps(masked: string): number[] {
  const out: number[] = [];
  const re = /(?<![\w$.])detached(?![\w$])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const colon = /^\s*:\s*/.exec(after);
    if (colon) {
      if (!NON_DETACHING_VALUE_RE.test(after.slice(colon[0].length))) out.push(m.index);
      continue;
    }
    if (!/^\s*[,}]/.test(after)) continue;
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(masked[k])) k--;
    if (k < 0 || (masked[k] !== "{" && masked[k] !== ",")) continue;
    const encl = findEnclosingBracket(masked, m.index);
    if (encl < 0 || masked[encl] !== "{" || isBlockBrace(masked, encl)) continue;
    if (isDestructuringPattern(masked, encl)) continue;
    out.push(m.index);
  }
  return out;
}

/** `true` quando o `{` em `open` é padrão de desestruturação, não objeto
 * literal: `const|let|var {…}`, `{…} = x`, `({…}) =>`, `function f({…}) {`.
 * Pura. */
function isDestructuringPattern(masked: string, open: number): boolean {
  if (/\b(?:const|let|var)\s*$/.test(masked.slice(Math.max(0, open - 20), open))) return true;
  const close = findBracketClose(masked, open);
  if (close < 0) return false;
  const rest = masked.slice(close, close + 200);
  if (/^\s*=(?![=>])/.test(rest)) return true;
  return /^\s*\)\s*(?:=>|\{)/.test(rest);
}

describe("findDetachedSpawnsWithoutWindowsHide (#13559, #13575) — lógica pura", () => {
  it("spawn(process.execPath) destacado sem windowsHide -> 1 ofensor", () => {
    const content = `spawn(process.execPath, ["--import", "tsx", abs], { cwd, detached: true, stdio: "ignore" });`;
    assert.equal(findDetachedSpawnsWithoutWindowsHide(content).length, 1);
  });

  it("mesmo spawn COM windowsHide -> nenhum ofensor", () => {
    const content = `spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("spawn(process.execPath) em foreground (sem detached) -> fora do escopo deste guard", () => {
    const content = `spawn(process.execPath, args, { stdio: "inherit" });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("windowsHide citado só num comentário não conta", () => {
    const content = [
      `spawn(process.execPath, args, {`,
      `  detached: true, // falta windowsHide: true aqui`,
      `  stdio: "ignore",`,
      `});`,
    ].join("\n");
    assert.equal(findDetachedSpawnsWithoutWindowsHide(content).length, 1);
  });

  it("#13575: spawn destacado de outro binário (\"npx\", não process.execPath) sem windowsHide -> 1 ofensor", () => {
    // Antes do #13575 o guard só ancorava em `spawn(process.execPath` e isto passava.
    const content = `spawn("npx", ["tsx", "scripts/x.ts"], { detached: true, stdio: "ignore", shell: true });`;
    assert.equal(findDetachedSpawnsWithoutWindowsHide(content).length, 1);
  });

  it("#13575: spawn destacado via alias injetado (spawnFn) sem windowsHide -> 1 ofensor", () => {
    const content = `spawnFn("node", [script], { detached: true, stdio: "ignore" }).unref();`;
    assert.equal(findDetachedSpawnsWithoutWindowsHide(content).length, 1);
  });

  it("#13575: windowsHide da chamada SEGUINTE não cobre esta (mesmo objeto, não janela)", () => {
    const content = [
      `spawn("node", [a], { detached: true, stdio: "ignore" });`,
      `spawn("node", [b], { detached: true, stdio: "ignore", windowsHide: true });`,
    ].join("\n");
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
  });

  it("#13575: binário de GUI (rundll32) destacado -> fora do escopo, nenhum ofensor", () => {
    const content = `spawn("rundll32", ["url.dll,FileProtocolHandler", url], { shell: false, stdio: "ignore", detached: true }).unref();`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("#13575: abridor por variável (`const opener = darwin ? \"open\" : \"xdg-open\"`) -> nenhum ofensor", () => {
    const content = [
      `const opener = process.platform === "darwin" ? "open" : "xdg-open";`,
      `spawn(opener, [authUrl], { stdio: "ignore", detached: true }).unref();`,
    ].join("\n");
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("#13575 fleet review: binário de GUI com `shell: true` no mesmo objeto NÃO é isento (o shell é cmd.exe no Windows)", () => {
    const content = [
      `const opener = process.platform === "darwin" ? "open" : "xdg-open";`,
      `spawn(opener, [authUrl], { shell: true, stdio: "ignore", detached: true }).unref();`,
    ].join("\n");
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
    const literal = `spawn("rundll32", [u], { shell: true, detached: true });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(literal), [literal.indexOf("detached")]);
  });

  it("#13575 fleet review: opts solto dentro do corpo de um callback (new Promise) -> 1 ofensor (antes pulava pro `(` de fora)", () => {
    const content = `new Promise((resolve) => { const opts = { detached: true, stdio: "ignore" }; spawn("node", [], opts); });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
  });

  it("#13575 fleet review: opts solto dentro do handler de app.get(...) -> 1 ofensor", () => {
    const content = [
      `app.get("/", () => {`,
      `  const opts = { detached: true, stdio: "ignore" };`,
      `  spawn("node", ["w.js"], opts);`,
      `});`,
    ].join("\n");
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
  });

  it("#13575 fleet review: opts solto dentro do corpo de função/if -> 1 ofensor; COM windowsHide -> nenhum", () => {
    const bad = `function f() { if (x) { const o = { detached: true }; spawn("node", [], o); } }`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(bad), [bad.indexOf("detached")]);
    const ok = `function f() { if (x) { const o = { detached: true, windowsHide: true }; spawn("node", [], o); } }`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(ok), []);
  });

  it("#13575 fleet review: `detached` dentro de spread condicional `...(bg ? { detached: true } : {})` -> 1 ofensor (callee vazio sobe)", () => {
    const content = `spawn(cmd, args, { stdio: "ignore", ...(bg ? { detached: true } : {}) });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
  });

  it("#13575 fleet review: spread condicional com windowsHide no objeto de opções de fora -> nenhum ofensor", () => {
    const content = `spawn(cmd, args, { windowsHide: true, ...(bg ? { detached: true } : {}) });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("#13575 fleet review: `Object.assign({}, base, { detached: true })` como opções de spawn -> 1 ofensor (sobe até o spawn)", () => {
    const content = `spawn(cmd, args, Object.assign({}, base, { detached: true }));`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
  });

  it("#13575 fleet review: `JSON.stringify` dentro de `console.log` dentro de callback, sem lançadora acima -> nenhum ofensor", () => {
    const content = `child.on("exit", () => { console.log(JSON.stringify({ ...child, detached: true }, null, 2)); });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("#13575: `detached: true` dentro de chamada que não lança processo (JSON.stringify) -> nenhum ofensor", () => {
    const content = `console.log(JSON.stringify({ ...child, detached: true, reused: false }, null, 2));`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), []);
  });

  it("#13575: objeto de opções solto numa variável, sem windowsHide -> 1 ofensor", () => {
    const content = `const opts = { detached: true, stdio: "ignore" };\nspawn("node", [s], opts);`;
    assert.equal(findDetachedSpawnsWithoutWindowsHide(content).length, 1);
  });

  describe("#13575 fleet review (P2): `{` de bloco precedido por identificador, `>` ou `:` de rótulo/case", () => {
    // Antes, `isBlockBrace` tratava esses `{` como objeto: `topObj` engolia o
    // corpo inteiro e o `windowsHide: true` de OUTRA chamada do mesmo corpo
    // cobria o `opts` solto com `detached: true`.
    const body = `const o = { detached: true }; spawn("node", [], o); execFileSync("git", [], { windowsHide: true });`;
    const cases: Array<[string, string]> = [
      ["função com tipo de retorno", `function f(): void { ${body} }`],
      ["async com Promise<void>", `async function main(): Promise<void> { ${body} }`],
      ["método com tipo de retorno", `class K { run(): T { ${body} } }`],
      ["corpo de classe (static block)", `class C { static { ${body} } }`],
      ["class C extends B + static", `class C extends B { static { ${body} } }`],
      ["catch sem binding", `try { x(); } catch { ${body} }`],
      ["bloco rotulado", `outer: { ${body} }`],
      ["bloco rotulado depois de statement sem `;` (ASI)", `foo()\nouter: { ${body} }`],
      ["case de switch", `switch (x) { case 1: { ${body} } }`],
      ["default de switch", `switch (x) { default: { ${body} } }`],
    ];
    for (const [label, content] of cases) {
      it(`${label} -> 1 ofensor`, () => {
        assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
      });
    }

    it("os mesmos blocos COM windowsHide no próprio opts -> nenhum ofensor", () => {
      const okBody = `const o = { detached: true, windowsHide: true }; spawn("node", [], o);`;
      for (const content of [`function f(): void { ${okBody} }`, `outer: { ${okBody} }`, `switch (x) { case 1: { ${okBody} } }`]) {
        assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [], content);
      }
    });

    it("`:` de propriedade e de ternário seguem sendo objeto -> windowsHide do objeto de fora vale", () => {
      const prop = `spawn(cmd, args, { windowsHide: true, extra: { detached: true } });`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(prop), []);
      const ternary = `spawn(cmd, args, { windowsHide: true, ...(bg ? {} : { detached: true }) });`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(ternary), []);
      const stmtTernary = `const o = bg ? { windowsHide: true } : { windowsHide: true, detached: true };\nspawn("node", [], o);`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(stmtTernary), []);
    });

    it("`return {`, `() => ({`, `export default {` seguem sendo objeto", () => {
      const ret = `function f() { return { detached: true, windowsHide: true }; }`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(ret), []);
      const arrow = `const mk = () => ({ detached: true, windowsHide: true });`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(arrow), []);
      const retBad = `function f() { return { detached: true }; }`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(retBad), [retBad.indexOf("detached")]);
      const def = `export default { opts: { detached: true }, windowsHide: true };`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(def), []);
    });
  });
});

describe("#13575 fleet review — chamada de alias por optional chaining e nomes genéricos", () => {
  it("(P3) `deps?.execFn(...)` sem windowsHide -> 1 ofensor", () => {
    const content = [`function f(execFn = execFileSync) {`, `  return deps?.execFn("git", ["status"], {});`, `}`].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`execFn("git"`)]);
  });

  it("(P3) `this?.run(...)` de alias genérico sem windowsHide -> 1 ofensor", () => {
    const content = `const run = spawnSync;\nclass C { go() { return this?.run("git", [], {}); } }`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`run("git"`)]);
  });

  it("(P3) alias com nome de método comum: `db.run(...)`, `fn.call(...)`, `res.send(...)` não contam; `run(...)` solto conta", () => {
    for (const name of ["run", "call", "apply", "bind", "get", "set", "send", "start"]) {
      const content = `const ${name} = spawnSync;\ndb.${name}("SELECT 1");\nx?.${name}(1);\n${name}("git", [], { windowsHide: true });`;
      assert.deepEqual(findWindowsHideMissingCalls(content), [], name);
      const bad = `const ${name} = spawnSync;\n${name}("git", [], {});`;
      assert.deepEqual(findWindowsHideMissingCalls(bad), [bad.indexOf(`${name}("git"`)], name);
    }
  });
});

describe("Regressão #13559 — scripts/ reais deste repo", () => {
  const files = listScriptFiles(SCRIPTS_DIR);

  it("existe script pra varrer (sanity)", () => {
    assert.ok(files.length > 0, `nenhum script encontrado em ${SCRIPTS_DIR}`);
  });

  it("todo spawn destacado (detached: true) em scripts/ declara windowsHide:true, fora binário de GUI", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = findDetachedSpawnsWithoutWindowsHide(readFileSync(join(SCRIPTS_DIR, file), "utf8"));
      if (hits.length > 0) offenders.push(`${file} (offsets ${hits.join(", ")})`);
    }
    assert.deepEqual(
      offenders,
      [],
      "spawn destacado de node sem windowsHide abre um console visível no Windows pela vida inteira do filho (#13559).",
    );
  });

  /** Caminho relativo à raiz do repo -> arquivo real (ver `importCandidates`). */
  const resolveSource = (rel: string): ResolvedSource | null => {
    if (rel.startsWith("..")) return null; // fora do repo
    for (const candidate of importCandidates(rel)) {
      try {
        return { path: candidate, content: readFileSync(join(ROOT, candidate), "utf8") };
      } catch {
        // tenta o próximo candidato (inexistente, ou diretório: EISDIR)
      }
    }
    return null;
  };

  it("#13592: DETACHED_CHILD_ENTRYPOINTS bate com os spawns destacados de node em scripts/", () => {
    const { entrypoints, unclassified } = deriveDetachedEntrypoints(
      files.map((rel) => ({ rel, content: readFileSync(join(SCRIPTS_DIR, rel), "utf8") })),
    );
    assert.deepEqual(
      unclassified,
      [],
      "spawn destacado de node sem script identificável (literal na chamada, import.meta.url no corpo, ou wrapper `*Detached*`): ajuste deriveDetachedEntrypoints.",
    );
    assert.deepEqual(
      entrypoints,
      [...DETACHED_CHILD_ENTRYPOINTS].sort(),
      "script lançado destacado fora de DETACHED_CHILD_ENTRYPOINTS (ou entrada que ninguém mais lança destacada): atualize a lista.",
    );
  });

  const reached = new Set<string>();
  const unresolvedImports = new Set<string>();
  for (const entry of DETACHED_CHILD_ENTRYPOINTS) {
    it(`${entry}: entrypoint destacado existe (senão o guard não prova nada)`, () => {
      assert.ok(resolveSource(`scripts/${entry}`) !== null, `scripts/${entry} sumiu — atualize DETACHED_CHILD_ENTRYPOINTS`);
    });
    const closure = collectRelativeImportClosure(`scripts/${entry}`, resolveSource);
    for (const rel of closure.files) reached.add(rel);
    for (const u of closure.unresolved) unresolvedImports.add(u);
  }
  // #14276: o waiter da página do site (`publish-edition-site-page.ts`) roda o
  // `session-registry.ts` como CLI filho (`merge-lock-acquire`/`-release`) em
  // vez de importá-lo. O filho herda a árvore destacada (sem console), então os
  // processos que ELE lança também precisam de windowsHide: entra no fecho.
  for (const child of ["scripts/lib/session-registry.ts"]) {
    const closure = collectRelativeImportClosure(child, resolveSource);
    for (const rel of closure.files) reached.add(rel);
    for (const u of closure.unresolved) unresolvedImports.add(u);
  }

  it("o fecho de imports alcança as libs que já abriram janela (gh-run, run-tsx, session-registry)", () => {
    for (const lib of ["scripts/lib/shared/gh-run.ts", "scripts/lib/run-tsx.ts", "scripts/lib/session-registry.ts"]) {
      assert.ok(reached.has(lib), `${lib} deveria estar no fecho de imports dos entrypoints destacados`);
    }
  });

  it("#13592: todo import relativo do fecho resolve (import que não resolve sairia da varredura em silêncio)", () => {
    assert.deepEqual([...unresolvedImports].sort(), []);
  });

  for (const file of [...reached].sort()) {
    it(`${file}: roda dentro de processo destacado (sem console), então toda chamada de processo declara windowsHide:true`, () => {
      const content = resolveSource(file)?.content ?? "";
      if (!/child_process/.test(content)) return; // não lança processo
      const code = stripComments(content);
      const offenders = findWindowsHideMissingCallsBroad(code);
      assert.deepEqual(
        offenders.map((o) => code.slice(o, o + 80).replace(/\s+/g, " ")),
        [],
        `${file}: ${offenders.length} chamada(s) de processo sem windowsHide:true — rodando destacado, ` +
          "cada gh/git/node filho abre uma janela no Windows (#13559).",
      );
    });
  }
});

describe("lexJs — propriedade sobre os fontes reais (fleet review do #13575)", () => {
  it("segmentos de lexJs são contíguos e, concatenados, reproduzem a fonte (scripts/ e .claude/hooks/)", () => {
    const files = [
      ...listScriptFiles(SCRIPTS_DIR).map((f) => join(SCRIPTS_DIR, f)),
      ...listHookFiles().map((f) => join(HOOKS_DIR, f)),
    ];
    assert.ok(files.length > 0, "nenhum fonte pra varrer");
    const broken: string[] = [];
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      const segs = lexJs(src);
      let pos = 0;
      for (const s of segs) {
        if (s.start !== pos || s.end <= s.start) break;
        pos = s.end;
      }
      if (pos !== src.length || segs.map((s) => src.slice(s.start, s.end)).join("") !== src) broken.push(path);
    }
    assert.deepEqual(broken, []);
  });
});

describe("lexJs — string e regex não atravessam quebra de linha (#13592, comentário da issue)", () => {
  // Propriedade mais forte que a da concatenação (verdadeira por construção):
  // fora de template literal, um segmento `string` ou `regex` com quebra de
  // linha é sinal de leitura errada (regex engolindo código, aspas perdidas).
  // Exceção legítima: continuação de linha `\` + newline dentro de string.
  it("nenhum segmento string (de aspas) ou regex dos fontes reais contém newline fora de continuação", () => {
    const files = [
      ...listScriptFiles(SCRIPTS_DIR).map((f) => join(SCRIPTS_DIR, f)),
      ...listHookFiles().map((f) => join(HOOKS_DIR, f)),
    ];
    const broken: string[] = [];
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      for (const s of lexJs(src)) {
        if (s.kind !== "string" && s.kind !== "regex") continue;
        const first = src[s.start];
        if (s.kind === "string" && first !== '"' && first !== "'") continue; // template
        const text = src.slice(s.start, s.end).replace(/\\\r?\n/g, "");
        if (/\n/.test(text)) broken.push(`${path}:${s.start}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  it("discrimina: divisão seguida de divisão na linha seguinte não vira regex", () => {
    const src = "const a = b / c;\nconst d = e / f;";
    assert.ok(lexJs(src).every((s) => s.kind === "code"));
  });
});

describe("#13592 item 1 — deriveDetachedEntrypoints", () => {
  it("literal de script dentro da chamada destacada de node", () => {
    const content = `spawn(process.execPath, ["--import", "tsx", "scripts/novo-bg.ts"], { detached: true, windowsHide: true });`;
    assert.deepEqual(deriveDetachedEntrypoints([{ rel: "a.ts", content }]).entrypoints, ["novo-bg.ts"]);
  });

  it("auto-relançamento: import.meta.url no corpo da função em volta -> o próprio arquivo", () => {
    const content = [
      `export const launch = () => {`,
      `  const self = fileURLToPath(import.meta.url);`,
      `  spawn(process.execPath, [self, "--child"], { detached: true, windowsHide: true }).unref();`,
      `};`,
    ].join("\n");
    assert.deepEqual(deriveDetachedEntrypoints([{ rel: "waiter.ts", content }]).entrypoints, ["waiter.ts"]);
  });

  it("wrapper `*Detached*`: os scripts passados às chamadas do wrapper em qualquer arquivo", () => {
    const wrapper = [
      `export function realSpawnDetached(root: string) {`,
      `  return (rel: string, args: string[]) => {`,
      `    spawn(process.execPath, ["--import", "tsx", rel, ...args], { detached: true, windowsHide: true });`,
      `  };`,
      `}`,
    ].join("\n");
    const caller = `deps.spawnDetached("scripts/fila-bg.ts", ["--x"]);`;
    const out = deriveDetachedEntrypoints([
      { rel: "stage.ts", content: wrapper },
      { rel: "outro.ts", content: caller },
    ]);
    assert.deepEqual(out, { entrypoints: ["fila-bg.ts"], unclassified: [] });
  });

  it("spawn destacado de node sem script identificável -> unclassified (o teste real reprova)", () => {
    const content = `function go(p: string) { spawn(process.execPath, [p], { detached: true, windowsHide: true }); }`;
    assert.equal(deriveDetachedEntrypoints([{ rel: "x.ts", content }]).unclassified.length, 1);
  });

  it("valor não literal (`detached: isBg`) também conta; binário que não é node fica de fora", () => {
    const content = [
      `spawn("node", ["scripts/bg.ts"], { detached: isBg, windowsHide: true });`,
      `spawn("rundll32", ["url.dll,FileProtocolHandler", "scripts/nao.ts"], { detached: true });`,
    ].join("\n");
    assert.deepEqual(deriveDetachedEntrypoints([{ rel: "x.ts", content }]).entrypoints, ["bg.ts"]);
  });
});

describe("#13592 item 2 — collectRelativeImportClosure resolve ou lista", () => {
  const fakeFs: Record<string, string> = {
    "scripts/a.ts": [
      `import { m } from "../workers/arquivo/src/hubs/meta.ts";`,
      `import { lib } from "./lib";`,
      `const c = require("./c.js");`,
      `export { z } from "./z.js";`,
      `import { nada } from "./sumiu.ts";`,
    ].join("\n"),
    "workers/arquivo/src/hubs/meta.ts": `export const m = 1;`,
    "scripts/lib/index.ts": `export const lib = 1;`,
    "scripts/c.ts": `module.exports = 1;`,
    "scripts/z.ts": `export const z = 1;`,
  };
  const resolveFake = (rel: string): ResolvedSource | null => {
    for (const c of importCandidates(rel)) if (c in fakeFs) return { path: c, content: fakeFs[c] };
    return null;
  };

  it("`..` acima de scripts/, diretório com index, require e export-from entram no fecho", () => {
    const { files } = collectRelativeImportClosure("scripts/a.ts", resolveFake);
    assert.deepEqual(files.sort(), [
      "scripts/a.ts",
      "scripts/c.ts",
      "scripts/lib/index.ts",
      "scripts/z.ts",
      "workers/arquivo/src/hubs/meta.ts",
    ]);
  });

  it("import que não resolve vai para unresolved em vez de sumir", () => {
    assert.deepEqual(collectRelativeImportClosure("scripts/a.ts", resolveFake).unresolved, ["scripts/a.ts -> ./sumiu.ts"]);
  });
});

describe("#13592 item 3 — âncora além do literal `detached: true`", () => {
  const flagged: Array<[string, string]> = [
    ["`detached: !fg`", `{ detached: !fg, stdio: "ignore" }`],
    ["`detached: isBg`", `{ detached: isBg, stdio: "ignore" }`],
    ["`detached: process.platform !== \"win32\"`", `{ detached: process.platform !== "win32" }`],
    ["shorthand `{ detached }`", `{ detached, stdio: "ignore" }`],
    ["shorthand no fim `{ stdio, detached }`", `{ stdio, detached }`],
  ];
  for (const [label, opts] of flagged) {
    it(`${label} sem windowsHide -> 1 ofensor nos dois guards (scripts/ e hooks)`, () => {
      const content = `spawn("node", ["w.js"], ${opts});`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [content.indexOf("detached")]);
      assert.deepEqual(findDetachedWithoutWindowsHide(content), [content.indexOf("detached")]);
    });
  }

  it("mesmos valores COM windowsHide -> nenhum ofensor", () => {
    for (const opts of [`{ detached: !fg, windowsHide: true }`, `{ detached, windowsHide: true }`]) {
      const content = `spawn("node", ["w.js"], ${opts});`;
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [], opts);
    }
  });

  it("não destaca ou não é propriedade: `false`/`undefined`/`null`/`0`, `x.detached`, `detached?:` de tipo, desestruturação", () => {
    for (const content of [
      `spawn("node", [], { detached: false });`,
      `spawn("node", [], { detached: undefined });`,
      `spawn("node", [], { detached: null });`,
      `spawn("node", [], { detached: 0 });`,
      `if (child.detached) log();`,
      `type O = { detached?: boolean };`,
      `const { detached } = opts;`,
      `const f = ({ detached }) => detached;`,
      `function g({ detached }) { return detached; }`,
      `const { stdio, detached } = parse(argv);`,
    ]) {
      assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(content), [], content);
      assert.deepEqual(findDetachedWithoutWindowsHide(content), [], content);
    }
  });
});

describe("#13592 item 4 — aliases não descobertos", () => {
  it("`import { spawn as sp } from \"node:child_process\"` -> sp(...) é varrido", () => {
    const content = `import { spawn as sp, execFileSync } from "node:child_process";\nsp("git", ["fetch"], {});`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`sp("git"`)]);
  });

  it("`const { execFileSync: run } = cp` e `= require(\"child_process\")` -> run(...) é varrido", () => {
    const viaNs = `import * as cp from "child_process";\nconst { execFileSync: run } = cp;\nrun("git", [], {});`;
    assert.deepEqual(findWindowsHideMissingCalls(viaNs), [viaNs.indexOf(`run("git"`)]);
    const viaRequire = `const { spawnSync: go } = require("node:child_process");\ngo("gh", [], {});`;
    assert.deepEqual(findWindowsHideMissingCalls(viaRequire), [viaRequire.indexOf(`go("gh"`)]);
  });

  it("`promisify(execFile)` (e `util.promisify`) -> o alias é varrido", () => {
    const a = `const execFileP = promisify(execFile);\nawait execFileP("git", ["status"], {});`;
    assert.deepEqual(findWindowsHideMissingCalls(a), [a.indexOf(`execFileP("git"`)]);
    const b = `const execP = util.promisify(exec);\nawait execP("git status");`;
    assert.deepEqual(findWindowsHideMissingCallsBroad(b), [b.indexOf(`execP("git`)]);
    const ok = `const execFileP = promisify(execFile);\nawait execFileP("git", [], { windowsHide: true });`;
    assert.deepEqual(findWindowsHideMissingCalls(ok), []);
  });

  it("parâmetro tipado SEM default com o tipo real (`typeof spawnSync`, ou `type T = typeof spawnSync`)", () => {
    const direct = `function f(run: typeof spawnSync) {\n  return run("git", [], {});\n}`;
    assert.deepEqual(findWindowsHideMissingCalls(direct), [direct.indexOf(`run("git"`)]);
    const viaType = `type Runner = typeof execFileSync;\nfunction f(deps: { go?: Runner }) {\n  return deps.go("git", [], {});\n}`;
    assert.deepEqual(findWindowsHideMissingCalls(viaType), [viaType.indexOf(`go("git"`)]);
  });

  it("limite documentado: parâmetro com tipo WRAPPER sem opções (`run: GitSpawnFn`) não é alias -> 0 ofensores", () => {
    const content = `function f(run: GitSpawnFn) {\n  return run("git", ["status"]);\n}`;
    assert.deepEqual(findWindowsHideMissingCalls(content), []);
  });

  it("anotação de tipo em várias linhas (união quebrada em `|`)", () => {
    const content = [
      `function f(`,
      `  exec:`,
      `    | ExecFileSyncFn`,
      `    | typeof execFileSync = execFileSync,`,
      `) {`,
      `  return exec("git", ["status"], {});`,
      `}`,
    ].join("\n");
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`exec("git"`)]);
  });

  it("chamada por namespace: `cp.execSync(` / `cp.exec(` / `cp.fork(` no guard amplo", () => {
    for (const call of [`cp.execSync("git worktree prune")`, `cp.exec("git status")`, `cp.fork("w.js")`]) {
      const content = `import * as cp from "node:child_process";\n${call};`;
      assert.deepEqual(findWindowsHideMissingCallsBroad(content), [content.indexOf("cp.")], call);
      const ok = `import * as cp from "node:child_process";\n${call.replace(/\)$/, ", { windowsHide: true })")};`;
      assert.deepEqual(findWindowsHideMissingCallsBroad(ok), [], ok);
    }
    const required = `const cp = require("child_process");\ncp.execSync("git status");`;
    assert.deepEqual(findWindowsHideMissingCallsBroad(required), [required.indexOf("cp.")]);
  });

  it("`re.exec(...)` de regex num arquivo sem namespace de child_process não vira chamada", () => {
    const content = `import { execSync } from "node:child_process";\nconst m = re.exec(s);\nexecSync("git status", { windowsHide: true });`;
    assert.deepEqual(findWindowsHideMissingCallsBroad(content), []);
  });
});

describe("#13592 item 5 — windowsHide em string ou em objeto aninhado não satisfaz", () => {
  it("chamada: `windowsHide: true` só dentro de string -> 1 ofensor", () => {
    const content = `execFileSync("git", ["log", "--grep=windowsHide: true"], { encoding: "utf8" });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [0]);
  });

  it("chamada: `windowsHide: true` dentro de `env: {…}` -> 1 ofensor (é variável de ambiente, não a flag)", () => {
    const content = `spawnSync("git", [], { env: { ...process.env, windowsHide: true } });`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [0]);
    const strKey = `spawnSync("git", [], { "env": { windowsHide: true } });`;
    assert.deepEqual(findWindowsHideMissingCalls(strKey), [0]);
  });

  it("chamada: flag em ternário, spread condicional ou Object.assign segue valendo", () => {
    for (const opts of [
      `bg ? { windowsHide: true } : { windowsHide: true, stdio: "ignore" }`,
      `{ stdio: "ignore", ...(x ? { windowsHide: true } : {}) }`,
      `Object.assign({}, base, { windowsHide: true })`,
    ]) {
      const content = `spawnSync("git", [], ${opts});`;
      assert.deepEqual(findWindowsHideMissingCalls(content), [], opts);
    }
  });

  it("alias: `opts` solto com a flag aninhada (`{ env: { windowsHide: true } }`) -> 1 ofensor", () => {
    const content = `function f(execFn = execFileSync) {\n  const opts = { env: { windowsHide: true } };\n  return execFn("git", [], opts);\n}`;
    assert.deepEqual(findWindowsHideMissingCalls(content), [content.indexOf(`execFn("git"`)]);
  });

  it("spawn destacado: flag só em string ou aninhada -> 1 ofensor; no próprio objeto -> nenhum", () => {
    const inString = `spawn("node", ["--title=windowsHide: true"], { detached: true, stdio: "ignore", argv0: "windowsHide: true" });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(inString), [inString.indexOf("detached")]);
    const nested = `spawn("node", [], { detached: true, env: { windowsHide: true } });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(nested), [nested.indexOf("detached")]);
    const own = `spawn("node", [], { detached: true, env: { X: "1" }, windowsHide: true });`;
    assert.deepEqual(findDetachedSpawnsWithoutWindowsHide(own), []);
  });

  it("guard dos hooks: `windowsHide: true` só em comentário ou string perto do detached -> 1 ofensor", () => {
    const content = `// windowsHide: true\nspawn("node", [], { detached: true, title: "windowsHide: true" });`;
    assert.deepEqual(findDetachedWithoutWindowsHide(content), [content.indexOf("detached")]);
  });
});
