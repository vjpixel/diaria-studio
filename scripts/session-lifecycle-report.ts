#!/usr/bin/env node
/**
 * scripts/session-lifecycle-report.ts (#6624)
 *
 * Lê `data/session-lifecycle.jsonl` (instrumentação escrita por
 * `endSession`/`garbageCollectSessions` em `scripts/lib/session-registry.ts`)
 * e imprime o resumo que responde à pergunta da issue: sessões coordenadoras
 * (`overnight`/`develop`/`continuo`) terminam sem chamar `end` com que
 * frequência?
 *
 * Uso:
 *   npx tsx scripts/session-lifecycle-report.ts              # data/ do repo real
 *   npx tsx scripts/session-lifecycle-report.ts --root <path> # aponta pra um data/ alternativo (testes/CI)
 *
 * **Vazio nos primeiros dias após o merge é esperado**, não é falha — a
 * instrumentação só grava dali pra frente, não há como reconstruir histórico
 * (ver docstring de `scripts/lib/session-lifecycle-report.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { parseSessionLifecycleLog, summarizeSessionLifecycle } from "./lib/session-lifecycle-report.ts";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[session-lifecycle-report]";

function resolveRoot(argv: string[]): string {
  const idx = argv.indexOf("--root");
  if (idx !== -1 && argv[idx + 1]) return resolve(argv[idx + 1]!);
  return DEFAULT_ROOT;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const root = resolveRoot(argv);
  const logPath = join(root, "data", "session-lifecycle.jsonl");

  if (!existsSync(logPath)) {
    console.log(
      `${LOG_PREFIX} ${logPath} ainda não existe — nenhuma sessão coordenadora terminou (via end ou GC) desde ` +
        `que a instrumentação (#6624) foi mergeada. Isto é esperado logo após o merge, não é falha.`,
    );
    return;
  }

  const content = readFileSync(logPath, "utf8");
  const events = parseSessionLifecycleLog(content);
  const summary = summarizeSessionLifecycle(events);

  console.log(`${LOG_PREFIX} ${summary.totalEvents} evento(s) no log.`);
  console.log(`${LOG_PREFIX} "ended" (chamou end corretamente): ${summary.endedCount}`);
  console.log(`${LOG_PREFIX} "gc-removed-without-end" (GC removeu sem end): ${summary.gcRemovedWithoutEndCount}`);
  if (summary.gcRemovedWithoutEndRatio !== null) {
    console.log(
      `${LOG_PREFIX} proporção sem end: ${(summary.gcRemovedWithoutEndRatio * 100).toFixed(1)}%`,
    );
  }
  for (const [kind, counts] of Object.entries(summary.byKind)) {
    console.log(`${LOG_PREFIX}   ${kind}: ended=${counts.ended} gc-removed-without-end=${counts.gcRemovedWithoutEnd}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
