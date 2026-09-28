// hermes/scripts/lib/gh-wrapper-core.mjs (#8884)
//
// Lógica PURA (sem `child_process`, sem tocar o `gh` de verdade) por trás do
// wrapper `hermes/scripts/gh-wrapper.mjs`. Recebe o argv JÁ EXPANDIDO pelo
// shell (é essa a diferença em relação a `.claude/hooks/block-gh-comment-
// secrets.mjs`, que só vê o TEXTO do comando antes da expansão — por isso
// `--body "$VAR"` escapa daquele hook e não escapa deste) e decide se o
// comando publica texto e, se sim, se algum dos textos finais (body inline,
// `--body-file`/`-f`/`-F @arquivo`/`--input`, posicional de `gh gist
// create`, ou stdin quando qualquer uma dessas fontes usa `-`) carrega um
// segredo reconhecível.
//
// Padrões vêm de `.claude/hooks/lib/secret-patterns.mjs` — fonte única
// compartilhada com o hook do Claude Code e com `redact_public_text` de
// `hermes/scripts/continuo-pr-review.sh` (critério de pronto da #8884).
//
// Testável sem I/O real: toda leitura de arquivo/stdin é injetada via
// `deps` — ver `test/gh-wrapper.test.ts`.

import { findSecrets } from "../../../.claude/hooks/lib/secret-patterns.mjs";

/** Flags cujo VALOR seguinte é texto literal publicado inline. */
const BODY_FLAGS = new Set(["--body", "-b", "--notes", "--title", "-t"]);
/** Flags cujo VALOR seguinte é um caminho de arquivo (ou `-` para stdin). */
const FILE_FLAGS = new Set(["--body-file", "--notes-file", "--input"]);
/** Flags de campo do `gh api` — valor pode ser `campo=texto` ou `campo=@arquivo`. */
const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);

/**
 * Flags do `gh api` cujo TOKEN SEGUINTE é o valor da flag (nunca o path).
 * Usado só para achar o path posicional (`pathArg` abaixo) — sem isso, o
 * valor de `-X`/`--method` (ex: "PATCH") é confundido com o path quando vem
 * antes dele no argv, e `isPublishingInvocation` deixa passar (#8891). Forma
 * `--flag=valor` não consome o próximo token, então não entra aqui.
 */
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** Acha o path posicional de `gh api ...` (argv sem o `api` inicial), pulando flags com valor. */
function findGhApiPath(argvAfterApi) {
  for (let i = 0; i < argvAfterApi.length; i++) {
    const a = argvAfterApi[i];
    if (!a.startsWith("-")) return a;
    if (GH_API_VALUE_FLAGS.has(a)) i++; // pula o valor da flag, nunca é o path
  }
  return "";
}

/** O invocação (`argv` sem o `gh` inicial) publica texto no GitHub? */
export function isPublishingInvocation(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return false;
  const [cmd, sub] = argv;
  if ((cmd === "pr" || cmd === "issue") && ["comment", "create", "edit", "review"].includes(sub)) {
    return true;
  }
  if (cmd === "release" && ["create", "edit"].includes(sub)) return true;
  if (cmd === "gist" && sub === "create") return true;
  if (cmd === "api") {
    const hasWriteMethod = argv.some(
      (a, i) =>
        (a === "-X" || a === "--method") && /^(?:POST|PATCH|PUT)$/i.test(argv[i + 1] ?? ""),
    );
    const hasFieldArg = argv.some((a) => FIELD_FLAGS.has(a));
    const pathArg = findGhApiPath(argv.slice(1));
    const touchesTarget = /\/(?:comments|issues|pulls|reviews)\b/.test(pathArg) || pathArg === "graphql";
    if ((hasWriteMethod || hasFieldArg) && touchesTarget) return true;
  }
  return false;
}

/** O comando precisa ler stdin (algum `-` usado como valor de arquivo/campo)? */
export function requiresStdin(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FILE_FLAGS.has(a) && argv[i + 1] === "-") return true;
    if (FIELD_FLAGS.has(a)) {
      const v = argv[i + 1] ?? "";
      const m = v.match(/^[^=]+=@(.+)$/);
      if (m && m[1] === "-") return true;
    }
  }
  if (argv[0] === "gist" && argv[1] === "create") {
    const toks = argv.slice(2);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === "-") return true;
      if (t.startsWith("-")) {
        if (["-d", "--desc", "-f", "--filename"].includes(t)) i++;
        continue;
      }
    }
  }
  return false;
}

function safeRead(readFileSync, path) {
  try {
    return readFileSync(path);
  } catch {
    return ""; // arquivo ilegível: fail-open, mesma filosofia do hook irmão
  }
}

/**
 * Coleta todos os textos que este invocação publicaria, já resolvidos
 * (arquivo lido, stdin substituído). `deps.readFileSync(path): string` e
 * `deps.stdinText: string | undefined` (só precisa existir quando
 * `requiresStdin(argv)` for true).
 */
export function collectTextsToCheck(argv, deps = {}) {
  const { readFileSync = () => "", stdinText } = deps;
  const texts = [];
  const resolveFileOrStdin = (path) => (path === "-" ? (stdinText ?? "") : safeRead(readFileSync, path));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BODY_FLAGS.has(a)) {
      texts.push(argv[i + 1] ?? "");
      i++;
      continue;
    }
    if (a.startsWith("--body=")) {
      texts.push(a.slice("--body=".length));
      continue;
    }
    if (FILE_FLAGS.has(a)) {
      texts.push(resolveFileOrStdin(argv[i + 1] ?? ""));
      i++;
      continue;
    }
    if (FIELD_FLAGS.has(a)) {
      const v = argv[i + 1] ?? "";
      i++;
      const atMatch = v.match(/^([^=]+)=@(.+)$/);
      if (atMatch) {
        texts.push(resolveFileOrStdin(atMatch[2]));
      } else if (/^[^=]+=/.test(v)) {
        texts.push(v.slice(v.indexOf("=") + 1));
      }
      continue;
    }
  }

  if (argv[0] === "gist" && argv[1] === "create") {
    const toks = argv.slice(2);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t !== "-" && t.startsWith("-")) {
        if (["-d", "--desc", "-f", "--filename"].includes(t)) i++;
        continue;
      }
      texts.push(resolveFileOrStdin(t));
    }
  }

  return texts;
}

/**
 * Decisão final: `{ blocked: false }` (deixa passar) ou
 * `{ blocked: true, secrets: string[] }` (recusa, não repassa pro `gh` real).
 * Comando que não publica nada nunca é lido/verificado (fail-open por
 * escopo, não por erro).
 */
export function evaluateGhInvocation(argv, deps = {}) {
  if (!isPublishingInvocation(argv)) return { blocked: false };
  const texts = collectTextsToCheck(argv, deps);
  const found = new Set();
  for (const t of texts) for (const n of findSecrets(t)) found.add(n);
  if (found.size === 0) return { blocked: false };
  return { blocked: true, secrets: [...found] };
}
