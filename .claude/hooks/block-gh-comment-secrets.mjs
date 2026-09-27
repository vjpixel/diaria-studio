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
// Fail-open em qualquer falha de parse/leitura, mesma filosofia dos hooks
// irmãos. Self-contained (sem import de `scripts/*.ts`).

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

/** Padrões de segredo com formato de provedor. Cada um exige corpo longo. */
export const SECRET_PATTERNS = [
  { name: "OpenRouter", re: /sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI", re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: "Brevo", re: /xkeysib-[A-Za-z0-9-]{20,}/ },
  { name: "GitHub", re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "Doppler", re: /\bdp\.(?:st|pt|sa|ct|scim)\.[A-Za-z0-9_.-]{20,}/ },
  { name: "Slack", re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { name: "Google API", re: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { name: "AWS", re: /\bAKIA[A-Z0-9]{16}\b/ },
];

/** Nomes dos provedores cujos segredos aparecem em `text` (vazio = limpo). */
export function findSecrets(text) {
  if (typeof text !== "string" || text === "") return [];
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

/** Troca todo segredo reconhecido por `[REDACTED_{PROVEDOR}]`. */
export function redactSecrets(text) {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    const tag = `[REDACTED_${p.name.toUpperCase().replace(/\s+/g, "_")}]`;
    out = out.replace(new RegExp(p.re.source, "g"), tag);
  }
  return out;
}

/** O comando publica texto no GitHub via `gh`? */
export function isGhPublishCommand(command) {
  if (typeof command !== "string") return false;
  return (
    /\bgh\s+(?:pr|issue)\s+(?:comment|create|edit|review|close)\b/.test(command) ||
    /\bgh\s+release\s+(?:create|edit)\b/.test(command) ||
    /\bgh\s+gist\s+create\b/.test(command) ||
    // `gh api` só publica quando manda corpo (campo/arquivo) ou método de escrita.
    (/\bgh\s+api\b[\s\S]*\/(?:comments|issues|pulls|reviews)\b/.test(command) &&
      /(?:\s-[fF]\s|\s--(?:field|raw-field|input)\b|\s-X\s*(?:POST|PATCH|PUT)\b|--method\s+(?:POST|PATCH|PUT)\b)/.test(command))
  );
}

/** Arquivos passados como corpo (`--body-file`, `-F`, `--input`). */
export function bodyFileArgs(command) {
  const out = [];
  const re = /(?:--body-file|--input|-F)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    let v = m[1] ?? m[2] ?? m[3];
    // `gh api -F body=@arquivo` → arquivo; `-F campo=valor` literal fica no comando.
    const at = v.match(/^[^=]+=@(.+)$/);
    if (at) v = at[1];
    else if (/^[^=]+=/.test(v)) continue;
    if (v !== "-") out.push(v);
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
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`;

if (isMain) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(raw);
      if (payload.tool_name !== "Bash") return;
      const reason = evaluate(payload.tool_input?.command, payload.cwd);
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
      }
    } catch {
      // fail-open
    }
  });
}
