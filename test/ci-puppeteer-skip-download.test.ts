/**
 * test/ci-puppeteer-skip-download.test.ts (#8483)
 *
 * `puppeteer` (dependência raiz, `package.json`) baixa um binário do Chrome
 * no postinstall de TODO `npm ci` — download que ocasionalmente falha com
 * `ECONNRESET` (flake de rede do runner), derrubando o job inteiro mesmo
 * quando o diff da PR não tem nada a ver (aconteceu no job `markdown-guards`
 * da PR #8457: 4 testes de conteúdo markdown, nenhum toca em Chrome).
 *
 * Quase nenhum job de CI/deploy deste repo usa o Chrome baixado pelo
 * puppeteer — os consumidores dos SCRIPTS (`scripts/capture-livros-promo.ts`,
 * `scripts/collect-edition-signals.ts`) rodam como parte da pipeline
 * editorial (local/servidor), nunca dentro de `npm test`/`npm run smoke`; o
 * único teste que exercita a lógica de `capture-livros-promo.ts`
 * (`test/capture-livros-promo.test.ts`) mocka a `captureFn` de propósito,
 * "guarda de CI" (ver docstring desse arquivo).
 *
 * **Exceção real, achada ao vivo (run 35474594708, job 105981540676):**
 * `test/verify-accessibility-e2e.test.ts` exercita o fallback de browser
 * REAL de `scripts/verify-accessibility.ts` (quando o fetch puro devolve
 * body <500 chars) — e `ci.yml` roda `npm test`, que inclui esse teste. Sem
 * o Chrome baixado, o job `test` de `ci.yml` falha de verdade. Por isso
 * `ci.yml` está na allowlist `WORKFLOWS_NEEDING_BROWSER` abaixo. O mesmo vale
 * para `weekly-e2e.yml`, que também roda `npm test` (#9995 — o #8483 tinha
 * assumido que `ci.yml` era o único, e o run semanal passou a falhar). O
 * teste "#9995" abaixo trava isso: todo workflow que roda `npm test` precisa
 * estar na allowlist e sem o skip.
 *
 * Este guard varre TODO workflow em `.github/workflows/` que rode `npm ci`
 * de verdade (linha `- run: npm ci`, não uma menção em comentário) e exige
 * que o mesmo arquivo declare `PUPPETEER_SKIP_DOWNLOAD` em algum nível de
 * `env:` (workflow, job ou step) — ou conste em `WORKFLOWS_NEEDING_BROWSER`
 * abaixo, com justificativa. Sem isso, um workflow novo (ou um caller da
 * reusable `deploy-worker.yml`) reintroduz o download em silêncio e volta
 * a expor o mesmo flake.
 *
 * Parsing é por regex sobre o texto bruto (não YAML completo), mesma
 * disciplina de `test/ci-workflow-paths-ignore.test.ts` e
 * `test/markdown-guards-workflow.test.ts` — evita adicionar uma
 * dependência de parser YAML só para este guard estreito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = resolve(ROOT, ".github", "workflows");

/**
 * Workflows que legitimamente precisam do Chrome real do puppeteer em CI.
 * Adicionar aqui só com um comentário justificando por que o skip não pode
 * ser aplicado a esse arquivo — ver docstring acima.
 *
 * - `ci.yml`: roda `npm test`, que inclui
 *   `test/verify-accessibility-e2e.test.ts` (fallback de browser real de
 *   `verify-accessibility.ts`). Achado ao vivo #8483 (run 35474594708,
 *   job 105981540676) — com o skip ligado, esse teste falha porque o
 *   binário do Chrome não existe.
 * - `weekly-e2e.yml`: step "Run unit tests" também roda `npm test` — o
 *   #8483 o marcou com skip por engano e o teste #3211 de
 *   `verify-accessibility-e2e.test.ts` passou a falhar no run semanal
 *   (#9995, run 37954585273: verdict `uncertain` em vez de `accessible`).
 */
const WORKFLOWS_NEEDING_BROWSER = new Set<string>(["ci.yml", "weekly-e2e.yml"]);

/**
 * true se o arquivo tem um step real que roda a suíte inteira (`npm test`),
 * na forma `- run: npm test` ou `run: npm test` dentro de um step nomeado.
 * Ignora linhas comentadas.
 */
function runsNpmTest(text: string): boolean {
  return /^\s*(-\s*)?run:\s*npm (run )?test\s*$/m.test(text);
}

/** true se o arquivo tem um step real `run: npm ci` (não uma menção em comentário). */
function runsNpmCi(text: string): boolean {
  return /^\s*-\s*run:\s*npm ci\s*$/m.test(text);
}

/**
 * true se o arquivo declara PUPPETEER_SKIP_DOWNLOAD como chave de env: (em
 * qualquer nível). Menção em comentário (`# ... PUPPETEER_SKIP_DOWNLOAD ...`)
 * não conta — workflows da allowlist citam o nome no comentário justamente
 * para explicar por que NÃO skipam (#9995).
 */
function skipsPuppeteerDownload(text: string): boolean {
  return /^\s*PUPPETEER_SKIP_DOWNLOAD\s*:/m.test(text);
}

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );
}

describe("CI puppeteer skip download (#8483)", () => {
  it("todo workflow que roda `npm ci` de verdade skipa o download do Chrome do puppeteer, ou está na allowlist de browser real", () => {
    const offenders: string[] = [];
    for (const file of listWorkflowFiles()) {
      const text = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      if (!runsNpmCi(text)) continue;
      if (WORKFLOWS_NEEDING_BROWSER.has(file)) continue;
      if (!skipsPuppeteerDownload(text)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Workflow(s) rodando \`npm ci\` sem PUPPETEER_SKIP_DOWNLOAD (nem na allowlist ` +
        `WORKFLOWS_NEEDING_BROWSER): ${offenders.join(", ")}. Adicione ` +
        `\`env: PUPPETEER_SKIP_DOWNLOAD: "true"\` ao workflow (ou, se o job de fato ` +
        `precisa do Chrome real, adicione o arquivo a WORKFLOWS_NEEDING_BROWSER acima ` +
        `com justificativa).`,
    );
  });

  it("#9995: todo workflow que roda `npm test` (suíte inteira) NÃO skipa o download e está na allowlist de browser real", () => {
    // `npm test` inclui test/verify-accessibility-e2e.test.ts, que exercita o
    // fallback de browser REAL — sem o Chrome baixado, o teste #3211 falha
    // (verdict `uncertain`). O #8483 pôs o skip em weekly-e2e.yml supondo que
    // só ci.yml rodava a suíte; este teste trava essa suposição pelo conteúdo.
    const offenders: string[] = [];
    let found = 0;
    for (const file of listWorkflowFiles()) {
      const text = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      if (!runsNpmTest(text)) continue;
      found++;
      if (skipsPuppeteerDownload(text) || !WORKFLOWS_NEEDING_BROWSER.has(file)) {
        offenders.push(file);
      }
    }
    assert.ok(found >= 2, `sanity: esperava ≥2 workflows rodando npm test (ci.yml, weekly-e2e.yml), achou ${found}`);
    assert.deepEqual(
      offenders,
      [],
      `Workflow(s) que rodam \`npm test\` mas skipam o Chrome do puppeteer (ou ` +
        `faltam em WORKFLOWS_NEEDING_BROWSER): ${offenders.join(", ")}. ` +
        `verify-accessibility-e2e.test.ts precisa do browser real.`,
    );
  });

  it("deploy-worker.yml (reusable) skipa o download — cobre todos os callers via workflow_call", () => {
    const text = readFileSync(
      join(WORKFLOWS_DIR, "deploy-worker.yml"),
      "utf8",
    );
    assert.ok(runsNpmCi(text), "sanity check: deploy-worker.yml deveria rodar npm ci");
    assert.ok(
      skipsPuppeteerDownload(text),
      "deploy-worker.yml precisa declarar PUPPETEER_SKIP_DOWNLOAD — cobre 8+ callers via workflow_call",
    );
  });
});
