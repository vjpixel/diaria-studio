/**
 * edition-lock.ts (#10309) — CLI da trava por edição entre sessões.
 * Lógica e racional em `scripts/lib/edition-lock.ts`.
 *
 * Uso (sempre STANDALONE, nunca encadeado: o hook `inject-session-id.mjs`
 * só injeta `--session-id` em comando sem `&&`/`;`/`|`):
 *   npx tsx scripts/edition-lock.ts acquire --edition-dir DIR --stage 4 [--force]
 *   npx tsx scripts/edition-lock.ts release --edition-dir DIR [--force]
 *   npx tsx scripts/edition-lock.ts status  --edition-dir DIR
 *
 * Exit codes: 0 ok (acquire: acquired|refreshed|took_stale|taken_over;
 * release: released|not_held) · 2 uso inválido / `--session-id` ausente ·
 * 3 a edição está com outra sessão viva (acquire/release sem `--force`) ·
 * 4 trava vencida de OUTRO host (#11690): data/ possivelmente defasado.
 * Stdout: JSON com `action`/`result` e o detentor.
 */
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  EDITION_LOCK_TTL_MS,
  acquireEditionLock,
  readEditionLock,
  releaseEditionLock,
} from "./lib/edition-lock.ts";

const USAGE =
  "Uso: edition-lock.ts acquire --edition-dir DIR --stage N [--force] [--session-id ID]\n" +
  "     edition-lock.ts release --edition-dir DIR [--force] [--session-id ID]\n" +
  "     edition-lock.ts status  --edition-dir DIR";

function fail(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

function requireSession(values: Record<string, string>): string {
  const sid = values["session-id"]?.trim();
  if (!sid) {
    fail(
      "[edition-lock] --session-id ausente — rode o comando STANDALONE (sem &&/;/|) para o hook inject-session-id injetar a flag.",
      2,
    );
  }
  return sid;
}

function main(): void {
  const { positional, values, flags } = parseArgs(process.argv.slice(2));
  const sub = positional[0];
  if (!values["edition-dir"]) fail(USAGE, 2);
  const editionDir = resolve(values["edition-dir"]);
  const force = flags.has("force");

  if (sub === "status") {
    console.log(JSON.stringify({ lock: readEditionLock(editionDir), ttl_ms: EDITION_LOCK_TTL_MS }));
    return;
  }
  if (sub === "acquire") {
    const sessionId = requireSession(values);
    const stage = Number(values.stage);
    if (!values.stage || !Number.isInteger(stage)) fail(`--stage inválido: ${values.stage ?? "(ausente)"}\n${USAGE}`, 2);
    const d = acquireEditionLock(editionDir, { sessionId, stage, force });
    console.log(JSON.stringify(d));
    if (d.action === "held_by_other") {
      const prev = d.previous!;
      const min = Math.round((d.previous_age_ms ?? 0) / 60000);
      console.error(
        `[edition-lock] edição em uso por outra sessão (${prev.session_id} em ${prev.host}, Stage ${prev.stage}, heartbeat há ${min} min).`,
      );
      process.exit(3);
    }
    if (d.action === "stale_other_host") {
      const prev = d.previous!;
      console.error(
        `[edition-lock] trava vencida de OUTRO host (${prev.host}, Stage ${prev.stage}, heartbeat ${Number.isFinite(d.previous_age_ms) ? `há ${Math.floor((d.previous_age_ms as number) / 3600000)} h` : "ilegível"}): data/ possivelmente defasado (OneDrive) — aguardar sync antes de re-rodar o stage. --force só se o editor confirmar.`,
      );
      process.exit(4);
    }
    return;
  }
  if (sub === "release") {
    const sessionId = requireSession(values);
    const result = releaseEditionLock(editionDir, { sessionId, force });
    console.log(JSON.stringify({ result }));
    if (result === "held_by_other") process.exit(3);
    return;
  }
  fail(USAGE, 2);
}

if (isMainModule(import.meta.url)) main();
