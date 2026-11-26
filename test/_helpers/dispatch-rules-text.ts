/**
 * Texto das regras das rodadas autônomas para os testes de documentação (#14043).
 *
 * Desde o #14043 `context/overnight-dispatch-rules.md` guarda só as regras do
 * subagente (`dev-implementador`, `dev-fixer`), e os critérios do coordenador
 * (itens 9, 11, 15-18, 21, 22, 24-26, 28, 32, 33, 35, 36, com a mesma
 * numeração) moram em `context/overnight-coordinator-rules.md`. Teste que
 * confere uma regra sem se importar com quem a lê usa `readDispatchRules()`;
 * teste que trava O LADO (o que o subagente lê, ou o que só o coordenador lê)
 * usa `readSubagentRules()`/`readCoordinatorRules()`.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

export const SUBAGENT_RULES_PATH = "context/overnight-dispatch-rules.md";
export const COORDINATOR_RULES_PATH = "context/overnight-coordinator-rules.md";

/** Regras do subagente: o que `dev-implementador`/`dev-fixer` leem. */
export function readSubagentRules(root = ROOT): string {
  return readFileSync(join(root, SUBAGENT_RULES_PATH), "utf8");
}

/** Regras do coordenador. */
export function readCoordinatorRules(root = ROOT): string {
  return readFileSync(join(root, COORDINATOR_RULES_PATH), "utf8");
}

/**
 * O item `n` (`## n. ...` até o próximo `## `) dos dois arquivos, concatenado:
 * item dividido (parte do implementador num, do coordenador no outro) volta
 * inteiro. String vazia se o item não existe em nenhum.
 */
export function dispatchRulesSection(n: number, root = ROOT): string {
  const parts: string[] = [];
  for (const text of [readSubagentRules(root), readCoordinatorRules(root)]) {
    const start = text.indexOf(`\n## ${n}. `);
    if (start < 0) continue;
    const next = text.indexOf("\n## ", start + 1);
    parts.push(text.slice(start, next < 0 ? undefined : next));
  }
  return parts.join("\n\n");
}

/** Os dois arquivos concatenados (subagente primeiro), cada um com uma linha de origem. */
export function readDispatchRules(root = ROOT): string {
  return [
    `<!-- arquivo: ${SUBAGENT_RULES_PATH} -->\n${readSubagentRules(root)}`,
    `<!-- arquivo: ${COORDINATOR_RULES_PATH} -->\n${readCoordinatorRules(root)}`,
  ].join("\n\n");
}
