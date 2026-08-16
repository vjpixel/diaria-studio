#!/usr/bin/env node
/**
 * clarice-sunset-damage-report.ts (#5401)
 *
 * READ-ONLY. Nunca escreve no store, nunca chama a Brevo. Relatório de
 * escopo do dano causado pela subcontagem de `opens_count` (#5401): quantos
 * contatos estão hoje cortados por `sunset_non_opener` agrupados pelo mês do
 * `last_sent_at`, mesma tabela que o corpo da issue usou pra medir o dano
 * (14.922 cortes concentrados em envios de 2026-07).
 *
 * ─── Por que isto NÃO é uma ferramenta de reversão ────────────────────────
 *
 * `classifyEligibility` (`lib/clarice-db.ts`) é uma função PURA, recomputada
 * do zero a cada `recomputeDerived`/`clarice-build-db.ts`, a partir de
 * `sends_count`/`opens_count`/`brevo_modified_at` do momento —
 * `ineligible_reason` não é uma decisão persistida, é derivada. Confirmado
 * pelo próprio editor no comentário de correção da issue #5401: uma vez que
 * `opens_count` seja corrigido (via re-sync com o fix de concorrência deste
 * PR — `runOpensCatchup` agora alcança as ~49 campanhas da janela em vez de
 * travar nas mais antigas), a elegibilidade se recompõe SOZINHA no próximo
 * `clarice-build-db.ts`: quem de fato abriu volta a ser elegível, quem de
 * fato não abriu continua cortado. Nenhuma mutação manual de
 * `send_eligible`/`ineligible_reason` é necessária nem seria correta — um
 * script que "desbanisse" contatos escrevendo direto nessas colunas seria
 * IGNORADO no próximo recompute (que já é automático, roda em toda sync) e
 * arriscaria mascarar contatos que genuinamente nunca abriram.
 *
 * Este relatório existe só pra dar visibilidade ANTES de rodar o re-sync
 * (blast radius: potencialmente milhares de contatos voltando a ser
 * elegíveis para envio de uma vez, o que muda o tamanho de fila/segmento —
 * decisão de supervisão, não automação cega, mesmo a recomputação sendo
 * mecânica). Requer sessão LOCAL com o junction `data/` — não roda a partir
 * de sessão cloud (a issue já foi explícita: a re-sincronização em si exige
 * `/diaria-develop` com o editor presente).
 *
 * Uso:
 *   npx tsx scripts/clarice-sunset-damage-report.ts [--db <path>]
 *
 * Stdout: JSON. Stderr: progresso.
 */
import type { DatabaseSync } from "node:sqlite";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

export interface SunsetDamageReport {
  generated_at: string;
  total_sunset_cut: number;
  /** Chave = "YYYY-MM" (mês de `last_sent_at`) ou "(null)" quando ausente. */
  by_last_sent_month: Record<string, number>;
}

/**
 * Pura (dado um `DatabaseSync` já aberto) — testável com fixture sem
 * depender do junction `data/`. Só SELECT — nenhuma escrita.
 */
export function computeSunsetDamageReport(db: DatabaseSync): SunsetDamageReport {
  const total = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM clarice_users WHERE send_eligible = 0 AND ineligible_reason = 'sunset_non_opener'",
      )
      .get() as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT substr(last_sent_at, 1, 7) AS month, COUNT(*) AS n
         FROM clarice_users
        WHERE send_eligible = 0 AND ineligible_reason = 'sunset_non_opener'
        GROUP BY month`,
    )
    .all() as Array<{ month: string | null; n: number }>;

  const by_last_sent_month: Record<string, number> = {};
  for (const r of rows) {
    by_last_sent_month[r.month ?? "(null)"] = r.n;
  }

  return {
    generated_at: new Date().toISOString(),
    total_sunset_cut: total,
    by_last_sent_month,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const db = openClariceDb(dbPath);
  try {
    const report = computeSunsetDamageReport(db);
    console.log(JSON.stringify(report, null, 2));
    console.error(
      "[clarice-sunset-damage-report] READ-ONLY — nenhuma linha foi alterada. " +
        "A correção é automática (recomputeDerived) no próximo sync bem-sucedido " +
        "com o fix de concorrência deste PR (#5401); não existe (nem deveria existir) " +
        "um script de reversão manual — ver docstring.",
    );
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[clarice-sunset-damage-report] erro:", e);
    process.exit(1);
  });
}
