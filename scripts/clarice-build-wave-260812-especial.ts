#!/usr/bin/env node
/**
 * clarice-build-wave-260812-especial.ts (one-off, sessão 260810/11)
 *
 * Onda especial do ciclo 2607-08, decidida com o editor em chat (não é um
 * NAMED_GROUP recorrente — composição multi-tier específica desta rodada):
 *
 *   Tier 1 — jurídico (isJuridicoEmail), qualquer score
 *   Tier 2 — não-jurídico, score>0 ("os outros")
 *   Tier 3 — cohort='assinantes-ativos', score=0
 *   Tier 4 — cohort='leads-2026-08', score=0
 *   Tier 5 — cohort='leads-2026-07', score=0
 *   Tier 6 — cohort='leads-2024h1', score=0, ordenado por `created` DESC
 *            (mais recentes primeiro) — único tier cortado por budget.
 *
 * Todos os tiers passam pelos MESMOS guards que `clarice-build-segment.ts`
 * usa pros 4 grupos nomeados: dedup por ciclo (`sent-or-queued.json`, #3227),
 * corte de recência automático (início do mês de ENVIO do ciclo, #4765) e
 * checagem AO VIVO de campanha comprometida — escopo "committed" (queued ∪
 * sent), o mesmo escopo de `ramp-warm`/`novos` (grupos de 1º-envio-do-mês),
 * porque esta onda também é "não recebeu ainda este mês", não um re-envio.
 *
 * BUDGET fixo: 3000 (decisão do editor). Se o universo pós-guards não fechar
 * 3000 exatamente, o script ABORTA sem escrever nada — não expande nem
 * encolhe o pedido em silêncio.
 *
 * Uso:
 *   npx tsx scripts/clarice-build-wave-260812-especial.ts --dry-run
 *   npx tsx scripts/clarice-build-wave-260812-especial.ts            # escreve
 *
 * Saída (mesmo shape que clarice-build-segment.ts, pra clarice-import-waves.ts
 * consumir via --group d12-qua12):
 *   data/clarice-subscribers/2607-08/segments/d12-qua12.csv
 *   data/clarice-subscribers/2607-08/segments/d12-qua12-priority-snapshot.csv
 *   data/clarice-subscribers/2607-08/segments/d12-qua12-manifest.json
 *   sent-or-queued.json atualizado (união, nunca remove)
 *
 * NÃO EXERCITADO EM TESTE — one-off editorial, mesma disciplina de
 * transparência dos demais scripts de sessão sem cobertura (#4320/#4382/
 * #4490/#4534/#4572): revisar o resumo impresso com atenção antes de confiar
 * no output.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { isJuridicoEmail } from "./lib/clarice-sector.ts";
import { isTestAccount } from "./lib/cohorts.ts";
import { clariceSegmentsDir, cycleSendMonthStartIso, ensureDir } from "./lib/clarice-paths.ts";
import { hasFlag } from "./lib/cli-args.ts";
import { fetchCommittedCampaignListIds } from "./lib/brevo-client.ts";
import { excludeCommittedToQueuedCampaigns, type StoreRow } from "./lib/clarice-segment.ts";
import { waveKey } from "./lib/clarice-wave-plan.ts";
import { firstName } from "./lib/clarice-name.ts";

loadProjectEnv();

const CYCLE = "2607-08";
const BUDGET = 3000;
// #4657: numeração vem do próprio clarice-plan-wave.ts (startingWaveNumber),
// não digitada — reconsultado ao vivo em 2026-08-11 02:43 UTC: d11-ter11
// (agendada pra 2026-08-11) está "suspended" e não conta no state.waves
// vivo (só sent até d10-seg10) nem no scheduledCount (0) — o planejador
// recalculou "11" como próximo número livre pra 2026-08-12. Usar d11-qua12
// (não d12) pra ficar alinhado com essa contagem canônica.
const WAVE_N = 11;
const WAVE_DATE = "2026-08-12";

interface Row extends StoreRow {
  name: string | null;
  created: string | null;
}

interface SentOrQueuedFile {
  cycle: string;
  emails: string[];
  history: Array<{ group: string; count: number; at: string }>;
}

function loadSentOrQueued(segDir: string): Set<string> {
  const file = resolve(segDir, "sent-or-queued.json");
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SentOrQueuedFile>;
    if (!Array.isArray(parsed.emails)) return new Set();
    return new Set(parsed.emails.map((e) => String(e).trim().toLowerCase()));
  } catch {
    return new Set();
  }
}

function appendSentOrQueued(segDir: string, cycle: string, group: string, newEmails: string[]): void {
  ensureDir(segDir);
  const file = resolve(segDir, "sent-or-queued.json");
  let existingEmails: string[] = [];
  let history: SentOrQueuedFile["history"] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SentOrQueuedFile>;
      if (Array.isArray(parsed.emails)) existingEmails = parsed.emails.map(String);
      if (Array.isArray(parsed.history)) history = parsed.history;
    } catch {
      // recomeça do zero, mesma postura tolerante do original
    }
  }
  const emailSet = new Set(existingEmails.map((e) => e.trim().toLowerCase()));
  for (const e of newEmails) emailSet.add(e.trim().toLowerCase());
  const merged: SentOrQueuedFile = {
    cycle,
    emails: [...emailSet].sort(),
    history: [...history, { group, count: newEmails.length, at: new Date().toISOString() }],
  };
  writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
}

function buildPrioritySnapshotCsv(selected: Row[]): string {
  const rows = selected.map((r) => ({
    email: r.email,
    priority_points: r.priority_points ?? 0,
    cohort: r.cohort ?? "",
    priority_optin: r.priority_optin ? 1 : 0,
  }));
  return Papa.unparse({ fields: ["email", "priority_points", "cohort", "priority_optin"], data: rows });
}

async function main(): Promise<void> {
  const dryRun = hasFlag(process.argv.slice(2), "dry-run");
  const monthStart = cycleSendMonthStartIso(CYCLE);
  const segDir = clariceSegmentsDir(CYCLE);

  const db = openClariceDb(DEFAULT_DB_PATH);
  const rows = db
    .prepare(
      `SELECT email, name, cohort, priority_points, priority_optin, send_eligible, ineligible_reason,
              sends_count, opens_count, last_sent_at, mv_bucket, brevo_list_ids, created, brevo_modified_at
       FROM clarice_users WHERE send_eligible = 1`,
    )
    .all() as unknown as Row[];
  db.close();
  console.error(`universo bruto (send_eligible=1): ${rows.length}`);

  // guard 1: test accounts (#2895) — internos (#4434) NÃO são mais excluídos.
  const notTest = rows.filter((r) => !isTestAccount(r.email));
  console.error(`- contas de teste excluídas: ${rows.length - notTest.length}`);

  // guard 2: dedup por ciclo (#3227)
  const sentOrQueued = loadSentOrQueued(segDir);
  const afterDedup = notTest.filter((r) => !sentOrQueued.has(r.email.trim().toLowerCase()));
  console.error(`- já selecionado(s) este ciclo (sent-or-queued.json): ${notTest.length - afterDedup.length}`);

  // guard 3: recência automática (#4765) — início do mês de ENVIO do ciclo
  const afterRecency = afterDedup.filter((r) => !r.last_sent_at || r.last_sent_at < monthStart);
  console.error(
    `- last_sent_at >= ${monthStart} excluído(s): ${afterDedup.length - afterRecency.length}`,
  );

  // guard 4: campanha comprometida AO VIVO (queued ∪ sent — escopo "committed",
  // mesmo escopo de ramp-warm/novos porque esta onda é 1º-envio-do-mês)
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("❌ BREVO_CLARICE_API_KEY ausente — necessária mesmo em --dry-run aqui (onda real).");
    process.exit(1);
  }
  let guardListIds: Set<string>;
  try {
    guardListIds = await fetchCommittedCampaignListIds(apiKey);
  } catch (err) {
    console.error(`❌ falha ao consultar campanhas agendadas/disparadas na Brevo: ${String((err as Error)?.message ?? err)}`);
    process.exit(1);
  }
  const universe = excludeCommittedToQueuedCampaigns(afterRecency, guardListIds) as Row[];
  console.error(
    `- excluído(s) por campanha agendada/disparada (guard ao vivo, ${guardListIds.size} lista(s) comprometida(s)): ${afterRecency.length - universe.length}`,
  );
  console.error(`universo final pós-guards: ${universe.length}`);

  // Tiers
  const juridico = universe.filter((r) => isJuridicoEmail(r.email));
  const naoJuridico = universe.filter((r) => !isJuridicoEmail(r.email));
  const outrosEngajados = [...naoJuridico.filter((r) => (r.priority_points ?? 0) > 0)].sort(
    (a, b) => (b.priority_points ?? 0) - (a.priority_points ?? 0) || a.email.localeCompare(b.email),
  );
  const ativosZero = naoJuridico.filter((r) => r.cohort === "assinantes-ativos" && (r.priority_points ?? 0) === 0);
  const ago26Zero = naoJuridico.filter((r) => r.cohort === "leads-2026-08" && (r.priority_points ?? 0) === 0);
  const jul26Zero = naoJuridico.filter((r) => r.cohort === "leads-2026-07" && (r.priority_points ?? 0) === 0);
  const zero2024h1 = [...naoJuridico.filter((r) => r.cohort === "leads-2024h1" && (r.priority_points ?? 0) === 0)].sort(
    (a, b) => (b.created ?? "").localeCompare(a.created ?? "") || a.email.localeCompare(b.email),
  );

  const tiers: Array<{ name: string; rows: Row[] }> = [
    { name: "tier1_juridico", rows: juridico },
    { name: "tier2_outros_engajados", rows: outrosEngajados },
    { name: "tier3_assinantes_ativos_score0", rows: ativosZero },
    { name: "tier4_leads_2026-08_score0", rows: ago26Zero },
    { name: "tier5_leads_2026-07_score0", rows: jul26Zero },
    { name: "tier6_leads_2024h1_score0_recentes", rows: zero2024h1 },
  ];

  let remaining = BUDGET;
  const selected: Row[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    const take = Math.min(tier.rows.length, Math.max(0, remaining));
    let taken = 0;
    for (const r of tier.rows) {
      if (taken >= take) break;
      const key = r.email.toLowerCase();
      if (seen.has(key)) continue; // segurança extra (não deveria colidir entre tiers, mas nunca conta 2x)
      seen.add(key);
      selected.push(r);
      taken++;
    }
    remaining -= taken;
    console.error(`  ${tier.name.padEnd(35)} tomado ${taken} de ${tier.rows.length} disponíveis (resta ${remaining})`);
  }

  const total = BUDGET - remaining;
  console.error(`TOTAL selecionado: ${total} de ${BUDGET} pedidos`);
  if (total !== BUDGET) {
    console.error(
      `❌ não fechou ${BUDGET} exatos (deu ${total}) — abortando sem escrever. ` +
        `Universo mudou desde a última prévia (guards ao vivo/novos registros) — revisar composição com o editor.`,
    );
    process.exit(1);
  }

  const key = waveKey(WAVE_N, WAVE_DATE);
  const file = `${key}.csv`;
  const csvRows = selected.map((r) => ({ email: r.email, NOME: firstName(r.name) }));
  const csv = Papa.unparse({ fields: ["email", "NOME"], data: csvRows });
  const manifestEntry = {
    key,
    file,
    // Brevo rejeita nome de lista longo demais (visto ao vivo: ~130 chars
    // falhou com "List name is invalid", 400). Desc curto de propósito —
    // listNameFor() concatena "Clarice {label} {key} — {desc}", então tanto
    // --label (no import) quanto este desc precisam ficar enxutos.
    desc: "Onda especial 12/08",
    count: selected.length,
  };

  if (dryRun) {
    console.error(`ℹ️  dry-run — nada escrito. ${selected.length} contato(s) selecionado(s) pra '${key}'.`);
    console.log(JSON.stringify({ ...manifestEntry, dry_run: true }, null, 2));
    return;
  }

  ensureDir(segDir);
  writeFileSync(resolve(segDir, file), csv, "utf8");
  writeFileSync(resolve(segDir, `${key}-priority-snapshot.csv`), buildPrioritySnapshotCsv(selected), "utf8");
  writeFileSync(resolve(segDir, `${key}-manifest.json`), JSON.stringify([manifestEntry], null, 2), "utf8");
  appendSentOrQueued(segDir, CYCLE, key, selected.map((r) => r.email));
  console.error(`✅ ${selected.length} contato(s) em ${resolve(segDir, file)}`);
  console.log(JSON.stringify(manifestEntry, null, 2));
}

main().catch((e) => {
  console.error(String((e as Error)?.stack || e));
  process.exit(1);
});
