/**
 * Verifica a ordem da fila `--daily` nos arquivos `daily-eligible-queue.csv`
 * gravados por onda (#10479 / #9824): nenhum incluído com score menor que um
 * elegível deixado de fora.
 *
 * Uso: npx tsx scripts/verify-clarice-daily-order.ts <queue.csv> [<queue.csv> ...]
 * Exit 1 se houver violação em qualquer arquivo.
 */
import { readFileSync } from "node:fs";
import { verifyEligibleQueueCsv } from "./lib/clarice-daily-eligible-queue.ts";
import { isMainModule } from "./lib/cli-args.ts";

export function main(files: string[]): number {
  if (files.length === 0) {
    console.error("uso: verify-clarice-daily-order.ts <daily-eligible-queue.csv> [...]");
    return 2;
  }
  let bad = 0;
  for (const f of files) {
    const v = verifyEligibleQueueCsv(readFileSync(f, "utf8"));
    console.log(`${v.length === 0 ? "OK  " : "FAIL"} ${f}${v.length ? ` — ${v.length} violação(ões), ex: ${JSON.stringify(v[0])}` : ""}`);
    if (v.length) bad++;
  }
  return bad ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
