/**
 * test/monthly-paths-group-campaigns-4783.test.ts (#4783)
 *
 * `resolveSubjectFromCampaignsSummary` só lia `{ciclo}/sends/cells/campaigns-summary.json`
 * (escrito por `clarice-schedule-sends.ts --create`, pipeline canônico multi-bloco).
 * Ciclos montados via `--group` (`clarice-schedule-group.ts`) escrevem em
 * `{ciclo}/segments/group-campaigns.json` — nunca em `campaigns-summary.json`.
 * Resultado: `/diaria-clarice-novos` abortava TODA rodada num ciclo `--group`
 * pedindo `--subject` explícito, anulando o regime "sem gate humano" da skill.
 *
 * Cobre os 3 cenários exigidos pela issue:
 *   1. só group-campaigns.json + vencedora clara (pluralidade estrita) -> resolve.
 *   2. A/B/C empatado -> NÃO resolve, mantém o abort do #4621.
 *   3. campaigns-summary.json presente -> precedência inalterada (canônico vence).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSubjectFromGroupCampaigns,
  resolveSubjectFromCampaignsSummary,
  resolveSubjectForCycle,
} from "../scripts/lib/mensal/monthly-paths.ts";

function writeGroupCampaigns(root: string, cycle: string, entries: Array<{ subject?: string }>): void {
  const dir = join(root, cycle, "segments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "group-campaigns.json"),
    JSON.stringify(
      entries.map((e, i) => ({
        key: `k${i}`,
        campaignId: 1000 + i,
        listId: 1,
        status: "sent",
        ...e,
      })),
    ),
    "utf8",
  );
}

function writeCampaignsSummary(root: string, cycle: string, entries: Array<{ subject?: string }>): void {
  const dir = join(root, cycle, "sends", "cells");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "campaigns-summary.json"), JSON.stringify(entries), "utf8");
}

// Cenário real do ciclo 2607-08 em 260808 (issue #4783): A/B/C empatados
// 5x5x5 em d1-d5, depois A entra em rollout solo (d6-d8) e abre vantagem —
// 8 (A) x 5 (B) x 5 (C). Pluralidade estrita: 8 > 5, resolve A.
const CELL_A = "Notícias do mês sobre IA: Agentes saem do controle";
const CELL_B = "Notícias do mês sobre IA: outro título B";
const CELL_C = "Notícias do mês sobre IA: outro título C";

function abcTiedThenSoloWinner(): Array<{ subject: string }> {
  const entries: Array<{ subject: string }> = [];
  // d1-d5: 5 campanhas por célula, empatadas.
  for (let i = 0; i < 5; i++) {
    entries.push({ subject: CELL_A }, { subject: CELL_B }, { subject: CELL_C });
  }
  // d6-d8: rollout solo da vencedora A.
  for (let i = 0; i < 3; i++) {
    entries.push({ subject: CELL_A });
  }
  return entries;
}

test("resolveSubjectFromGroupCampaigns: vencedora clara (pluralidade estrita, caso real 2607-08) -> resolve sem fallback pro --subject manual", () => {
  const root = mkdtempSync(join(tmpdir(), "monthly-group-campaigns-"));
  try {
    writeGroupCampaigns(root, "2607-08", abcTiedThenSoloWinner());
    const subject = resolveSubjectFromGroupCampaigns("2607-08", root);
    assert.equal(subject, CELL_A);
    // A precedência combinada também resolve — sem campaigns-summary.json no ciclo.
    assert.equal(resolveSubjectForCycle("2607-08", root), CELL_A);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubjectFromGroupCampaigns: A/B/C empatado (sem pluralidade estrita) -> undefined, mantém o abort pedindo --subject", () => {
  const root = mkdtempSync(join(tmpdir(), "monthly-group-campaigns-tied-"));
  try {
    // Só a fase balanceada: 5x5x5, sem rollout solo — ninguém abre vantagem.
    const entries: Array<{ subject: string }> = [];
    for (let i = 0; i < 5; i++) {
      entries.push({ subject: CELL_A }, { subject: CELL_B }, { subject: CELL_C });
    }
    writeGroupCampaigns(root, "2607-08", entries);
    assert.equal(resolveSubjectFromGroupCampaigns("2607-08", root), undefined);
    // A precedência combinada também fica sem assunto — comportamento do #4621 preservado.
    assert.equal(resolveSubjectForCycle("2607-08", root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubjectForCycle: campaigns-summary.json presente -> precedência inalterada (canônico vence, group-campaigns.json ignorado)", () => {
  const root = mkdtempSync(join(tmpdir(), "monthly-campaigns-summary-precedence-"));
  try {
    // Pipeline canônico já resolveu um assunto...
    writeCampaignsSummary(root, "2605-06", [{ subject: "Assunto canônico" }, { subject: "Assunto canônico" }]);
    // ...e o MESMO ciclo também tem group-campaigns.json com um vencedor DIFERENTE
    // (cenário artificial pra provar que a precedência não muda: canônico sempre vence).
    writeGroupCampaigns(root, "2605-06", abcTiedThenSoloWinner());

    assert.equal(resolveSubjectFromCampaignsSummary("2605-06", root), "Assunto canônico");
    assert.equal(resolveSubjectForCycle("2605-06", root), "Assunto canônico");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubjectForCycle: sem campaigns-summary.json e sem group-campaigns.json -> undefined", () => {
  const root = mkdtempSync(join(tmpdir(), "monthly-nenhum-arquivo-"));
  try {
    assert.equal(resolveSubjectForCycle("2607-08", root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubjectFromGroupCampaigns: arquivo ausente -> undefined (sem lançar)", () => {
  const root = mkdtempSync(join(tmpdir(), "monthly-group-campaigns-ausente-"));
  try {
    assert.equal(resolveSubjectFromGroupCampaigns("2607-08", root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
