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

/** Nome da branch atual, ou `null` se não for possível determinar (HEAD destacado, erro de git). Capturado ANTES de qualquer mudança, pra tentar restaurar o checkout se algo falhar no meio. */
function currentBranch(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const branch = r.stdout.trim();
  return branch && branch !== "HEAD" ? branch : null;
}

/**
 * Executa o plano contra o checkout real — SEMPRE do checkout PRINCIPAL,
 * nunca de um worktree (guard #5716, achado ao vivo desta rodada). Não
 * faz merge — só cria a branch, o commit de revert e a PR; merge segue o
 * fluxo normal (#5251).
 *
 * Limpeza em caso de falha (achado de review do #7978, alta confiança —
 * este checkout pode ser COMPARTILHADO com outra sessão, incidentes
 * históricos `checkout-compartilhado-multi-sessao.md`): uma falha no meio
 * da sequência antes desta correção deixava o checkout numa branch nova,
 * às vezes com conflito de revert não resolvido, sem sinalizar que
 * intervenção manual era necessária. Agora: falha em `git revert`
 * dispara `git revert --abort` antes de retornar; QUALQUER falha depois
 * de `checkout -b` tenta voltar pra branch original (capturada antes de
 * começar) — best-effort, reportado mas nunca escondido se a própria
 * restauração falhar.
 */
export function executeRevertPlan(plan: RevertPlan, cwd: string): { ok: boolean; error?: string } {
  const originalBranch = currentBranch(cwd);

  const restoreOriginalBranch = (): string => {
    if (!originalBranch) return " (branch original não pôde ser determinada — checar `git status` manualmente antes de continuar)";
    const back = spawnSync("git", ["checkout", originalBranch], { cwd, encoding: "utf8" });
    return back.status === 0
      ? ` (checkout restaurado pra ${originalBranch})`
      : ` (FALHA ao restaurar checkout pra ${originalBranch}: ${back.stderr} — intervenção manual necessária)`;
  };

  const checkout = spawnSync("git", ["checkout", "-b", plan.branchName], { cwd, encoding: "utf8" });
  if (checkout.status !== 0) return { ok: false, error: `checkout -b falhou: ${checkout.stderr}` };

  const revert = spawnSync(plan.revertCommand[0], [...plan.revertCommand.slice(1)], { cwd, encoding: "utf8" });
  if (revert.status !== 0) {
    spawnSync("git", ["revert", "--abort"], { cwd, encoding: "utf8" }); // best-effort — se já não houver revert em progresso, isso é no-op inofensivo
    const restored = restoreOriginalBranch();
    return { ok: false, error: `git revert falhou (provável conflito, revert abortado automaticamente): ${revert.stderr}${restored}` };
  }

  const push = spawnSync("git", ["push", "-u", "origin", plan.branchName], { cwd, encoding: "utf8" });
  if (push.status !== 0) {
    const restored = restoreOriginalBranch();
    return { ok: false, error: `git push falhou: ${push.stderr}${restored}. A branch local ${plan.branchName} com o commit de revert AINDA EXISTE — apagar com 'git branch -D ${plan.branchName}' antes de tentar de novo pro mesmo SHA.` };
  }

  const pr = spawnSync("gh", ["pr", "create", "--title", plan.prTitle, "--body", plan.prBody], { cwd, encoding: "utf8" });
  if (pr.status !== 0) {
    const restored = restoreOriginalBranch();
    return { ok: false, error: `gh pr create falhou: ${pr.stderr}${restored}. A branch ${plan.branchName} já foi pusheada — abrir a PR manualmente ou rodar 'gh pr create' de novo.` };
  }

  restoreOriginalBranch();
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
