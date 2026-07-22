#!/usr/bin/env node
/**
 * weekly-send-plan-audience.ts (#2974) — Parte 2 (local) do planejador semanal
 * de rampa de envio cold.
 *
 * Split de arquitetura obrigatório (comentário do editor na issue): o worker
 * (`workers/brevo-dashboard/src/weekly-plan.ts`, aba "Rampa") decide os 3
 * volumes (maturação >48h → agregado de saúde → semáforo → plano) porque só
 * ele acessa o Brevo ao vivo; este script NÃO recalcula essa decisão — recebe
 * os 3 volumes já decididos como INPUT e só executa a seleção de audiência
 * sobre o store local (SQLite/OneDrive), que o worker não alcança.
 *
 * Audiência = `segmentRampWarm` (scripts/lib/clarice-segment.ts, #2885): 1º
 * envio (nunca recebeu, `sends_count=0`) + `send_eligible=1` + `mv_bucket=
 * 'verified'` (MillionVerifier limpo — só quem já foi verificado entra no 1º
 * contato, #1297) — OU cohort MV-isento (`isMvExemptCohort`, hoje só
 * `assinantes-ativos`; #3826: pagante nunca é submetido ao MV, então nunca
 * teria `mv_bucket` — o pagamento Stripe já valida o e-mail, mesmo racional
 * de #3819), ordenado por `cohortSendRank` (morno→frio, `assinantes-ativos`
 * rank 0). Mesmo grupo nomeado "ramp-warm" já usado por
 * `clarice-build-segment.ts` — reusado aqui sem duplicar a lógica de
 * filtro/ordem.
 *
 * Valida crédito Brevo do ciclo (`GET /v3/account`) cobre a soma dos volumes
 * ANTES de escrever qualquer coisa — nunca dimensionar depois do fato
 * (mesmo racional do guardrail "brevo-scheduled-campaigns-immutable").
 *
 * SEGURANÇA: só LÊ o store e ESCREVE CSVs locais — nunca envia/agenda nada.
 * dry-run por padrão (só imprime o plano); `--write` grava os arquivos.
 *
 * Uso:
 *   npx tsx scripts/weekly-send-plan-audience.ts --volumes 7000,7500,8000 [--write] [--db path] [--out-dir path]
 *   --volumes N,N,N   OBRIGATÓRIO — os 3 volumes (ter/sex/dom) decididos pela aba Rampa do dashboard.
 *   --write           grava wN.csv + manifest.json em data/clarice-subscribers/weekly-plan/{data-de-hoje}/
 *                      (default: dry-run, só imprime o plano).
 *   --db path         override do path do store (default DEFAULT_DB_PATH).
 *   --out-dir path    override do diretório de saída (default sob CLARICE_BASE).
 *
 * Requer BREVO_CLARICE_API_KEY no env (mesma convenção de clarice-import-waves.ts)
 * pra validar o crédito do plano — sem a chave, a validação de crédito é pulada
 * com warning (não bloqueia o dry-run; bloqueia o --write, fail-safe).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { excludeCommittedToQueuedCampaigns, segmentRampWarm, type StoreRow } from "./lib/clarice-segment.ts";
import { CLARICE_BASE, ensureDir } from "./lib/clarice-paths.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet, fetchCommittedCampaignListIds } from "./lib/brevo-client.ts";

/**
 * DUPLICADO de `extractPlanCredits` (workers/brevo-dashboard/src/brevo-api.ts,
 * #2910) — mesmo padrão de tipo/lógica duplicada entre bundles worker↔script
 * já usado no projeto (ver ContactsSummary em types.ts): importar direto do
 * worker puxa @cloudflare/workers-types (KVNamespace/CacheStorage) no
 * typecheck da raiz, que não tem esses ambient types. Mantida em sincronia
 * manualmente — mudança de shape em ambos os lugares.
 */
interface BrevoAccountPlan {
  type?: string;
  credits?: number;
  creditsType?: string;
}
interface BrevoAccountResponse {
  plan?: BrevoAccountPlan[];
}
function extractPlanCredits(account: BrevoAccountResponse | null | undefined): number | null {
  const plans = account?.plan;
  if (!Array.isArray(plans) || plans.length === 0) return null;
  const sendLimit = plans.find((p) => p.creditsType === "sendLimit" && typeof p.credits === "number");
  if (sendLimit) return sendLimit.credits as number;
  const first = plans.find((p) => typeof p.credits === "number");
  return typeof first?.credits === "number" ? first.credits : null;
}

export interface AudienceRow extends StoreRow {
  name: string | null;
}

export interface WeekPlanManifestEntry {
  key: string;
  file: string;
  desc: string;
  count: number;
}

const DAY_LABELS = ["ter", "sex", "dom"];

/** 1º nome p/ personalização — mesma convenção de clarice-build-waves-store.ts. */
function firstName(name: string | null): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
}

/** Parse de `--volumes N,N,N` — exatamente 3 inteiros > 0. Pura, testável. */
export function parseVolumesArg(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || !Number.isInteger(n))) return null;
  return nums;
}

/**
 * Fatia a audiência já ordenada (topo = mais prioritário) nos 3 volumes, na
 * ordem em que foram informados (ter/sex/dom). Não embaralha nem reordena —
 * respeita a ordem de `segmentRampWarm`. Pura, testável.
 */
export function sliceIntoVolumes<T>(ordered: T[], volumes: number[]): T[][] {
  const out: T[][] = [];
  let cursor = 0;
  for (const v of volumes) {
    out.push(ordered.slice(cursor, cursor + v));
    cursor += v;
  }
  return out;
}

export function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const volumes = parseVolumesArg(getArg(argv, "volumes"));
  if (!volumes) {
    console.error("❌ --volumes N,N,N é obrigatório — 3 inteiros > 0, separados por vírgula. Ex: --volumes 7000,7500,8000");
    process.exit(1);
  }
  const write = hasFlag(argv, "write");
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const outDir = getArg(argv, "out-dir") || resolve(CLARICE_BASE, "weekly-plan", new Date().toISOString().slice(0, 10));

  return run(volumes, { write, dbPath, outDir });
}

async function run(
  volumes: number[],
  opts: { write: boolean; dbPath: string; outDir: string },
): Promise<void> {
  const totalRequested = volumes.reduce((a, b) => a + b, 0);
  console.log(`Plano: ${volumes.map((v, i) => `${DAY_LABELS[i]}=${v.toLocaleString("pt-BR")}`).join(", ")} (total ${totalRequested.toLocaleString("pt-BR")}).`);

  // Crédito Brevo — valida ANTES de escrever qualquer coisa.
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.warn("⚠️  BREVO_CLARICE_API_KEY não definida — validação de crédito pulada.");
    if (opts.write) {
      console.error("❌ --write requer validação de crédito bem-sucedida (BREVO_CLARICE_API_KEY ausente). Abortando.");
      process.exit(1);
    }
  } else {
    const { body } = await brevoGet(apiKey, "/account");
    const credits = extractPlanCredits(body);
    if (credits === null) {
      console.warn("⚠️  Não foi possível ler créditos do plano Brevo (/v3/account) — validação pulada.");
      if (opts.write) {
        console.error("❌ --write requer validação de crédito bem-sucedida. Abortando.");
        process.exit(1);
      }
    } else {
      console.log(`Crédito restante no ciclo Brevo: ${credits.toLocaleString("pt-BR")}.`);
      if (totalRequested > credits) {
        console.error(
          `❌ Total do plano (${totalRequested.toLocaleString("pt-BR")}) excede o crédito restante (${credits.toLocaleString("pt-BR")}). Reduza --volumes ou aguarde o próximo ciclo de cobrança.`,
        );
        process.exit(1);
      }
    }
  }

  // #2994/#3682 (P0/P1): contatos em listas com campanha AGENDADA (queued) OU
  // JÁ DISPARADA (sent) do ciclo precisam ser excluídos ANTES de fatiar
  // volumes — `sends_count=0` sozinho não distingue "nunca agendado" de
  // "agendado, ainda não disparado" (campanha Brevo agendada é imutável, ver
  // incidente 260706), NEM "nunca recebeu" de "recebeu, mas o sync
  // incremental do store ainda não propagou o incremento" (lag observado de
  // até ~1 dia, incidente 260716-260721: envios 4-5 do mensal 2606
  // reenviaram 100% pra quem já tinha recebido nas ondas 1-3, #3682). Fetch
  // AO VIVO na Brevo — imune ao lag do store. Fail-safe: sem a chave (ou se
  // a consulta falhar), `--write` é bloqueado; dry-run prossegue com aviso
  // (não bloqueia inspeção/planejamento, só a escrita real dos CSVs).
  let committedListIds: Set<string> = new Set();
  if (apiKey) {
    try {
      committedListIds = await fetchCommittedCampaignListIds(apiKey);
      if (committedListIds.size > 0) {
        console.log(
          `Campanhas agendadas/já disparadas detectadas — ${committedListIds.size} lista(s) comprometida(s) serão excluídas da seleção.`,
        );
      }
    } catch (err) {
      console.warn(`⚠️  Não foi possível consultar campanhas agendadas/disparadas na Brevo: ${err instanceof Error ? err.message : err}`);
      if (opts.write) {
        console.error("❌ --write requer a checagem de campanhas agendadas/disparadas bem-sucedida — evita envio duplicado. Abortando.");
        process.exit(1);
      }
    }
  } else if (opts.write) {
    console.error("❌ --write requer BREVO_CLARICE_API_KEY (checagem de campanhas agendadas/disparadas é obrigatória — evita envio duplicado). Abortando.");
    process.exit(1);
  }

  const db = openClariceDb(opts.dbPath);
  let rows: AudienceRow[];
  try {
    rows = db
      .prepare(
        `SELECT email, name, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count,
                opens_count, last_sent_at, mv_bucket, brevo_list_ids
           FROM clarice_users`,
      )
      .all() as unknown as AudienceRow[];
  } finally {
    // fecha o handle mesmo se o .prepare/.all lançar — no Windows, um handle
    // SQLite aberto segura o lock do arquivo e trava um sync concorrente.
    db.close();
  }

  const rampWarm = segmentRampWarm(rows) as AudienceRow[];
  const ordered = excludeCommittedToQueuedCampaigns(rampWarm, committedListIds);
  const committedExcluded = rampWarm.length - ordered.length;
  if (committedExcluded > 0) {
    console.log(
      `Excluídos ${committedExcluded.toLocaleString("pt-BR")} contato(s) já comprometidos com uma campanha agendada ou já disparada — evita envio duplicado.`,
    );
  }
  console.log(`Audiência elegível (1º envio, send_eligible, verificado): ${ordered.length.toLocaleString("pt-BR")} contatos.`);

  const groups = sliceIntoVolumes(ordered, volumes);
  const shortfall = totalRequested - ordered.length;
  if (shortfall > 0) {
    console.warn(
      `⚠️  Audiência disponível (${ordered.length.toLocaleString("pt-BR")}) é menor que o total pedido (${totalRequested.toLocaleString("pt-BR")}) — faltam ${shortfall.toLocaleString("pt-BR")} contatos. As últimas waves ficarão menores que o planejado.`,
    );
  }

  groups.forEach((g, i) => {
    console.log(`  ${DAY_LABELS[i]}: ${g.length.toLocaleString("pt-BR")}/${volumes[i].toLocaleString("pt-BR")} contatos.`);
  });

  if (!opts.write) {
    console.log("(dry-run — nada escrito. Rode com --write para gerar os CSVs.)");
    return;
  }

  ensureDir(opts.outDir);
  const manifest: WeekPlanManifestEntry[] = [];
  groups.forEach((g, i) => {
    const key = `w${i + 1}`;
    const file = `${key}-${DAY_LABELS[i]}.csv`;
    const csvRows = g.map((r) => ({ email: r.email, NOME: firstName(r.name) }));
    const csv = Papa.unparse({ fields: ["email", "NOME"], data: csvRows });
    writeFileSync(resolve(opts.outDir, file), csv);
    manifest.push({ key, file, desc: `Rampa ${DAY_LABELS[i]}`, count: g.length });
  });
  writeFileSync(resolve(opts.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`✅ Escrito em ${opts.outDir} (${manifest.map((m) => m.file).join(", ")} + manifest.json).`);
  console.log("Próximo passo: importar cada CSV como lista no Brevo (mesmo fluxo manual de clarice-import-waves.ts) e agendar os envios.");
}

// Guard de execução direta Windows-safe (mesmo padrão de clarice-build-segment.ts):
// process.argv[1] usa backslashes no Windows e import.meta.url usa file:/// —
// normalizar pra não virar no-op silencioso quando rodado via `npx tsx ...`.
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
