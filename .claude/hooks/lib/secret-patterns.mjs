// .claude/hooks/lib/secret-patterns.mjs (#8884)
//
// Fonte ÚNICA dos padrões de segredo com formato de provedor, extraída de
// `.claude/hooks/block-gh-comment-secrets.mjs` (#8827) pra ser consumida
// também pelo wrapper `hermes/scripts/gh-wrapper.mjs` e por
// `redact_public_text` em `hermes/scripts/continuo-pr-review.sh` — os 3
// pontos que hoje filtram/redigem texto antes de publicar no GitHub. Antes
// desta extração, `redact_public_text` duplicava os mesmos padrões via sed
// (#8880); a divergência entre as duas cópias é exatamente o tipo de gap
// que a #8884 pede pra fechar.
//
// Módulo puro (sem `fs`) — importável de qualquer runtime Node (hook,
// wrapper) e chamável via CLI standalone (usado pelo `redact_public_text`
// do bash, que não tem acesso direto ao módulo JS).

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

// --- CLI standalone: usado por `redact_public_text` (bash, sem acesso a
// import JS) via `node secret-patterns.mjs check|redact` lendo stdin. ---

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const isMain =
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`;

if (isMain) {
  const mode = process.argv[2];
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    if (mode === "redact") {
      process.stdout.write(redactSecrets(raw));
      process.exit(0);
    }
    if (mode === "check") {
      const found = findSecrets(raw);
      if (found.length > 0) {
        process.stderr.write(found.join(","));
        process.exit(1);
      }
      process.exit(0);
    }
    process.stderr.write("uso: secret-patterns.mjs check|redact  (lê stdin)\n");
    process.exit(2);
  });
}
