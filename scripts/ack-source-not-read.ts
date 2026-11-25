/**
 * ack-source-not-read.ts (#13884) — registra a DECISÃO DO EDITOR de manter na
 * edição um item de pool cuja fonte não foi lida (403, vídeo sem texto, resumo
 * curto). Sem esse aceite o invariante `source-not-read` é error e bloqueia o
 * gate 4; com ele, o item vira warning e aparece no gate como "aceito pelo
 * editor".
 *
 * Só o editor decide: o orchestrator roda este comando quando o editor
 * responde no gate que o item fica. Em `--no-gates` não há editor, então a
 * edição para em halt banner (`orchestrator-stage-4.md` §5) — nunca registrar
 * aceite sozinho.
 *
 * Uso:
 *   npx tsx scripts/ack-source-not-read.ts --edition-dir {EDITION_DIR}/ --url URL --reason "motivo do editor"
 *   npx tsx scripts/ack-source-not-read.ts --edition-dir {EDITION_DIR}/ --remove --url URL
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { SOURCE_NOT_READ_ACK_FILE, readSourceNotReadAcks, type SourceNotReadAck } from "./lib/diaria/source-readability.ts";

const USAGE = 'Uso: ack-source-not-read.ts --edition-dir DIR --url URL (--reason "motivo" | --remove)';

export function writeAck(
  editionDir: string,
  url: string,
  opts: { reason?: string; remove?: boolean; now?: () => Date },
): { path: string; acks: SourceNotReadAck[] } {
  const internal = join(editionDir, "_internal");
  if (!existsSync(internal)) throw new Error(`${internal} ausente`);
  const acks = readSourceNotReadAcks(internal);
  if (opts.remove) acks.delete(url);
  else {
    const reason = opts.reason?.trim();
    if (!reason) throw new Error("--reason obrigatório: o aceite registra o motivo do editor");
    acks.set(url, { url, reason, acked_at: (opts.now ?? (() => new Date()))().toISOString() });
  }
  const path = join(internal, SOURCE_NOT_READ_ACK_FILE);
  const list = [...acks.values()];
  writeFileSync(path, JSON.stringify({ acks: list }, null, 2), "utf8");
  return { path, acks: list };
}

async function main(): Promise<number | void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"] || !args.url || (!args.reason && !flags.has("remove"))) {
    console.error(USAGE);
    return 1;
  }
  const out = writeAck(resolve(process.cwd(), args["edition-dir"]), args.url, { reason: args.reason, remove: flags.has("remove") });
  console.log(JSON.stringify(out, null, 2));
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`ack-source-not-read: ${(e as Error).message}`) });
}
