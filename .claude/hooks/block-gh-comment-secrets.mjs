// PreToolUse hook — recusa comando `gh` que PUBLICA texto no GitHub
// (`gh pr|issue comment|create|edit|review`, `gh api .../comments`) quando o
// texto publicado carrega um segredo com formato reconhecível (#8827).
//
// Incidente de origem (25/09/2026): a chave OpenRouter `Hrms2` do Hermes
// apareceu num comentário da PR #8800 (repositório público) e foi
// desabilitada pela OpenRouter ~minutos depois. O comentário foi postado por
// uma sessão automática do contínuo; o transcript salvo não guarda o corpo,
// então a origem exata ficou indeterminada. Em vez de corrigir UM caminho,
// este guard fecha o ponto de saída comum: todo texto que uma sessão do
// Claude Code publica no GitHub passa por um `gh` via Bash.
//
// O que é checado: o próprio comando (cobre `--body "..."`, `-b`, `-f body=`,
// heredoc) E o conteúdo de `--body-file`/`-F`/`--input` quando é um arquivo
// legível. Só padrões de ALTA especificidade (prefixo de provedor + corpo
// longo), para nunca bloquear texto que só MENCIONA o nome de uma variável.
//
// Desde o #12746 o hook também recusa `--body-file` de nome genérico em `gh
// issue|pr create|comment|edit` e avisa quando o arquivo é velho (bloco
// `evaluateBodyFileName` abaixo); essa checagem roda depois e à parte da de
// segredos.
//
// Fail-open em qualquer falha de parse/leitura, mesma filosofia dos hooks
// irmãos, com o erro no stderr.
//
// Duas brechas conhecidas e deliberadamente fora de escopo deste hook —
// resolvidas por `hermes/scripts/gh-wrapper.mjs` (#8884), que compartilha os
// padrões abaixo via `./lib/secret-patterns.mjs`:
// (1) corpo dinâmico (`--body "$VAR"`/`"$(cmd | ...)"`) só é resolvido em
//     runtime, este hook só vê o texto do COMANDO antes de executar;
// (2) o agente Hermes (GLM) roda fora do Claude Code — hooks daqui não se
//     aplicam a esse processo.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { SECRET_PATTERNS, findSecrets, redactSecrets } from "./lib/secret-patterns.mjs";

export { SECRET_PATTERNS, findSecrets, redactSecrets };

// O tokenizer do guard #12009 só serve à checagem de nome do #12746. Import
// dinâmico dentro de try: se o módulo sumir ou quebrar, cai só essa checagem,
// nunca a de segredos (review da PR #12846).
let shellLib = null;
try {
  shellLib = await import("../../scripts/lib/protected-path-bash-write.mjs");
} catch (err) {
  process.stderr.write(`block-gh-comment-secrets (#12746): tokenizer indisponível, checagem de --body-file desligada: ${err?.stack ?? err}\n`);
}

// ---------------------------------------------------------------------------
// #12746 — nome único e frescor do `--body-file` de `gh issue|pr
// create|comment|edit`.
//
// Incidente: a #12547 nasceu com o corpo da #12348, byte a byte (0 edições na
// API). Causa provável: o `--body-file` apontava para um arquivo de nome
// genérico que guardava o corpo da issue anterior, e a escrita do corpo novo
// falhou ou foi para outro lugar sem sinal de erro. Mesma classe da #12169
// (comentários de outra sessão na PR errada), cujo guard cobre só o
// `gh-pr-review-api.ts`. Aqui:
//   1. recusa `--body-file`/`-F` cujo NOME não tem número de 4+ dígitos (a
//      issue/PR da unidade, `$RANDOM`, timestamp — item 9 de
//      context/overnight-dispatch-rules.md);
//   2. avisa, sem recusar, quando o arquivo foi escrito há mais de
//      BODY_FILE_STALE_MS: um corpo recém-escrito para esta chamada nunca é
//      velho.
// `-`/stdin e nome com expansão (`"$F"`, `body-$RANDOM.md`, não resolvível
// antes de rodar) ficam fora.
// ---------------------------------------------------------------------------

/** Idade a partir da qual o `--body-file` gera aviso (#12746). */
export const BODY_FILE_STALE_MS = 10 * 60 * 1000;

/** Mesma regra do `isUniqueBodyFileName` de `scripts/gh-pr-review-api.ts` (#12169): só o nome-base conta. */
export function isUniqueBodyFileName(path) {
  const base = String(path).split(/[\\/]/).pop() ?? "";
  return /\d{4,}/.test(base);
}

const GH_VALUE_FLAGS = new Set(["-R", "--repo"]);

/** `--body-file` que é stdin, não arquivo: fora da checagem de nome. */
const STDIN_BODY_FILES = new Set(["-", "/dev/stdin", "/dev/fd/0"]);

/**
 * Valores de `--body-file`/`-F` dos `gh issue|pr create|comment|edit` do
 * comando. Usa o tokenizer de shell do guard #12009: texto entre aspas e corpo
 * de heredoc não viram comando (um corpo que CITA `gh issue comment
 * --body-file x.md` não conta).
 */
export function ghBodyFileValues(command) {
  if (typeof command !== "string" || !shellLib) return [];
  const out = [];
  for (const cmd of shellLib.tokenizeShell(command)) {
    // Pula atribuições e wrappers (`env`, `command`, `exec`, `timeout 30`,
    // `nice`, `sudo`) e desce no `xargs`.
    const w = shellLib.resolveCommandWords(cmd.words);
    let i = 0;
    if (w[i] !== "gh" && !/[\\/]gh(?:\.exe)?$/.test(w[i] ?? "")) continue;
    i++;
    while (i < w.length && w[i].startsWith("-")) i += GH_VALUE_FLAGS.has(w[i]) ? 2 : 1;
    if (!["issue", "pr"].includes(w[i]) || !["create", "comment", "edit"].includes(w[i + 1])) continue;
    const args = w.slice(i + 2);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === "--") break;
      let v;
      if (a === "--body-file" || a === "-F") v = args[++k];
      else if (a.startsWith("--body-file=")) v = a.slice("--body-file=".length);
      // `-Fx.md` e `-F=x.md` (o pflag do gh aceita os dois)
      else if (a.startsWith("-F") && a.length > 2) v = a.slice(a[2] === "=" ? 3 : 2);
      else continue;
      if (v == null || v === "" || STDIN_BODY_FILES.has(v)) continue;
      // Nome com expansão (`body-$RANDOM.md`, `"$F"`, `issue-$(date +%s).md`,
      // em que o tokenizer corta no `$(`) só se resolve ao rodar: fora.
      if (v.includes("$") || command.includes(`${v}$`) || command.includes(`${v}\``)) continue;
      out.push(v);
    }
  }
  return out;
}

/**
 * #12746: `{ deny, warn }` sobre os `--body-file` do comando. `deny` é string
 * de motivo (nome genérico); `warn` é string de aviso (arquivo velho).
 * `statMtimeMs(path)` devolve o mtime em ms ou lança (arquivo ausente: sem
 * aviso, o `gh` falha sozinho).
 */
export function evaluateBodyFileName(command, cwd, { statMtimeMs = (p) => statSync(p).mtimeMs, now = Date.now() } = {}) {
  const values = ghBodyFileValues(command);
  const generic = values.filter((v) => !isUniqueBodyFileName(v));
  if (generic.length) {
    return {
      deny:
        `Bloqueado (#12746): \`--body-file ${generic[0]}\` tem nome genérico. Um arquivo de corpo sem número no nome ` +
        "colide entre sessões e chamadas (a #12547 nasceu com o corpo da #12348, a PR #12135 recebeu comentários de " +
        "outra sessão, #12169). Grave o corpo num arquivo cujo nome tenha o número da issue/PR (4+ dígitos) e um " +
        "sufixo aleatório escolhido ao gravar, ex. `/tmp/issue-12746-4821.md` (num `gh issue create` o número ainda " +
        "não existe: use só os dígitos aleatórios ou um timestamp, ex. `/tmp/issue-nova-1762871234.md`), ou passe o " +
        "corpo por stdin: `--body-file - <<'EOF'` (item 9 de context/overnight-dispatch-rules.md).",
    };
  }
  const stale = [];
  for (const v of values) {
    try {
      const p = isAbsolute(v) ? v : resolvePath(cwd || process.cwd(), v);
      const age = now - statMtimeMs(p);
      if (age > BODY_FILE_STALE_MS) stale.push({ v, min: Math.round(age / 60000) });
    } catch {
      // arquivo ausente/ilegível: sem aviso
    }
  }
  if (stale.length) {
    const { v, min } = stale[0];
    return {
      warn:
        `Aviso (#12746): \`--body-file ${v}\` foi escrito há ${min} min. Um corpo recém-escrito para esta chamada ` +
        "nunca é velho: se a escrita do corpo novo falhou (o Write recusa sobrescrever arquivo que a sessão não leu), " +
        "este comando publica o texto antigo sem erro nenhum. Confira o conteúdo do arquivo antes de seguir.",
    };
  }
  return {};
}

/** O comando publica texto no GitHub via `gh`? */
export function isGhPublishCommand(command) {
  if (typeof command !== "string") return false;
  return (
    /\bgh\s+(?:pr|issue)\s+(?:comment|create|edit|review|close)\b/.test(command) ||
    /\bgh\s+release\s+(?:create|edit)\b/.test(command) ||
    /\bgh\s+gist\s+create\b/.test(command) ||
    // `gh api` só publica quando manda corpo (campo/arquivo) ou método de escrita.
    (/\bgh\s+api\b[\s\S]*(?:\/(?:comments|issues|pulls|reviews)\b|\bgraphql\b)/.test(command) &&
      /(?:\s-[fF]\s|\s--(?:field|raw-field|input)\b|\s-X\s*(?:POST|PATCH|PUT)\b|--method\s+(?:POST|PATCH|PUT)\b)/.test(command))
  );
}

/**
 * Arquivos cujo conteúdo vira texto publicado: `--body-file`, `--notes-file`,
 * `--input`, `-F`/`-f`/`--field`/`--raw-field` com `campo=@arquivo`, e
 * substituição `$(cat arquivo)` / `$(< arquivo)`.
 *
 * Limite conhecido: substituição que não lê arquivo direto
 * (`--body "$VAR"`, `$(comando | ...)`) não é resolvível estaticamente —
 * por isso o `continuo-pr-review.sh` também redige no script.
 */
export function bodyFileArgs(command) {
  const out = [];
  for (const m of command.matchAll(/\$\(\s*(?:cat\s+|<\s*)(?:"([^"]+)"|'([^']+)'|([^\s)|;&]+))\s*\)/g)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  const re =
    /(?:--body-file|--notes-file|--input|--field|--raw-field|-F|-f)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    let v = m[1] ?? m[2] ?? m[3];
    // `gh api -F body=@arquivo` → arquivo; `-F campo=valor` literal fica no comando.
    const at = v.match(/^[^=]+=@(.+)$/);
    if (at) v = at[1];
    else if (/^[^=]+=/.test(v)) continue;
    if (v !== "-") out.push(v);
  }
  // `gh gist create arq1 arq2`: o conteúdo vem de argumentos posicionais.
  const gist = command.match(/\bgh\s+gist\s+create\b([^|;&]*)/);
  if (gist) {
    const toks = gist[1].match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i].replace(/^["']|["']$/g, "");
      if (/^-/.test(t)) {
        if (/^(?:-d|--desc|-f|--filename)$/.test(t)) i++; // flag com valor
        continue;
      }
      if (t !== "-") out.push(t);
    }
  }
  return out;
}

/** Decide: string de motivo quando bloqueia, `null` quando deixa passar. */
export function evaluate(command, cwd, readFile = (p) => readFileSync(p, "utf8")) {
  if (!isGhPublishCommand(command)) return null;
  const found = new Set(findSecrets(command));
  for (const f of bodyFileArgs(command)) {
    try {
      const p = isAbsolute(f) ? f : resolvePath(cwd || process.cwd(), f);
      for (const n of findSecrets(readFile(p))) found.add(n);
    } catch {
      // arquivo ilegível: fail-open
    }
  }
  if (found.size === 0) return null;
  return (
    `Bloqueado (#8827): o texto que este comando publicaria no GitHub contém ` +
    `o que parece um segredo (${[...found].join(", ")}). O repositório é público ` +
    `e o provedor revoga a chave ao detectá-la. Remova o valor do corpo ` +
    `(cite só o nome da variável, ex. OPENROUTER_API_KEY) e rode de novo.`
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const isMain =
  // #9197: path com espaço/não-ASCII chega percent-encoded em import.meta.url
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`;

if (isMain) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(raw);
      if (payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      // Segredos (#8827) primeiro e independente: erro na checagem de nome
      // do #12746 nunca derruba esta (review da PR #12846).
      let reason = null;
      try {
        reason = evaluate(command, payload.cwd);
      } catch (err) {
        process.stderr.write(`block-gh-comment-secrets (#8827): erro na checagem de segredos: ${err?.stack ?? err}\n`);
      }
      let bodyFile = {};
      try {
        bodyFile = evaluateBodyFileName(command, payload.cwd);
      } catch (err) {
        process.stderr.write(`block-gh-comment-secrets (#12746): erro na checagem de --body-file: ${err?.stack ?? err}\n`);
      }
      reason = reason ?? bodyFile.deny;
      if (reason) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          }),
        );
      } else if (bodyFile.warn) {
        // #12746: aviso sem recusa — o comando segue o fluxo normal.
        process.stdout.write(
          JSON.stringify({
            systemMessage: bodyFile.warn,
            hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: bodyFile.warn },
          }),
        );
      }
    } catch (err) {
      // fail-open, com o erro no stderr
      process.stderr.write(`block-gh-comment-secrets: erro, comando liberado: ${err?.stack ?? err}\n`);
    }
  });
}
