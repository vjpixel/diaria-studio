#!/usr/bin/env npx tsx
/**
 * inject-reativar-token-brevo.ts (#8194)
 *
 * Popula o atributo de contato Brevo `REATIVAR_TOKEN` (`computeReativarToken`,
 * `lib/shared/reativar-token.ts`) em toda a lista da Brevo diária, pra o botão
 * "Confirmar minha inscrição" do intro levar `&t={{ contact.REATIVAR_TOKEN }}`.
 * Com token válido, o worker `reativar` ativa direto no Kit, sem DOI.
 *
 * Chamado INLINE por `publish-daily-brevo.ts`, logo depois do `POLL_TOKEN`.
 * **Fail-soft de propósito**, ao contrário do `POLL_TOKEN`: contato sem token
 * recebe o link com `t=` vazio, que o worker trata como "sem token" e segue o
 * fluxo DOI de sempre. Nunca aborta a campanha.
 *
 * Reusa a enumeração paginada e o batch de `inject-poll-token-brevo.ts`
 * (mesma lista, mesmo endpoint, mesma disciplina de 404 = erro).
 *
 * Uso standalone:
 *   npx tsx scripts/inject-reativar-token-brevo.ts --list-id 7 [--dry-run]
 *
 * Env: BREVO_DIARIA_API_KEY, REATIVAR_SECRET (o mesmo do worker `reativar`).
 */

import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet, brevoPost, brevoPut } from "./lib/brevo-client.ts";
import { computeReativarToken, REATIVAR_TOKEN_ATTR } from "./lib/shared/reativar-token.ts";
import { iterateListContacts, processBatch, type ApiOpts } from "./inject-poll-token-brevo.ts";

const CONCURRENCY = 3;

export interface ReativarTokenRunResult {
  total_contacts: number;
  patched: number;
  skipped_already_correct: number;
  failed: number;
  failedEmails: string[];
  dry_run: boolean;
}

async function ensureAttribute(apiKey: string): Promise<void> {
  const { body } = await brevoGet(apiKey, "/contacts/attributes");
  const names = new Set(((body as { attributes?: { name: string }[] })?.attributes ?? []).map((a) => a.name));
  if (names.has(REATIVAR_TOKEN_ATTR)) return;
  await brevoPost(apiKey, `/contacts/attributes/normal/${REATIVAR_TOKEN_ATTR}`, { type: "text" });
  console.error(`[inject-reativar-token-brevo] criado atributo de contato "${REATIVAR_TOKEN_ATTR}"`);
}

export async function runInjectReativarToken(args: {
  apiOpts: ApiOpts;
  secret: string;
  dryRun: boolean;
  /** Injetáveis pra teste. */
  iterate?: typeof iterateListContacts;
  putContact?: (email: string, token: string) => Promise<void>;
  ensure?: (apiKey: string) => Promise<void>;
}): Promise<ReativarTokenRunResult> {
  const iterate = args.iterate ?? iterateListContacts;
  const putContact =
    args.putContact ??
    ((email: string, token: string) =>
      brevoPut(args.apiOpts.apiKey, `/contacts/${encodeURIComponent(email)}`, {
        attributes: { [REATIVAR_TOKEN_ATTR]: token },
      }).then(() => undefined));
  if (!args.dryRun) await (args.ensure ?? ensureAttribute)(args.apiOpts.apiKey);

  const result: ReativarTokenRunResult = {
    total_contacts: 0,
    patched: 0,
    skipped_already_correct: 0,
    failed: 0,
    failedEmails: [],
    dry_run: args.dryRun,
  };
  for await (const page of iterate(args.apiOpts)) {
    result.total_contacts += page.length;
    const todo: Array<{ email: string; token: string }> = [];
    for (const c of page) {
      if (!c.email?.trim()) continue;
      const token = await computeReativarToken(args.secret, c.email);
      if (c.attributes?.[REATIVAR_TOKEN_ATTR] === token) {
        result.skipped_already_correct++;
        continue;
      }
      todo.push({ email: c.email, token });
    }
    if (args.dryRun) {
      result.patched += todo.length;
      continue;
    }
    const batch = await processBatch(todo, CONCURRENCY, (item) => putContact(item.email, item.token));
    result.patched += batch.ok;
    result.failed += batch.failed.length;
    for (const f of batch.failed) result.failedEmails.push(f.item.email);
  }
  return result;
}

async function main(): Promise<void> {
  loadProjectEnv();
  const { flags, values } = parseArgs(process.argv.slice(2));
  const listId = Number(values["list-id"]);
  const apiKey = process.env.BREVO_DIARIA_API_KEY;
  const secret = process.env.REATIVAR_SECRET;
  if (!Number.isFinite(listId) || !apiKey || !secret) {
    console.error(
      "[inject-reativar-token-brevo] uso: --list-id N [--dry-run]; requer BREVO_DIARIA_API_KEY e REATIVAR_SECRET",
    );
    process.exit(1);
  }
  const result = await runInjectReativarToken({ apiOpts: { apiKey, listId }, secret, dryRun: flags.has("dry-run") });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[inject-reativar-token-brevo] ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
