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
 * Gasto e cadastros no NÍVEL DE CONTA (Google GAQL, Microsoft Reporting
 * API, Meta Graph `insights`, Kit `/v4/subscribers`) — o mesmo caminho da
 * página `/ads` do Studio (`scripts/lib/ads-campaign-economics-fetch.ts`).
 * O braço Microsoft soma PMax (571543153) + Search (571615527): a fonte é
 * nível de conta, então as 2 campanhas já vêm somadas — ver #8256 pra
 * separação por campanha (fora do escopo desta unidade).
 *
 * Os cadastros do Kit aqui são CONTAGEM BRUTA — `fetchKitSignupsByChannel`
 * (a mesma função que alimenta `/ads`) não exclui os e-mails de teste do
 * próprio editor (`vjpixel+...`/`pixel@memelab.com.br`). A exclusão continua
 * manual, como no SKILL.md local (Passo 2) — o número aqui é o ponto de
 * partida pro agente, não o CAC final. Achado registrado em #8349 (gap
 * genérico de `fetchKitSignupsByChannel`, fora do escopo desta unidade —
 * afeta também o dashboard `/ads`, não só este relatório).
 *
 * ## Workaround de ambiente (Neo)
 *
 * `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN`
 * (identidade Google usada pela renovação de token do Microsoft Ads) vêm
 * poluídas no ambiente do processo em algumas máquinas — achado ao vivo em
 * 17/09/2026 (#8237): o app desktop do Claude Code injeta
 * `GOOGLE_CLIENT_ID`/`SECRET` pro próprio uso interno, sem relação com este
 * repo. `loadProjectEnv()` nunca sobrescreve var já presente (precedência
 * deliberada, `warnOnEnvDivergence` só avisa) — então, SÓ pra estas 3
 * chaves, este script força o valor de `.env` por cima do ambiente. Um
 * `Unauthorized` na fonte Microsoft depois de `loadProjectEnv()` sem este
 * force seria esse mesmo sintoma.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Só estas 3 — nunca generalizar o force pra outras chaves (#8237: a
 *  precedência "ambiente vence" é deliberada em todo o resto do projeto,
 *  `test/env-loader.test.ts` trava isso). @pure — recebe o texto do .env
 *  já lido, nunca lê disco. */
export function forceFromDotenvText(envText: string, keys: readonly string[], target: NodeJS.ProcessEnv): void {
  for (const key of keys) {
    const m = envText.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m) target[key] = m[1].replace(/^"|"$/g, "");
  }
}

export const FORCE_FROM_DOTENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN"] as const;

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

/** Formata a tabela dia/cadastros-acumulados de um canal (Kit, contagem
 *  bruta — ver aviso de teste-email na docstring do módulo). @pure */
export function formatSignupsTable(canal: string, rows: readonly { date: string; cadastros: number }[]): string {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let acc = 0;
  const lines = [`\n${canal} — cadastros Kit (contagem bruta, sem excluir e-mail de teste)\ndata        cadastros  acumulado`];
  for (const r of sorted) {
    acc += r.cadastros;
    lines.push(`${r.date}  ${String(r.cadastros).padStart(9)}  ${String(acc).padStart(9)}`);
  }
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadProjectEnv(ROOT);
  const envText = readFileSync(resolve(ROOT, ".env"), "utf8");
  forceFromDotenvText(envText, FORCE_FROM_DOTENV_KEYS, process.env);

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
  const lookbackDays = Math.ceil((now.getTime() - Date.parse(`${d0}T00:00:00-03:00`)) / 86_400_000) + 1;
  const kitApiKey = process.env.KIT_API_KEY;

  const res = await fetchCampaignEconomicsSources(fetch, kitApiKey ? { apiKey: kitApiKey } : null, { now, lookbackDays });

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

  const spendByCanal = new Map<string, { date: string; gastoBrl: number }[]>();
  for (const m of res.metrics) {
    if (m.date < d0) continue;
    if (!spendByCanal.has(m.canal)) spendByCanal.set(m.canal, []);
    spendByCanal.get(m.canal)!.push({ date: m.date, gastoBrl: m.gastoBrl });
  }
  for (const [canal, rows] of spendByCanal) console.log(formatSpendTable(canal, rows));

  const signupsByCanal = new Map<string, { date: string; cadastros: number }[]>();
  for (const s of res.signups) {
    if (s.date < d0) continue;
    if (!signupsByCanal.has(s.canal)) signupsByCanal.set(s.canal, []);
    signupsByCanal.get(s.canal)!.push({ date: s.date, cadastros: s.cadastros });
  }
  for (const [canal, rows] of signupsByCanal) console.log(formatSignupsTable(canal, rows));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`ads-live-spend-signups: erro fatal — ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
