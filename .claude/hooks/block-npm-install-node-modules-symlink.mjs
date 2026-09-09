// PreToolUse hook (#7763) — recusa `npm ci` / `npm install` quando o
// `node_modules` do diretório alvo é symlink/junction pra FORA dele.
//
// Por que hook, e não `preinstall` do package.json (tentado e descartado na
// PR #7774): o `npm ci` remove a árvore antiga ANTES de disparar qualquer
// lifecycle script. Medido ao vivo (Windows, npm 11, 09/09/2026) — a linha
// `npm warn reify Removing non-directory .../node_modules` aparece ANTES do
// `> preinstall`, e o diretório apontado pela junction já sai vazio; quando o
// guard roda, `node_modules` é ENOENT e ele legitimamente libera. Um
// `preinstall` aqui seria pior que nada: falsa garantia mecânica no lugar da
// vigilância humana que a regra em prosa ainda provia.
//
// O hook roda ANTES do npm sequer ser invocado, que é o único ponto do fluxo
// real onde ainda dá pra ver o symlink intacto.
//
// COBERTURA HONESTA: protege comandos rodados por uma sessão de Claude Code
// DESTE projeto (o vetor do #7763 — subagente bootstrapando worktree). Um
// `npm ci` digitado num terminal fora do Claude Code não passa por aqui.
//
// Self-contained de propósito: nenhum import de `.ts` (convenção dos hooks
// irmãos). A paridade com `scripts/lib/worktree-node-modules-guard.ts` é
// travada por teste (`test/worktree-node-modules-guard.test.ts`).

import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove o CORPO de heredocs (`<<EOF ... EOF`, `<<'EOF' ... EOF`, `<<-EOF ...
 * EOF`), preservando a linha de abertura. Duplicado de
 * `block-unsafe-shared-checkout-ops.mjs` (#7757) pela mesma razão: estes hooks
 * são self-contained, sem import de `.ts`.
 *
 * Sem isto, um `cat <<EOF ... npm ci ... EOF` que apenas MENCIONA o comando
 * (um README, o corpo de uma issue) era bloqueado como se estivesse
 * instalando — achado do review da PR #7774. Efeito colateral aceito, o mesmo
 * do hook irmão: um `bash <<EOF` que de fato EXECUTE `npm ci` pelo corpo do
 * heredoc passa sem inspeção.
 */
export function stripHeredocSpans(command) {
  if (typeof command !== "string") return command;
  const startRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = "";
  let lastIndex = 0;
  let m;
  while ((m = startRe.exec(command)) !== null) {
    if (m.index < lastIndex) continue; // dentro de um heredoc já removido
    const delim = m[2];
    const isDashVariant = m[0].startsWith("<<-");
    const markerEnd = m.index + m[0].length;
    const lineEnd = command.indexOf("\n", markerEnd);
    if (lineEnd === -1) {
      result += command.slice(lastIndex);
      lastIndex = command.length;
      break;
    }
    const bodyStart = lineEnd + 1;
    const terminatorRe = new RegExp(`^${isDashVariant ? "[ \t]*" : ""}${delim}[ \t]*$`, "m");
    const termMatch = terminatorRe.exec(command.slice(bodyStart));
    const stripEnd = termMatch ? bodyStart + termMatch.index + termMatch[0].length : command.length;
    result += command.slice(lastIndex, lineEnd + 1);
    lastIndex = stripEnd;
    startRe.lastIndex = stripEnd;
  }
  result += command.slice(lastIndex);
  return result;
}

// Reconhecimento por POSIÇÃO ESTRUTURAL, não por enumeração de prefixos.
//
// As rodadas anteriores do review da PR #7774 tentaram listar o que pode vir
// ANTES do comando — atribuição inline (`FOO=bar`), no-op (`sudo`, `env`,
// `exec`…), e depois as flags de cada um (`sudo -u foo`, `env -i`). Cada
// rodada fechava os casos citados e o review devolvia outros: `sudo -p 'pw:'`,
// `sudo -a`, `sudo -t 30`, `--preserve-env=LIST`. A lista de flags de `sudo` e
// `env` é aberta demais para enumerar, e errar para o lado de "não bloqueia" é
// o lado errado — o guard existe justamente para o caso em que alguém invocou
// o npm de um jeito que ninguém previu.
//
// Então o critério deixou de ser "o que vem antes" e passou a ser: **está
// fora de aspas?** Um `npm ci` em texto não citado é comando, venha lá qual
// prefixo vier; um `npm ci` DENTRO de aspas é texto — que é exatamente o que
// distingue `sudo -p 'pw:' npm ci` (bloqueia) de
// `git commit -m "roda npm ci"` e `echo "use bash -c 'npm ci'"` (não
// bloqueiam). O mesmo vale para o wrapper de shell.
//
// Nome de programa citado (`"npm" ci`, `'bash' -c "..."`) NÃO é exceção: um
// span citado sem espaço dentro é um token, não prosa, e fica visível — ver
// `maskQuotedSpans`. Para o `npm` isso vale só no INÍCIO do segmento (senão
// `echo "npm" "ci"` viraria um comando que ninguém invocou); para o wrapper
// vale em qualquer posição, já que dois argumentos citados não se fundem num
// `bash -c`. Custo que sobra dessa assimetria: `sudo "npm" ci` — o nome do
// NPM citado atrás de um prefixo — não é detectado.
//
// Limitações honestas que sobram, todas herdadas de tratar aspas como texto:
// um caminho citado COM espaço (`"C:/Program Files/nodejs/npm.cmd" ci`),
// `env -S 'npm ci'` (que executa o conteúdo citado), e truques de quoting que
// partem o nome do comando no meio (`np"m" ci`, `npm${IFS}ci`). É o mesmo
// trade-off do corpo de heredoc que de fato roda um comando, e do hook irmão.
// Fechar isso pediria um parser de shell de verdade; o custo não se paga para
// um guard que é uma das camadas, não a única.

/**
 * Devolve o segmento com o CONTEÚDO de cada string citada trocado por espaços,
 * preservando comprimento e offsets — assim uma regex casa só no que está fora
 * de aspas, e `readQuotedString` ainda lê o texto original no mesmo índice.
 */
export function maskQuotedSpans(segment, { tokensAnywhere = false } = {}) {
  const text = String(segment);
  let masked = "";
  let i = 0;
  while (i < text.length) {
    const quoted = readQuotedString(text, i);
    if (quoted) {
      // Span citado SEM espaço e no INÍCIO do segmento é o nome do programa
      // (`"npm" ci`, `'bash' -c "..."`), forma que executa exatamente como sem
      // as aspas. Mascará-lo desligava a detecção inteira (achado do review da
      // PR #7848). Fica visível, com as aspas viradas em espaço: mesmo
      // comprimento, offsets preservados, e o token continua delimitado.
      //
      // Só no início, e não em qualquer posição: dois argumentos citados
      // adjacentes de um outro programa (`echo "npm" "ci"`) se juntavam num
      // `npm ci` que ninguém invocou — falso positivo achado no mesmo review.
      // `tokensAnywhere` levanta essa restrição para quem procura o WRAPPER
      // (`sudo 'bash' -c "npm ci"`): ali o nome buscado é `bash`/`sh`/…, e
      // dois argumentos citados não se fundem num wrapper — só o `npm` sofria
      // desse falso positivo.
      // Span COM espaço é prosa (`-m "roda npm ci"`) e segue mascarado.
      const width = quoted.end - i;
      // `padEnd`/`slice` porque escape (`\"`) ocupa 2 caracteres no original e
      // 1 no valor lido: sem isso o span encolheria e todo offset à direita
      // sairia do lugar.
      const token = ` ${quoted.value} `.slice(0, width).padEnd(width, " ");
      const isProgramName = (tokensAnywhere || i === 0) && !/\s/.test(quoted.value);
      masked += isProgramName ? token : " ".repeat(width);
      i = quoted.end;
      continue;
    }
    masked += text[i];
    i++;
  }
  return masked;
}

// Termina na flag, sem consumir os espaços seguintes: como a máscara troca o
// span citado por espaços do mesmo tamanho, um `\s+` guloso no fim engoliria a
// própria aspa de abertura e `readQuotedString` não acharia mais o payload.
const SHELL_WRAPPER_FLAG_RE =
  /(?:^|\s)(?:[A-Za-z]:[^\s]*|[^\s]*\/)?(?:bash|sh|zsh|dash|ksh|powershell|pwsh|cmd)(?:\.exe)?\s+(?:-c|-Command|-command|\/c|\/C)(?=\s)/i;

/**
 * A partir de `start`, lê uma string entre aspas simples ou duplas e devolve
 * `{ value, end }` — ou `null` se não houver string citada ali. Feito à mão em
 * vez de regex porque escapes (`\"`) dentro da string exigem um scanner.
 */
function readQuotedString(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '"' && ch === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return null; // string não fechada — nada confiável a promover
}

// Separadores de comando do shell. `(` e `)` entram na lista por causa do
// achado do review da PR #7774: sem eles, `(cd /wt && npm ci)` e
// `RESULT=$(cd /wt && npm ci)` deixavam um `)` colado no segmento, e
// `isNpmInstallSegment` — que exige espaço ou fim de string depois do
// subcomando — não casava. Subshell é a forma idiomática de rodar algo num
// diretório sem mexer no `cd` da sessão, então era um bypass mais provável que
// o `bash -c` já coberto.
const SEGMENT_BREAKERS = new Set(["(", ")", "{", "}", "&", "|", ";", "\n"]);

/**
 * Divide em segmentos de comando RESPEITANDO aspas: separador dentro de uma
 * string citada não quebra o segmento, e a string chega inteira ao chamador
 * (que decide se o conteúdo dela é comando ou texto).
 */
function splitTopLevel(text) {
  const segments = [];
  let current = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuotedString(text, i);
      if (quoted) {
        current += text.slice(i, quoted.end);
        i = quoted.end;
        continue;
      }
      // Aspas não fechadas: trata como caractere comum e segue.
    }
    if (SEGMENT_BREAKERS.has(ch)) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  segments.push(current);
  return segments.map((seg) => seg.trim()).filter(Boolean);
}

/**
 * Quando o segmento invoca um wrapper de shell FORA DE ASPAS — `bash -c "cd
 * /wt && npm ci"`, `sudo -p 'senha:' bash -c "..."`, `cmd /c "..."` —, devolve
 * o conteúdo da string que ele executa; senão, `null`.
 *
 * Achado do review da PR #7774: o hook irmão usa `stripQuotedSpans`, que
 * DESCARTA o conteúdo citado. Serve pra não confundir separadores dentro de
 * uma string, mas aqui jogaria fora justamente o `npm ci` perigoso, que é o
 * que está DENTRO das aspas. Promover o argumento de um wrapper que aparece
 * fora de aspas — e não toda string citada — mantém
 * `git commit -m "roda npm ci"` e `echo "use bash -c 'npm ci'"` fora do radar,
 * sem depender de enumerar o que pode vir antes do wrapper.
 */
export function shellWrapperPayload(segment) {
  const text = String(segment);
  const m = SHELL_WRAPPER_FLAG_RE.exec(maskQuotedSpans(text, { tokensAnywhere: true }));
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  const quoted = readQuotedString(text, i);
  return quoted && quoted.value ? quoted.value : null;
}

/**
 * Segmentos de comando do texto, já sem corpo de heredoc e com o conteúdo de
 * wrappers de shell expandido no lugar (recursivo, até 3 níveis).
 */
export function commandSegments(command, depth = 0) {
  const segments = splitTopLevel(stripHeredocSpans(String(command)));
  if (depth > 3) return segments;
  const expanded = [];
  for (const segment of segments) {
    const payload = shellWrapperPayload(segment);
    if (payload) expanded.push(...commandSegments(payload, depth + 1));
    else expanded.push(segment);
  }
  return expanded;
}

/**
 * true quando o segmento é um `npm ci` / `npm install` / `npm i` / `npm add`
 * — os comandos que reconstroem `node_modules` e portanto apagam o que
 * estiver lá. `npm run`, `npm test`, `npm ls` etc. não contam.
 */
export function isNpmInstallSegment(segment) {
  // Casa em QUALQUER posição fora de aspas, não só no início do segmento: o
  // que pode vir antes (`sudo -p 'senha:'`, `env -i`, `FOO=bar`, `nice -n 10`)
  // é lista aberta demais para enumerar, e cada tentativa de enumerar deixou
  // um bypass novo (rodadas do review da PR #7774). O `npm ci` de dentro de
  // aspas continua sendo texto, que é o que separa `sudo -p 'x' npm ci` de
  // `git commit -m "roda npm ci"`.
  return /(?:^|\s)(?:[A-Za-z]:[^\s]*|[^\s]*\/)?npm(?:\.cmd)?\s+(?:ci|install|i|add)(?:\s|$)/.test(
    maskQuotedSpans(String(segment).trim()),
  );
}

/** `--prefix <dir>` / `--prefix=<dir>` redireciona o alvo do npm. */
export function npmPrefixArg(segment) {
  const eq = /--prefix=(\S+)/.exec(segment);
  if (eq) return stripQuotes(eq[1]);
  const spaced = /--prefix\s+(\S+)/.exec(segment);
  return spaced ? stripQuotes(spaced[1]) : null;
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

/** Diretório de um `cd <dir>` (o shell mantém isso entre segmentos `&&`). */
export function cdTarget(segment) {
  const m = /^cd\s+(?:--\s+)?(\S+)/.exec(String(segment).trim());
  if (!m) return null;
  const dir = stripQuotes(m[1]);
  return dir === "-" ? null : dir;
}

/** true quando `inner` é o próprio `outer` ou está contido nele. */
function isInside(outer, inner) {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/**
 * Espelha `checkNodeModulesSymlink` de
 * `scripts/lib/worktree-node-modules-guard.ts`: bloqueia symlink pra fora do
 * diretório, e bloqueia também inspeção inconclusiva (EACCES e afins).
 * ENOENT e diretório real liberam.
 */
export function nodeModulesEscapesDir(dir) {
  const nm = resolvePath(dir, "node_modules");
  try {
    const st = lstatSync(nm);
    if (!st.isSymbolicLink()) return null;
    const target = readlinkSync(nm);
    const absTarget = isAbsolute(target) ? resolvePath(target) : resolvePath(dir, target);
    const absDir = resolvePath(dir);
    if (isInside(absDir, absTarget) || isInside(absTarget, absDir)) return null;
    return absTarget;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return `<inspeção falhou: ${e?.code ?? "erro desconhecido"}>`;
  }
}

/**
 * Percorre os segmentos rastreando o `cd`, e devolve `{ dir, target }` do
 * primeiro `npm install`-like cujo `node_modules` escapa do diretório.
 */
export function findBlockedNpmInstall(command, cwd, inspect = nodeModulesEscapesDir) {
  let current = cwd;
  for (const segment of commandSegments(command)) {
    const cd = cdTarget(segment);
    if (cd) {
      current = isAbsolute(cd) ? cd : resolvePath(current, cd);
      continue;
    }
    if (!isNpmInstallSegment(segment)) continue;
    const prefix = npmPrefixArg(segment);
    const dir = prefix ? (isAbsolute(prefix) ? prefix : resolvePath(current, prefix)) : current;
    const target = inspect(dir);
    if (target) return { dir, target };
  }
  return null;
}

export function blockReason({ dir, target }) {
  return (
    `[GUARD #7763] BLOQUEADO: \`node_modules\` de ${dir} é symlink/junction para ${target} — fora desse diretório. ` +
    "`npm ci`/`npm install` APAGA a árvore antiga antes de reinstalar: seguindo o link, ele esvazia o alvo " +
    "(foi assim que o checkout principal compartilhado ficou sem `node_modules` no #7763). " +
    "Remova o link e instale DENTRO do diretório: `rm node_modules && npm ci --prefer-offline`. " +
    "Cada worktree precisa do seu próprio `node_modules/` — nunca symlinkar pro principal."
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (typeof command !== "string") return;
      const cwd = payload.cwd || process.cwd();
      const hit = findBlockedNpmInstall(command, cwd);
      if (!hit) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: blockReason(hit),
          },
        }),
      );
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
    }
  });
}
