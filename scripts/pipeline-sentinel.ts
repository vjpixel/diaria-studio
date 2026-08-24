#!/usr/bin/env npx tsx
/**
 * pipeline-sentinel.ts (#780, #1330) — CLI wrapper para pipeline-state.ts.
 *
 * Subcomandos (step-level — gate approvals):
 *   write  --edition AAMMDD --step N --outputs "file1,file2"
 *   assert --edition AAMMDD --step N [--outputs "file1,file2"]
 *   exists --edition AAMMDD --step N
 *
 * Subcomandos (sub-step markers — invariantes intra-stage, #1330):
 *   write-marker  --edition AAMMDD --name <kebab-case> [--details '{"k":"v"}']
 *   assert-marker --edition AAMMDD --name <kebab-case>
 *
 * `--dir <path>` (opcional, #2795): sobrepõe o diretório default
 * `data/editions/{edition}` — usado por pipelines com outro layout (ex:
 * `/diaria-mensal` → `--dir data/monthly/{ciclo}`). `--edition` continua
 * obrigatório mesmo com `--dir` (vira label do editionId; auto-update de
 * stage-status é no-op fora do layout da diária). Ver `resolveEditionDir`.
 *
 * Exit codes para `assert`:
 *   0 — sentinel presente + todos os outputs existem (pass)
 *   1 — sentinel ausente (hard fail); com --outputs, só retorna 1 se algum
 *       output também estiver ausente (caso sem --outputs → sempre 1)
 *   2 — sentinel presente mas outputs ausentes (hard fail)
 *   3 — sentinel ausente MAS todos os arquivos em --outputs existem (legacy/migração — warn)
 *
 * Exit codes para `assert-marker`:
 *   0 — marker presente (pass)
 *   1 — marker ausente (hard fail)
 *
 * Exit codes para `write` / `write-marker`:  0 = ok, 1 = erro
 * Exit codes para `exists`: 0 = presente, 1 = ausente
 *
 * `write` (#6009): antes de gravar o sentinel de um stage 1-6 no layout
 * padrão da diária (sem `--dir`, `--edition` AAMMDD), roda as regras de
 * `check-invariants --stage N` (via `checkStageInvariantsForWrite`) e recusa
 * o write (exit 1) se houver violação de `severity: "error"` — gate mecânico,
 * não depende do orchestrator lembrar de rodar o check antes. Passe
 * `--bypass-reason "<motivo>"` pra escrever mesmo assim (logado como warn,
 * sem bloquear) quando a violação for um falso-positivo conhecido.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir as resolveFindEditionDir } from "./lib/find-current-edition.ts";
import { getRulesForStage } from "./lib/invariant-checks/index.ts";
import type { InvariantViolation } from "./lib/invariant-checks/types.ts";
import {
  assertMarker,
  assertSentinel,
  readSentinel,
  resolveSentinelEndMs,
  sentinelExists,
  writeMarker,
  writeSentinel,
} from "./lib/pipeline-state.js";
import {
  applyUpdate,
  blockReasonForMarkingStageDone,
  loadDoc,
  saveDoc,
  STAGES,
} from "./update-stage-status.ts";

/**
 * #1563: when a stage sentinel is written, auto-update stage-status to mark
 * the stage as `done` if it was previously `running`. Orchestrator can forget
 * the explicit `update-stage-status --status done` call; the sentinel write
 * is the authoritative completion signal so we mirror it here.
 *
 * Best-effort: never throws. Returns `true` if stage-status was updated,
 * `false` if no-op (already done, no running row, no stage-status file, or
 * any internal error).
 */
export function autoUpdateStageStatusOnSentinel(
  editionDir: string,
  editionId: string,
  step: number,
  nowMs: number = Date.now(),
): boolean {
  if (!STAGES.includes(step as (typeof STAGES)[number])) return false;
  // Don't touch legacy editions (pre-#1216) that only have stage-status.md —
  // loadDoc fallback to parseStageStatus drops start/end/duration/cost/tokens,
  // and saveDoc would re-render the MD with empty columns.
  const jsonPath = resolve(editionDir, "_internal", "stage-status.json");
  if (!existsSync(jsonPath)) return false;
  try {
    const doc = loadDoc(editionDir, editionId);
    const row = doc.rows.find((r) => r.stage === step);
    // #2374: handle both "running" and "pending" — a stage interrupted before
    // the orchestrator called update-stage-status --status running stays "pending"
    // even though its sentinel is written. On resume, assert detects the sentinel
    // and skips the stage, but the status is never repaired. Treat pending+sentinel
    // the same as running+sentinel: transition to done using the sentinel's
    // completed_at as the end timestamp.
    if (!row || (row.status !== "running" && row.status !== "pending")) return false;
    // Same transition gates as the CLI (#1530 — Stage 4 needs report). If
    // we can't safely mark this stage done, leave it for the editor /
    // explicit update-stage-status call instead of silently flipping.
    if (blockReasonForMarkingStageDone(editionDir, step) !== null) return false;
    const nowIso = new Date(nowMs).toISOString();
    // #2439 Item 3: guard NaN para row.start — `new Date(malformed).getTime()` retorna
    // NaN, que propagaria para duration_ms silenciosamente. Usar o mesmo padrão de
    // resolveSentinelEndMs: checar isNaN, cair para undefined (preserva row.duration_ms
    // existente) com warn para que o problema fique visível nos logs.
    let durationMs: number | undefined;
    if (row.start) {
      const startMs = new Date(row.start).getTime();
      if (Number.isNaN(startMs)) {
        console.warn(
          `[autoUpdateStageStatusOnSentinel step ${step}] row.start malformado="${row.start}" — durationMs não calculado`,
        );
        durationMs = typeof row.duration_ms === "number" ? row.duration_ms : undefined;
      } else {
        durationMs = nowMs - startMs;
      }
    } else {
      durationMs = typeof row.duration_ms === "number" ? row.duration_ms : undefined;
    }
    const updated = applyUpdate(doc, {
      stage: step,
      status: "done",
      end: nowIso,
      duration_ms: durationMs,
    });
    saveDoc(editionDir, updated);
    return true;
  } catch {
    return false;
  }
}

/**
 * Data de corte do mecanismo de sentinel (#1216, commit `8b10346a`,
 * 2026-05-13) — edições CRIADAS a partir desta data sempre tiveram o
 * mecanismo disponível, então nunca deveriam cair no fallback
 * "legacy/migração" de `assert` (exit 3, warn-only). Esse fallback existe
 * só pra edições anteriores ao #1216, que nunca chegaram a ter
 * `.step-N-done.json`; uma edição recente que caia nele é sinal de stage
 * rodado FORA do playbook (dispatch direto de subagentes em vez de
 * `/diaria-N-*`), não de legado — e deveria falhar de verdade em vez de só
 * logar warn (#5678).
 */
export const SENTINEL_MECHANISM_CUTOFF_AAMMDD = "260513";

/** Pure: parseia `AAMMDD` pra `Date` local (meia-noite). `null` se inválido. */
function parseAammdd(s: string): Date | null {
  if (!/^\d{6}$/.test(s)) return null;
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  const year = 2000 + yy;
  const d = new Date(year, mm - 1, dd);
  // Reconfirma componentes — rejeita datas inválidas tipo 260231 (31/fev)
  // que o construtor de Date rola silenciosamente pro mês seguinte.
  if (d.getFullYear() !== year || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}

/**
 * Pure (#5678): `true` quando `editionId` (AAMMDD) é anterior à data de
 * corte do mecanismo de sentinel — só nesse caso o fallback legado de
 * `assert` deve fazer warn em vez de falhar de verdade. `editionId`
 * malformado (não bate o formato AAMMDD) é tratado como NÃO-legado
 * (retorna `false`) — fail-safe: um id que não parseia não deveria herdar
 * silenciosamente o comportamento mais permissivo.
 */
export function isLegacySentinelEdition(
  editionId: string,
  cutoff: string = SENTINEL_MECHANISM_CUTOFF_AAMMDD,
): boolean {
  const editionDate = parseAammdd(editionId);
  const cutoffDate = parseAammdd(cutoff);
  if (!editionDate || !cutoffDate) return false;
  return editionDate.getTime() < cutoffDate.getTime();
}

/**
 * #2795: resolve o diretório alvo do sentinel. Comportamento DEFAULT inalterado
 * (compat com a diária): resolve `data/editions/{edition}`. Quando `--dir` é
 * passado explicitamente, usa esse path (relativo a `cwd`) em vez do layout
 * `data/editions/` — permite reusar a mesma infra de sentinel/checkpoint
 * (`.step-N-done.json`) para outros pipelines com layout de diretório
 * diferente, ex: `/diaria-mensal` (#2795), cujos outputs vivem em
 * `data/monthly/{ciclo}/`, não `data/editions/{AAMMDD}/`.
 *
 * `--edition` continua obrigatório mesmo com `--dir` — vira só o `editionId`
 * usado como label pro auto-update de stage-status (no-op fora do layout da
 * diária: `autoUpdateStageStatusOnSentinel` exige `_internal/stage-status.json`
 * no dir, ausente em outros pipelines — ver guard no topo da função).
 */
export function resolveEditionDir(
  args: { edition?: string; dir?: string },
  cwd: string = process.cwd(),
): string {
  if (args.dir) return resolve(cwd, args.dir);
  // #3024: resolve o path REAL da edição (flat legado OU nested novo, #2463)
  // em vez de montar `data/editions/{edition}` à mão — hardcode flat quebraria
  // pra qualquer edição criada após o cutover de editionDir() pro layout nested.
  const editionsDirAbs = resolve(cwd, "data", "editions");
  return resolveFindEditionDir(editionsDirAbs, args.edition ?? "");
}

/**
 * #6009: gate mecânico pré-`write` — recusa gravar o sentinel de conclusão
 * de um stage (1-6, layout AAMMDD da diária) se `check-invariants --stage N`
 * reportar violação de `severity: "error"`.
 *
 * Fecha a lacuna que permitiu o sentinel do Stage 2 ser gravado como "done"
 * numa execução caótica multi-máquina (edição 260824) com `humanizer-ran`
 * falhando pra newsletter E social — o texto nunca passou pelo humanizador,
 * mas o sentinel foi escrito assim mesmo. Até este fix, `check-invariants
 * --stage 2` só rodava como PROSA no playbook do orchestrator (§2d de
 * `orchestrator-stage-2.md`) — um passo que uma sessão LLM pode pular sob
 * colisão/retry/resume sem nenhum ponto de execução determinístico
 * impedindo o `write` seguinte. Este helper roda as mesmas regras
 * (`getRulesForStage`, o registry que `check-invariants.ts` consulta) direto
 * no processo do `write`, então pular o passo do playbook não basta mais
 * pra produzir um sentinel inválido.
 *
 * Escopo deliberadamente restrito ao layout padrão da diária — pipelines com
 * `--dir` custom (ex: `/diaria-mensal`, `data/monthly/{ciclo}`) e edições com
 * `editionId` fora do formato AAMMDD de 6 dígitos NÃO são cobertos: o
 * registry de invariantes assume a estrutura de arquivos da diária
 * (`02-reviewed.md`, `03-social.md`, ...), que não existe nesses layouts —
 * rodar as mesmas regras ali produziria falso-positivo garantido em vez de
 * sinal útil. Mesmo padrão de restrição já usado no fallback legado do
 * `assert` (ver `editionIsAammdd` mais abaixo).
 *
 * **Anti-deadlock (2 filtros, achado no self-review deste PR):** o `write`
 * roda ANTES do sentinel do próprio stage existir — é literalmente o que
 * está prestes a criá-lo. Rodar o registry completo sem cuidado produziria
 * um deadlock onde o stage nunca conseguiria se auto-declarar concluído:
 *   1. `getRulesForStage(step, { phase: "pre-dispatch" })` exclui regras
 *      `postDispatchOnly` (ex: Stage 5 `stage-usage-captured`, que só pode
 *      passar DEPOIS que este mesmo `write` já rodou e `capture-stage-usage.ts`
 *      já populou `stage-status.json` — checar isso ANTES seria
 *      falso-positivo garantido, mesmo comportamento que motivou o `--phase
 *      pre-dispatch` original do #4516).
 *   2. Filtro explícito de qualquer regra `step-${step}-sentinel-exists` —
 *      cobre o caso do Stage 6 (`checkStep6Sentinel`, que verifica
 *      `.step-6-done.json`), que **não** está marcada `postDispatchOnly`
 *      (só o filtro 1 não bastaria) mas é old-testamente self-referencial:
 *      checar a existência do sentinel que este `write` está prestes a criar
 *      sempre falharia. Regras `step-N-sentinel-exists` para um stage
 *      ANTERIOR (ex: Stage 6 checando `.step-5-done.json`) continuam rodando
 *      normalmente — essas são legítimas (aquele sentinel já deveria existir).
 *
 * Pure o suficiente para teste direto: recebe `editionDir` já resolvido e
 * devolve o resultado sem tocar em stdout/stderr/process.exit — quem chama
 * decide como reportar.
 */
export function checkStageInvariantsForWrite(
  editionDir: string,
  step: number,
): { passed: boolean; errors: InvariantViolation[] } {
  if (!Number.isInteger(step) || step < 0 || step > 6) {
    return { passed: true, errors: [] };
  }
  const selfSentinelRuleId = `step-${step}-sentinel-exists`;
  const rules = getRulesForStage(step as 0 | 1 | 2 | 3 | 4 | 5 | 6, {
    phase: "pre-dispatch",
  }).filter((rule) => rule.id !== selfSentinelRuleId);
  const errors: InvariantViolation[] = [];
  for (const rule of rules) {
    for (const v of rule.run(editionDir)) {
      if (v.severity === "error") errors.push(v);
    }
  }
  return { passed: errors.length === 0, errors };
}

function main(): void {
  const [, , subcmd, ...rest] = process.argv;
  const args = parseCliArgs(rest).values;

  if (!args.edition) {
    console.error("[error] --edition é obrigatório");
    process.exit(1);
  }

  const editionDir = resolveEditionDir(args, process.cwd());

  // Marker subcmds só precisam de --name. Step subcmds precisam de --step.
  const isMarkerCmd = subcmd === "write-marker" || subcmd === "assert-marker";

  if (!isMarkerCmd && !args.step) {
    console.error("[error] --step é obrigatório (use --name para sub-step markers)");
    process.exit(1);
  }

  if (isMarkerCmd && !args.name) {
    console.error("[error] --name é obrigatório para write-marker/assert-marker");
    process.exit(1);
  }

  const step = isMarkerCmd ? -1 : Number(args.step);

  if (!isMarkerCmd && (Number.isNaN(step) || step < 1)) {
    console.error(`[error] --step inválido: ${args.step}`);
    process.exit(1);
  }

  switch (subcmd) {
    case "write": {
      if (!args.outputs) {
        console.error("[error] --outputs é obrigatório para write");
        process.exit(1);
      }
      // #6009: gate mecânico — recusa escrever o sentinel se check-invariants
      // pro mesmo stage reportar violação de severity=error. Restrito ao
      // layout padrão da diária (sem --dir custom, editionId AAMMDD de 6
      // dígitos) — ver docstring de checkStageInvariantsForWrite.
      const editionIsAammdd = /^\d{6}$/.test(args.edition);
      if (!args.dir && editionIsAammdd) {
        const invariantResult = checkStageInvariantsForWrite(editionDir, step);
        if (!invariantResult.passed) {
          if (args["bypass-reason"]) {
            console.warn(
              `[warn] sentinel step ${step} escrito com --bypass-reason apesar de ${invariantResult.errors.length} violação(ões) de invariantes: "${args["bypass-reason"]}"`,
            );
          } else {
            console.error(
              `[error] sentinel step ${step} NÃO escrito — check-invariants --stage ${step} reportou ${invariantResult.errors.length} violação(ões) de severity=error:`,
            );
            for (const v of invariantResult.errors) {
              console.error(`  ❌ [${v.rule}/${v.source_issue}] ${v.message}`);
            }
            console.error(
              `Corrija as violações acima e rode 'write' de novo, ou passe --bypass-reason "<motivo>" se for um falso-positivo conhecido (registrado no stderr acima para auditoria).`,
            );
            process.exit(1);
          }
        }
      }
      const outputs = args.outputs.split(",").map((s) => s.trim()).filter(Boolean);
      try {
        writeSentinel(editionDir, step, outputs);
        console.log(`sentinel step ${step} escrito em ${editionDir}/_internal/.step-${step}-done.json`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[error] falha ao escrever sentinel: ${msg}`);
        process.exit(1);
      }
      // #1563: auto-update stage-status when sentinel is written.
      if (autoUpdateStageStatusOnSentinel(editionDir, args.edition, step)) {
        console.log(`stage-status auto-updated: stage ${step} → done`);
      }
      break;
    }

    case "assert": {
      const result = assertSentinel(editionDir, step);
      if (result.ok) {
        // #2374: resume path — sentinel exists but stage-status may still be
        // "running" or "pending" from the interrupted session. Repair it here
        // so timing is recorded even when the orchestrator skips write.
        // #2401: use sentinel.completed_at as nowMs (not Date.now()) so the
        // recorded `end` reflects when the stage actually completed, not the
        // resume time.
        const sentinel = readSentinel(editionDir, step);
        // #2416: guard NaN via helper compartilhado (resolveSentinelEndMs) —
        // `completed_at` malformado → NaN → new Date(NaN).toISOString() lança
        // RangeError engolido por try/catch → no-op silencioso. O helper cai
        // para Date.now() com warn. Sentinel ausente (não deveria após assert ok)
        // também usa Date.now().
        const nowMs = sentinel
          ? resolveSentinelEndMs(sentinel, `pipeline-sentinel step ${step}`)
          : Date.now();
        if (autoUpdateStageStatusOnSentinel(editionDir, args.edition, step, nowMs)) {
          console.log(`stage-status auto-updated on resume: stage ${step} → done`);
        }
        process.exit(0);
      }
      if (result.reason === "sentinel_missing") {
        if (args.outputs) {
          const files = args.outputs.split(",").map((s) => s.trim()).filter(Boolean);
          const missingFiles = files.filter((f) => !existsSync(resolve(editionDir, f)));
          if (missingFiles.length === 0) {
            // #5678: o fallback legado só vale pra edições anteriores ao
            // mecanismo de sentinel (#1216) — uma edição recente sem
            // sentinel mas com outputs em disco não é "legado", é um stage
            // rodado fora do playbook, e precisa falhar de verdade (não
            // mascarar o buraco em stage-status.json/run-log.jsonl). Escopo
            // restrito ao layout AAMMDD da diária (`args.edition` de 6
            // dígitos) — pipelines com id fora desse formato (ex: mensal,
            // `2604-06`) não têm data de corte conhecida e continuam com o
            // comportamento legado inalterado (fora do escopo do #5678).
            const editionIsAammdd = /^\d{6}$/.test(args.edition);
            if (!editionIsAammdd || isLegacySentinelEdition(args.edition)) {
              console.warn(
                `[warn] sentinel step ${step} ausente mas outputs encontrados em disco (legado) — logar e continuar`,
              );
              process.exit(3);
            }
            console.error(
              `[error] sentinel step ${step} ausente mas outputs encontrados em disco — edição ${args.edition} é posterior à data de corte do mecanismo de sentinel (${SENTINEL_MECHANISM_CUTOFF_AAMMDD}, #1216) e não pode usar o fallback legado. Stage provavelmente rodou fora do playbook (dispatch direto em vez de /diaria-N-*) — rode o stage completo pelo fluxo padrão.`,
            );
            process.exit(1);
          }
          // Some outputs missing — list them for actionable diagnosis
          console.error(
            `[error] sentinel step ${step} ausente e outputs faltando: ${missingFiles.join(", ")}`,
          );
          process.exit(1);
        }
        console.error(`[error] sentinel step ${step} ausente em ${editionDir}`);
        process.exit(1);
      }
      // outputs_missing
      const missing = result.missingOutputs.join(", ");
      console.error(`[error] sentinel step ${step} presente mas outputs ausentes: ${missing}`);
      process.exit(2);
    }

    case "exists": {
      process.exit(sentinelExists(editionDir, step) ? 0 : 1);
    }

    case "write-marker": {
      let details: Record<string, unknown> | undefined;
      if (args.details) {
        try {
          details = JSON.parse(args.details) as Record<string, unknown>;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[error] --details JSON inválido: ${msg}`);
          process.exit(1);
        }
      }
      try {
        writeMarker(editionDir, args.name, details);
        console.log(`marker '${args.name}' escrito em ${editionDir}/_internal/.marker-${args.name}.json`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[error] falha ao escrever marker: ${msg}`);
        process.exit(1);
      }
      break;
    }

    case "assert-marker": {
      const result = assertMarker(editionDir, args.name);
      if (result.ok) {
        process.exit(0);
      }
      console.error(`[error] marker '${args.name}' ausente em ${editionDir}/_internal/`);
      process.exit(1);
    }

    default: {
      console.error(`[error] subcomando desconhecido: ${subcmd}. Use write|assert|exists|write-marker|assert-marker`);
      process.exit(1);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
