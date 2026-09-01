/**
 * test/markdown-guards-workflow.test.ts (#6935, Defeito 1)
 *
 * Guard mecânico contra o próprio incidente que motivou o novo workflow:
 * `.github/workflows/ci.yml` pula o job `test` (e o guard
 * `claude-md-size.test.ts` dentro dele) em PRs que só tocam CLAUDE.md,
 * qualquer `.md`, ou `docs/` (`paths-ignore`, #6711/#5901) — a PR #6931 estourou o
 * teto do CLAUDE.md sem que NENHUM CI acusasse, e a falha só apareceu 3
 * minutos depois na PR de código seguinte (#6929), invertendo a
 * atribuição de culpa (#6933).
 *
 * `markdown-guards.yml` existe pra rodar justamente esses guards SEM
 * `paths-ignore` — este teste trava que ele continua sem esse filtro (se
 * alguém "otimizar" adicionando um path filter de volta, reintroduziria
 * a mesma classe de bug que motivou a criação do workflow) e que
 * `claude-md-size.test.ts` está de fato na lista de arquivos rodados.
 *
 * Parsing é por regex sobre o texto bruto (não YAML completo), mesma
 * disciplina de `test/ci-workflow-paths-ignore.test.ts` — evita
 * adicionar uma dependência de parser YAML só para um guard estreito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = resolve(ROOT, ".github", "workflows", "markdown-guards.yml");

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

/** Extrai só o bloco `on: ... jobs:` (entre os dois marcadores de nível
 *  0), pra checar paths-ignore/paths sem confundir com uma menção em
 *  comentário fora desse bloco. */
function extractOnBlock(yamlText: string): string {
  const lines = yamlText.split("\n");
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  assert.notEqual(onIdx, -1, "bloco 'on:' não encontrado em markdown-guards.yml");
  const jobsIdx = lines.findIndex((l, i) => i > onIdx && /^jobs:\s*$/.test(l));
  assert.notEqual(jobsIdx, -1, "bloco 'jobs:' não encontrado em markdown-guards.yml");
  return lines.slice(onIdx, jobsIdx).join("\n");
}

describe("markdown-guards.yml (#6935) — nunca pode ter paths-ignore/paths (é O CONSERTO do bug de path filter)", () => {
  it("o bloco 'on:' inteiro (linhas de configuração, não comentários fora dele) não contém 'paths-ignore:' nem 'paths:'", () => {
    const onBlock = extractOnBlock(readWorkflow());
    const configLines = onBlock.split("\n").filter((l) => !l.trim().startsWith("#"));
    const joined = configLines.join("\n");
    assert.doesNotMatch(joined, /^\s*paths-ignore:/m, "'on:' não pode ter paths-ignore — reintroduziria o bug do #6935");
    assert.doesNotMatch(joined, /^\s*paths:/m, "'on:' não pode ter paths — mesma classe de risco");
  });

  it("tem trigger push: com branches: [master]", () => {
    const src = readWorkflow();
    assert.match(src, /push:\s*\n\s*branches:\s*\[master\]/);
  });

  it("tem trigger pull_request:", () => {
    const src = readWorkflow();
    assert.match(src, /pull_request:\s*$/m);
  });

  it("claude-md-size.test.ts está na lista de arquivos rodados", () => {
    const src = readWorkflow();
    assert.match(src, /test\/claude-md-size\.test\.ts/);
  });

  it("os 3 arquivos de conteúdo-de-CLAUDE.md conhecidos também estão na lista (não só claude-md-size)", () => {
    const src = readWorkflow();
    for (const f of [
      "test/diaria-develop-goal-exhaust-all-4319.test.ts",
      "test/diaria-overnight-rescan-sem-cap-5272.test.ts",
      "test/overnight-paralelo-contrato.test.ts",
    ]) {
      assert.ok(src.includes(f), `esperava ${f} na lista de testes do markdown-guards.yml`);
    }
  });

  it("usa 'node --experimental-strip-types --test' direto (não 'npm test', que descobre a suíte inteira)", () => {
    const src = readWorkflow();
    assert.match(src, /node --experimental-strip-types --test/);
    assert.doesNotMatch(src, /run:\s*npm test\s*$/m, "não pode usar 'npm test' — roda a suíte inteira, não só os guards de markdown");
  });
});
