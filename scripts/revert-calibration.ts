#!/usr/bin/env npx tsx
/**
 * scripts/revert-calibration.ts (#7978, Camada 5 da #7972, ponto 8)
 *
 * Reverte 1 PR de calibração já mergeada — `git revert --no-edit <sha>`,
 * abre PR, deixa pro fluxo normal de auto-merge do #5251 (a REVERSÃO em
 * si é "operação de código" — restaura o estado sign-off ANTERIOR, não
 * introduz um novo; #7978 ponto 8 é explícito: "tratado como operação de
 * código via #5251, sem exigir novo sign-off").
 *
 * **PENDÊNCIA NOMEADA:** o próprio commit de revert vai tocar as mesmas
 * linhas dentro de um bloco `CALIBRATED:*` (ou o mesmo arquivo TS
 * calibrável) que o PR original tocou — `check-editorial-signoff.ts`
 * (#7978 ponto 4) hoje NÃO distingue "revert de uma calibração já
 * aprovada" de "calibração nova", então a PR de revert AINDA vai pedir a
 * label `editorial-signoff:approved` antes de passar o gate, mesmo sendo
 * (por design) dispensada de sign-off NOVO pelo texto da issue. Resolver
 * isso exigiria o gate reconhecer commits de revert (`git revert` deixa
 * "This reverts commit <sha>" no corpo) e checar se o SHA revertido já
 * tinha sign-off — mecanismo real, mas sem nenhuma calibração real
 * mergeada ainda pra testar contra. Registrado aqui em vez de implementado
 * às cegas; até lá, o editor aplica a label também na PR de revert (1
 * clique a mais, não um bloqueio genuíno).
 *
 * NUNCA roda `git push`/`gh pr create` sozinho como side-effect de
 * importar este módulo — `buildRevertPlan` é puro (monta o plano), a
 * execução real fica behind `isMainModule`.
 *
 * Uso:
 *   npx tsx scripts/revert-calibration.ts --sha <sha-do-merge> --reason "..."
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface RevertPlan {
  sha: string;
  branchName: string;
  revertCommand: readonly string[];
  prTitle: string;
  prBody: string;
}

export function buildRevertPlan(sha: string, reason: string): RevertPlan {
  const shortSha = sha.slice(0, 10);
  return {
    sha,
    branchName: `revert/calibration-${shortSha}`,
    revertCommand: ["git", "revert", "--no-edit", sha],
    prTitle: `revert: calibração ${shortSha} — regressão detectada`,
    prBody: [
      `Reverte a calibração mergeada em ${sha}.`,
      "",
      `**Motivo:** ${reason}`,
      "",
      "Esta reversão é tratada como operação de código normal (#5251) — restaura o estado ANTERIOR já aprovado, não introduz uma calibração nova. Ver `scripts/revert-calibration.ts` pra pendência sobre o gate de sign-off ainda pedir a label nesta PR mesmo assim (#7978).",
    ].join("\n"),
  };
}

/** Executa o plano contra o checkout real — SEMPRE do checkout PRINCIPAL, nunca de um worktree (guard #5716, achado ao vivo desta rodada). Não faz merge — só cria a branch, o commit de revert e a PR; merge segue o fluxo normal (#5251). */
export function executeRevertPlan(plan: RevertPlan, cwd: string): { ok: boolean; error?: string } {
  const checkout = spawnSync("git", ["checkout", "-b", plan.branchName], { cwd, encoding: "utf8" });
  if (checkout.status !== 0) return { ok: false, error: `checkout -b falhou: ${checkout.stderr}` };

  const revert = spawnSync(plan.revertCommand[0], [...plan.revertCommand.slice(1)], { cwd, encoding: "utf8" });
  if (revert.status !== 0) return { ok: false, error: `git revert falhou (provável conflito — resolver manualmente): ${revert.stderr}` };

  const push = spawnSync("git", ["push", "-u", "origin", plan.branchName], { cwd, encoding: "utf8" });
  if (push.status !== 0) return { ok: false, error: `git push falhou: ${push.stderr}` };

  const pr = spawnSync("gh", ["pr", "create", "--title", plan.prTitle, "--body", plan.prBody], { cwd, encoding: "utf8" });
  if (pr.status !== 0) return { ok: false, error: `gh pr create falhou: ${pr.stderr}` };

  return { ok: true };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const sha = values["sha"];
  const reason = values["reason"];
  if (!sha || !reason) {
    console.error('Uso: revert-calibration.ts --sha <sha-do-merge> --reason "..."');
    process.exit(2);
  }

  const plan = buildRevertPlan(sha, reason);
  console.log(`[revert-calibration] plano: branch ${plan.branchName}, revert de ${sha}`);
  const result = executeRevertPlan(plan, ROOT);
  if (!result.ok) {
    console.error(`[revert-calibration] falhou: ${result.error}`);
    process.exit(1);
  }
  console.log("[revert-calibration] PR de reversão aberta — segue fluxo normal de review/CI/auto-merge (#5251). Ver docstring do script pra pendência sobre a label de sign-off nesta PR específica.");
}
