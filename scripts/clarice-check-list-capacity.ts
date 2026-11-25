#!/usr/bin/env node
/** #13966: leitura recorrente antes da seleção novos (09h/18h).
 * Exit 1 a partir de 270 listas: a unit failed aciona o alarme existente.
 * Nunca consolida/apaga listas automaticamente. Um GET de contatos, sem
 * consumir a quota escassa de /emailCampaigns. Não precisa paginar: count
 * é o total da conta, não o tamanho da página.
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";

export function listCapacityAlarm(count: unknown): string | null {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Brevo /contacts/lists sem count válido — capacidade não verificada.");
  }
  if (count < 270) return null;
  return `${count}/300 listas na conta Clarice (alarme ≥270, #13966). ` +
    "AÇÃO: rode npx tsx scripts/clarice-consolidate-lists.ts (dry-run), " +
    "revise o plano e execute --apply no host/conta autorizados (#9532). " +
    "Nenhuma seleção nova foi criada; retome novos após liberar espaço.";
}

export async function checkListCapacity(
  get: (path: string) => Promise<{ status: number; body: any }>,
): Promise<void> {
  const { status, body } = await get("/contacts/lists?limit=1&offset=0");
  if (status !== 200) throw new Error(`Brevo /contacts/lists HTTP ${status} — capacidade não verificada.`);
  const alarm = listCapacityAlarm(body?.count);
  if (alarm) throw new Error(alarm);
}

if (isMainModule(import.meta.url)) {
  void runCli(async () => {
    loadProjectEnv();
    const key = process.env.BREVO_CLARICE_API_KEY;
    if (!key) throw new Error("BREVO_CLARICE_API_KEY não definida.");
    await checkListCapacity((path) => brevoGet(key, path));
    console.log("Capacidade de listas Clarice abaixo do limiar de 270/300.");
    return 0;
  }, { onError: (e) => console.error(`[clarice-check-list-capacity] ${e instanceof Error ? e.message : String(e)}`) });
}
