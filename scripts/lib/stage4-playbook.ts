/**
 * scripts/lib/stage4-playbook.ts (#14033)
 *
 * O playbook da Etapa 4 virou dois arquivos: `orchestrator-stage-4.md`
 * (pré-condição e §4a–§4c, pré-gate) e `orchestrator-stage-4-gate.md`
 * (§4d–§4e e a fronteira pós-gate). O cartão de receitas do loop do gate
 * (`context/stage-4-gate-receitas.md`) é consulta, não playbook, e fica fora
 * desta lista.
 *
 * Os testes que pinam texto do playbook leem o conjunto pela
 * `readStage4Playbook()`, na ordem de leitura (pré-gate e depois gate), para
 * que uma asserção sobre uma instrução continue valendo quando ela mudar de
 * arquivo, e asserções de ordem (`indexOf`) sigam comparando posições no
 * texto contínuo.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Caminhos relativos à raiz do repo, na ordem em que o orchestrator lê. */
export const STAGE4_PLAYBOOK_FILES = [
  ".claude/agents/orchestrator-stage-4.md",
  ".claude/agents/orchestrator-stage-4-gate.md",
] as const;

/** Cartão de receitas do loop do gate (#14033). */
export const STAGE4_GATE_RECIPES_FILE = "context/stage-4-gate-receitas.md";

/** Texto do playbook da Etapa 4 inteiro (pré-gate + gate), concatenado. */
export function readStage4Playbook(root: string = DEFAULT_ROOT): string {
  return STAGE4_PLAYBOOK_FILES.map((p) => readFileSync(resolve(root, p), "utf8")).join("\n");
}
