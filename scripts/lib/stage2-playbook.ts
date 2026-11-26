/**
 * scripts/lib/stage2-playbook.ts (#14113)
 *
 * O playbook da Etapa 2 virou caminho principal + fallback, como os das
 * Etapas 0 e 1 no #14030 (`stage01-playbook.ts`):
 *
 *   - `orchestrator-stage-2.md`: bloco do runner `stage-2-run.ts` e o que o
 *     top-level executa fora dele (dispatch de `pendingAgentDispatch` com o
 *     `category_label`, custo, consertos por id dos lints, proposta do erro
 *     intencional, exceções do `check-invariants --stage 2`, gate).
 *   - `orchestrator-stage-2-fallback.md`: a prosa dos passos que o runner
 *     executa (pré-condição, §2a-§2d), lida só quando o runner falha fora
 *     dos codes previstos. A Clarice é só REST nos dois.
 *
 * A skill `/diaria-2-escrita` deixou de repetir a receita: aponta para os
 * dois arquivos. Os testes que pinam texto da Etapa 2 leem o conjunto por
 * este helper, para que uma asserção sobre uma instrução continue valendo
 * quando ela mudar de arquivo. A ordem é a de leitura: principal primeiro.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Caminhos relativos à raiz do repo, na ordem em que o orchestrator lê. */
export const STAGE2_PLAYBOOK_FILES = [
  ".claude/agents/orchestrator-stage-2.md",
  ".claude/agents/orchestrator-stage-2-fallback.md",
] as const;

/** Texto do playbook da Etapa 2 inteiro (principal + fallback). */
export function readStage2Playbook(root: string = DEFAULT_ROOT): string {
  return STAGE2_PLAYBOOK_FILES.map((p) => readFileSync(resolve(root, p), "utf8")).join("\n");
}
