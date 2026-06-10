#!/usr/bin/env node
/**
 * clarice-schedule-sends.ts (Edição Maio, ciclo 2605-06 — Semana 1 com A/B/C)
 *
 * Cria e agenda as campanhas Brevo da SEMANA 1 do plano de envio: 3 campanhas
 * por dia (células A/B/C, teste de assunto same-time), 06:00 BRT, d01=10/jun …
 * d07=16/jun. Mira as listas-célula criadas por clarice-split-cells.ts
 * (cells-summary.json). HTML = render aprovado (_internal/cloudflare-preview.html,
 * mesmo draftToEmail do publish-monthly, com merge tags Brevo).
 *
 * Fases (cada uma exige flag explícita; default = dry-run que só imprime o plano):
 *   --create       cria as 21 campanhas como RASCUNHO (nada é enviado)
 *   --send-test    manda test email das células d01-A/B/C pro test_email
 *   --schedule     agenda TODAS as campanhas criadas (06:00 BRT nas datas do plano)
 *
 * Uso típico:
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06                 # plano
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --create
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --send-test
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --schedule
 *
 * Estado em {ciclo}/sends/cells/campaigns-summary.json (idempotência: --create
 * pula campanhas já criadas; --schedule usa os IDs gravados).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoPut } from "./lib/brevo-client.ts";
import { clariceCycleDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { SENDS } from "./clarice-build-edition-sends.ts";
import { CELLS } from "./clarice-split-cells.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Assuntos do teste A/B/C (decisão do editor 2026-06-09; A corrigido — a lei NÃO foi aprovada). */
export const SUBJECTS: Record<string, string> = {
  A: "Notícias do mês sobre IA: marco da IA vai a voto e Brasil ganha unicórnio",
  B: "Notícias do mês sobre IA: Google retoma a liderança na corrida",
  C: "Notícias do mês sobre IA: Agentes tomaram postos de trabalho",
};
export const PREVIEW_TEXT =
  "Marco legal, unicórnio de IA e agentes substituindo equipes: maio foi o mês das decisões.";

/** d01=10/jun/2026 … d07=16/jun — 06:00 BRT (-03:00). */
export function scheduledAtFor(n: number): string {
  const day = 9 + n; // d01 -> 10
  return `2026-06-${String(day).padStart(2, "0")}T06:00:00-03:00`;
}

interface CellEntry { list: string; listId: number; count: number }
interface CampaignEntry {
  key: string; // "d01-A"
  campaignId: number;
  listId: number;
  subject: string;
  scheduledAt: string;
  status: "draft" | "scheduled";
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const doCreate = argv.includes("--create");
  const doTest = argv.includes("--send-test");
  const doSchedule = argv.includes("--schedule");

  const cellsDir = resolve(clariceCycleDir(cycle), "sends", "cells");
  const cellsSummaryPath = resolve(cellsDir, "cells-summary.json");
  if (!existsSync(cellsSummaryPath)) {
    throw new Error(`cells-summary.json não existe — rode clarice-split-cells.ts --execute antes.`);
  }
  const cells: { label: string; results: CellEntry[] } = JSON.parse(readFileSync(cellsSummaryPath, "utf8"));
  const listByKey = new Map<string, CellEntry>();
  for (const r of cells.results) {
    const m = r.list.match(/d(\d{2})-([ABC])/);
    if (m) listByKey.set(`d${m[1]}-${m[2]}`, r);
  }

  const htmlPath = resolve(ROOT, "data", "monthly", "2605", "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) throw new Error(`HTML render não existe: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");

  const campaignsPath = resolve(cellsDir, "campaigns-summary.json");
  const campaigns: CampaignEntry[] = existsSync(campaignsPath)
    ? JSON.parse(readFileSync(campaignsPath, "utf8"))
    : [];
  const byKey = new Map(campaigns.map((c) => [c.key, c]));

  const week1 = SENDS.filter((s) => s.week === 1);

  // --- Plano (sempre imprime) ---
  console.error(`\n📋 Campanhas S1 — ${week1.length} dias × ${CELLS.length} células = ${week1.length * CELLS.length} campanhas`);
  for (const s of week1) {
    for (const cell of CELLS) {
      const key = `d${String(s.n).padStart(2, "0")}-${cell}`;
      const entry = listByKey.get(key);
      const existing = byKey.get(key);
      console.error(
        `  ${key} (${s.day} ${scheduledAtFor(s.n)})  lista #${entry?.listId ?? "?"} (${entry?.count ?? "?"})  assunto ${cell}` +
          (existing ? `  [campanha #${existing.campaignId} ${existing.status}]` : ""),
      );
    }
  }
  if (!doCreate && !doTest && !doSchedule) {
    console.error(`\ndry-run — use --create, depois --send-test, depois --schedule.`);
    return;
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const brevo = cfg.brevo_monthly;
  if (!brevo?.sender_email) throw new Error("brevo_monthly.sender_email ausente no platform.config.json");

  // --- create (rascunhos; idempotente) ---
  if (doCreate) {
    for (const s of week1) {
      for (const cell of CELLS) {
        const key = `d${String(s.n).padStart(2, "0")}-${cell}`;
        if (byKey.has(key)) {
          console.error(`↷ ${key} já criada (#${byKey.get(key)!.campaignId}) — pulando`);
          continue;
        }
        const entry = listByKey.get(key);
        if (!entry) throw new Error(`lista-célula não encontrada pra ${key}`);
        const resp = (await brevoPost(apiKey, "/emailCampaigns", {
          name: `Clarice News 2605 ${key} (${s.day})`,
          subject: SUBJECTS[cell],
          previewText: PREVIEW_TEXT,
          sender: { name: brevo.sender_name, email: brevo.sender_email },
          recipients: { listIds: [entry.listId] },
          htmlContent: html,
        })) as { id?: number };
        if (typeof resp?.id !== "number") throw new Error(`/emailCampaigns shape inesperado: ${JSON.stringify(resp)}`);
        const c: CampaignEntry = {
          key,
          campaignId: resp.id,
          listId: entry.listId,
          subject: SUBJECTS[cell],
          scheduledAt: scheduledAtFor(s.n),
          status: "draft",
        };
        campaigns.push(c);
        byKey.set(key, c);
        writeFileAtomic(campaignsPath, JSON.stringify(campaigns, null, 2)); // persiste a cada criação (crash-safe)
        console.error(`✓ ${key} → campanha #${resp.id} (rascunho)`);
      }
    }
  }

  // --- send-test (d01-A/B/C → test_email) ---
  if (doTest) {
    for (const cell of CELLS) {
      const c = byKey.get(`d01-${cell}`);
      if (!c) throw new Error(`campanha d01-${cell} não criada — rode --create antes.`);
      await brevoPost(apiKey, `/emailCampaigns/${c.campaignId}/sendTest`, { emailTo: [brevo.test_email] });
      console.error(`✓ test email d01-${cell} (campanha #${c.campaignId}) → ${brevo.test_email}`);
    }
  }

  // --- schedule (todas as criadas) ---
  if (doSchedule) {
    for (const c of campaigns) {
      if (c.status === "scheduled") {
        console.error(`↷ ${c.key} já agendada — pulando`);
        continue;
      }
      await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { scheduledAt: c.scheduledAt });
      c.status = "scheduled";
      writeFileAtomic(campaignsPath, JSON.stringify(campaigns, null, 2));
      console.error(`✓ ${c.key} agendada → ${c.scheduledAt}`);
    }
  }

  console.log(JSON.stringify({ created: campaigns.length, scheduled: campaigns.filter((c) => c.status === "scheduled").length }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
