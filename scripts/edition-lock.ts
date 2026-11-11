/**
 * edition-lock.ts (#10309) — CLI da trava por edição entre sessões.
 * Lógica e racional em `scripts/lib/edition-lock.ts`.
 *
 * Uso (sempre STANDALONE, nunca encadeado: o hook `inject-session-id.mjs`
 * só injeta `--session-id` em comando sem `&&`/`;`/`|`):
 *   npx tsx scripts/edition-lock.ts acquire --edition-dir DIR --stage 4 [--force]
 *   npx tsx scripts/edition-lock.ts release --edition-dir DIR [--force] [--complete-stage N]
 *   npx tsx scripts/edition-lock.ts status  --edition-dir DIR
 *
 * Exit codes: 0 ok (acquire: acquired|refreshed|took_stale|taken_over;
 * release: released|not_held) · 2 uso inválido / `--session-id` ausente ·
 * 3 a edição está com outra sessão viva (acquire/release sem `--force`) ·
 * 4 trava vencida de OUTRO host (#11690): data/ possivelmente defasado.
 * Stdout: JSON com `action`/`result` e o detentor.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { d1LocksClientFromRepo } from "./lib/d1-locks.ts";
import {
  EDITION_LOCK_TTL_MS,
  acquireEditionLockShared,
  formatLockAge,
  readEditionLock,
  releaseEditionLockShared,
} from "./lib/edition-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** #12842: lock `edition:{AAMMDD}` no D1 (entre máquinas); `null` = só o arquivo. */
function d1Client() {
  return d1LocksClientFromRepo(ROOT, process.env, (reason) =>
    console.error(`⚠️  d1-locks (#12842): D1 configurado mas indisponível (${reason}) — seguindo com a trava LOCAL.`),
  );
}

const USAGE =
  "Uso: edition-lock.ts acquire --edition-dir DIR --stage N [--force] [--session-id ID]\n" +
  "     edition-lock.ts release --edition-dir DIR [--force] [--complete-stage N] [--session-id ID]\n" +
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

async function main(): Promise<void> {
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
    const d = await acquireEditionLockShared(editionDir, { sessionId, stage, force }, d1Client());
    if (d.d1Warning) process.stderr.write(d.d1Warning);
    const { d1Warning: _w, ...out } = d;
    console.log(JSON.stringify(out));
    if (d.action === "held_by_other") {
      const prev = d.previous!;
      console.error(
        `[edition-lock] edição em uso por outra sessão (${prev.session_id} em ${prev.host}, Stage ${prev.stage}, heartbeat ${formatLockAge(d.previous_age_ms)}).`,
      );
      process.exit(3);
    }
    if (d.action === "stale_other_host") {
      const prev = d.previous!;
      console.error(
        `[edition-lock] trava vencida de OUTRO host (${prev.host}, Stage ${prev.stage}, heartbeat ${formatLockAge(d.previous_age_ms)}): data/ possivelmente defasado (sync do Drive: bisync do 300 / Drive for desktop) — aguardar sync antes de re-rodar o stage. --force só se o editor confirmar.`,
      );
      process.exit(4);
    }
    return;
  }
  if (sub === "release") {
    const sessionId = requireSession(values);
    const cs = values["complete-stage"];
    if (cs !== undefined && !Number.isInteger(Number(cs))) fail(`--complete-stage inválido: ${cs}\n${USAGE}`, 2);
    const shared = await releaseEditionLockShared(
      editionDir,
      { sessionId, force, completedStage: cs === undefined ? undefined : Number(cs) },
      d1Client(),
    );
    if (shared.d1Warning) process.stderr.write(shared.d1Warning);
    const result = shared.result;
    console.log(JSON.stringify({ result, backend: shared.backend }));
    if (result === "held_by_other") process.exit(3);
    return;
  }
  fail(USAGE, 2);
}

if (isMainModule(import.meta.url)) void main();
