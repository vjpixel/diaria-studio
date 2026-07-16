#!/usr/bin/env node
/**
 * apoia-se-probe.ts (#3500)
 *
 * Probe/CLI pra validar a integração com a API pública da apoia.se AO VIVO —
 * é o `--dry-run` do desbloqueio de credencial (#573): o COORDENADOR roda
 * isto (nunca um subagente autônomo) pra confirmar que `APOIA_SE_API_KEY` /
 * `APOIA_SE_API_SECRET` / `APOIA_SE_CAMPAIGN` (em `.env.local`) estão
 * corretos, antes de qualquer integração consumir `checkBacker`.
 *
 * Uso:
 *   npx tsx scripts/apoia-se-probe.ts --email foo@bar.com
 *   npx tsx scripts/apoia-se-probe.ts --email foo@bar.com --cache-dir /tmp/x  # override p/ debug/teste
 *
 * Env (obrigatórios, .env.local — ver .env.example):
 *   APOIA_SE_API_KEY
 *   APOIA_SE_API_SECRET
 *   APOIA_SE_CAMPAIGN
 *
 * Custo: 1 chamada real à API por invocação SEM cache prévio pro mês
 * corrente (teto 5.000 req/mês) — `checkBacker` cacheia por mês-competência
 * (BRT) em `data/apoia-se/{campaign}/{YYYY-MM}.json` (`--cache-dir` só pra
 * apontar pra outro lugar — testes usam isso pra nunca tocar o `data/` real),
 * então re-rodar o probe pro mesmo e-mail no mesmo mês não gasta uma 2ª chamada.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  checkBacker,
  readApoiaSeEnv,
  ApoiaSeAuthError,
  ApoiaSeApiError,
} from "./lib/apoia-se.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

// .env.local (precedência) + .env — loader canônico do projeto (#923).
loadProjectEnv();

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const email = getArg(argv, "email");
  if (!email) {
    console.error("Uso: npx tsx scripts/apoia-se-probe.ts --email <email>");
    process.exit(1);
  }

  try {
    readApoiaSeEnv();
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    console.error(
      "   configure APOIA_SE_API_KEY, APOIA_SE_API_SECRET e APOIA_SE_CAMPAIGN no .env.local (ver .env.example).",
    );
    process.exit(1);
    return;
  }

  const cacheDir = getArg(argv, "cache-dir") || undefined;

  try {
    const status = await checkBacker(email, cacheDir ? { cacheDir } : {});
    console.error(`apoia.se — ${email}`);
    console.error(`  isBacker:           ${status.isBacker}`);
    console.error(`  isPaidThisMonth:    ${status.isPaidThisMonth}`);
    console.error(
      `  thisMonthPaidValue: ${status.thisMonthPaidValue != null ? status.thisMonthPaidValue : "(não retornado — e-mail não encontrado ou não pago)"}`,
    );
    console.log(JSON.stringify(status, null, 2));
  } catch (e) {
    if (e instanceof ApoiaSeAuthError) {
      console.error(`❌ ${e.message}`);
    } else if (e instanceof ApoiaSeApiError) {
      console.error(`❌ erro da API apoia.se (HTTP ${e.status}): ${e.message}`);
    } else {
      console.error(`❌ ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
