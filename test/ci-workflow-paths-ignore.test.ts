/**
 * test/ci-workflow-paths-ignore.test.ts (#6711)
 *
 * `.github/workflows/ci.yml` mantém DOIS blocos `paths-ignore:` — um sob
 * `push:` (branches: [master]) e um sob `pull_request:` — que precisam ficar
 * idênticos (#6711): um PR docs-only que já pula a suíte no lado
 * `pull_request:` (#5901) mas paga a suíte inteira de novo no `push:master`
 * do squash-merge é exatamente o bug que motivou #6711. Como não existe
 * include/anchor compartilhado nativo do GitHub Actions entre triggers de um
 * mesmo workflow, os dois blocos são mantidos em sincronia MANUALMENTE — este
 * teste é o guard mecânico contra o próximo edit que toque só um dos dois e
 * reintroduza a assimetria em silêncio.
 *
 * Parsing é por regex sobre o texto bruto (não YAML completo) de propósito —
 * evita adicionar uma dependência de parser YAML só para este guard estreito,
 * e o formato de `paths-ignore:` (lista de strings entre aspas, uma por
 * linha) é estável o bastante para não justificar o parser completo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YML_PATH = resolve(ROOT, ".github", "workflows", "ci.yml");

/**
 * Extrai a lista de `paths-ignore:` que segue logo após uma linha
 * `{trigger}:` (ex: "push:", "pull_request:") em `on:`. Assume o formato já
 * usado no arquivo: uma linha `paths-ignore:` seguida de itens `- "..."`
 * indentados, até a próxima linha que não seja um item de lista.
 */
function extractPathsIgnore(yamlText: string, trigger: string): string[] {
  const lines = yamlText.split("\n");
  const triggerLineIdx = lines.findIndex((l) => new RegExp(`^\\s{2}${trigger}:\\s*$`).test(l));
  assert.notEqual(triggerLineIdx, -1, `bloco '${trigger}:' não encontrado em ci.yml`);

  // Escopo da busca: da linha do trigger até a próxima chave de mesmo nível
  // (indentação de 2 espaços) ou fim do arquivo — nunca vazar pro próximo trigger.
  const triggerIndent = lines[triggerLineIdx].match(/^\s*/)![0].length;
  let blockEnd = lines.length;
  for (let i = triggerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^\s*/)![0].length;
    if (indent <= triggerIndent) {
      blockEnd = i;
      break;
    }
  }
  const block = lines.slice(triggerLineIdx, blockEnd);

  const pathsIgnoreIdx = block.findIndex((l) => /^\s*paths-ignore:\s*$/.test(l));
  assert.notEqual(pathsIgnoreIdx, -1, `'paths-ignore:' não encontrado sob '${trigger}:' em ci.yml`);

  const items: string[] = [];
  for (let i = pathsIgnoreIdx + 1; i < block.length; i++) {
    const m = block[i].match(/^\s*-\s*"([^"]*)"\s*$/);
    if (!m) break;
    items.push(m[1]);
  }
  assert.ok(items.length > 0, `'paths-ignore:' sob '${trigger}:' não tem itens em ci.yml`);
  return items;
}

describe("ci.yml: paths-ignore sincronizado entre push: e pull_request: (#6711)", () => {
  const yamlText = readFileSync(CI_YML_PATH, "utf8");

  it("bloco push: tem paths-ignore", () => {
    const pushPaths = extractPathsIgnore(yamlText, "push");
    assert.ok(pushPaths.length > 0);
  });

  it("bloco pull_request: tem paths-ignore", () => {
    const prPaths = extractPathsIgnore(yamlText, "pull_request");
    assert.ok(prPaths.length > 0);
  });

  it("as duas listas de paths-ignore são idênticas (mesmo conjunto, mesma ordem)", () => {
    const pushPaths = extractPathsIgnore(yamlText, "push");
    const prPaths = extractPathsIgnore(yamlText, "pull_request");
    assert.deepEqual(
      pushPaths,
      prPaths,
      "push:.paths-ignore e pull_request:.paths-ignore divergiram — #6711 existe pra manter os dois em sincronia " +
        "(um merge docs-only não pode pular a suíte só de um lado e pagar do outro)",
    );
  });
});
