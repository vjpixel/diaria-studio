#!/usr/bin/env npx tsx
/**
 * onboarding-form-conversas.ts (#10605 v3)
 *
 * Lista LOCAL, só de leitura, de quem marcou no formulário que toparia uma
 * conversa de 20 minutos (`conversa`), para o editor escolher com quem falar
 * por perfil. Lê `GET /api/respostas` do Worker (token de
 * `onboarding.followup.form_responses_token_env`, do .env/Doppler) e usa a
 * resposta mais recente de cada e-mail.
 *
 * Mostra e-mail, data, `uso_ia`, `situacao`, `area`, `motivacao`,
 * `dificuldades`, `maior_gasto` e o relato de falha (`relato_falha`). Os
 * textos livres (relato e "Outro/Outra") só saem AQUI, no terminal de quem
 * roda; nunca vão para o perfil de audiência nem para arquivo versionado.
 * Não grava nada, não chama o Kit.
 *
 * Filtros (todos opcionais, combinam com E; o valor casa por trecho, sem
 * diferença de maiúscula/acento):
 *   --uso-ia <trecho> --situacao <trecho> --area <trecho> --motivacao <trecho>
 *   --dificuldade <trecho> --maior-gasto <trecho> --desde AAAA-MM-DD
 * Saída: tabela em texto (padrão) ou `--json`.
 *
 * Uso:
 *   npx tsx scripts/onboarding-form-conversas.ts
 *   npx tsx scripts/onboarding-form-conversas.ts --situacao "próprio negócio" --uso-ia "elaboradas"
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { CliExit, runCli } from "./lib/cli-exit.ts";
import { latestFormResponses, otherTextFieldId, splitMultiAnswer, type FormResponse } from "./lib/onboarding-form-contract.ts";
import { resolveFollowupConfig, type FollowupConfigRaw } from "./lib/onboarding-followup.ts";
import { fetchFormResponsesReal } from "./onboarding-followup-run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ConversaRow {
  email: string;
  data: string;
  uso_ia: string;
  situacao: string;
  area: string;
  motivacao: string;
  dificuldades: string;
  maior_gasto: string;
  relato_falha: string;
}

/** Filtros por pergunta (trecho) e data mínima. */
export interface ConversaFilters {
  uso_ia?: string;
  situacao?: string;
  area?: string;
  motivacao?: string;
  dificuldades?: string;
  maior_gasto?: string;
  desde?: string;
}

const FILTER_FLAGS: Record<string, keyof ConversaFilters> = {
  "--uso-ia": "uso_ia",
  "--situacao": "situacao",
  "--area": "area",
  "--motivacao": "motivacao",
  "--dificuldade": "dificuldades",
  "--maior-gasto": "maior_gasto",
  "--desde": "desde",
};

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Valor da pergunta com o texto do "Outro/Outra" junto, quando houver. */
function withOther(answers: Readonly<Record<string, string>>, id: string): string {
  const v = answers[id] ?? "";
  const other = answers[otherTextFieldId({ id })];
  return other ? `${v} (${other})` : v;
}

/** @pure — quem topou conversar (resposta mais recente por e-mail), filtrado, mais recente primeiro. */
export function conversaRows(responses: readonly FormResponse[], filters: ConversaFilters = {}): ConversaRow[] {
  const rows: ConversaRow[] = [];
  for (const r of latestFormResponses(responses)) {
    if (!r.answers.conversa || r.answers.conversa.trim() === "") continue;
    const a = r.answers;
    rows.push({
      email: r.email,
      data: r.submitted_at.slice(0, 10),
      uso_ia: a.uso_ia ?? "",
      situacao: a.situacao ?? "",
      area: withOther(a, "area"),
      motivacao: withOther(a, "motivacao"),
      dificuldades: [splitMultiAnswer(a.dificuldades ?? "").join("; "), a.dificuldades_outro ? `(${a.dificuldades_outro})` : ""].filter(Boolean).join(" "),
      maior_gasto: a.maior_gasto ?? "",
      relato_falha: a.relato_falha ?? "",
    });
  }
  const keep = rows.filter((row) => {
    for (const [k, v] of Object.entries(filters) as [keyof ConversaFilters, string | undefined][]) {
      if (v == null || v === "") continue;
      if (k === "desde") {
        if (row.data < v) return false;
        continue;
      }
      if (!fold(row[k]).includes(fold(v))) return false;
    }
    return true;
  });
  return keep.sort((x, y) => (x.data < y.data ? 1 : x.data > y.data ? -1 : 0));
}

/** @pure — tabela em texto, um bloco por pessoa (o relato pode ser longo). */
export function renderConversaTable(rows: readonly ConversaRow[]): string {
  if (rows.length === 0) return "Ninguém marcou a conversa (com esses filtros).";
  const out = [`${rows.length} pessoa(s) toparam conversar:`, ""];
  for (const r of rows) {
    out.push(`${r.data}  ${r.email}`);
    out.push(`  uso de IA:    ${r.uso_ia}`);
    out.push(`  situação:     ${r.situacao}`);
    out.push(`  área:         ${r.area}`);
    out.push(`  objetivo:     ${r.motivacao}`);
    out.push(`  atrapalha:    ${r.dificuldades}`);
    out.push(`  maior gasto:  ${r.maior_gasto}`);
    if (r.relato_falha) out.push(`  relato:       ${r.relato_falha.replace(/\n+/g, " / ")}`);
    out.push("");
  }
  return out.join("\n");
}

/** `AAAA-MM-DD` que existe no calendário (a comparação com a data da resposta é por texto). */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function parseConversaArgs(argv: readonly string[]): { filters: ConversaFilters; json: boolean } {
  const filters: ConversaFilters = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--json") json = true;
    else if (f in FILTER_FLAGS) {
      const v = argv[++i];
      if (v == null) throw new Error(`${f} sem valor`);
      if (f === "--desde" && !isIsoDate(v)) throw new Error(`--desde precisa de uma data AAAA-MM-DD válida (veio "${v}")`);
      filters[FILTER_FLAGS[f]] = v;
    } else throw new Error(`flag desconhecida: ${f}`);
  }
  return { filters, json };
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseConversaArgs>;
  try {
    args = parseConversaArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`[onboarding-form-conversas] ${(e as Error).message}\n`);
    throw new CliExit(2);
  }
  loadProjectEnv();
  const raw = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as { onboarding?: { followup?: FollowupConfigRaw } };
  const cfg = resolveFollowupConfig(raw.onboarding?.followup);
  const rows = conversaRows(await fetchFormResponsesReal(cfg), args.filters);
  console.log(args.json ? JSON.stringify(rows, null, 2) : renderConversaTable(rows));
}

if (isMainModule(import.meta.url)) {
  void runCli(main, { onError: (e) => process.stderr.write(`[onboarding-form-conversas] erro: ${(e as Error).message}\n`) });
}
