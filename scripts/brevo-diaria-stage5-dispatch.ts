#!/usr/bin/env node
/**
 * scripts/brevo-diaria-stage5-dispatch.ts (#5772)
 *
 * Dispatch do canal Brevo diária (segmento Pending da Beehiiv — reativação)
 * DENTRO da Etapa 5 (`orchestrator-stage-5.md`), em paralelo com os demais
 * publicadores (Beehiiv, LinkedIn, Facebook, Instagram, Threads). Reusa a
 * maquinaria existente, sem reimplementar nada:
 *
 *   - Passos 1-4 de `/diaria-brevo-diaria` (contatos + rampa): spawna
 *     `scripts/brevo-diaria-run.ts --apply --max-add N` (#5192). `N` é
 *     derivado deterministicamente (`resolveStage5MaxAdd`,
 *     `scripts/lib/brevo-diaria-max-add.ts`) em vez de perguntado — decisão
 *     do editor, comentário 2026-08-20 da issue #5772 ("Perguntar é
 *     exceção", CLAUDE.md #5321).
 *   - Passos 5-7 de `/diaria-brevo-diaria` (campanha, SEM o Passo 8 —
 *     agendamento fica pra Etapa 6, mesma divisão 5/6 já usada pelo
 *     Beehiiv): spawna `scripts/publish-daily-brevo.ts <edition-dir>
 *     --i-reviewed-the-copy`, que cria (ou reaproveita, #5677) a campanha
 *     como RASCUNHO. `--i-reviewed-the-copy` é assumido aqui — Stage 5 é
 *     dispatch sem gate (o editor já aprovou o conteúdo da edição no gate
 *     do Stage 4; o bloco de intro do segmento Pending é copy fixa,
 *     reaproveitada edição a edição, não nova a cada disparo).
 *
 * Idempotência em resume (#5772): ANTES de rodar qualquer passo, checa se
 * `<edition-dir>/_internal/brevo-diaria-published.json` já tem um
 * `campaign_id` registrado — se sim, uma invocação anterior desta mesma
 * edição (resume da Etapa 5) já criou a campanha, e o dispatch inteiro vira
 * no-op (`status: "already_done"`). Isso evita não só uma 2ª campanha
 * duplicada (`publish-daily-brevo.ts` já reaproveita via #5677de qualquer
 * forma) como também reprocessar o pool/rampa de contatos sem necessidade
 * numa 2ª invocação.
 *
 * Fail-soft (#5772): qualquer falha (config ausente, store ausente, algum
 * sub-script falhou) retorna `status: "skipped"`/`"failed"` com `reason` —
 * NUNCA lança. O caller (orchestrator Stage 5) trata isso como mais um
 * canal no dispatch paralelo: loga warning e segue — não deve derrubar
 * newsletter/LinkedIn/Facebook/Instagram/Threads.
 *
 * Uso:
 *   npx tsx scripts/brevo-diaria-stage5-dispatch.ts --edition-dir <dir>
 *
 * Exit codes: 0 = "ok" ou "already_done" ou "skipped" (fail-soft, nunca é
 * erro do orchestrator); 1 = "failed" (sub-script falhou) — ainda assim
 * fail-soft do ponto de vista do Stage 5 (o orchestrator lê o JSON de
 * stdout e decide, nunca aborta o stage inteiro por causa deste exit code).
 *
 * @see scripts/lib/brevo-diaria-max-add.ts (fórmula de `--max-add`)
 * @see scripts/brevo-diaria-run.ts (Passos 1-4)
 * @see scripts/publish-daily-brevo.ts (Passos 5-7, sem 8)
 * @see .claude/agents/orchestrator-stage-5.md (dispatch paralelo)
 * @see .claude/agents/orchestrator-stage-6.md (Passo 8 — agendamento)
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveStage5MaxAdd } from "./lib/brevo-diaria-max-add.ts";
import { readStore, DEFAULT_STORE_PATH, type BrevoDiariaContact } from "./lib/brevo-diaria-store.ts";
import { computeCurrentActiveCount } from "./sync-pending-to-brevo.ts";
import { readBrevoDiariaPublished } from "./publish-daily-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn de sub-script — injetável pra teste (mesmo padrão de brevo-diaria-run.ts).
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => ExecResult;

/** Default de produção — `process.execPath` absoluto, nunca `npx`/PATH-resolved (guard #4343). */
export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
    });
    if (result.error || result.status === null) {
      return {
        code: 1,
        stdout: result.stdout ?? "",
        stderr:
          (result.stderr ?? "") +
          `\nERRO: o passo não executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

// ---------------------------------------------------------------------------
// Deps injetáveis
// ---------------------------------------------------------------------------

export interface Stage5BrevoDeps {
  rootDir: string;
  exec: ExecFn;
  storeExists: () => boolean;
  readContacts: () => readonly BrevoDiariaContact[];
  readPlatformConfig: () => { brevo_diaria?: { stage5_target_total?: number | null } };
  /** Mesmo shape de `readBrevoDiariaPublished` (publish-daily-brevo.ts) — retorna `null` se ausente/ilegível. */
  readPublished: (editionDir: string) => { campaign_id: number } | null;
}

export function productionDeps(rootDir: string = ROOT): Stage5BrevoDeps {
  return {
    rootDir,
    exec: realExec(rootDir),
    storeExists: () => existsSync(DEFAULT_STORE_PATH),
    readContacts: () => readStore(DEFAULT_STORE_PATH).contacts,
    readPlatformConfig: () =>
      JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as {
        brevo_diaria?: { stage5_target_total?: number | null };
      },
    readPublished: (editionDir) => readBrevoDiariaPublished(editionDir),
  };
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export type Stage5BrevoResult =
  | { status: "already_done"; campaignId: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; reason: string }
  | { status: "ok"; campaignId: number; totalAtual: number; targetTotal: number; maxAdd: number };

function tailReason(execResult: ExecResult): string {
  const tail = execResult.stderr.trim().split("\n").slice(-4).join(" | ");
  return tail || `exit ${execResult.code}`;
}

// ---------------------------------------------------------------------------
// Orquestração principal — pura o suficiente pra ser testada com `deps`
// injetado, sem spawn real nem I/O real.
// ---------------------------------------------------------------------------

export function runStage5BrevoDispatch(editionDir: string, deps: Stage5BrevoDeps): Stage5BrevoResult {
  // Idempotência (#5772): resume nunca re-roda a sequência inteira se a
  // campanha desta edição já foi criada por uma invocação anterior.
  const existing = deps.readPublished(editionDir);
  if (existing && typeof existing.campaign_id === "number") {
    return { status: "already_done", campaignId: existing.campaign_id };
  }

  const platformConfig = deps.readPlatformConfig();
  const brevoDiaria = platformConfig.brevo_diaria;
  if (!brevoDiaria) {
    return { status: "skipped", reason: "brevo_diaria não configurado em platform.config.json." };
  }

  const storeExists = deps.storeExists();
  const currentActiveCount = storeExists ? computeCurrentActiveCount(deps.readContacts() as BrevoDiariaContact[]) : 0;
  const resolved = resolveStage5MaxAdd({
    storeExists,
    currentActiveCount,
    targetTotal: brevoDiaria.stage5_target_total,
  });
  if (!resolved.ok) {
    return { status: "skipped", reason: resolved.reason };
  }

  process.stderr.write(
    `[brevo-diaria stage5] total_atual=${resolved.totalAtual} target=${resolved.targetTotal} ` +
      `max-add=${resolved.maxAdd} (premissa registrada automaticamente, #5321/#5772)\n`,
  );

  const applyResult = deps.exec("scripts/brevo-diaria-run.ts", ["--apply", "--max-add", String(resolved.maxAdd)]);
  if (applyResult.code !== 0) {
    return { status: "failed", step: "brevo-diaria-run --apply", reason: tailReason(applyResult) };
  }

  const publishResult = deps.exec("scripts/publish-daily-brevo.ts", [editionDir, "--i-reviewed-the-copy"]);
  if (publishResult.code !== 0) {
    return { status: "failed", step: "publish-daily-brevo", reason: tailReason(publishResult) };
  }

  const published = deps.readPublished(editionDir);
  if (!published || typeof published.campaign_id !== "number") {
    return {
      status: "failed",
      step: "publish-daily-brevo",
      reason: "campanha aparentemente criada, mas brevo-diaria-published.json não confirma campaign_id.",
    };
  }

  return {
    status: "ok",
    campaignId: published.campaign_id,
    totalAtual: resolved.totalAtual,
    targetTotal: resolved.targetTotal,
    maxAdd: resolved.maxAdd,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const editionDirArg = getStringArg(argv, "edition-dir");
  if (!editionDirArg) {
    process.stderr.write("uso: npx tsx scripts/brevo-diaria-stage5-dispatch.ts --edition-dir <dir>\n");
    process.exit(2);
  }
  const editionDir = resolve(editionDirArg);
  const deps = productionDeps(ROOT);
  const result = runStage5BrevoDispatch(editionDir, deps);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "failed" ? 1 : 0;
}
