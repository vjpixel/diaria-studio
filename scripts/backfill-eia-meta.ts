/**
 * backfill-eia-meta.ts (#3984)
 *
 * Script ONE-TIME: varre `data/editions/*` (ambos os layouts, flat e nested
 * — #2463, via `enumerateEditionDirs`), lê `_internal/01-eia-meta.json` de
 * cada edição que já tem esse arquivo, e faz push da descrição+crédito pro
 * Worker via `POST /admin/eiameta` (mesmo canal admin HMAC de
 * `scripts/close-poll.ts`, `adminEiaMetaSig` reusado — mudar um lado sem
 * espelhar o outro quebra a verificação).
 *
 * Motivação: `close-poll.ts` só passou a empurrar `eiameta:{edition}`
 * automaticamente a partir do #3984 — edições publicadas ANTES disso nunca
 * tiveram esse push disparado, mesmo já tendo `01-eia-meta.json` completo
 * (o campo `wikimedia.description`, novo no #3984, também só existe em
 * edições compostas depois do eia-compose.ts atualizado — edições mais
 * antigas terão `description` ausente e só backfillam `credit`, ou nada, se
 * `wikimedia.credit` também estiver vazio).
 *
 * Escopo real de uso: a sequência `/jogar` (jogar.ts, `renderJogarSequencePageHtml`)
 * só joga o MÊS DE CONTEÚDO anterior ao atual — rodar este script sem
 * `--edition`/`--since` cobre TODO o histórico (mais amplo que o necessário,
 * mas idempotente e barato — reescrever `eiameta:{edition}` de uma edição já
 * backfillada não tem efeito colateral). Use `--since AAMMDD` pra restringir
 * a edições mais recentes se preferir.
 *
 * Uso (NÃO rodado automaticamente por nenhuma skill/pipeline — ação manual
 * do editor):
 *   npx tsx scripts/backfill-eia-meta.ts --dry-run
 *   npx tsx scripts/backfill-eia-meta.ts
 *   npx tsx scripts/backfill-eia-meta.ts --since 260601
 *   npx tsx scripts/backfill-eia-meta.ts --edition 260601,260602
 *
 * Requer `ADMIN_SECRET` (ou `POLL_ADMIN_SECRET`) no ambiente — mesmo secret
 * de `close-poll.ts`. `--editions-dir <path>` só pra teste (default:
 * data/editions/ real).
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { parseEiaMeta } from "./lib/schemas/eia-meta.ts";
import { dohFetch } from "./lib/doh-fetch.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { adminEiaMetaSig } from "./close-poll.ts";
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL;

export interface EiaMetaBackfillItem {
  edition: string;
  description: string;
  credit: string;
}

export type EiaMetaBackfillSkipReason = "no_meta_file" | "invalid_meta_schema" | "no_description_or_credit";

export interface EiaMetaBackfillSkip {
  edition: string;
  reason: EiaMetaBackfillSkipReason;
  detail?: string;
}

export interface EiaMetaBackfillPlan {
  items: EiaMetaBackfillItem[];
  skipped: EiaMetaBackfillSkip[];
}

/**
 * Pure-ish (#3984): monta o plano de backfill a partir do disco —
 * `enumerateEditionDirs` (find-current-edition.ts, #2463) já resolve os 2
 * layouts (flat/nested). `editionsFilter` (opcional) restringe a um
 * subconjunto explícito de AAMMDD — quando omitido, varre TODAS as edições
 * encontradas. Nunca lança: edição sem `01-eia-meta.json`, com schema
 * inválido, ou sem descrição/crédito viram entradas em `skipped` (com
 * motivo), não abortam o scan inteiro.
 */
export function buildEiaMetaBackfillPlan(
  editionsRoot: string,
  editionsFilter?: string[],
): EiaMetaBackfillPlan {
  const found = enumerateEditionDirs(editionsRoot);
  const editions = editionsFilter && editionsFilter.length > 0
    ? editionsFilter.filter((ed) => found.has(ed))
    : [...found.keys()].sort();

  const items: EiaMetaBackfillItem[] = [];
  const skipped: EiaMetaBackfillSkip[] = [];

  for (const edition of editions) {
    const dirPath = found.get(edition)!;
    const metaPath = resolve(dirPath, "_internal", "01-eia-meta.json");
    if (!existsSync(metaPath)) {
      skipped.push({ edition, reason: "no_meta_file" });
      continue;
    }
    let description = "";
    let credit = "";
    try {
      const meta = parseEiaMeta(JSON.parse(readFileSync(metaPath, "utf8")));
      description = meta.wikimedia?.description ?? "";
      credit = meta.wikimedia?.credit ?? "";
    } catch (e) {
      skipped.push({ edition, reason: "invalid_meta_schema", detail: (e as Error).message });
      continue;
    }
    if (!description && !credit) {
      skipped.push({ edition, reason: "no_description_or_credit" });
      continue;
    }
    items.push({ edition, description, credit });
  }

  return { items, skipped };
}

export interface PushEiaMetaResult {
  edition: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Interface estrutural mínima compartilhada por `fetch` (nativo) e
 * `dohFetch` (lib/doh-fetch.ts, retorna `DohFetchResponse` — subset de
 * `Response`) — evita um cast forçado no call site de `main()`; ambos
 * satisfazem esta assinatura sem conversão.
 */
export type MinimalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * `fetchImpl`/`pollWorkerUrl` injetáveis pra teste (nunca faz rede real na
 * suíte — mesmo padrão de `subscribeToBeehiiv`, `dohFetch` é usado só no
 * `main()` real). Nunca lança — falha de rede vira `{ok:false, error}`.
 */
export async function pushEiaMetaForEdition(
  pollWorkerUrl: string,
  secret: string,
  item: EiaMetaBackfillItem,
  fetchImpl: MinimalFetch = fetch,
): Promise<PushEiaMetaResult> {
  try {
    const sig = adminEiaMetaSig(secret, item.edition, item.description, item.credit);
    const res = await fetchImpl(`${pollWorkerUrl}/admin/eiameta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edition: item.edition, description: item.description, credit: item.credit, sig }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      return { edition: item.edition, ok: false, status: res.status, error: data.error ?? `HTTP ${res.status}` };
    }
    return { edition: item.edition, ok: true, status: res.status };
  } catch (e) {
    return { edition: item.edition, ok: false, error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { values } = parseCliArgs(args);

  const secret = process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET;
  if (!secret) {
    console.error("[backfill-eia-meta] ADMIN_SECRET não definido. Ver .env.");
    process.exit(1);
  }

  const editionsRootDir = values["editions-dir"]
    ? resolve(process.cwd(), values["editions-dir"])
    : resolve(ROOT, "data", "editions");

  const dryRun = args.includes("--dry-run");

  let editionsFilter: string[] | undefined;
  if (values["edition"]) {
    editionsFilter = values["edition"].split(",").map((s) => s.trim()).filter(Boolean);
  } else if (values["since"]) {
    const since = values["since"];
    const all = [...enumerateEditionDirs(editionsRootDir).keys()].sort();
    editionsFilter = all.filter((ed) => ed >= since);
  }

  const plan = buildEiaMetaBackfillPlan(editionsRootDir, editionsFilter);

  console.error(`[backfill-eia-meta] ${plan.items.length} edição(ões) com descrição/crédito pra empurrar; ${plan.skipped.length} pulada(s).`);
  for (const s of plan.skipped) {
    console.error(`[backfill-eia-meta] pulado ${s.edition}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
  }

  if (dryRun) {
    console.log(JSON.stringify({ dry_run: true, would_push: plan.items.map((i) => i.edition), skipped: plan.skipped }, null, 2));
    return;
  }

  const results: PushEiaMetaResult[] = [];
  for (const item of plan.items) {
    // Serial (não Promise.all) — evita rajada contra o Worker num backfill
    // potencialmente grande (dezenas/centenas de edições); custo de latência
    // aceitável pra um script one-time, nunca rodado em caminho quente.
    const result = await pushEiaMetaForEdition(POLL_WORKER_URL, secret, item, dohFetch);
    results.push(result);
    console.error(`[backfill-eia-meta] ${result.edition}: ${result.ok ? "ok" : `FALHOU (${result.error ?? result.status})`}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ pushed: results.filter((r) => r.ok).map((r) => r.edition), failed: failed.map((r) => r.edition), skipped: plan.skipped }, null, 2));
  if (failed.length > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
