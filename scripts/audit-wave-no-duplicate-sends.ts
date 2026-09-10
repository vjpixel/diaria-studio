#!/usr/bin/env node
/**
 * audit-wave-no-duplicate-sends.ts (#7880)
 *
 * Responde "algum contato da onda recém-montada (`{group}.csv`, saída de
 * `clarice-build-segment.ts`) já recebeu/vai receber e-mail Clarice/Brevo AO
 * VIVO dentro do `--month` alvo, por uma via que o guard de recência
 * (`last_sent_at`, #7234) e o dedup cycle-wide (`sent-or-queued.json`) não
 * enxergam?" — os dois guards existentes leem só o STORE LOCAL; se o store
 * estiver defasado, eles concordam com a defasagem e não acusam nada. Ver
 * `scripts/lib/clarice-wave-audit.ts` (lógica pura) pro racional completo e
 * a armadilha `suspended`/data-fictícia que este script evita por
 * CONSTRUÇÃO (só consulta `status=sent`/`status=queued`, nunca
 * `suspended`/`draft`).
 *
 * READ-ONLY POR CONSTRUÇÃO — não escreve nada, não agenda, não dispara.
 * Verificação PÓS-montagem (o `{group}.csv` já existe em disco, produzido
 * por `clarice-build-segment.ts`) — não bloqueante por padrão: reporta a
 * colisão e sai com exit code 2 (mesmo padrão de `clarice-audit-overlap.ts`/
 * `clarice-plan-wave.ts` pra "sucesso com blockers"), quem chama decide se
 * trata como bloqueio.
 *
 * Uso:
 *   npx tsx scripts/audit-wave-no-duplicate-sends.ts --cycle 2608-09 --group engajados [--month 2026-09] [--exclude-list 62,63] [--json]
 *
 *   --cycle X          obrigatório — {conteúdo}-{envio} do ciclo cuja onda foi montada.
 *   --group X          obrigatório — nome do grupo nomeado (mesmo `--group` de
 *                       clarice-build-segment.ts) cujo `{group}.csv` será auditado.
 *   --month YYYY-MM    opcional — mês-calendário a auditar contra a Brevo ao vivo.
 *                       Default: mês de ENVIO do `--cycle` (`cycleSendMonthStartIso`).
 *   --exclude-list N,M opcional — list_ids Brevo a IGNORAR na checagem (ex: a
 *                       lista da PRÓPRIA onda, se já importada/agendada antes
 *                       desta auditoria rodar — nunca deveria colidir consigo).
 *   --db PATH          opcional — override do store SQLite (default: produção).
 *   --data-root DIR    opcional, uso interno de teste — mesmo padrão de
 *                       `clarice-build-segment.ts` (#4207): onde ler `{group}.csv`.
 *   --json              imprime o resultado como JSON em vez de texto legível.
 *
 * Env: `BREVO_CLARICE_API_KEY` (obrigatória).
 *
 * Exit codes: 0 nenhuma colisão · 1 erro (credencial ausente, cota baixa,
 * arquivo do grupo ausente, falha de rede) · 2 colisão encontrada.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { requireCycleArg, clariceSegmentsDir, cycleSendMonthStartIso } from "./lib/clarice-paths.ts";
import { assertCampaignQuotaHeadroom, fetchCampaignsByStatus } from "./lib/brevo-client.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { loadStoreRows } from "./lib/clarice-segment.ts";
import { extractCsvEmails } from "./clarice-import-waves.ts";
import {
  monthWindowIso,
  buildLiveListIndex,
  mergeLiveListIndexes,
  findWaveListCollisions,
  type WaveContact,
  type WaveCollision,
} from "./lib/clarice-wave-audit.ts";

loadProjectEnv();

export function renderWaveAuditReport(checked: number, month: string, collisions: WaveCollision[]): string {
  if (collisions.length === 0) {
    return `✅ nenhuma colisão — ${checked} contato(s) da onda verificado(s) contra a Brevo ao vivo em ${month}.`;
  }
  const lines = [
    `⚠️  ${collisions.length} de ${checked} contato(s) da onda já receberam/estão agendados pra receber e-mail Brevo em ${month} (fonte: API ao vivo, não o store local):`,
  ];
  for (const c of collisions) {
    const camps = c.campaigns
      .map((camp) => `#${camp.id ?? "?"} "${camp.name ?? "?"}" (${camp.status ?? "?"}, ${camp.date ?? "sem data"})`)
      .join(", ");
    lines.push(`  ${c.email} — lista(s) ${c.listIds.join(", ")}: ${camps}`);
  }
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    throw new Error("BREVO_CLARICE_API_KEY ausente — sem ela não dá pra consultar a Brevo.");
  }

  const cycle = requireCycleArg(argv);
  const group = getStringArg(argv, "group", { example: "engajados" });
  if (!group) {
    throw new Error("--group é obrigatório (ex: --group engajados).");
  }
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dataRoot = getArg(argv, "data-root") || undefined;
  const monthArg = getStringArg(argv, "month", { example: "2026-09" });
  const month = monthArg || cycleSendMonthStartIso(cycle).slice(0, 7);
  const excludeListArg = getArg(argv, "exclude-list");
  const excludeListIds = new Set(
    excludeListArg
      ? excludeListArg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

  // #5697/#7880: consumidor READ-ONLY/diagnóstico — recusa gastar cota da
  // família /emailCampaigns* se já estiver abaixo da reserva que o caminho
  // de ESCRITA (clarice-build-segment.ts/clarice-plan-wave.ts) precisa.
  assertCampaignQuotaHeadroom();

  const csvPath = resolve(clariceSegmentsDir(cycle, dataRoot), `${group}.csv`);
  if (!existsSync(csvPath)) {
    throw new Error(
      `${csvPath} não existe — rode clarice-build-segment.ts --cycle ${cycle} --group ${group} antes de auditar.`,
    );
  }
  const emails = extractCsvEmails(readFileSync(csvPath, "utf8"));

  const window = monthWindowIso(month);

  let contacts: WaveContact[] = [];
  if (emails.length > 0) {
    const db = openClariceDb(dbPath);
    try {
      const storeRows = loadStoreRows(db);
      const listIdsByEmail = new Map(storeRows.map((r) => [r.email.trim().toLowerCase(), r.brevo_list_ids]));
      contacts = emails.map((email) => ({ email, brevo_list_ids: listIdsByEmail.get(email) ?? null }));
    } finally {
      db.close();
    }
  }

  const [sentCampaigns, queuedCampaigns] = await Promise.all([
    fetchCampaignsByStatus(apiKey, "sent"),
    fetchCampaignsByStatus(apiKey, "queued"),
  ]);
  const sentIndex = buildLiveListIndex(sentCampaigns, "sent", window, excludeListIds);
  const queuedIndex = buildLiveListIndex(queuedCampaigns, "queued", window, excludeListIds);
  const liveIndex = mergeLiveListIndexes(sentIndex, queuedIndex);

  const collisions = findWaveListCollisions(contacts, liveIndex);

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify({ cycle, group, month, checked: contacts.length, collisions }, null, 2));
  } else {
    console.log(renderWaveAuditReport(contacts.length, month, collisions));
  }

  if (collisions.length > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
