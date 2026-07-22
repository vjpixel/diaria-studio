/**
 * apoia-se-gmail-drain.ts (#3859 metade 1)
 *
 * Wrapper CLI de `scripts/lib/apoia-se-gmail-drain.ts::drainApoiaSeNotifications`
 * — uso manual/debug, mesmo padrão de `scripts/inbox-drain.ts`. Em produção
 * o drain é chamado direto pela lib a partir de `refreshApoiosData`
 * (`scripts/studio-ui/studio-apoios.ts`), não por este CLI.
 *
 * Uso:
 *   npx tsx scripts/apoia-se-gmail-drain.ts
 *
 * Output (stdout): JSON com { notifications[], most_recent_iso, skipped, ... }
 */

import { resolve } from "node:path";
import { drainApoiaSeNotifications } from "./lib/apoia-se-gmail-drain.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(import.meta.dirname, "..");

async function main(rootDir: string = ROOT): Promise<void> {
  const result = await drainApoiaSeNotifications(rootDir);
  console.log(JSON.stringify(result, null, 2));
}

export { main };

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("apoia-se-gmail-drain error:", err.message);
    console.log(JSON.stringify({ notifications: [], most_recent_iso: null, skipped: true, reason: err.message }, null, 2));
    process.exit(0);
  });
}
