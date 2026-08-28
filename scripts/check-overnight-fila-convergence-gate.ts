#!/usr/bin/env npx tsx
/**
 * check-overnight-fila-convergence-gate.ts (#6435)
 *
 * Gate MECÂNICO pro re-scan de convergência da Fase 1 passo 1 de
 * `.claude/skills/diaria-overnight/SKILL.md` — o ponto DENTRO do loop
 * principal onde o coordenador precisa decidir "a fila elegível esgotou
 * de verdade, ou só parece esgotada porque não confiro `gh issue list`
 * de novo?" antes de declarar convergência e seguir pra Fase 1.5.
 *
 * Até esta issue, aquele ponto era só PROSA ("fazer um re-scan") — os 5
 * gates da Fase 2 (`check-state-changed-pending.ts` e os 4 vizinhos, ver
 * SKILL.md passos 0.5-0.9) têm `exit 1` mecânico que BLOQUEIA a compilação
 * do relatório se a condição não for satisfeita; a Fase 1 passo 1 não tinha
 * nenhum gate equivalente, e prosa é pulável sob pressão de contexto —
 * achado ao vivo na rodada 260827b (#6435): o coordenador declarou "fila
 * esgotada" e seguiu direto pra Fase 1.5 sem re-scan, e só pegou a issue
 * nova (#6431, criada depois da varredura inicial) porque o EDITOR
 * perguntou diretamente. Sem essa pergunta, a issue ficaria de fora do
 * relatório da noite.
 *
 * ## O que faz
 *
 * Reusa a MESMA lógica pura de convergência que a Fase 2 já usa
 * (`checkConvergenceScan`/`findMissingConvergenceIssues`,
 * `scripts/lib/state-changed-tracker.ts`) e o MESMO fetch fail-soft
 * (`fetchOpenIssuesForConvergence`, exportado de
 * `scripts/check-state-changed-pending.ts`) — não reimplementa nada, só dá
 * um ponto de entrada e uma mensagem dedicados ao momento DENTRO do loop
 * (antes de declarar convergência), diferente do ponto de saída (antes do
 * relatório) que `check-state-changed-pending.ts` cobre. As DUAS chamadas
 * continuam necessárias — não são redundantes: esta roda a cada vez que a
 * fila elegível esvazia dentro da Fase 1 (pode acontecer várias vezes numa
 * rodada longa, #5272 removeu o cap de re-varreduras); aquela roda 1x, no
 * fim, como último gate antes do relatório.
 *
 * `exit 0` = nenhuma issue nova/fora do conjunto conhecido — convergência
 * real, seguro declarar a fila esgotada e avançar (pra Fase 1.5, ou pro
 * próximo re-scan se `--loop` indicar que ainda há trabalho). `exit 1` =
 * lista de issues novas — voltar e classificá-las (aceitar como `mid-round`
 * elegível, ou `pulada` com motivo do vocabulário de `overnight-plan-motivo.ts`)
 * antes de repetir a checagem.
 *
 * Uso (chamado pelo coordenador toda vez que a Fase 1 passo 1 esvaziar a fila):
 *   npx tsx scripts/check-overnight-fila-convergence-gate.ts --plan data/overnight/{AAMMDD}/plan.json
 *
 * @see scripts/lib/state-changed-tracker.ts (lógica pura, fonte única)
 * @see scripts/check-state-changed-pending.ts (gate irmão — mesma lógica, ponto de SAÍDA/Fase 2)
 * @see .claude/skills/diaria-overnight/SKILL.md Fase 1 passo 1
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  checkConvergenceScan,
  recordConvergenceScan,
  type PlanWithGoal,
} from "./lib/state-changed-tracker.ts";
import { fetchOpenIssuesForConvergence } from "./check-state-changed-pending.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-overnight-fila-convergence-gate] uso: --plan {path}");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-overnight-fila-convergence-gate] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  const fetched = fetchOpenIssuesForConvergence(process.cwd());
  if (fetched.error) {
    // Fail-soft (#738): `gh` indisponível não trava a rodada — mas, ao
    // contrário do gate de Fase 2 (que já tem outras 4 checagens
    // cobrindo o encerramento), este é o ÚNICO freio mecânico do meio do
    // loop. Sair 0 com aviso explícito é o comportamento correto (não
    // inventar convergência que não foi verificada), mas o texto deixa
    // claro que "ok" aqui não é "confirmado".
    console.error(
      `[check-overnight-fila-convergence-gate] gh indisponível — re-scan NÃO executado (fail-soft, #738): ${fetched.error}`,
    );
    console.log("ok (não verificado) — trate como convergência NÃO confirmada, não como 'nenhuma issue nova'.");
    process.exit(0);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-overnight-fila-convergence-gate] plan.json malformado — re-scan NÃO executado (fail-soft, #738): ${(e as Error).message}`,
    );
    console.log("ok (não verificado) — trate como convergência NÃO confirmada.");
    process.exit(0);
  }

  const convergence = checkConvergenceScan(planRaw as PlanWithGoal, fetched.issues);
  recordConvergenceScan(planPath, convergence.novas_encontradas);

  if (convergence.status === "ok") {
    console.log("ok — convergência confirmada: nenhuma issue nova/fora do conjunto conhecido em gh issue list.");
    process.exit(0);
  }

  const list = convergence.issues.map((n) => `#${n}`).join(", ");
  console.error(
    `[check-overnight-fila-convergence-gate] issue(s) nova(s) fora de goal.target_set/tiers/issues[]: ${list} — classifique cada uma (mid-round elegível OU pulada com motivo válido) antes de declarar a fila esgotada.`,
  );
  process.exit(1);
}
