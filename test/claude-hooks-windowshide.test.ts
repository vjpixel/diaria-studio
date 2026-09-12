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
 * Escopo: só varre `.claude/hooks/*.mjs` DESTE repo (o `sync-check.cjs`
 * equivalente em `claude-config` não tem CI — mudança lá é tratada à parte,
 * ver corpo da #7952).
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
 * mas o guard geral, aplicado aos outros 17 hooks, segue exposto a esse
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
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(ROOT, ".claude", "hooks");

/** Janela de caracteres ao redor de cada `detached: true` onde
 * `windowsHide: true` precisa aparecer. Generosa o bastante pra cobrir um
 * objeto de opções multi-linha inteiro (chamadas reais deste repo não
 * passam de ~600 chars entre `detached:` e o fechamento do objeto). */
const WINDOW_CHARS = 600;

/** Pura — recebe o conteúdo já lido de um arquivo `.mjs`, devolve o offset
 * (não linha — mais barato de calcular, suficiente pra achar no editor) de todo
 * `detached: true` sem `windowsHide: true` na janela ao redor. */
export function findDetachedWithoutWindowsHide(content: string): number[] {
  const offenders: number[] = [];
  const detachedRe = /detached\s*:\s*true/g;
  let match: RegExpExecArray | null;
  while ((match = detachedRe.exec(content)) !== null) {
    const start = Math.max(0, match.index - WINDOW_CHARS);
    const end = Math.min(content.length, match.index + WINDOW_CHARS);
    const window = content.slice(start, end);
    if (!/windowsHide\s*:\s*true/.test(window)) {
      offenders.push(match.index);
    }
  }
  return offenders;
}

/** Remove comentários `//...` e `/* ... *\/` antes da descoberta de alias
 * (achado ao vivo #8017: sem isto, prosa de comentário do tipo "`execFn` é
 * injetável (default = execFileSync real)" — presente em
 * `pr-create-review.mjs` — inventa um alias falso chamado `default`, que
 * depois casa toda ocorrência da palavra "default(" no arquivo como suposta
 * chamada, produzindo dezenas de falsos positivos). Heurística simples (não
 * distingue `//` dentro de uma string literal de um comentário real) —
 * aceitável pro mesmo custo/benefício documentado no resto deste arquivo:
 * nenhum hook real tem `//`/`/* *\/` dentro de uma string que colidiria com
 * o padrão `nome = execFileSync` que estamos procurando. Pura. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
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
 * execFileSync)`) ou atribuição de variável.
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
 * seguida de `(`). Pura. */
function discoverInjectedExecAliases(content: string): string[] {
  const code = stripComments(content);
  const aliasRe = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:execFileSync|execFile|spawnSync|spawn)\b(?!\s*\()/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = aliasRe.exec(code)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

/** 2º guard, mais estrito (ver docstring do módulo) — varre TODA chamada
 * `execFile`/`execFileSync`/`spawn`/`spawnSync`, com ou sem `detached`, e
 * confirma `windowsHide: true` na janela ao redor. Desde #8017, também varre
 * chamadas via ALIAS injetado (`execFn = execFileSync` → `execFn(...)`) —
 * ver docstring do módulo pro porquê da janela bidirecional só nesse ramo.
 * Pura. */
export function findWindowsHideMissingCalls(content: string): number[] {
  const offenders: number[] = [];
  const callRe = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(content)) !== null) {
    const start = match.index;
    const end = Math.min(content.length, match.index + WINDOW_CHARS);
    const window = content.slice(start, end);
    if (!/windowsHide\s*:\s*true/.test(window)) {
      offenders.push(match.index);
    }
  }
  for (const name of discoverInjectedExecAliases(content)) {
    const aliasCallRe = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = aliasCallRe.exec(content)) !== null) {
      // Bidirecional (ver docstring do módulo #8017) — diferente do ramo
      // literal acima, que é só-pra-frente.
      const start = Math.max(0, aliasMatch.index - WINDOW_CHARS);
      const end = Math.min(content.length, aliasMatch.index + WINDOW_CHARS);
      const window = content.slice(start, end);
      if (!/windowsHide\s*:\s*true/.test(window)) {
        offenders.push(aliasMatch.index);
      }
    }
  }
  return offenders;
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
