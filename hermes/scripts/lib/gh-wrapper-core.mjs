// hermes/scripts/lib/gh-wrapper-core.mjs (#8884, buracos fechados no #8950)
//
// Lógica PURA (sem `child_process`, sem tocar o `gh` de verdade) por trás do
// wrapper `hermes/scripts/gh-wrapper.mjs`. Recebe o argv JÁ EXPANDIDO pelo
// shell (é essa a diferença em relação a `.claude/hooks/block-gh-comment-
// secrets.mjs`, que só vê o TEXTO do comando antes da expansão — por isso
// `--body "$VAR"` escapa daquele hook e não escapa deste) e decide se o
// comando publica texto e, se sim, se algum dos textos finais (body inline,
// `--body-file`/`-F`/`--input`, `--comment` de close, posicional de `gh gist
// create`, ou stdin quando qualquer uma dessas fontes usa `-`) carrega um
// segredo reconhecível.
//
// Padrões vêm de `.claude/hooks/lib/secret-patterns.mjs` — fonte única
// compartilhada com o hook do Claude Code e com `redact_public_text` de
// `hermes/scripts/continuo-pr-review.sh` (critério de pronto da #8884).
//
// #8950 fechou 4 buracos que deixavam passar texto sem checagem — todos por
// causa de `-F`/`-f` terem significado DIFERENTE conforme o subcomando
// (`-F` é `--body-file` em `pr`/`issue`/`release`/`gist`, mas é
// `--field key=value` em `gh api`; `-f` é o boolean `--fill` em `pr create`,
// mas é `--raw-field key=value` em `gh api`). A classificação de flags agora
// é resolvida por CONTEXTO (`flagTableFor`) em vez de um único par de
// conjuntos globais:
//   1. `-F arquivo`/`-F -` em `pr`/`issue`/`release`/`review` agora é lido
//      como arquivo (antes só `--body-file`/`--notes-file` eram reconhecidos
//      — a forma curta passava sem checagem nenhuma, e `-F -` sem checar
//      stdin).
//   2. `pr close`/`issue close --comment TEXTO` (e `-c`) agora publicam —
//      antes `close` nem entrava em `isPublishingInvocation`.
//   3. `--flag=valor` é normalizado ANTES de qualquer classificação
//      (`normalizeArgv`), então `--body-file=x`, `--title=x`, `--comment=x`,
//      `--input=x` etc. são tratados como o par `["--flag", "valor"]`
//      independente de qual flag específica é.
//   4. `gh api .../comments --input arquivo` (sem `-X`) agora é reconhecido
//      como publicação — `--input` conta como sinal de corpo, igual a
//      `-f`/`-F`/`--field`/`--raw-field`.
//
// Testável sem I/O real: toda leitura de arquivo/stdin é injetada via
// `deps` — ver `test/gh-wrapper.test.ts`.

import { findSecrets } from "../../../.claude/hooks/lib/secret-patterns.mjs";

/** Flags do `gh api` cujo VALOR é `campo=texto` ou `campo=@arquivo`. */
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
/** Flag genérica de arquivo-corpo do `gh api` (não é key=value, é path/-). */
const API_FILE_FLAGS = new Set(["--input"]);

/** Flags de arquivo (path ou `-` para stdin) em pr/issue/release/gist/review. */
const NON_API_FILE_FLAGS = new Set(["-F", "--body-file", "--notes-file"]);

/**
 * Flags de texto inline (valor literal publicado) em pr/issue/release/review,
 * por subcomando. `close` só publica via `--comment`/`-c`; os demais publicam
 * via corpo/notas/título.
 */
function nonApiBodyFlags(sub) {
  if (sub === "close") return new Set(["-c", "--comment"]);
  return new Set(["-b", "--body", "-t", "--title", "-n", "--notes"]);
}

/**
 * Flags do `gh api` cujo TOKEN SEGUINTE é o valor da flag (nunca o path).
 * Usado só para achar o path posicional (`pathArg` abaixo) — sem isso, o
 * valor de `-X`/`--method` (ex: "PATCH") é confundido com o path quando vem
 * antes dele no argv, e `isPublishingInvocation` deixa passar (#8891). Forma
 * `--flag=valor` já vem normalizada em dois tokens antes de chegar aqui, então
 * segue consumindo 1 token do mesmo jeito.
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

/**
 * Normaliza `--flag=valor` → `["--flag", "valor"]` (split no primeiro `=`).
 * Cobre TODAS as flags longas — inclusive `-f`/`-F` de campo do `gh api`
 * (`--field=body=texto` vira `["--field", "body=texto"]`, que é exatamente
 * como o parser de `-F`/`--field` já espera o valor). Flags curtas de 1
 * caractere (`-F`, `-f`, `-b`, ...) não usam esta sintaxe no `gh`/cobra e não
 * são tocadas. Só normaliza `--flag=valor` — nunca strings que não começam
 * com `--` (paths, `campo=valor` já resolvido de `-F`, etc.).
 */
export function normalizeArgv(argv) {
  const out = [];
  for (const a of argv) {
    if (typeof a === "string" && a.startsWith("--") && a.includes("=")) {
      const idx = a.indexOf("=");
      out.push(a.slice(0, idx), a.slice(idx + 1));
      continue;
    }
    out.push(a);
  }
  return out;
}

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
export function isPublishingInvocation(rawArgv) {
  if (!Array.isArray(rawArgv) || rawArgv.length < 2) return false;
  const argv = normalizeArgv(rawArgv);
  const [cmd, sub] = argv;
  if ((cmd === "pr" || cmd === "issue") && ["comment", "create", "edit", "review", "close"].includes(sub)) {
    return true;
  }
  if (cmd === "release" && ["create", "edit"].includes(sub)) return true;
  if (cmd === "gist" && sub === "create") return true;
  if (cmd === "api") {
    const hasWriteMethod = argv.some(
      (a, i) =>
        (a === "-X" || a === "--method") && /^(?:POST|PATCH|PUT)$/i.test(argv[i + 1] ?? ""),
    );
    const hasBodyArg = argv.some((a) => API_FIELD_FLAGS.has(a) || API_FILE_FLAGS.has(a));
    const pathArg = findGhApiPath(argv.slice(1));
    const touchesTarget = /\/(?:comments|issues|pulls|reviews)\b/.test(pathArg) || pathArg === "graphql";
    if ((hasWriteMethod || hasBodyArg) && touchesTarget) return true;
  }
  return false;
}

/** O comando precisa ler stdin (algum `-` usado como valor de arquivo/campo)? */
export function requiresStdin(rawArgv) {
  const argv = normalizeArgv(rawArgv);
  const [cmd] = argv;
  const isApi = cmd === "api";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!isApi && NON_API_FILE_FLAGS.has(a) && argv[i + 1] === "-") return true;
    if (isApi && API_FILE_FLAGS.has(a) && argv[i + 1] === "-") return true;
    if (isApi && API_FIELD_FLAGS.has(a)) {
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
export function collectTextsToCheck(rawArgv, deps = {}) {
  const argv = normalizeArgv(rawArgv);
  const { readFileSync = () => "", stdinText } = deps;
  const resolveFileOrStdin = (path) => (path === "-" ? (stdinText ?? "") : safeRead(readFileSync, path));

  const [cmd, sub] = argv;
  const isApi = cmd === "api";
  const bodyFlags = isApi ? new Set() : nonApiBodyFlags(sub);
  const fileFlags = isApi ? API_FILE_FLAGS : NON_API_FILE_FLAGS;

  const texts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bodyFlags.has(a)) {
      texts.push(argv[i + 1] ?? "");
      i++;
      continue;
    }
    if (fileFlags.has(a)) {
      texts.push(resolveFileOrStdin(argv[i + 1] ?? ""));
      i++;
      continue;
    }
    if (isApi && API_FIELD_FLAGS.has(a)) {
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
