#!/usr/bin/env npx tsx
/**
 * scripts/check-agent-eval-required.ts (#8144)
 *
 * Roda em `.github/workflows/agent-eval-required.yml` pra CADA PR. Metade
 * "barata, roda no Actions" do gatilho de eval de regressão de prompt
 * descrito na issue #8144 — a outra metade (`scripts/run-agent-eval-for-pr.ts`)
 * roda de dentro da esteira overnight/develop, que TEM sessão claude.ai
 * autenticada (#5608) pra de fato disparar o agent via
 * `scripts/eval-prompt-regression.ts` (#8143). Este script NUNCA chama
 * `claude`/gasta token — só decide "esta PR precisa do resultado do eval
 * antes de mergear?" e, se sim, exige que ele já tenha sido registrado
 * (label `agent-eval:passed`).
 *
 * Mesma forma de `scripts/check-editorial-signoff.ts` (#7978) — o modelo
 * comprovado deste repo pra "portão que nasce PENDENTE, nunca bloqueante
 * por conta própria":
 * 1. O diff toca corpo ou `model:` de algum agent MAPEADO
 *    (`scripts/lib/agent-eval-trigger-allowlist.ts::classifyAgentEvalEligibility`
 *    + `evaluateAgentEvalTrigger`)? Se NADA elegível foi tocado → passa
 *    direto (`exit 0`), sem chamar a API do GitHub (mesma otimização do
 *    #7978).
 * 2. Se algo elegível foi tocado: exige a label `agent-eval:passed` na PR —
 *    aplicada pela esteira overnight/develop DEPOIS de rodar
 *    `run-agent-eval-for-pr.ts` com sucesso (não por uma sessão qualquer
 *    "aprovando" manualmente; a label representa "o eval rodou e está
 *    registrado", nunca "o eval passou 100%" — é WARNING-ONLY por desenho,
 *    ver corpo da issue #8144, "Fora de escopo").
 *
 * **Este workflow NASCE PENDENTE de virar required check** — mesma regra
 * do #7978: NÃO alterar branch protection/required-status-checks
 * autonomamente. Enquanto o editor não tornar este check obrigatório
 * manualmente (Settings → Branches → master → Require status checks to
 * pass → adicionar "Check agent-eval gate"), este workflow RODA e REPORTA
 * mas não BLOQUEIA merge nenhum sozinho — é só sinal visível na PR
 * (vermelho/verde), consistente com o escopo "warning-only" pedido pela
 * issue #8144.
 *
 * Agent não-mapeado tocado (`classifyAgentEvalEligibility` devolve
 * `"excluded"` ou `"unclassified"`) NUNCA exige a label — só os 2 agents em
 * `PROMPT_EVAL_AGENTS` (`scripts/lib/prompt-regression-eval.ts`, #8143)
 * disparam. Um agent `"unclassified"` (arquivo novo, ainda sem entrada em
 * `AGENT_EVAL_EXCLUDED_AGENTS`) é reportado em log como aviso — a garantia
 * "nunca por silêncio" pedida pela issue #8144 é aplicada pelo TESTE
 * (`test/agent-eval-trigger-allowlist.test.ts`, que varre `.claude/agents/*.md`
 * de verdade), não por este gate de PR, que não tem como saber se um agent
 * novo é candidato legítimo a harness futuro ou definitivamente fora de
 * escopo — essa é uma decisão de autoria, não de CI.
 *
 * Env vars (mesmo padrão de check-editorial-signoff.ts/check-pr-bugfix.ts):
 *   GH_TOKEN  — auth pra gh CLI (só usado quando algo elegível foi tocado)
 *   PR_NUMBER — número do PR
 *   BASE_SHA  — sha do base (master) na hora do PR
 *   HEAD_SHA  — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (nada elegível tocado, OU elegível tocado COM a label)
 *   1 — falha (elegível tocado, label ausente)
 *   2 — input inválido / erro de git ou gh CLI irrecuperável
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import type { PrCheckSpawnFn } from "./lib/spawn-types.ts";
import { classifyAgentEvalEligibility, evaluateAgentEvalTrigger, AGENT_FILE_RE, type PromptEvalAgent } from "./lib/agent-eval-trigger-allowlist.ts";
import { gitShowFileAtSha } from "./lib/diff-touched-lines.ts";

export const AGENT_EVAL_LABEL = "agent-eval:passed";

export type SpawnFn = PrCheckSpawnFn;

function getChangedFiles(baseSha: string, headSha: string, spawnFn: SpawnFn): string[] {
  const r = spawnFn("git", ["diff", "--name-only", `${baseSha}..${headSha}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff --name-only falhou: ${r.stderr}`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Delay real entre tentativas (produção). Em testes, substituído por mock. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mesmo padrão de retry+backoff de check-editorial-signoff.ts::getPrLabelsWithRetry — 401/5xx/timeout transitórios não devem virar "label ausente" por engano. Cada check-*.ts deste repo mantém sua PRÓPRIA cópia (mesma convenção de check-pr-bugfix.ts vs check-editorial-signoff.ts) em vez de compartilhar um helper — extrair um shared agora seria um refactor não pedido por esta issue. */
export async function getPrLabelsWithRetry(
  prNumber: string,
  spawnFn: SpawnFn = spawnSync as SpawnFn,
  sleepFn: (ms: number) => Promise<void> = sleepMs,
  maxAttempts = 3,
): Promise<string[]> {
  const backoffMs = [10_000, 20_000];
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = spawnFn("gh", ["pr", "view", prNumber, "--json", "labels", "--jq", ".labels[].name"], { encoding: "utf8" });
    if (r.status === 0) {
      return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    lastError = r.stderr || (r.status === null ? "processo morto por sinal" : `exit ${r.status}`);
    if (attempt < maxAttempts) {
      const delay = backoffMs[attempt - 1] ?? 30_000;
      console.warn(`[#8144] tentativa ${attempt}/${maxAttempts} de consultar labels falhou (${lastError.trim()}). Aguardando ${delay / 1000}s...`);
      await sleepFn(delay);
    }
  }
  throw new Error(`[#8144] INFRA: não foi possível consultar labels da PR após ${maxAttempts} tentativas. Último erro: ${lastError.trim()}`);
}

export interface AgentEvalTouchCheck {
  /** Agents MAPEADOS cuja mudança de corpo/model dispara o eval — vazio se nada elegível foi tocado. */
  triggeringAgents: PromptEvalAgent[];
  /** Linhas informativas (agent tocado mas não elegível, ou elegível mas sem trigger) — só log, nunca afeta o veredito. */
  infoLines: string[];
}

/**
 * Determina se o diff toca corpo/model de algum agent mapeado — puro dado
 * provedores de conteúdo ANTIGO/NOVO injetáveis (testável sem git real).
 * `getOldContent`/`getNewContent` recebem o PATH do arquivo (`.claude/agents/{agent}.md`)
 * e devolvem `string | null` (`null` = arquivo ausente naquele ref).
 */
export function evaluateAgentEvalTouch(
  changedFiles: string[],
  getOldContent: (path: string) => string | null,
  getNewContent: (path: string) => string | null,
): AgentEvalTouchCheck {
  const triggeringAgents: PromptEvalAgent[] = [];
  const infoLines: string[] = [];

  for (const path of changedFiles) {
    const m = AGENT_FILE_RE.exec(path);
    if (!m) continue;
    const agentName = m[1];
    const eligibility = classifyAgentEvalEligibility(agentName);

    if (eligibility.status === "excluded") {
      infoLines.push(`${path}: agent excluído do gatilho (${eligibility.reason})`);
      continue;
    }
    if (eligibility.status === "unclassified") {
      infoLines.push(`${path}: AVISO — agent não classificado nem em PROMPT_EVAL_AGENTS nem em AGENT_EVAL_EXCLUDED_AGENTS (scripts/lib/agent-eval-trigger-allowlist.ts). Não exige a label aqui — test/agent-eval-trigger-allowlist.test.ts é quem deveria pegar isso antes do merge.`);
      continue;
    }

    // eligibility.status === "mapped"
    const oldContent = getOldContent(path);
    const newContent = getNewContent(path);
    const verdict = evaluateAgentEvalTrigger(eligibility.agent, oldContent, newContent);
    if (verdict.triggers) {
      triggeringAgents.push(eligibility.agent);
      infoLines.push(`${path}: DISPARA eval (${verdict.reason})`);
    } else {
      infoLines.push(`${path}: mapeado mas não dispara (${verdict.reason})`);
    }
  }

  return { triggeringAgents, infoLines };
}

async function main(): Promise<void> {
  const prNumber = process.env.PR_NUMBER ?? "";
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!prNumber || !baseSha || !headSha) {
    console.error("[#8144] env vars ausentes: PR_NUMBER, BASE_SHA, HEAD_SHA são obrigatórias.");
    process.exit(2);
  }

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles(baseSha, headSha, spawnSync as SpawnFn);
  } catch (err) {
    console.error(`[#8144] INFRA: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  const check = evaluateAgentEvalTouch(
    changedFiles,
    (path) => gitShowFileAtSha(process.cwd(), baseSha, path),
    (path) => gitShowFileAtSha(process.cwd(), headSha, path),
  );

  for (const line of check.infoLines) console.log(`[#8144] ${line}`);

  if (check.triggeringAgents.length === 0) {
    console.log("[#8144] Nenhum agent elegível (corpo ou model:) tocado — passa sem consultar a label.");
    process.exit(0);
    return;
  }

  console.log(`[#8144] Diff dispara eval de regressão de prompt pra: ${check.triggeringAgents.join(", ")}. Verificando label "${AGENT_EVAL_LABEL}"...`);

  let labels: string[];
  try {
    labels = await getPrLabelsWithRetry(prNumber);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }

  if (labels.includes(AGENT_EVAL_LABEL)) {
    console.log(`[#8144] Label presente ("${AGENT_EVAL_LABEL}") — passa.`);
    process.exit(0);
    return;
  }

  console.error(
    `[#8144] PENDENTE — esta PR muda corpo/model de agent(s) com harness de replay (${check.triggeringAgents.join(", ")}) e ainda não tem o resultado do eval registrado.\n` +
      `Rode "npx tsx scripts/run-agent-eval-for-pr.ts --pr ${prNumber} --live" numa sessão overnight/develop (autenticada claude.ai, #5608) — ela aplica a label "${AGENT_EVAL_LABEL}" ao registrar o resultado.\n` +
      `Warning-only por desenho (#8144): este check não bloqueia merge sozinho até o editor tornar o workflow obrigatório (Settings → Branches).`,
  );
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[#8144] erro inesperado:", err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
