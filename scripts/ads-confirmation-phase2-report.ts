#!/usr/bin/env node
/**
 * scripts/ads-confirmation-phase2-report.ts (#8543, fase 2)
 *
 * CLI SOMENTE LEITURA: compara, por canal pago (Google, Meta), cadastro ×
 * pageview de `/confirmada` × import da confirmação × confirmados reais.
 * Sem rede, sem escrita — só lê arquivos locais em `data/` (fontes e limites
 * na docstring de `scripts/lib/ads-confirmation-phase2-report.ts`).
 *
 * Fail-soft: fonte ausente ou ilegível vira nota no relatório e a coluna sai
 * como `n/d`; sem o roster do Kit (a base de tudo) imprime o motivo e sai com
 * exit 0 sem relatório. Nunca muda campanha, meta, CPA nem teto — fase 3 é do
 * editor.
 *
 * Uso:
 *   npx tsx scripts/ads-confirmation-phase2-report.ts [--since AAAA-MM-DD] [--until AAAA-MM-DD]
 *     [--data-root <dir>] [--format text|json]
 *
 * Default da janela: 2026-09-27 (fim do teste 2608, início da fase 2) até hoje (BRT).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import {
  brtDay,
  buildPhase2Report,
  extractConfirmadaFromGa4Cache,
  renderPhase2ReportText,
  type Phase2Ga4Confirmada,
  type Phase2IndexEntry,
  type Phase2RosterEntry,
} from "./lib/ads-confirmation-phase2-report.ts";
import { loadConfirmationIndex } from "./lib/google-ads-confirmation-batch.ts";
import { loadMetaConfirmationIndex } from "./lib/meta-capi-confirmation-batch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PHASE2_DEFAULT_SINCE = "2026-09-27";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Phase2Paths {
  roster: string;
  googleIndex: string;
  metaIndex: string;
  ga4Latest: string;
}

export function phase2Paths(dataRoot: string): Phase2Paths {
  return {
    roster: resolve(dataRoot, "kit-sub-state", "current.json"),
    googleIndex: resolve(dataRoot, "google-ads", "_confirmation-conversions-sent.json"),
    metaIndex: resolve(dataRoot, "meta-capi", "_confirmation-sent.json"),
    ga4Latest: resolve(dataRoot, "ga4-cache", "latest.json"),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Lê as fontes; nunca lança. `roster: null` = sem base pro relatório. */
export function loadPhase2Sources(paths: Phase2Paths): {
  roster: Phase2RosterEntry[] | null;
  googleIndex: Record<string, Phase2IndexEntry> | null;
  metaIndex: Record<string, Phase2IndexEntry> | null;
  ga4: Phase2Ga4Confirmada | null;
  notes: string[];
} {
  const notes: string[] = [];
  let roster: Phase2RosterEntry[] | null = null;
  if (!existsSync(paths.roster)) {
    notes.push(`roster do Kit ausente (${paths.roster}) — gerado por kit-subscriber-state-transition-alarm.ts no servidor 300`);
  } else {
    try {
      const parsed = JSON.parse(readFileSync(paths.roster, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("esperado array JSON");
      roster = parsed as Phase2RosterEntry[];
    } catch (e) {
      notes.push(`roster do Kit ilegível (${paths.roster}): ${errMsg(e)}`);
    }
  }
  let googleIndex: Record<string, Phase2IndexEntry> | null = null;
  if (!existsSync(paths.googleIndex)) notes.push(`índice do lote Google ausente (${paths.googleIndex})`);
  else {
    try {
      googleIndex = loadConfirmationIndex(paths.googleIndex);
    } catch (e) {
      notes.push(`índice do lote Google ilegível: ${errMsg(e)}`);
    }
  }
  let metaIndex: Record<string, Phase2IndexEntry> | null = null;
  if (!existsSync(paths.metaIndex)) notes.push(`índice do lote Meta ausente (${paths.metaIndex})`);
  else {
    try {
      metaIndex = loadMetaConfirmationIndex(paths.metaIndex);
    } catch (e) {
      notes.push(`índice do lote Meta ilegível: ${errMsg(e)}`);
    }
  }
  let ga4: Phase2Ga4Confirmada | null = null;
  if (!existsSync(paths.ga4Latest)) notes.push(`cache do GA4 ausente (${paths.ga4Latest})`);
  else {
    try {
      ga4 = extractConfirmadaFromGa4Cache(JSON.parse(readFileSync(paths.ga4Latest, "utf8")));
      if (!ga4) notes.push("cache do GA4 sem a página /confirmada em top_pages");
    } catch (e) {
      notes.push(`cache do GA4 ilegível: ${errMsg(e)}`);
    }
  }
  return { roster, googleIndex, metaIndex, ga4, notes };
}

export function runPhase2Report(
  argv: string[],
  now: Date = new Date(),
): { exitCode: number; stdout: string; stderr: string } {
  const since = getArg(argv, "since") || PHASE2_DEFAULT_SINCE;
  const until = getArg(argv, "until") || brtDay(now.toISOString())!;
  const format = getArg(argv, "format") || "text";
  const dataRoot = getArg(argv, "data-root") || resolve(ROOT, "data");
  for (const [name, v] of [["since", since], ["until", until]] as const) {
    if (!DATE_RE.test(v)) return { exitCode: 2, stdout: "", stderr: `--${name} deve ser AAAA-MM-DD (recebido "${v}")\n` };
  }
  if (since > until) return { exitCode: 2, stdout: "", stderr: `--since (${since}) depois de --until (${until})\n` };
  if (format !== "text" && format !== "json") {
    return { exitCode: 2, stdout: "", stderr: `--format deve ser text|json (recebido "${format}")\n` };
  }
  const src = loadPhase2Sources(phase2Paths(dataRoot));
  if (!src.roster) {
    return {
      exitCode: 0,
      stdout: "",
      stderr:
        "[ads-confirmation-phase2-report] relatório não gerado: sem o roster do Kit não há cadastros nem confirmados a comparar.\n" +
        src.notes.map((n) => `- ${n}\n`).join("") +
        "Rode no servidor 300 (onde data/ tem as fontes) ou passe --data-root.\n",
    };
  }
  const report = buildPhase2Report({
    roster: src.roster,
    googleIndex: src.googleIndex,
    metaIndex: src.metaIndex,
    ga4: src.ga4,
    since,
    until,
    sourceNotes: src.notes,
  });
  return {
    exitCode: 0,
    stdout: format === "json" ? JSON.stringify(report, null, 2) + "\n" : renderPhase2ReportText(report),
    stderr: "",
  };
}

if (isMainModule(import.meta.url)) {
  const r = runPhase2Report(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.exitCode;
}
