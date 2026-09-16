/**
 * stage4-post-edit-checks.ts (#8123 Fatia 3)
 *
 * Script único que substitui a cadeia ad-hoc de checagens síncronas que
 * `.claude/agents/orchestrator-stage-4.md` disparava (1 processo por check)
 * antes de cada gate e a cada volta do loop `ajustar` (§4d.1) — ver
 * `scripts/lib/stage4-post-edit-checks-core.ts` pra lista completa dos 6
 * sub-checks consolidados aqui.
 *
 * Pensado pra rodar em BACKGROUND (`Bash(..., run_in_background: true)`)
 * logo depois de aplicar um ajuste inline — o fast path da Fatia 2 (#8123)
 * já responde "aplicado" ao editor sem esperar por nenhuma checagem; este
 * script roda em paralelo, e só fala alguma coisa se houver achado.
 *
 * Coalescing (#8123 §3, "uma rajada de ajustes gera uma rodada sobre o
 * estado final, não uma por ajuste"): usa `scripts/lib/stage4-check-lock.ts`
 * — antes de disparar uma nova rodada, o orchestrator consulta o lock
 * (`--edition-dir {dir}/_internal/.stage4-post-edit-checks-lock.json`) e só
 * lança se não houver uma já em curso. Ao terminar, o relatório carrega
 * `inputs_hash` — se o orchestrator perceber que o arquivo mudou DE NOVO
 * enquanto esta rodada rodava (hash do estado atual ≠ `inputs_hash` do
 * relatório), relança UMA vez sobre o estado atual, nunca 1x por edição
 * intermediária.
 *
 * Uso:
 *   npx tsx scripts/stage4-post-edit-checks.ts --edition-dir <path> [--out <path>]
 *
 * Exit codes:
 *   0  — nenhum achado GATE-BLOCKING (findings warn-only podem existir)
 *   1  — pelo menos 1 achado GATE-BLOCKING
 *   2  — uso inválido (--edition-dir ausente)
 *
 * Output:
 *   - stdout: 1 linha de resumo BARATO (issue #8123 §3, "notificação de
 *     término precisa ser barata: sem achado = 1 linha, nenhuma ação").
 *     Nunca despeja a lista de findings no stdout — quem quiser o detalhe
 *     lê o relatório completo (`--out`, default
 *     `{edition-dir}/_internal/stage4-post-edit-checks.json`).
 *   - arquivo `--out`: `Stage4PostEditChecksReport` completo (JSON).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStage4PostEditChecks } from "./lib/stage4-post-edit-checks-core.ts";
import { claimGeneration, releaseGeneration } from "./lib/stage4-check-lock.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  loadProjectEnv(process.env.DIARIA_PROJECT_ROOT);
  const argv = process.argv.slice(2);
  const editionDirArg = getArg(argv, "edition-dir");
  if (!editionDirArg) {
    console.error("Uso: stage4-post-edit-checks.ts --edition-dir <path> [--out <path>]");
    process.exit(2);
  }

  const editionDir = resolve(editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`edition-dir não existe: ${editionDir}`);
    process.exit(2);
  }

  const outPath = getArg(argv, "out") || resolve(editionDir, "_internal", "stage4-post-edit-checks.json");
  const lockPath = resolve(editionDir, "_internal", ".stage4-post-edit-checks-lock.json");

  const myGeneration = claimGeneration(lockPath);
  let report;
  try {
    report = runStage4PostEditChecks(editionDir, ROOT);
  } finally {
    releaseGeneration(lockPath, myGeneration);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  // Notificação barata (#8123 §3): 1 linha, sem despejar findings no stdout.
  if (report.findings_count === 0) {
    console.log(`✅ stage4-post-edit-checks: 0 achados (${report.duration_ms}ms) — ${outPath}`);
  } else {
    const blocking = report.findings.filter((f) => f.gate_blocking).length;
    const warn = report.findings_count - blocking;
    console.log(
      `⚠️ stage4-post-edit-checks: ${report.findings_count} achado(s) (${blocking} gate-blocking, ${warn} warn-only, ${report.duration_ms}ms) — ver ${outPath}`,
    );
  }

  process.exit(report.gate_blocking ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(2);
  });
}
