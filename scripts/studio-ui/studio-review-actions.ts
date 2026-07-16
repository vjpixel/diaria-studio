/**
 * studio-review-actions.ts (#3559)
 *
 * "Ações rápidas" do painel de revisão de conteúdo — aceite do #3559 pede
 * pelo menos 1 funcionando ponta-a-ponta. A única ação implementada nesta
 * fatia é **trocar destaque por runner-up/pool** (`scripts/swap-destaque.ts`)
 * porque é DETERMINÍSTICA (script puro, sem LLM) — as outras duas citadas no
 * corpo da issue ("reescrever título", "regenerar imagem") são, por natureza,
 * ações que precisam de geração (LLM / Gemini-ComfyUI) e a issue as descreve
 * como "prompt visível/editável antes de enviar" pra uma SESSÃO — ou seja,
 * dependem da ponte chat-drawer/Agent-SDK (#3556), que roda em worktree
 * irmã em paralelo a este e não estava mergeada no momento desta fatia.
 * Ficam como GANCHO (ver `docs` no PR): o painel já expõe onde essas 2 ações
 * entrariam (`studio-review.js` renderiza os cards com aviso "depende de
 * #3556"), mas não fazem chamada nenhuma ainda.
 *
 * `scripts/swap-destaque.ts` não exporta uma função orquestradora única —
 * o script inteiro é o `main()` (validação + mutação inline). Reusar via
 * import quebraria a garantia de "todas as pré-condições validadas ANTES de
 * qualquer mutação" documentada no cabeçalho do script (reimplementar essa
 * lógica aqui seria exatamente o tipo de duplicação/drift que o dispatch
 * pediu pra evitar). Em vez disso, invocamos o script como subprocess — a
 * MESMA CLI que o editor rodaria manualmente no terminal — e repassamos o
 * JSON de stdout como está. `spawnFn` é injetável pra testes (mock, sem
 * spawnar processo nem tocar disco real).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnFn } from "./studio-review.ts";

export interface SwapDestaqueRequest {
  aammdd: string;
  /** `"radar:0"`, `"lancamento:1"`, `"use_melhor:0"`, `"video:0"`, `"runners_up:2"` */
  promote: string;
  /** `"d1"` | `"d2"` | `"d3"` */
  demote: string;
  drop?: boolean;
  dryRun?: boolean;
}

export interface SwapDestaqueResponse {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  /** stdout parseado (o `SwapResult` de swap-destaque.ts) quando `ok`. */
  result?: unknown;
}

const AAMMDD_RE = /^\d{6}$/;
const PROMOTE_RE = /^(radar|lancamento|use_melhor|video|runners_up):\d+$/;
const DEMOTE_RE = /^d[123]$/;

/** Valida a forma da requisição ANTES de gastar um spawn — o script também
 * valida, mas falhar aqui é mais barato e dá uma mensagem consistente com o
 * resto da API (JSON, não texto de stderr do CLI). */
export function validateSwapRequest(req: Partial<SwapDestaqueRequest>): string | null {
  if (!req.aammdd || !AAMMDD_RE.test(req.aammdd)) return "aammdd inválido (esperado AAMMDD)";
  if (!req.promote || !PROMOTE_RE.test(req.promote)) {
    return "promote inválido (esperado bucket:idx — radar|lancamento|use_melhor|video|runners_up)";
  }
  if (!req.demote || !DEMOTE_RE.test(req.demote)) return "demote inválido (esperado d1, d2 ou d3)";
  return null;
}

/**
 * Executa (ou simula, se `dryRun`) a troca de destaque via subprocess de
 * `scripts/swap-destaque.ts`. Fail-soft: qualquer erro de spawn/parse vira
 * `{ ok: false, error }`, nunca lança.
 */
export function runSwapDestaque(
  rootDir: string,
  req: SwapDestaqueRequest,
  spawnFn: SpawnFn = spawnSync,
): SwapDestaqueResponse {
  const invalid = validateSwapRequest(req);
  if (invalid) return { ok: false, dryRun: !!req.dryRun, error: invalid };

  const scriptPath = resolve(rootDir, "scripts", "swap-destaque.ts");
  if (!existsSync(scriptPath)) {
    return { ok: false, dryRun: !!req.dryRun, error: "scripts/swap-destaque.ts não encontrado" };
  }

  const args = [
    "--import", "tsx",
    scriptPath,
    "--edition", req.aammdd,
    "--promote", req.promote,
    "--demote", req.demote,
  ];
  if (req.drop) args.push("--drop");
  if (req.dryRun) args.push("--dry-run");

  try {
    const proc = spawnFn(process.execPath, args, { cwd: rootDir, encoding: "utf8", timeout: 30_000 });
    if (proc.error) return { ok: false, dryRun: !!req.dryRun, error: proc.error.message };
    if (proc.status !== 0) {
      return {
        ok: false,
        dryRun: !!req.dryRun,
        error: (proc.stderr || "").trim() || `swap-destaque.ts saiu com status ${proc.status}`,
      };
    }
    try {
      return { ok: true, dryRun: !!req.dryRun, result: JSON.parse(proc.stdout) };
    } catch {
      return { ok: true, dryRun: !!req.dryRun, result: proc.stdout };
    }
  } catch (e) {
    return { ok: false, dryRun: !!req.dryRun, error: (e as Error).message };
  }
}
