/**
 * test/pr-checks-guards-wired.test.ts (#7299, #7232)
 *
 * `.github/workflows/pr-checks.yml` roda em TODO PR (sem `paths-ignore:` —
 * diferente de `ci.yml`, que ignora `**`/`*.md` e `**`/`.claude/skills/**` (glob
 * duplo-asterisco escrito com espaço aqui só pra não fechar este comentário
 * de bloco — "*" + "/" fecharia `/**`) tanto em `push:` quanto em
 * `pull_request:`. Isso o torna o único lugar onde um
 * guard que precisa reagir a PR docs-only/frontmatter-only pode viver — e é
 * exatamente a classe de defeito que motivou este teste:
 *
 *   - #7299: `npm run validate-agents` (frontmatter YAML + MCP tool names,
 *     #122/#7279) tinha o guard ESCRITO e testado, mas nenhum workflow o
 *     chamava — "guard que só existe se alguém lembrar de rodar o comando".
 *     Um PR que só edita `.claude/agents/*.md` (o caso que #7301 expôs ao
 *     vivo) nunca dispararia `ci.yml` por causa do `paths-ignore`, então o
 *     guard PRECISA estar em `pr-checks.yml`, não lá.
 *
 *   - #7232: `tsc -p tsconfig.test.json --noEmit` (job "Typecheck ratchet",
 *     #6217) é o único caminho de CI que type-checka `test/**` — o
 *     `npm run typecheck` de `ci.yml` cobre só `scripts/**`
 *     (`tsconfig.json`). Um teste de regressão cuja asserção é de TIPO só
 *     conta como guard real se este job continuar existindo — este teste
 *     protege contra a próxima edição de `pr-checks.yml` remover o job (ou
 *     trocar de `-p tsconfig.test.json` pra algo que não cobre `test/**`)
 *     em silêncio.
 *
 * Parsing por regex sobre o texto bruto do YAML, mesmo padrão de
 * `test/ci-workflow-paths-ignore.test.ts` — evita depender de um parser
 * YAML só pra este guard estreito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PR_CHECKS_PATH = resolve(ROOT, ".github", "workflows", "pr-checks.yml");
const CI_PATH = resolve(ROOT, ".github", "workflows", "ci.yml");

describe("pr-checks.yml roda em todo PR — sem paths-ignore (#7299)", () => {
  it("não declara paths-ignore (diferente de ci.yml, que ignora **/*.md)", () => {
    const yamlText = readFileSync(PR_CHECKS_PATH, "utf8");
    assert.doesNotMatch(
      yamlText,
      /paths-ignore:/,
      "pr-checks.yml ganhou paths-ignore — isso reintroduziria o gap do #7301 (PR só-de-.md sem NENHUM guard)",
    );
  });

  it("sanity: ci.yml de fato ignora .md — é por isso que o guard de agent precisa estar em pr-checks.yml", () => {
    const ciText = readFileSync(CI_PATH, "utf8");
    assert.match(ciText, /paths-ignore:/);
    assert.match(ciText, /\*\*\/\*\.md/);
  });
});

describe("validate-agents está wired em pr-checks.yml (#7299)", () => {
  const yamlText = readFileSync(PR_CHECKS_PATH, "utf8");

  it("existe um job que roda 'npm run validate-agents' (ou o script direto)", () => {
    assert.match(
      yamlText,
      /npm run validate-agents|npx tsx scripts\/validate-agent-frontmatter\.ts/,
      "nenhum job de pr-checks.yml chama validate-agent-frontmatter.ts — o guard voltaria a só existir em disco",
    );
  });

  it("o job de validate-agents roda em todo PR (nenhum 'if:' condicionando por path/label)", () => {
    const lines = yamlText.split("\n");
    const jobLineIdx = lines.findIndex((l) => /^\s{2}validate-agents:\s*$/.test(l));
    assert.notEqual(jobLineIdx, -1, "job 'validate-agents:' não encontrado em pr-checks.yml");
    // Escopo do job: da linha do id até a próxima chave de mesmo nível (2 espaços).
    let blockEnd = lines.length;
    for (let i = jobLineIdx + 1; i < lines.length; i++) {
      if (/^\s{2}\S/.test(lines[i])) {
        blockEnd = i;
        break;
      }
    }
    const block = lines.slice(jobLineIdx, blockEnd).join("\n");
    assert.doesNotMatch(block, /\bif:\s*/, "job validate-agents tem 'if:' condicional — não devia, precisa rodar sempre");
  });
});

describe("typecheck-ratchet (test/** typechecked) continua wired em pr-checks.yml (#7232, #6217)", () => {
  const yamlText = readFileSync(PR_CHECKS_PATH, "utf8");

  it("existe um job que roda scripts/typecheck-ratchet.ts", () => {
    assert.match(
      yamlText,
      /npx tsx scripts\/typecheck-ratchet\.ts/,
      "job typecheck-ratchet sumiu de pr-checks.yml — todo teste de regressão de TIPO em test/** " +
        "voltaria a ser decorativo (#7232)",
    );
  });

  it("tsconfig.test.json (o tsconfig que o ratchet usa) inclui test/**/*.ts", () => {
    const tsconfigTestPath = resolve(ROOT, "tsconfig.test.json");
    const raw = readFileSync(tsconfigTestPath, "utf8");
    const parsed = JSON.parse(raw) as { include?: string[] };
    assert.ok(
      (parsed.include ?? []).some((p) => p.includes("test/")),
      "tsconfig.test.json parou de incluir test/**/*.ts — o ratchet passaria a checar só scripts/**, " +
        "igual ao tsconfig.json raiz, e o gap do #7232 voltaria mesmo com o job presente",
    );
  });
});
