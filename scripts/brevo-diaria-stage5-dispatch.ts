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
 * Background (#14037): o orchestrator lança este script com
 * `run_in_background` logo depois do §5c-pre e junta o resultado com
 * `scripts/brevo-diaria-stage5-join.ts` antes do sentinel do §5h. Para isso o
 * CLI grava `running` e depois `done` (com o mesmo JSON do stdout) em
 * `<edition-dir>/_internal/05-brevo-stage5-dispatch.json`
 * (`scripts/lib/brevo-stage5-background.ts`).
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
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveStage5MaxAdd } from "./lib/brevo-diaria-max-add.ts";
import { readStore, DEFAULT_STORE_PATH, type BrevoDiariaContact } from "./lib/brevo-diaria-store.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts"; // #9427
import { computeCurrentActiveCount } from "./sync-pending-to-brevo.ts";
import { readBrevoDiariaPublished } from "./publish-daily-brevo.ts";
import { checkSemanalCapacity, countKitSemAberturaInBrevo, decideBrevoSemanalSend, parseBrevoDiariaSemanal } from "./lib/brevo-diaria-semanal.ts"; // #11226
import { ORIGIN_PREFIX } from "./lib/shared/brevo-diaria-origin.ts"; // #11226
import { currentHost, writeBrevoStage5Record, type BrevoStage5Record } from "./lib/brevo-stage5-background.ts"; // #14037

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
  readPlatformConfig: () => { brevo_diaria?: { stage5_target_total?: number | null; semanal?: unknown } };
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
        brevo_diaria?: { stage5_target_total?: number | null; semanal?: unknown };
      },
    readPublished: (editionDir) => readBrevoDiariaPublished(editionDir),
  };
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export type Stage5BrevoResult =
  | { status: "already_done"; campaignId: number }
  | { status: "skipped"; reason: string; warnings?: string[] }
  | { status: "failed"; step: string; reason: string }
  | {
      status: "ok";
      campaignId: number;
      totalAtual: number;
      targetTotal: number;
      /** #6793 (30/08/2026): deixou de ser aplicado como cap — desde o item 7
       * da issue, `--max-add` não é mais passado a `brevo-diaria-run.ts`.
       * Campo mantido só como valor INFORMATIVO (o que a fórmula antiga teria
       * pedido), não como intenção real. */
      maxAdd: number;
      /** #5839 — recontagem real pós-`--apply` (`computeCurrentActiveCount` sobre
       * `deps.readContacts()` relido). Desde #6793, reflete só quantos
       * candidatos elegíveis existiam nesta rodada (sem cap pra comparar
       * contra). */
      addedActual: number;
      /** #8192 — avisos dos passos fail-soft de `brevo-diaria-run.ts` (pool
       * Kit inactive). Vazio = nada a relatar. Não-vazio com `status: "ok"`:
       * a campanha saiu, mas o pool Kit falhou nesta rodada — o orchestrator
       * loga `warn` (orchestrator-stage-5.md, passo 5). */
      warnings: string[];
    };

/**
 * Pura (#8192) — extrai `warnings` do JSON que `brevo-diaria-run.ts` imprime
 * na última linha do stdout. JSON ausente/malformado vira um aviso próprio,
 * nunca lista vazia silenciosa.
 */
export function extractRunWarnings(stdout: string): string[] {
  const lastLine = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(lastLine) as { warnings?: unknown };
    if (!Array.isArray(parsed.warnings)) return ["brevo-diaria-run: JSON sem campo warnings — avisos do pool Kit não verificáveis."];
    return parsed.warnings.filter((w): w is string => typeof w === "string");
  } catch {
    return ["brevo-diaria-run: stdout sem JSON parseável — avisos do pool Kit não verificáveis."];
  }
}

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
  // #11226 — config do regime semanal inválida é FALHA (antes de qualquer
  // passo), nunca "skipped": skip esconderia que a edição não saiu pela Brevo
  // por um erro de config.
  const semanal = parseBrevoDiariaSemanal(brevoDiaria.semanal);
  if ("error" in semanal) {
    return { status: "failed", step: "config", reason: semanal.error };
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

  // #6793 "Faixa A" (30/08/2026, decisão do editor, item 7): freio de VOLUME
  // por meta diária removido — `--max-add` deixou de ser passado a
  // `brevo-diaria-run.ts`, então o backfill preenche TODOS os slots livres
  // (também ilimitados desde o item 6, `sync-pending-to-brevo.ts`) em vez de
  // parar num alvo fixo diário. `resolveStage5MaxAdd`/`resolved.maxAdd`
  // continuam computados abaixo só pra log/observabilidade e pra preservar o
  // skip-on-missing-store (`storeExists`) — não gate mais nada no `exec`.
  process.stderr.write(
    `[brevo-diaria stage5] total_atual=${resolved.totalAtual} target-informativo=${resolved.targetTotal} ` +
      `(sem teto aplicado, #6793 — max-add não é mais passado)\n`,
  );

  const applyResult = deps.exec("scripts/brevo-diaria-run.ts", ["--apply"]);
  if (applyResult.code !== 0) {
    return { status: "failed", step: "brevo-diaria-run --apply", reason: tailReason(applyResult) };
  }
  const warnings = extractRunWarnings(applyResult.stdout);

  // Recontagem REAL pós-`--apply` (#5839) — sem cap (#6793), `addedActual`
  // reflete só quantos candidatos elegíveis existiam nesta rodada, não mais
  // uma comparação contra um pedido de N.
  const activeCountAfterApply = deps.storeExists()
    ? computeCurrentActiveCount(deps.readContacts() as BrevoDiariaContact[])
    : resolved.totalAtual;
  const addedActual = Math.max(0, activeCountAfterApply - resolved.totalAtual);

  // #11226 — regime semanal: contatos/rampa rodam todo dia (o clique na Brevo
  // vira ida pro Kit na rodada seguinte), mas a CAMPANHA só sai na segunda.
  const contactsNow = deps.storeExists() ? deps.readContacts() : [];
  const kitSemAberturaInBrevo = countKitSemAberturaInBrevo(contactsNow, ORIGIN_PREFIX.KIT_SEM_ABERTURA);
  const semanalDecision = decideBrevoSemanalSend({ semanal, editionAammdd: basename(editionDir), kitSemAberturaInBrevo });
  if (!semanalDecision.send) {
    return { status: "skipped", reason: semanalDecision.reason, warnings };
  }
  if (semanalDecision.mode === "diaria" && semanalDecision.warning) warnings.push(semanalDecision.warning);
  if (semanalDecision.mode === "semanal" && semanal.enabled) {
    // #11286 — com `terca_list_id`, a divisão segunda/terça é feita pelo publish; sem ele, avisa.
    const capacity = checkSemanalCapacity(activeCountAfterApply, semanal.splitThreshold, semanal.tercaListId);
    if (capacity.warning) warnings.push(capacity.warning);
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
    addedActual,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Registro do background (#14037)
// ---------------------------------------------------------------------------

export interface RecordIo {
  write: (record: BrevoStage5Record) => void;
  warn: (msg: string) => void;
  now: () => string;
  pid: number;
  host: string;
}

/**
 * #14037 — roda o dispatch gravando `running` antes e `done` depois em
 * `_internal/05-brevo-stage5-dispatch.json`, para o orchestrator lançar este
 * script com `run_in_background` e juntar o resultado com
 * `brevo-diaria-stage5-join.ts` antes do sentinel do §5h. O `result` gravado é
 * o MESMO objeto impresso no stdout. Exceção do dispatch vira `failed`
 * (step `crash`) no registro e no stdout, nunca some. Falha ao GRAVAR o
 * registro só avisa no stderr: o resultado do canal sai no stdout igual.
 */
export function runStage5BrevoDispatchWithRecord(
  run: () => Stage5BrevoResult,
  io: RecordIo,
): { result: Stage5BrevoResult; exitCode: number } {
  const startedAt = io.now();
  const base = { pid: io.pid, host: io.host, started_at: startedAt };
  const safeWrite = (record: BrevoStage5Record) => {
    try {
      io.write(record);
    } catch (e) {
      io.warn(
        `[brevo-diaria stage5] AVISO (#14037): registro ${record.state} não gravado (${(e as Error).message}) — ` +
          `o join vai acusar o processo como morto/não lançado; o resultado real está no stdout deste comando.`,
      );
    }
  };
  safeWrite({ ...base, state: "running" });
  let result: Stage5BrevoResult;
  try {
    result = run();
  } catch (e) {
    result = { status: "failed", step: "crash", reason: (e as Error).message ?? String(e) };
  }
  const exitCode = result.status === "failed" ? 1 : 0;
  safeWrite({
    ...base,
    state: "done",
    finished_at: io.now(),
    exit_code: exitCode,
    result: result as unknown as { status: string; [k: string]: unknown },
  });
  return { result, exitCode };
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
  // #9427: resolve contra a raiz do repo (antes era `process.cwd()`). Argumento
  // inválido vira JSON `failed` (contrato do orchestrator), sem rodar passo algum
  // e sem registro (#14037: não há pasta de edição onde gravar; o join acusa
  // `not_launched`).
  const resolvedArg = tryResolveEditionDirArg(editionDirArg, { root: ROOT });
  if (!resolvedArg.ok) {
    console.log(JSON.stringify({ status: "failed", step: "args", reason: resolvedArg.error } satisfies Stage5BrevoResult));
    process.exitCode = 1;
  } else {
    const editionDir = resolvedArg.editionDir;
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(
      () => runStage5BrevoDispatch(editionDir, productionDeps(ROOT)),
      {
        write: (record) => writeBrevoStage5Record(editionDir, record),
        warn: (msg) => process.stderr.write(msg + "\n"),
        now: () => new Date().toISOString(),
        pid: process.pid,
        host: currentHost(),
      },
    );
    console.log(JSON.stringify(result));
    process.exitCode = exitCode;
  }
}
