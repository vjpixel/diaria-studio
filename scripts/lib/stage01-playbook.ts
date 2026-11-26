/**
 * scripts/lib/stage01-playbook.ts (#14030)
 *
 * Os playbooks das Etapas 0 e 1 viraram caminho principal + fallback:
 *
 *   - `orchestrator-stage-0-preflight.md`: bloco do runner `stage-0-run.ts`
 *     e o que o orchestrator executa fora dele (0b, pings MCP, 0g, 0j, 0n,
 *     0m). `orchestrator-stage-0-replies.md` guarda o §0-replies (lido pelo
 *     top-level do `/diaria-edicao`, pelo Stage 6 e pelo Stage 1 interativo
 *     com `pre_gate`). `orchestrator-stage-0-fallback.md` guarda a prosa dos
 *     passos que o runner executa.
 *   - `orchestrator-stage-1-research.md`: bloco do runner `stage-1-run.ts` e
 *     os passos fora dele (§1f Path B, custo de §1g, §1m-ter..§1m-quinquies,
 *     §1q, §1x, §1y). `orchestrator-stage-1-fallback.md` guarda o resto.
 *
 * Os testes que pinam texto desses playbooks leem o conjunto por estes
 * helpers, para que uma asserção sobre uma instrução continue valendo
 * quando ela mudar de arquivo. Mesmo padrão de `stage4-playbook.ts`
 * (#14033). A ordem é a de leitura: principal primeiro, fallback depois.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Caminhos relativos à raiz do repo, na ordem em que o orchestrator lê. */
export const STAGE0_PLAYBOOK_FILES = [
  ".claude/agents/orchestrator-stage-0-preflight.md",
  ".claude/agents/orchestrator-stage-0-replies.md",
  ".claude/agents/orchestrator-stage-0-fallback.md",
] as const;

export const STAGE1_PLAYBOOK_FILES = [
  ".claude/agents/orchestrator-stage-1-research.md",
  ".claude/agents/orchestrator-stage-1-fallback.md",
] as const;

function readAll(files: readonly string[], root: string): string {
  return files.map((p) => readFileSync(resolve(root, p), "utf8")).join("\n");
}

/** Texto do playbook da Etapa 0 inteiro (principal + §0-replies + fallback). */
export function readStage0Playbook(root: string = DEFAULT_ROOT): string {
  return readAll(STAGE0_PLAYBOOK_FILES, root);
}

/** Texto do playbook da Etapa 1 inteiro (principal + fallback). */
export function readStage1Playbook(root: string = DEFAULT_ROOT): string {
  return readAll(STAGE1_PLAYBOOK_FILES, root);
}
