#!/usr/bin/env node
/**
 * clarice-resolve-folder.ts (#4347 Etapa 4)
 *
 * Resolve (ou cria) a folder Brevo dedicada "Clarice novos" e imprime o id
 * pra `clarice-import-waves.ts --folder-id N`. Se não der pra resolver
 * (rede, permissão, shape inesperado), cai na folder 1 (default histórico do
 * projeto) COM AVISO — nunca aborta a rodada por causa disso (a folder é só
 * organização visual no Brevo, não afeta elegibilidade/envio).
 *
 * Uso:
 *   npx tsx scripts/clarice-resolve-folder.ts [--name "Clarice novos"]
 *   # stdout: JSON { folderId, resolved, error? }
 */
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveOrCreateBrevoFolder } from "./lib/brevo-client.ts";

loadProjectEnv();

export const DEFAULT_FOLDER_ID = 1;
export const DEFAULT_FOLDER_NAME = "Clarice novos";

export interface ResolveFolderResult {
  folderId: number;
  resolved: boolean;
  error?: string;
}

export async function resolveFolderIdOrDefault(
  apiKey: string,
  name: string,
  resolveFn: (apiKey: string, name: string) => Promise<number> = resolveOrCreateBrevoFolder,
): Promise<ResolveFolderResult> {
  try {
    const folderId = await resolveFn(apiKey, name);
    return { folderId, resolved: true };
  } catch (e) {
    return { folderId: DEFAULT_FOLDER_ID, resolved: false, error: (e as Error).message };
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const name = getArg(argv, "name") || DEFAULT_FOLDER_NAME;
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error(`BREVO_CLARICE_API_KEY não definida — caindo na folder ${DEFAULT_FOLDER_ID} com aviso.`);
    console.log(JSON.stringify({ folderId: DEFAULT_FOLDER_ID, resolved: false, error: "BREVO_CLARICE_API_KEY ausente" }, null, 2));
    return;
  }
  const result = await resolveFolderIdOrDefault(apiKey, name);
  if (!result.resolved) {
    console.error(`⚠️  não foi possível resolver/criar a folder "${name}" (${result.error}) — caindo na folder ${DEFAULT_FOLDER_ID} com aviso.`);
  } else {
    console.error(`✓ folder "${name}" → #${result.folderId}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String((e as Error)?.stack || e));
    process.exit(1);
  });
}
