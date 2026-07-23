#!/usr/bin/env node
/**
 * scripts/build-apoiador-allowlist.ts (#3940)
 *
 * Constrói a allowlist de e-mails de apoiadores R$10+/mês (mês vigente) —
 * pra push no KV `ALLOWLIST` do worker `artigo-mensal` (gate do artigo
 * mensal, ver `workers/artigo-mensal/`).
 *
 * NÃO reimplementa a checagem de apoio: reusa a MESMA maquinaria já testada
 * do painel Apoios (`scripts/studio-ui/studio-apoios.ts`) —
 * `buildApoiosData` (loadContacts + fetchCurrentStatuses/checkBacker +
 * deriveContactStatus, tudo já fail-soft em 3 camadas) e `computeRewardGroup`
 * (fonte única do limiar R$10 = tier "apoiador"). A ÚNICA lógica nova aqui é
 * `computeApoiadorAllowlist` — pura, filtra `ContactWithStatus[]` já
 * resolvido pra a lista de e-mails que qualificam.
 *
 * Uso:
 *   npx tsx scripts/build-apoiador-allowlist.ts [--out <path>] [--push]
 *
 * Sem `--out`: imprime o JSON (array de e-mails) em stdout.
 * `--push` (+ credenciais Cloudflare no env): grava no KV `ALLOWLIST` via
 * `uploadTextToWorkerKV` — mesmo padrão de `scripts/clarice-db-summary.ts`.
 * Recusa o push (fail-closed) se `buildApoiosData` reportou erro (data/
 * ausente, credenciais apoia.se ausentes, 401) — uma allowlist parcial
 * nunca é gravada por cima da anterior.
 *
 * IMPORTANTE (#3940 — escopo desta unidade): `--push` NUNCA foi executado
 * nesta sessão, nem contra `data/apoia-se/contacts.jsonl` real nem contra um
 * KV namespace real. `APOIADOR_ALLOWLIST_KV_NAMESPACE_ID` ainda é
 * placeholder em `workers/artigo-mensal/wrangler.toml` até o 1º
 * `wrangler kv namespace create` (próximo passo manual do editor).
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { buildApoiosData, computeRewardGroup, type ContactWithStatus } from "./studio-ui/studio-apoios.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

/**
 * KV namespace ID do binding `ALLOWLIST` em `workers/artigo-mensal/wrangler.toml`.
 * Placeholder até o editor rodar `wrangler kv namespace create ALLOWLIST --remote`
 * (deploy real fora do escopo desta unidade, #3940).
 */
export const APOIADOR_ALLOWLIST_KV_NAMESPACE_ID = "REPLACE_ME_APOS_CRIAR_NAMESPACE_ALLOWLIST";

/** Chave única do KV ALLOWLIST — valor é o JSON array de e-mails. */
export const APOIADOR_ALLOWLIST_KV_KEY = "emails";

/**
 * Pure: filtra contatos com status "apoiando" no mês corrente E valor pago
 * dentro do tier R$10+ (`computeRewardGroup` !== null && !== "amigo" — a
 * faixa "amigo" é R$5–10, abaixo do gate desta issue). Cada contato pode ter
 * múltiplos e-mails cadastrados (#3500) — TODOS entram na allowlist, não só
 * o e-mail que casou com a apoia.se, pra que o apoiador consiga logar com
 * qualquer um dos e-mails que ele mesmo cadastrou.
 *
 * Retorna lista ordenada, deduplicada, sem I/O — caller decide o que fazer
 * com o resultado (imprimir, gravar em arquivo, ou push pro KV).
 */
export function computeApoiadorAllowlist(contacts: ContactWithStatus[]): string[] {
  const emails = new Set<string>();
  for (const c of contacts) {
    if (c.status.label !== "apoiando") continue;
    const group = computeRewardGroup(c.status.monthlyValue);
    if (group === null || group === "amigo") continue; // < R$10 — não qualifica
    for (const email of c.emails) emails.add(email);
  }
  return [...emails].sort();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(REPO_ROOT);

  const data = await buildApoiosData(REPO_ROOT);
  const allowlist = computeApoiadorAllowlist(data.contacts);
  const payload = JSON.stringify(allowlist);

  const outPath = getArg(argv, "out");
  if (outPath) {
    writeFileSync(resolve(REPO_ROOT, outPath), payload, "utf-8");
    console.error(`[build-apoiador-allowlist] gravado em ${outPath} (${allowlist.length} e-mails)`);
  } else {
    console.log(payload);
  }

  if (data.error) {
    console.error(
      `[build-apoiador-allowlist] aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}`,
    );
  }

  if (hasFlag(argv, "push")) {
    if (data.error) {
      console.error(
        "[build-apoiador-allowlist] RECUSANDO --push: dados de apoio incompletos/indisponíveis " +
          "(ver aviso acima) — nunca sobrescreve a allowlist do KV com dado parcial.",
      );
      process.exit(1);
    }
    console.error(
      `[build-apoiador-allowlist] --push: enviando ${allowlist.length} e-mail(s) pro KV ALLOWLIST...`,
    );
    await uploadTextToWorkerKV(payload, APOIADOR_ALLOWLIST_KV_KEY, {
      kvNamespaceId: APOIADOR_ALLOWLIST_KV_NAMESPACE_ID,
      contentType: "application/json",
    });
    console.error(`[build-apoiador-allowlist] push concluído.`);
  } else {
    console.error(
      `[build-apoiador-allowlist] dry-run (default) — ${allowlist.length} e-mail(s) computados, ` +
        "NENHUM push ao KV. Use --push para gravar.",
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-apoiador-allowlist: erro fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
