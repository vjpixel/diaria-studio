#!/usr/bin/env npx tsx
/**
 * scripts/check-editorial-signoff.ts (#7978, Camada 5 da #7972)
 *
 * Roda em `.github/workflows/editorial-signoff-required.yml` pra CADA PR.
 * Portão de promoção — REGRA DE OURO da #7972: nenhuma mudança de score,
 * seleção de destaque ou prompt de geração real pode entrar sem sign-off
 * editorial explícito, e NUNCA vindo de sessão automática (overnight,
 * develop, ou uma sessão de `/goal`).
 *
 * Decide em 2 passos:
 * 1. O diff toca algum arquivo da allowlist de calibração
 *    (`scripts/lib/calibration-file-allowlist.ts`)? Pra arquivos `.md` de
 *    agent prompt, só conta se a mudança cair DENTRO de um bloco
 *    `CALIBRATED:*` — não qualquer edição de prosa. Se NADA calibrável foi
 *    tocado → passa direto (`exit 0`), sem chamar a API do GitHub.
 * 2. Se algo calibrável foi tocado: exige a label `editorial-signoff:approved`
 *    na PR — aplicada manualmente pelo editor (nunca por uma sessão
 *    automática; não há caminho de código neste repo que aplique essa
 *    label sozinho, de propósito). Sem a label → `exit 1`, PR fica
 *    bloqueada aguardando o editor.
 *
 * **Este workflow NASCE PENDENTE de virar required check** — #7978 pede
 * explicitamente NÃO alterar a proteção de branch/required-checks do repo
 * autonomamente. Enquanto não for tornado obrigatório manualmente pelo
 * editor (Settings → Branches → master → required status checks →
 * adicionar "editorial-signoff-required"), este check RODA e REPORTA mas
 * não BLOQUEIA merge nenhum sozinho — é só sinal visível na PR.
 *
 * Env vars (passados pelo GH Action, mesmo padrão de check-pr-bugfix.ts):
 *   GH_TOKEN  — auth pra gh CLI (só usado quando a allowlist é tocada)
 *   PR_NUMBER — número do PR
 *   BASE_SHA  — sha do base (master) na hora do PR
 *   HEAD_SHA  — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (nada calibrável tocado, OU calibrável tocado COM sign-off)
 *   1 — falha (calibrável tocado, sign-off ausente)
 *   2 — input inválido / erro de git ou gh CLI irrecuperável
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import type { PrCheckSpawnFn } from "./lib/spawn-types.ts";
import { CALIBRATION_ALLOWLIST, isCalibrationTouchingFile } from "./lib/calibration-file-allowlist.ts";
import { gitDiffTouchedLines, gitShowFileAtSha } from "./lib/diff-touched-lines.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const SIGNOFF_LABEL = "editorial-signoff:approved";

export type SpawnFn = PrCheckSpawnFn;

function getChangedFiles(baseSha: string, headSha: string, spawnFn: SpawnFn): string[] {
  // Mesma convenção de check-pr-bugfix.ts: sem `cwd` explícito — o processo
  // do GH Action já roda na raiz do checkout (`ROOT` é usado só pra
  // gitDiffTouchedLines/gitShowFileAtSha abaixo, que aceitam cwd).
  const r = spawnFn("git", ["diff", "--name-only", `${baseSha}..${headSha}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff --name-only falhou: ${r.stderr}`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Delay real entre tentativas (produção). Em testes, substituído por mock. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mesmo padrão de retry+backoff de check-pr-bugfix.ts::getPrLabels — 401/5xx/timeout transitórios não devem virar "sign-off ausente" por engano. */
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
      console.warn(`[#7978] tentativa ${attempt}/${maxAttempts} de consultar labels falhou (${lastError.trim()}). Aguardando ${delay / 1000}s...`);
      await sleepFn(delay);
    }
  }
  throw new Error(`[#7978] INFRA: não foi possível consultar labels da PR após ${maxAttempts} tentativas. Último erro: ${lastError.trim()}`);
}

export interface CalibrationTouchCheck {
  touchesCalibration: boolean;
  touchedPaths: string[];
}

/** Determina se o diff toca a allowlist de calibração — puro dado um provedor de linhas/conteúdo injetável (testável sem git real). */
export function evaluateCalibrationTouch(
  changedFiles: string[],
  getTouchedLines: (path: string) => Set<number>,
  getNewContent: (path: string) => string | null,
): CalibrationTouchCheck {
  const allowlistPaths = new Set(CALIBRATION_ALLOWLIST.map((e) => e.path));
  const touchedPaths: string[] = [];
  for (const path of changedFiles) {
    if (!allowlistPaths.has(path)) continue;
    const touchedLines = getTouchedLines(path);
    const newContent = getNewContent(path);
    if (isCalibrationTouchingFile(path, touchedLines, newContent)) touchedPaths.push(path);
  }
  return { touchesCalibration: touchedPaths.length > 0, touchedPaths };
}

async function main(): Promise<void> {
  const prNumber = process.env.PR_NUMBER ?? "";
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!prNumber || !baseSha || !headSha) {
    console.error("[#7978] env vars ausentes: PR_NUMBER, BASE_SHA, HEAD_SHA são obrigatórias.");
    process.exit(2);
  }

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles(baseSha, headSha, spawnSync as SpawnFn);
  } catch (err) {
    console.error(`[#7978] INFRA: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  const check = evaluateCalibrationTouch(
    changedFiles,
    (path) => gitDiffTouchedLines(ROOT, baseSha, headSha, path),
    (path) => gitShowFileAtSha(ROOT, headSha, path),
  );

  if (!check.touchesCalibration) {
    console.log("[#7978] Nenhum arquivo/bloco calibrável tocado — passa sem consultar sign-off.");
    process.exit(0);
    return;
  }

  console.log(`[#7978] Diff toca superfície de calibração: ${check.touchedPaths.join(", ")}. Verificando sign-off (label "${SIGNOFF_LABEL}")...`);

  let labels: string[];
  try {
    labels = await getPrLabelsWithRetry(prNumber);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }

  if (labels.includes(SIGNOFF_LABEL)) {
    console.log(`[#7978] Sign-off presente (label "${SIGNOFF_LABEL}") — passa.`);
    process.exit(0);
    return;
  }

  console.error(
    `[#7978] BLOQUEADO — esta PR muda superfície de calibração (${check.touchedPaths.join(", ")}) e não tem sign-off editorial.\n` +
      `Aguardando o editor revisar o relatório de evidência e aplicar a label "${SIGNOFF_LABEL}" — nenhuma sessão automática pode aplicar essa label sozinha (REGRA DE OURO, #7972).`,
  );
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("[#7978] erro inesperado:", err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
