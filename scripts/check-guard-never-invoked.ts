#!/usr/bin/env npx tsx
/**
 * scripts/check-guard-never-invoked.ts (#7137, item 1 bullet 2)
 *
 * "Guard mecânico do próprio guard" pedido no escopo (1) da #7137: varre
 * `scripts/` por `check-*.ts` / `*-alarm.ts` / `*-gate.ts` / `*-drift-check.ts`
 * e reporta quem não tem NENHUM ponto de invocação nas superfícies
 * verificáveis localmente — mesmo corpus da medição manual que abriu a
 * issue (`.claude/skills/**`, `.claude/agents/**`, `.claude/hooks/**`,
 * `.claude/settings.json`, `hermes/**`, `.github/workflows/*`,
 * `package.json`, `scripts/lib/scheduled-tasks.ts`,
 * `docs/scheduled-tasks-registry.md`, `scripts/overnight/*`). Lógica pura
 * em `scripts/lib/guard-never-invoked.ts`.
 *
 * **Limitação conhecida, documentada de propósito (não é bug):** os timers
 * systemd REAIS vivem no servidor `helios`, alcançável só por SSH — fora do
 * alcance de um worktree isolado (mesma limitação que motivou a correção
 * de escopo no comentário de 02/09 da #7137: duas afirmações da issue
 * original erraram por não terem esse acesso). Este guard mede só a
 * DECLARAÇÃO local (registro tipado `SCHEDULED_TASKS` + hooks/skills/CI do
 * checkout) — nunca o estado armado real do systemd. Isso quer dizer que um
 * script `DECLARADA, NAO ARMADA` no registro (padrão usado extensivamente
 * em `scripts/lib/scheduled-tasks.ts` pra tasks que um worktree isolado não
 * pode armar) já conta como "tem ponto de invocação" aqui — a checagem
 * declaração-vs-systemd-real é responsabilidade de
 * `scripts/task-never-armed-alarm.ts` (#5607) e
 * `scripts/task-registry-prose-drift-check.ts` (#6105 item 2), não deste
 * guard. As duas checagens são complementares, não redundantes.
 *
 * **Não-bloqueante por enquanto** (mesmo espírito do item 26 de
 * `context/overnight-dispatch-rules.md`) — reporta, nunca falha o processo
 * chamador, até acumular histórico de quantos achados reais este guard
 * produz na prática. `--strict` inverte isso pra exit 1 quando há achado,
 * pra quem quiser usá-lo como gate real (ex: um workflow de CI futuro).
 *
 * Uso:
 *   npx tsx scripts/check-guard-never-invoked.ts
 *   npx tsx scripts/check-guard-never-invoked.ts --json
 *   npx tsx scripts/check-guard-never-invoked.ts --strict   # exit 1 se achar algo
 *
 * Exit codes:
 *   0 — sem achados (ou achados existem mas --strict ausente — default é
 *       relatório, nunca gate)
 *   1 — achados encontrados E --strict presente
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  listGuardCandidates,
  buildLocalCorpusText,
  evaluateGuardNeverInvoked,
} from "./lib/guard-never-invoked.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[check-guard-never-invoked]";

export function runCheck(repoRoot: string) {
  const candidates = listGuardCandidates(join(repoRoot, "scripts"));
  const corpusText = buildLocalCorpusText(repoRoot);
  return evaluateGuardNeverInvoked(candidates, corpusText);
}

function main(): void {
  const argv = process.argv.slice(2);
  const report = runCheck(ROOT);

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${LOG_PREFIX} ${report.candidates.length} candidato(s) (check-*/*-alarm/*-gate/*-drift-check) verificados.`,
    );
    if (report.excludedByKnownIndirectInvocation.length > 0) {
      console.log(
        `${LOG_PREFIX} ${report.excludedByKnownIndirectInvocation.length} excluído(s) por cadeia de ` +
          `invocação indireta verificada à mão (KNOWN_INDIRECT_INVOCATIONS): ` +
          report.excludedByKnownIndirectInvocation.map((c) => c.name).join(", "),
      );
    }
    if (report.findings.length === 0) {
      console.log(`${LOG_PREFIX} nenhum guard sem ponto de invocação nas superfícies locais.`);
    } else {
      console.log(`${LOG_PREFIX} ${report.findings.length} sem ponto de invocação local:`);
      for (const f of report.findings) {
        console.log(`${LOG_PREFIX}   - scripts/${f.relPath}`);
      }
      console.log(
        `${LOG_PREFIX} decisão pra cada um: armar (SCHEDULED_TASKS/hook/fase de skill) ou remover — ` +
          `"deixar como está" não é opção válida (#7137).`,
      );
    }
  }

  const strict = hasFlag(argv, "strict");
  process.exit(strict && report.findings.length > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main();
}
