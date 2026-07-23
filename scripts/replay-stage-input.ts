#!/usr/bin/env npx tsx
/**
 * replay-stage-input.ts (#3833, item 2 do #3748 — issue-mãe #3379)
 *
 * Prepara um FIXTURE de input congelado para comparação A/B de mecanismo
 * dentro de um mesmo stage da pipeline diária (#3442 paralelismo Stage 1,
 * #3443 writer-destaque ×3, #3444 scorer-chunk). Problema que resolve: sem
 * input congelado, variante A e variante B rodariam sobre edições de dias
 * diferentes — nº/tamanho de artigos variam dia a dia, então a diferença de
 * custo medida mistura "efeito do mecanismo" com "efeito do conteúdo do
 * dia" (#3833).
 *
 * O script copia os `_internal/*.json` (+ companions) relevantes de uma
 * EDIÇÃO DE REFERÊNCIA já publicada para uma edição de TESTE isolada, sob
 * `data/editions/replay-{label}/`. O prefixo `replay-` é estrutural (sempre
 * prepended, mesmo sem `--label`) — nunca bate nos regexes AAMMDD (`^\d{6}$`)
 * / AAMM (`^\d{4}$`) que `find-current-edition.ts` usa pra enumerar edições
 * reais, então o diretório de teste NUNCA aparece como edição "em curso" e
 * NUNCA contamina `data/past-editions.md`/dedup real (ver
 * `test/replay-stage-input.test.ts`, que testa isso contra o módulo real).
 *
 * **NÃO dispara agentes de verdade** — isso é trabalho de quem for medir em
 * #3442/#3443/#3444. Este script só prepara o fixture; o coordenador dispara
 * os agentes/scripts manualmente (2×, variante A e variante B) apontando
 * pro diretório de teste.
 *
 * ## Como um coordenador roda uma comparação A/B (exemplo: #3444 scorer-chunk
 * ## K-way vs. scorer single-call, sobre o MESMO pool de artigos)
 *
 *   # 1. Congela o input do scorer a partir de uma edição de referência real
 *   #    já publicada (qualquer AAMMDD com tmp-dates-reviewed.json em disco):
 *   npx tsx scripts/replay-stage-input.ts \
 *     --reference-edition 260715 --stage 1-scorer --label scorer-ab-a
 *   → cria data/editions/replay-scorer-ab-a/_internal/tmp-dates-reviewed.json
 *
 *   # 2. Rodar a VARIANTE A (scorer-chunk, mecanismo atual — split +
 *   #    N scorer-chunk em paralelo + merge) manualmente sobre o fixture,
 *   #    usando data/editions/replay-scorer-ab-a como {EDITION_DIR} (mesmos
 *   #    comandos do passo "1q" de orchestrator-stage-1-research.md). Ao
 *   #    final, gravar o custo capturado dos dispatches:
 *   npx tsx scripts/record-agent-costs.ts \
 *     --edition-dir data/editions/replay-scorer-ab-a \
 *     --edition replay-scorer-ab-a --stage 1 --costs <tmp-costs-A.json>
 *
 *   # 3. Repetir com um SEGUNDO fixture (mesma edição de referência) pra
 *   #    variante B (scorer single-call, "1q-fallback", sobre o MESMO
 *   #    tmp-dates-reviewed.json):
 *   npx tsx scripts/replay-stage-input.ts \
 *     --reference-edition 260715 --stage 1-scorer --label scorer-ab-b
 *   npx tsx scripts/record-agent-costs.ts \
 *     --edition-dir data/editions/replay-scorer-ab-b \
 *     --edition replay-scorer-ab-b --stage 1 --costs <tmp-costs-B.json>
 *
 *   # 4. Diff: cada rodada gravou seu próprio cost.json (mesmo schema de
 *   #    scripts/lib/edition-cost.ts) em replay-scorer-ab-a/_internal/cost.json
 *   #    e replay-scorer-ab-b/_internal/cost.json — comparar
 *   #    `aggregate.overall.subagent_tokens` de ambos (ou reabrir com
 *   #    `aggregateCostByStage`/`buildCostArtifact`, REUSADAS de
 *   #    edition-cost.ts — este script não duplica lógica de agregação).
 *
 * ## Presets de --stage (ver STAGE_INPUT_FILES em scripts/lib/replay-stage-input.ts)
 *   - "1"        — pool bruto + categorizado/pontuado completo do Stage 1
 *                  (#3442 — mecanismo de pesquisa/paralelismo).
 *   - "1-scorer" — só o input imediato do scorer, `tmp-dates-reviewed.json`
 *                  (#3444 — scorer-chunk vs. single-call).
 *   - "2"        — input real do Stage 2 escrita, `01-approved.json`
 *                  (#3443 — writer-destaque ×3 vs. writer único).
 *   `--files a,b,c` (CSV de paths relativos à edição) sobrescreve o preset
 *   pra mecanismos não cobertos pelos 3 acima.
 *
 * Uso:
 *   npx tsx scripts/replay-stage-input.ts \
 *     --reference-edition AAMMDD [--stage 1|1-scorer|2] [--files a.json,b.json] \
 *     [--label nome-legivel] [--force]
 *
 * Sem `--label`, o diretório de teste usa um slug derivado do timestamp
 * (ainda assim prefixado `replay-`). `--force` sobrescreve um diretório de
 * teste pré-existente com o mesmo nome (apaga e recria).
 *
 * Lógica pura + orquestração de I/O em `scripts/lib/replay-stage-input.ts`
 * (mesmo padrão de `edition-cost.ts` + `record-agent-costs.ts`) — este
 * arquivo é só o wrapper de CLI.
 */

import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { createReplayFixture } from "./lib/replay-stage-input.ts";

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const referenceAammdd = values["reference-edition"];
  const stage = values["stage"];
  const filesOverrideCsv = values["files"];
  const label = values["label"];
  const force = flags.has("force");

  if (!referenceAammdd) {
    console.error(
      "Uso: replay-stage-input.ts --reference-edition AAMMDD [--stage 1|1-scorer|2] [--files a,b,c] [--label nome] [--force]",
    );
    process.exit(1);
  }
  if (!stage && !filesOverrideCsv) {
    console.error("[error] precisa de --stage <preset> ou --files <lista-csv>");
    process.exit(1);
  }

  const editionsRootDir = resolve(process.cwd(), "data/editions");

  try {
    const manifest = createReplayFixture({
      editionsRootDir,
      referenceAammdd,
      stage,
      filesOverrideCsv,
      label,
      force,
    });
    console.log(JSON.stringify(manifest, null, 2));
    const copiedCount = manifest.files.filter((f) => f.copied).length;
    const missingCount = manifest.files.length - copiedCount;
    console.error(
      `[replay-stage-input] fixture criado: data/editions/${manifest.test_dir_name}/ ` +
        `(${copiedCount} copiado(s), ${missingCount} ausente(s) da referência ${manifest.reference_edition})`,
    );
  } catch (e) {
    console.error(`[error] ${(e as Error).message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
