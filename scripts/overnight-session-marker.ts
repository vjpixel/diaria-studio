#!/usr/bin/env npx tsx
/**
 * overnight-session-marker.ts (#3322)
 *
 * Escreve/remove o marker determinístico que `.claude/hooks/pr-create-review.mjs`
 * (`isOvernightRoundActive`) usa pra detectar uma rodada `/diaria-overnight`
 * genuinamente em progresso NESTA máquina, independente de como PRs da rodada
 * nomeiam suas branches (#3321: convenção de naming `overnight/*` documentada em
 * SKILL.md mas nunca de fato instruída ao dispatch — o gating por branch nunca
 * disparou `low` numa rodada inteira). Path: `data/overnight/.active-session-{tag}.json`,
 * onde `{tag}` é o hostname sanitizado — cada máquina escreve/lê SÓ o próprio
 * arquivo, sem risco de colisão de escrita entre máquinas sincronizadas pelo
 * mesmo junction OneDrive `data/`.
 *
 * Deliberadamente NÃO é `data/overnight/{AAMMDD}/plan.json` (documento de progresso
 * do coordenador, schema evoluindo, dono de uma feature não-relacionada — a
 * statusLine). Uma revisão anterior desta correção reusava `plan.json` e o
 * code-review consolidado do PR encontrou 3 gaps reais nessa abordagem: (1)
 * sem staleness — uma rodada travada/crashada ficava "ativa" pra sempre; (2)
 * `readTodayPlan` só olha o diretório MAIS RECENTE — se esse for de outra
 * máquina, a rodada ativa desta máquina nunca era vista; (3) direção de
 * fail-safe invertida herdada de `isTerminalForBar` (status desconhecido/ausente
 * = "ainda rodando", certo pra uma barra de progresso, errado pra um gate de
 * custo). Um marker dedicado, por máquina, com timestamp próprio, evita as 3
 * classes por construção — contrato inteiro é "existe + é recente + é meu".
 *
 * A lógica de path (`activeSessionPath`/`machineTag`) é DUPLICADA — não
 * importada — em `.claude/hooks/pr-create-review.mjs`: aquele hook roda num
 * caminho que nunca pode lançar (`gh pr create` não pode ser bloqueado por um
 * hook quebrado) e evita depender de qualquer `scripts/*.ts` pra isso (imports
 * estáticos de `.ts` num hook `.mjs` são um ponto de falha sensível a versão
 * de Node — ver comentário no topo do hook). Se o esquema de path mudar aqui,
 * mudar lá também — `test/pr-create-review-hook.test.ts` e
 * `test/overnight-session-marker.test.ts` cobrem os dois lados
 * independentemente, então uma divergência acidental quebra pelo menos um dos
 * dois test files.
 *
 * Uso (chamado pela skill `/diaria-overnight` — Fase 0 passo 1 e Fase 2 passo 1):
 *   npx tsx scripts/overnight-session-marker.ts --start
 *   npx tsx scripts/overnight-session-marker.ts --end
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — string vazia em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

export function activeSessionPath(repoRoot: string, tag: string = machineTag()): string {
  return join(repoRoot, "data", "overnight", `.active-session-${tag}.json`);
}

/** Grava o marker de sessão ativa. Idempotente — sobrescreve `started_at` se já existir. */
export function startSession(repoRoot: string, startedAtIso: string): void {
  const path = activeSessionPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ started_at: startedAtIso }), "utf8");
}

/** Remove o marker de sessão ativa. Idempotente — no-op se já ausente. */
export function endSession(repoRoot: string): void {
  const path = activeSessionPath(repoRoot);
  if (existsSync(path)) rmSync(path);
}

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const arg = process.argv[2];
  if (arg === "--start") {
    startSession(repoRoot, new Date().toISOString());
    process.stdout.write(`overnight session marker: started (${activeSessionPath(repoRoot)})\n`);
  } else if (arg === "--end") {
    endSession(repoRoot);
    process.stdout.write(`overnight session marker: ended (${activeSessionPath(repoRoot)})\n`);
  } else {
    process.stderr.write("uso: npx tsx scripts/overnight-session-marker.ts --start | --end\n");
    process.exitCode = 1;
  }
}
