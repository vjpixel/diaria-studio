#!/usr/bin/env node
/**
 * scripts/create-brevo-semanal-terca-list.ts (#11286)
 *
 * Cria (uma vez) a 2ª lista da Brevo diária, a "terça" da divisão
 * segunda/terça da semanal (`lib/brevo-semanal-split.ts`), na MESMA pasta da
 * lista principal (`brevo_diaria.list_id`). Criar lista é reversível pela API
 * e não envia nada (decisão do editor no #11286). O script NÃO edita o
 * `platform.config.json`: imprime o id pra pôr em
 * `brevo_diaria.semanal.terca_list_id`. A lista nasce vazia — quem a preenche
 * é o `publish-daily-brevo.ts`, na 1ª segunda acima do teto.
 *
 * Idempotente: se já existe uma lista com o nome exato, devolve o id dela.
 *
 * Uso:
 *   npx tsx scripts/create-brevo-semanal-terca-list.ts            # dry-run
 *   npx tsx scripts/create-brevo-semanal-terca-list.ts --apply
 *
 * Exit: 0 ok (inclusive dry-run e "já existia"); 1 erro de config/API.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet, brevoListAllLists, brevoPost } from "./lib/brevo-client.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TERCA_LIST_NAME = "diar.ia.br semanal — terça (#11286)";

export interface CreateTercaListDeps {
  listAllLists: () => Promise<{ id: number; name: string }[]>;
  /** `GET /contacts/lists/{id}` — só o `folderId` interessa. */
  getList: (listId: number) => Promise<{ folderId?: unknown }>;
  createList: (name: string, folderId: number) => Promise<{ id?: unknown }>;
}

export type CreateTercaListResult =
  | { status: "exists"; listId: number }
  | { status: "dry_run"; folderId: number }
  | { status: "created"; listId: number }
  | { status: "error"; reason: string };

export async function createTercaList(
  deps: CreateTercaListDeps,
  opts: { mainListId: number; apply: boolean },
): Promise<CreateTercaListResult> {
  const existing = (await deps.listAllLists()).filter((l) => l.name === TERCA_LIST_NAME);
  if (existing.length > 1) {
    return { status: "error", reason: `${existing.length} listas com o nome "${TERCA_LIST_NAME}" (ids ${existing.map((l) => l.id).join(", ")}) — escolha uma à mão.` };
  }
  if (existing.length === 1) {
    if (existing[0].id === opts.mainListId) return { status: "error", reason: "a lista encontrada é a própria lista principal." };
    return { status: "exists", listId: existing[0].id };
  }
  const main = await deps.getList(opts.mainListId);
  if (typeof main.folderId !== "number") {
    return { status: "error", reason: `GET /contacts/lists/${opts.mainListId} sem folderId numérico (${JSON.stringify(main.folderId)}).` };
  }
  if (!opts.apply) return { status: "dry_run", folderId: main.folderId };
  const created = await deps.createList(TERCA_LIST_NAME, main.folderId);
  if (typeof created.id !== "number") return { status: "error", reason: `POST /contacts/lists sem id: ${JSON.stringify(created)}` };
  return { status: "created", listId: created.id };
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    brevo_diaria?: { api_key_env?: string; list_id?: number | null };
  };
  const bd = cfg.brevo_diaria;
  const apiKey = bd?.api_key_env ? process.env[bd.api_key_env] : undefined;
  if (!bd || typeof bd.list_id !== "number" || !apiKey) {
    process.stderr.write("[create-brevo-semanal-terca-list] ERRO: brevo_diaria.list_id e a API key da Brevo diária são obrigatórios.\n");
    process.exit(1);
  }
  createTercaList(
    {
      listAllLists: () => brevoListAllLists(apiKey),
      getList: async (id) => (await brevoGet(apiKey, `/contacts/lists/${id}`)).body as { folderId?: unknown },
      createList: async (name, folderId) => (await brevoPost(apiKey, "/contacts/lists", { name, folderId })) as { id?: unknown },
    },
    { mainListId: bd.list_id, apply: hasFlag(argv, "apply") },
  ).then(
    (r) => {
      console.log(JSON.stringify(r));
      if (r.status === "created" || r.status === "exists") {
        process.stderr.write(`Ponha "terca_list_id": ${r.listId} em brevo_diaria.semanal (platform.config.json).\n`);
      }
      process.exitCode = r.status === "error" ? 1 : 0;
    },
    (e) => {
      process.stderr.write(`[create-brevo-semanal-terca-list] erro fatal: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
