/**
 * weekly-summaries-passes.ts (#11065)
 *
 * Humanizador + Clarice nos resumos da retro semanal (`/diaria-retro-semanal`,
 * Passo 2c), entre o agente `weekly-summary-writer` e o preview/gate. Mesma
 * ordem da diária (Stage 2): Humanizador, depois Clarice. O Humanizador é uma
 * skill (roda no top-level, edita os campos `summary` do JSON em lugar); este
 * script cuida do que é determinístico em volta:
 *
 *   snapshot   Guarda a versão do agente em `summary_raw` (só onde ainda não
 *              existe — idempotente). Rodar ANTES do Humanizador.
 *   humanized  Marca o fim do Humanizador: copia `summary` pra
 *              `summary_humanized`, grava `passes.humanizador = "ok"` e
 *              revalida.
 *   clarice    Aplica a Clarice sobre `summary_humanized`, grava o final em
 *              `summary` e revalida. Três fontes:
 *                --suggestions S.json  sugestões que o top-level coletou do MCP
 *                                      `mcp__clarice__correct_text`, 1 chamada
 *                                      por resumo, serial: { "<url>": [ {from,to}, ... ] }
 *                --rest                fallback REST (`CLARICE_API_KEY`), mesmo
 *                                      engine do `clarice-correct.ts` (#1329)
 *                --failed "motivo"     MCP e REST fora: registra a falha e
 *                                      mantém o texto humanizado (sem halt — o
 *                                      texto é curto e o editor revisa no gate).
 *              --rest que falha também cai no registro de falha, sem abortar.
 *              Aborta (exit 2) se `summary` divergir da saída do último passe
 *              (ajuste manual): reaplicar sobre `summary_humanized` descartaria
 *              o ajuste. Recuperação: rodar `humanized` de novo, depois `clarice`.
 *
 * Revalidação: depois de `humanized` e de `clarice`, o texto FINAL passa de novo
 * por `validateWeeklySummary` — o Humanizador pode alongar e a Clarice mexe em
 * pontuação, então teto de 200 caracteres, 2 frases e repetição do título valem
 * sobre o que vai pra legenda. Problema encontrado → lista no stderr e exit 1
 * (o `publish-weekly-social.ts --schedule` também barra; aqui o aviso chega
 * antes do preview).
 *
 * Uso:
 *   npx tsx scripts/weekly-summaries-passes.ts snapshot  --path {06-summaries.json}
 *   npx tsx scripts/weekly-summaries-passes.ts humanized --path {06-summaries.json}
 *   npx tsx scripts/weekly-summaries-passes.ts clarice   --path {06-summaries.json} --suggestions {S.json}
 *   npx tsx scripts/weekly-summaries-passes.ts clarice   --path {06-summaries.json} --rest
 *   npx tsx scripts/weekly-summaries-passes.ts clarice   --path {06-summaries.json} --failed "MCP e REST fora"
 *
 * Exit codes: 0 ok · 1 algum resumo final não passa na validação · 2 args/IO/estado inválido.
 */

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyClariceSuggestions, type ClariceSuggestion } from "./clarice-apply.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { withClariceRetry, type RetryPolicy, DEFAULT_RETRY_POLICY } from "./lib/clarice-correct-engine.ts";
import { validateWeeklySummary, type WeeklySummariesFile } from "./lib/weekly-summaries.ts";

export function loadSummariesFile(path: string): WeeklySummariesFile {
  if (!existsSync(path)) throw new Error(`arquivo não existe: ${path} (rode o agente weekly-summary-writer antes)`);
  let data: WeeklySummariesFile;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as WeeklySummariesFile;
  } catch (e) {
    throw new Error(`06-summaries.json corrompido (${path}): ${(e as Error).message}`);
  }
  if (!data || !Array.isArray(data.items)) throw new Error(`06-summaries.json sem "items" (${path})`);
  data.items.forEach((it, i) => {
    if (!it || typeof it.url !== "string" || typeof it.summary !== "string") {
      throw new Error(`06-summaries.json: entrada ${i + 1} sem "url"/"summary" em texto (${path})`);
    }
  });
  return data;
}

function save(path: string, data: WeeklySummariesFile): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Guarda a versão do agente em `summary_raw` onde ainda não existe. Zera `passes` só quando há resumo novo. */
export function snapshotRaw(data: WeeklySummariesFile): { snapshotted: number } {
  let snapshotted = 0;
  for (const it of data.items) {
    if (typeof it.summary_raw !== "string") {
      it.summary_raw = it.summary;
      delete it.summary_humanized;
      delete it.summary_clarice;
      snapshotted++;
    }
  }
  if (snapshotted > 0) delete data.passes;
  return { snapshotted };
}

/** Fim do Humanizador. Lança se o snapshot não rodou (sem ele não há rastro da versão do agente). */
export function markHumanized(data: WeeklySummariesFile): void {
  const missing = data.items.filter((it) => typeof it.summary_raw !== "string");
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} resumo(s) sem summary_raw — rode "snapshot" antes do Humanizador (ou o Humanizador reescreveu a estrutura do JSON)`,
    );
  }
  for (const it of data.items) {
    it.summary_humanized = it.summary.trim();
    delete it.summary_clarice;
  }
  data.passes = { humanizador: "ok" };
}

function requireHumanized(data: WeeklySummariesFile): void {
  if (data.passes?.humanizador !== "ok" || data.items.some((it) => typeof it.summary_humanized !== "string")) {
    throw new Error('Humanizador não registrado — rode "humanized" antes da Clarice (a ordem é a da diária)');
  }
  const edited = manuallyEdited(data);
  if (edited.length > 0) {
    throw new Error(
      `ajuste manual detectado em ${edited.length} resumo(s) (${edited.map((it) => it.title ?? it.url).join("; ")}): ` +
        '"summary" mudou depois do último passe. A Clarice parte de "summary_humanized" e descartaria o ajuste — ' +
        'rode "humanized" de novo (o texto editado vira a nova base) e só então "clarice".',
    );
  }
}

/**
 * Itens cujo `summary` não bate com a saída do último passe registrado
 * (Clarice ok → `summary_clarice`; senão → `summary_humanized`): sinal de
 * edição à mão depois do passe. Reaplicar a Clarice sobre `summary_humanized`
 * jogaria esse ajuste fora em silêncio.
 */
export function manuallyEdited(data: WeeklySummariesFile): WeeklySummariesFile["items"] {
  return data.items.filter((it) => {
    const expected = data.passes?.clarice === "ok" ? it.summary_clarice : it.summary_humanized;
    return typeof expected === "string" && it.summary.trim() !== expected.trim();
  });
}

/** Aplica sugestões (por URL) sobre `summary_humanized`; o resultado vira `summary`. */
export function applyClarice(
  data: WeeklySummariesFile,
  byUrl: Record<string, ClariceSuggestion[]>,
  via: "mcp" | "rest",
): { applied: number; skipped: number } {
  requireHumanized(data);
  let applied = 0;
  let skipped = 0;
  for (const it of data.items) {
    const base = it.summary_humanized as string;
    const suggestions = byUrl[it.url] ?? [];
    const r = applyClariceSuggestions(base, suggestions);
    it.summary = r.patched.trim();
    it.summary_clarice = it.summary;
    applied += r.applied.length;
    skipped += r.skipped.length;
  }
  data.passes = { ...data.passes, humanizador: "ok", clarice: "ok", clarice_via: via, clarice_skipped: skipped };
  delete data.passes.clarice_error;
  return { applied, skipped };
}

/** MCP e REST fora: o texto final é o humanizado, e a falha fica registrada pro preview avisar. */
export function markClariceFailed(data: WeeklySummariesFile, reason: string): void {
  requireHumanized(data);
  for (const it of data.items) {
    it.summary = it.summary_humanized as string;
    delete it.summary_clarice;
  }
  data.passes = { humanizador: "ok", clarice: "falhou", clarice_error: reason || "sem detalhe" };
}

/**
 * Fallback REST: 1 chamada por resumo, SERIAL (#4952 — concorrência é o que
 * derruba o cortex.clarice.ai). Qualquer falha vira `clarice: "falhou"` em
 * todo o arquivo (nunca metade corrigida, metade não, sem registro).
 */
export async function runClariceRest(
  data: WeeklySummariesFile,
  opts: { apiKey: string; fetchImpl?: typeof fetch; policy?: RetryPolicy; sleepFn?: (ms: number) => Promise<void> },
): Promise<{ ok: true; applied: number; skipped: number } | { ok: false; reason: string }> {
  requireHumanized(data);
  const byUrl: Record<string, ClariceSuggestion[]> = {};
  try {
    for (const it of data.items) {
      const r = await withClariceRetry(
        { apiKey: opts.apiKey, text: it.summary_humanized as string, fetchImpl: opts.fetchImpl },
        opts.policy ?? DEFAULT_RETRY_POLICY,
        opts.sleepFn,
      );
      byUrl[it.url] = r.suggestions as ClariceSuggestion[];
    }
  } catch (e) {
    const reason = `REST: ${(e as Error).message}`.slice(0, 300);
    markClariceFailed(data, reason);
    return { ok: false, reason };
  }
  return { ok: true, ...applyClarice(data, byUrl, "rest") };
}

/** Revalida o texto FINAL (`summary`) de cada item contra o título. */
export function revalidate(data: WeeklySummariesFile): { title: string; url: string; problems: string[] }[] {
  return data.items
    .map((it) => ({ title: it.title ?? it.url, url: it.url, problems: validateWeeklySummary(it.title ?? "", it.summary) }))
    .filter((x) => x.problems.length > 0);
}

function report(data: WeeklySummariesFile): number {
  const bad = revalidate(data);
  for (const b of bad) console.error(`[weekly-summaries-passes] resumo inválido em "${b.title}": ${b.problems.join("; ")}`);
  if (bad.length > 0) {
    console.error(
      "[weekly-summaries-passes] o texto final precisa passar nas regras do #11062 — encurte/reescreva esses itens no JSON (campo summary) e rode o passo de novo.",
    );
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const { values, flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const path = values.path;
  if (!cmd || !path || !["snapshot", "humanized", "clarice"].includes(cmd)) {
    console.error("uso: weekly-summaries-passes.ts {snapshot|humanized|clarice} --path {06-summaries.json} [--suggestions S.json | --rest | --failed motivo]");
    return 2;
  }
  let data: WeeklySummariesFile;
  try {
    data = loadSummariesFile(path);
  } catch (e) {
    console.error(`ERRO: ${(e as Error).message}`);
    return 2;
  }
  try {
    if (cmd === "snapshot") {
      const { snapshotted } = snapshotRaw(data);
      save(path, data);
      console.log(`snapshot: ${snapshotted} resumo(s) do agente guardado(s) em summary_raw (${path})`);
      return 0;
    }
    if (cmd === "humanized") {
      markHumanized(data);
      save(path, data);
      const changed = data.items.filter((it) => it.summary_humanized !== it.summary_raw?.trim()).length;
      console.log(`humanizador: registrado (${changed}/${data.items.length} resumo(s) mudaram) em ${path}`);
      return report(data);
    }
    // clarice
    const sources = [values.suggestions !== undefined, flags.has("rest"), values.failed !== undefined || flags.has("failed")].filter(Boolean).length;
    if (sources !== 1) {
      console.error("ERRO: clarice exige exatamente uma fonte: --suggestions S.json, --rest ou --failed \"motivo\"");
      return 2;
    }
    if (values.suggestions !== undefined) {
      let byUrl: Record<string, ClariceSuggestion[]>;
      try {
        byUrl = JSON.parse(readFileSync(values.suggestions, "utf8"));
      } catch (e) {
        console.error(`ERRO: sugestões ilegíveis (${values.suggestions}): ${(e as Error).message}`);
        return 2;
      }
      if (!byUrl || typeof byUrl !== "object" || Array.isArray(byUrl)) {
        console.error('ERRO: --suggestions espera { "<url>": [ {from,to}, ... ] } (1 entrada por resumo)');
        return 2;
      }
      const missing = data.items.filter((it) => !Array.isArray(byUrl[it.url])).map((it) => it.url);
      if (missing.length > 0) {
        console.error(`ERRO: sem sugestões (nem lista vazia) para ${missing.length} resumo(s): ${missing.join(", ")} — a Clarice rodou em todos?`);
        return 2;
      }
      const r = applyClarice(data, byUrl, "mcp");
      save(path, data);
      console.log(`clarice (mcp): ${r.applied} sugestão(ões) aplicada(s), ${r.skipped} pulada(s) em ${path}`);
      return report(data);
    }
    if (flags.has("rest")) {
      const apiKey = process.env.CLARICE_API_KEY;
      if (!apiKey) {
        markClariceFailed(data, "MCP fora e CLARICE_API_KEY ausente");
        save(path, data);
        console.error("[weekly-summaries-passes] aviso: CLARICE_API_KEY ausente — Clarice registrada como falha, segue o texto humanizado");
        return report(data);
      }
      const r = await runClariceRest(data, { apiKey });
      save(path, data);
      if (r.ok) console.log(`clarice (rest): ${r.applied} sugestão(ões) aplicada(s), ${r.skipped} pulada(s) em ${path}`);
      else console.error(`[weekly-summaries-passes] aviso: Clarice falhou (${r.reason}) — segue o texto humanizado, o preview avisa`);
      return report(data);
    }
    markClariceFailed(data, values.failed ?? "MCP e REST fora");
    save(path, data);
    console.error(`[weekly-summaries-passes] aviso: Clarice registrada como falha — segue o texto humanizado, o preview avisa`);
    return report(data);
  } catch (e) {
    console.error(`ERRO: ${(e as Error).message}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
