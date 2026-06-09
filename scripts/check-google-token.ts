/**
 * check-google-token.ts (#1973)
 *
 * Pré-flight do Stage 0 §0c: checa proativamente a saúde do token OAuth Google
 * (mesmo token cobre Drive + Gmail/inbox-drain + upload de imagens sociais).
 * Emite UM banner consolidado se expirado/expirando, antes de qualquer passo
 * que dependa de Drive/Gmail — em vez de 3 falhas espalhadas no meio do pipeline.
 *
 * Uso:
 *   npx tsx scripts/check-google-token.ts
 *
 * Exit codes:
 *   0 = token válido (ou expiring_soon — funciona, mas imprime aviso)
 *   1 = expirado/inválido/ausente (banner com a ação) — orchestrator surfaça
 *   (expiring_soon imprime o banner mas NÃO derruba — exit 0, só avisa)
 */

import { checkTokenHealth, renderTokenHealthBanner } from "./google-auth.ts";

async function main(): Promise<number> {
  const health = await checkTokenHealth();
  console.log(JSON.stringify(health, null, 2));
  const banner = renderTokenHealthBanner(health);
  if (banner) console.error("\n" + banner + "\n");
  // expiring_soon ainda funciona (refresh ok) → não derruba o pipeline, só avisa.
  if (health.status === "valid" || health.status === "expiring_soon") return 0;
  return 1;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/check-google-token\.ts$/.test(_argv1)) {
  // process.exitCode (não process.exit) — deixa o socket keep-alive do fetch
  // fechar antes do exit, evitando o assert libuv no Windows
  // (!(handle->flags & UV_HANDLE_CLOSING)) ao forçar exit durante o close.
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main };
