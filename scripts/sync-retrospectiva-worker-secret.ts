#!/usr/bin/env tsx
/**
 * sync-retrospectiva-worker-secret.ts (#8046)
 *
 * Sincroniza o secret `KIT_API_KEY` do Worker `workers/retrospectiva` com a
 * key ativa em `.env`/Doppler — fecha o gap da retro do #8046: o gate de
 * cadastro (`retrospectiva.diar.ia.br/{slug}?email=...`) passou a recusar
 * assinantes `active` de verdade porque o secret DEPLOYADO no Worker (setado
 * manualmente via `wrangler secret put`, ver `workers/retrospectiva/README.md`
 * §Cutover) tinha ficado defasado em relação à key ativa localmente — não
 * existia nenhum script que reconciliasse os dois lados.
 *
 * Miolo puro (requisições HTTP injetáveis) em
 * `scripts/lib/retrospectiva-worker-secret-sync.ts` — este arquivo só faz
 * CLI + I/O (env, stdout, `fetch` real).
 *
 * Uso:
 *   npx tsx scripts/sync-retrospectiva-worker-secret.ts               # dry-run (default) — mostra o plano, NÃO grava
 *   npx tsx scripts/sync-retrospectiva-worker-secret.ts --push         # grava de verdade via API Cloudflare
 *   npx tsx scripts/sync-retrospectiva-worker-secret.ts --verify       # só confere se o NOME do secret está registrado (não confirma o valor — ver docstring da lib)
 *
 * Credenciais (de `.env`, via `loadProjectEnv`):
 *   KIT_API_KEY              — a key a sincronizar (mesma que `publish-newsletter-kit.ts`/MCP `kit` usam)
 *   CLOUDFLARE_ACCOUNT_ID    — conta Cloudflare
 *   CLOUDFLARE_WORKERS_TOKEN — token com permissão Workers Scripts:Edit (mesmo
 *                              nome que `.github/workflows/deploy-worker.yml`
 *                              mapeia pra `CLOUDFLARE_API_TOKEN` no deploy via CI)
 *
 * Nunca imprime o valor do secret — só um preview mascarado (8 primeiros
 * chars + "...") pra confirmar visualmente que a key certa foi lida, sem
 * vazar o valor completo em log/histórico de terminal.
 *
 * Rodar sempre que `KIT_API_KEY` rotacionar (mesmo cuidado que motivou o
 * #8046: a key local mudou e ninguém lembrou de repetir o `wrangler secret
 * put` manual no Worker). Não é gatilho automático de deploy — é um passo
 * manual reduzido a 1 comando, chamado explicitamente pelo editor (ou por
 * quem estiver mexendo em `KIT_API_KEY`).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  RETROSPECTIVA_WORKER_SCRIPT_NAME,
  RETROSPECTIVA_WORKER_SECRET_NAME,
  syncRetrospectivaWorkerSecret,
  verifyRetrospectivaWorkerSecret,
  type SyncResult,
  type VerifyResult,
} from "./lib/retrospectiva-worker-secret-sync.ts";

/** Preview mascarado do secret pra log — nunca o valor completo. */
export function maskSecretPreview(value: string): string {
  if (!value) return "(vazio)";
  return value.length <= 8 ? "***" : `${value.slice(0, 8)}...`;
}

export async function main(argv: string[]): Promise<number> {
  loadProjectEnv();

  const { flags } = parseArgs(argv);
  const push = flags.has("push");
  const verifyOnly = flags.has("verify");

  const secretValue = process.env.KIT_API_KEY ?? "";
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";

  console.log(
    `[sync-retrospectiva-worker-secret] Worker=${RETROSPECTIVA_WORKER_SCRIPT_NAME} secret=${RETROSPECTIVA_WORKER_SECRET_NAME} ` +
      `KIT_API_KEY local=${maskSecretPreview(secretValue)}`,
  );

  if (verifyOnly) {
    const result: VerifyResult = await verifyRetrospectivaWorkerSecret({ accountId, token }, fetch);
    console.log(`[sync-retrospectiva-worker-secret] verify: ${result.status} — ${result.message}`);
    if (result.apiError) console.error(result.apiError);
    return result.status === "present" ? 0 : 1;
  }

  if (!push) {
    console.log(
      "[sync-retrospectiva-worker-secret] dry-run (default) — nada foi gravado. " +
        "Rode com --push para gravar de verdade no Worker via API Cloudflare, ou --verify " +
        "para só checar se o secret está registrado (sem gravar).",
    );
    if (!secretValue) {
      console.warn("[sync-retrospectiva-worker-secret] AVISO: KIT_API_KEY ausente/vazio em .env — --push falharia agora.");
    }
    if (!accountId || !token) {
      console.warn(
        "[sync-retrospectiva-worker-secret] AVISO: CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_WORKERS_TOKEN ausentes — --push falharia agora.",
      );
    }
    return 0;
  }

  const result: SyncResult = await syncRetrospectivaWorkerSecret({ secretValue, accountId, token }, fetch);
  console.log(`[sync-retrospectiva-worker-secret] ${result.status} — ${result.message}`);
  if (result.apiError) console.error(result.apiError);
  return result.status === "synced" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
