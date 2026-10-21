/**
 * scripts/ads-live-spend-signups.ts (#8246)
 *
 * Porta pro repo o `gasto-ao-vivo.mts` que só existia em
 * `~/.claude/scheduled-tasks/relatorio-diario-teste-2608/` (máquina Neo,
 * fora do git) — Passo 1 (gasto por braço) da task local. Estendido pra
 * também imprimir os cadastros do Kit por canal/dia (Passo 2), já que
 * `fetchCampaignEconomicsSources` busca as duas coisas na mesma chamada —
 * o script original só imprimia gasto.
 *
 * Gasto e cadastros no NÍVEL DE CONTA (Google GAQL, Meta Graph `insights`,
 * Kit `/v4/subscribers`) — o mesmo caminho da página `/ads` do Studio
 * (`scripts/lib/ads-campaign-economics-fetch.ts`).
 *
 * **Microsoft Ads saiu no #10755** (canal encerrado em 21/10/2026): o gasto
 * do braço não é mais buscado ao vivo, e com ele saíram a seção "Quebra por
 * campanha (Microsoft Ads, #8256)" e o workaround que forçava 3 variáveis
 * do `.env` por cima do ambiente (#8237 — só existia pra renovação do token
 * do Microsoft Ads). Os cadastros com `utm_source=microsoft-ads` continuam
 * aparecendo na tabela de cadastros, porque vêm do Kit.
 *
 * Os cadastros do Kit aqui JÁ EXCLUEM os e-mails de teste do próprio editor
 * desde o #8349: `fetchKitSignupsByChannel` (a mesma função que alimenta
 * `/ads`) filtra por `isEditorTestSignupEmail`, que reusa
 * `isEditorTestEmail`/`EDITOR_TEST_EMAIL_PATTERN` (plus-address
 * `vjpixel+…@gmail.com`) e `EDITOR_WORKSPACE_EMAIL` (`pixel@memelab.com.br`).
 * **Não subtraia de novo à mão** — descartar o que o código já tirou conta o
 * mesmo cadastro duas vezes e infla o CAC, que é o oposto do que a exclusão
 * pretende. O e-mail simples do editor (sem plus-address) segue fora do filtro
 * de propósito (#8349). O único caso que ainda pede olho humano é um endereço
 * de teste que não casa nenhum desses padrões (domínio novo, por exemplo) — aí
 * o certo é estender o filtro no código, não corrigir só na prosa.
 *
 * Uso, a partir da raiz do repo:
 *   npx tsx scripts/ads-live-spend-signups.ts
 *   npx tsx scripts/ads-live-spend-signups.ts --json
 *
 * Exit codes:
 *   0 — rodou (mesmo com alguma fonte em erro — isso aparece na saída, não
 *       aborta o script; um braço sem dado é informação, não falha)
 *   1 — `run-state.json` ausente/ilegível (sem `d0` não há janela pra medir)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { fetchCampaignEconomicsSources } from "./lib/ads-campaign-economics-fetch.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { daysBetween, formatDateOnly } from "./lib/ads-test-schedule.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RunStateShape {
  d0?: string;
  fim_janela?: string;
  coorte_madura?: string;
  apuracao_snapshot?: string;
  revisao?: { pausa?: { inicio?: string; fim?: string } };
}

/** Formata a tabela dia/gasto-acumulado de um canal. @pure */
export function formatSpendTable(canal: string, rows: readonly { date: string; gastoBrl: number }[]): string {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let acc = 0;
  const lines = [`\n${canal}\ndata        gasto_dia  acumulado`];
  for (const r of sorted) {
    acc += r.gastoBrl;
    lines.push(`${r.date}  ${r.gastoBrl.toFixed(2).padStart(9)}  ${acc.toFixed(2).padStart(9)}`);
  }
  return lines.join("\n");
}

/** Formata a tabela dia/cadastros-acumulados de um canal (Kit; o e-mail de
 *  teste do editor JÁ vem excluído da fonte, #8349 — ver docstring do
 *  módulo: não subtrair de novo à mão). @pure */
export function formatSignupsTable(canal: string, rows: readonly { date: string; cadastros: number }[]): string {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let acc = 0;
  const lines = [`\n${canal} — cadastros Kit (e-mail de teste do editor já excluído, #8349)\ndata        cadastros  acumulado`];
  for (const r of sorted) {
    acc += r.cadastros;
    lines.push(`${r.date}  ${String(r.cadastros).padStart(9)}  ${String(acc).padStart(9)}`);
  }
  return lines.join("\n");
}

/** Agrupa uma lista `{canal, date, ...}` por canal, descartando dias
 *  anteriores a `d0` — mesmo filtro que as 2 tabelas "por braço" abaixo já
 *  aplicavam inline; extraído (#8256) pra também servir a quebra por
 *  campanha sem repetir o loop uma 3ª vez. @pure */
export function groupByCanalSince<T extends { canal: string; date: string }, R>(
  rows: readonly T[],
  d0: string,
  pick: (row: T) => R,
): Map<string, R[]> {
  const byCanal = new Map<string, R[]>();
  for (const row of rows) {
    if (row.date < d0) continue;
    if (!byCanal.has(row.canal)) byCanal.set(row.canal, []);
    byCanal.get(row.canal)!.push(pick(row));
  }
  return byCanal;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv(ROOT);

  const runStatePath = resolve(ROOT, "data/aquisicao/teste-2608/run-state.json");
  if (!existsSync(runStatePath)) {
    console.error(`ads-live-spend-signups: run-state.json ausente em ${runStatePath}`);
    process.exitCode = 1;
    return;
  }
  const runState = JSON.parse(readFileSync(runStatePath, "utf8")) as RunStateShape;
  const d0 = runState.d0;
  if (!d0) {
    console.error("ads-live-spend-signups: run-state.json sem d0 — sem janela pra medir.");
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  // Aritmética de calendário pura (dias corridos, sem hora-do-dia) — nunca
  // `Date.parse` + subtração de epoch, que fica sensível à hora em que o
  // script roda (achado do review da #8246: um `now` à noite soma quase 1
  // dia inteiro a mais que um `now` de manhã pro MESMO `d0`).
  const lookbackDays = daysBetween(d0, formatDateOnly(now)) + 1;
  const kitConfig = resolveKitConfig();

  const res = await fetchCampaignEconomicsSources(fetch, kitConfig.ok ? kitConfig.config : null, {
    now,
    lookbackDays,
    kitDateRangeStart: d0,
  });

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify({ runState, corte: now.toISOString(), ...res }, null, 2));
    return;
  }

  console.log(
    `run-state: d0=${d0} fim_janela=${runState.fim_janela ?? "?"} coorte_madura=${runState.coorte_madura ?? "?"} apuracao=${runState.apuracao_snapshot ?? "?"}`,
  );
  if (runState.revisao?.pausa) console.log(`pausa: ${runState.revisao.pausa.inicio} -> ${runState.revisao.pausa.fim}`);
  console.log(`corte: ${now.toISOString()} (o dia de hoje é PARCIAL)\n`);

  for (const [fonte, s] of Object.entries(res.sources)) {
    console.log(`${fonte}: ${s.error ? `ERRO — ${s.error}` : "ok"}`);
  }

  const spendByCanal = groupByCanalSince(res.metrics, d0, (m) => ({ date: m.date, gastoBrl: m.gastoBrl }));
  for (const [canal, rows] of spendByCanal) console.log(formatSpendTable(canal, rows));

  const signupsByCanal = groupByCanalSince(res.signups, d0, (s) => ({ date: s.date, cadastros: s.cadastros }));
  for (const [canal, rows] of signupsByCanal) console.log(formatSignupsTable(canal, rows));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`ads-live-spend-signups: erro fatal — ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
