#!/usr/bin/env node
/**
 * clarice-novos-preflight.ts (#10157)
 *
 * Pré-conferência do `cloudflare-preview.html` que os envios `novos` das
 * 09:00/18:00 (`Diaria-Clarice-Novos`/`-Tarde`, no `300`) vão ler. O HTML
 * vive em `data/` (OneDrive): regenerado numa máquina, pode ainda não ter
 * chegado na outra — e o envio sai com a versão antiga sem erro nem aviso.
 *
 * SEM efeito colateral: não envia, não grava state, não chama Brevo/Stripe/MV.
 * A única rede possível é `--compare-last-sent`, que LÊ o dashboard público
 * (`GET /api/campaigns`, mesma rota que o CLAUDE.md manda consultar).
 *
 * Uso (rodar no servidor, antes das 09:00):
 *   npx tsx scripts/clarice-novos-preflight.ts \
 *     [--cycle 2609-10]                  # default: resolve como o envio resolve
 *     [--expect 'dizendo "quero"' --expect "Garantir meu ingresso"]
 *     [--expect-sha <sha256 da máquina onde o HTML foi gerado>]
 *     [--newer-than 2026-10-14T03:00:00-03:00]
 *     [--baseline caminho/para/html-anterior.html]  # lista título/caixas/legendas que mudaram
 *     [--compare-last-sent [--dashboard-url URL]]   # assunto/ciclo da última campanha novos enviada
 *     [--html caminho]                   # outro arquivo (ex.: conferir a cópia local)
 *     [--json]
 *
 * Exit: 0 = ok; 1 = arquivo ausente, desatualizado (marcador/sha/mtime),
 * sem imagem, imagem fora do KV, seta, ou sem link `utm_source=clarice`.
 * A última linha do stdout é pronta pra colar no relatório.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  monthlyDir,
  resolveLatestMonthlyCycleFromDisk,
  clariceActivityDepsFromDisk,
  evaluateClariceActivityGuard,
  type ResolveLatestMonthlyCycleResult,
  type ClariceActivityDeps,
} from "./lib/mensal/monthly-paths.ts";
import {
  evaluatePreflight,
  pickLastSentNovosCampaign,
  type DashboardCampaign,
  type PreflightResult,
} from "./lib/clarice-novos-preflight.ts";

export const DEFAULT_DASHBOARD_URL = "https://clarice-dashboard.diaria.workers.dev";

export interface PreflightMainOverrides {
  resolveCycle?: (subjectOverride?: string) => ResolveLatestMonthlyCycleResult;
  activityDeps?: ClariceActivityDeps;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * Coleta todas as ocorrências de `--{key} valor` / `--{key}=valor` (flag
 * repetível — `getStringArg` rejeita repetição de propósito). Lança em
 * ocorrência sem valor ou com valor vazio, pelo mesmo motivo do
 * `getStringArg` (#4573): um `--expect` engolido em silêncio faria a
 * conferência passar sem checar o marcador que o operador pediu.
 */
export function collectRepeatedArg(argv: string[], key: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | undefined;
    if (a === `--${key}`) {
      v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${key} foi passado sem valor.`);
      i++;
    } else if (a.startsWith(`--${key}=`)) {
      v = a.slice(key.length + 3);
    } else {
      continue;
    }
    if (v.trim() === "") throw new Error(`--${key} foi passado com valor vazio.`);
    out.push(v);
  }
  return out;
}

async function fetchLastSentNovos(
  dashboardUrl: string,
  fetchFn: typeof fetch,
): Promise<DashboardCampaign | null> {
  const res = await fetchFn(`${dashboardUrl.replace(/\/$/, "")}/api/campaigns?limit=50`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { campaigns?: DashboardCampaign[] };
  return pickLastSentNovosCampaign(body.campaigns ?? []);
}

/** Roda a pré-conferência e devolve o exit code (0/1). Nunca chama `process.exit`. */
export async function runPreflight(argv: string[], overrides: PreflightMainOverrides = {}): Promise<number> {
  const log = overrides.log ?? ((l: string) => console.log(l));
  const err = overrides.err ?? ((l: string) => console.error(l));

  let opts: {
    cycle?: string;
    subject?: string;
    html?: string;
    expectSha?: string;
    newerThan?: string;
    baseline?: string;
    dashboardUrl?: string;
    expect: string[];
  };
  try {
    opts = {
      cycle: getStringArg(argv, "cycle", { example: "2609-10" }),
      subject: getStringArg(argv, "subject", { example: '"Assunto"' }),
      html: getStringArg(argv, "html", { example: "caminho/cloudflare-preview.html" }),
      expectSha: getStringArg(argv, "expect-sha", { example: "<sha256>" }),
      newerThan: getStringArg(argv, "newer-than", { example: "2026-10-14T03:00:00-03:00" }),
      baseline: getStringArg(argv, "baseline", { example: "caminho/anterior.html" }),
      dashboardUrl: getStringArg(argv, "dashboard-url", { example: DEFAULT_DASHBOARD_URL }),
      expect: collectRepeatedArg(argv, "expect"),
    };
  } catch (e) {
    err(`❌ ${(e as Error).message}`);
    return 1;
  }

  let cycle = opts.cycle ?? "";
  let resolvedSubject: string | null = null;
  const subjectOverride = opts.subject;
  if (!cycle) {
    const resolveCycle = overrides.resolveCycle ?? resolveLatestMonthlyCycleFromDisk;
    const r = resolveCycle(subjectOverride);
    if (!r.cycle) {
      err("❌ nenhum ciclo mensal pronto pra reenvio — o envio novos também vai abortar. Detalhe:");
      for (const c of r.checked) err(`   ${c.cycle}: ${c.reasons.join("; ") || "ok"}`);
      log("clarice-novos preflight ?: FALHA — nenhum ciclo mensal pronto");
      return 1;
    }
    cycle = r.cycle;
    resolvedSubject = r.subject;
    if (r.fallback) err(`⚠️  ciclo mais recente não estava pronto — o envio vai cair em ${cycle} (D3).`);
    try {
      const guard = evaluateClariceActivityGuard(
        r.cycle,
        r.fallback,
        !!subjectOverride,
        overrides.activityDeps ?? clariceActivityDepsFromDisk(),
      );
      if (guard.blocked) {
        err(`⚠️  o guard #4621 vai abortar o envio: fallback ${cycle} está >1 ciclo atrás do ativo (${guard.activeCycle}).`);
      }
    } catch (e) {
      err(`⚠️  guard #4621 não avaliado: ${(e as Error).message}`);
    }
  }

  const htmlPath = opts.html
    ? resolve(opts.html)
    : resolve(monthlyDir(cycle, { allowLegacyFallback: false }), "_internal", "cloudflare-preview.html");

  const exists = existsSync(htmlPath);
  const html = exists ? readFileSync(htmlPath, "utf8") : null;
  const mtime = exists ? statSync(htmlPath).mtime : null;

  const newerThanRaw = opts.newerThan;
  let newerThan: Date | undefined;
  if (newerThanRaw) {
    const d = new Date(newerThanRaw);
    if (Number.isNaN(d.getTime())) {
      err(`❌ --newer-than inválido: ${newerThanRaw} (use ISO, ex.: 2026-10-14T03:00:00-03:00)`);
      return 1;
    }
    newerThan = d;
  }

  const baselinePath = opts.baseline;
  let baselineHtml: string | null | undefined;
  if (baselinePath) {
    if (!existsSync(baselinePath)) {
      err(`⚠️  --baseline não encontrado (${baselinePath}) — comparação pulada.`);
    } else {
      baselineHtml = readFileSync(baselinePath, "utf8");
    }
  }

  let lastSent: DashboardCampaign | null | undefined;
  if (hasFlag(argv, "compare-last-sent")) {
    const dashboardUrl = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
    try {
      lastSent = await fetchLastSentNovos(dashboardUrl, overrides.fetchFn ?? fetch);
      if (!lastSent) err("↷ dashboard não devolveu nenhuma campanha novos enviada na janela.");
    } catch (e) {
      // Fail-soft: a comparação com o último envio é informativa, nunca decide o exit.
      err(`⚠️  dashboard indisponível (${(e as Error).message}) — comparação com o último envio pulada.`);
    }
  }

  const result: PreflightResult = evaluatePreflight({
    cycle,
    htmlPath,
    html,
    mtime,
    expectMarkers: opts.expect,
    expectSha: opts.expectSha,
    newerThan,
    baselineHtml,
    lastSent,
    resolvedSubject,
  });

  if (result.analysis) {
    const a = result.analysis;
    err(`arquivo: ${htmlPath}`);
    err(`  mtime ${mtime?.toISOString()} · ${a.bytes} bytes · sha256 ${a.sha256}`);
    err(`  título: ${a.summary.title ?? "(sem <title>)"}`);
    err(`  ${a.images.total} <img> (${a.images.nonKv.length} fora do KV) · ${a.arrows} seta · ${a.utmClariceLinks} link(s) utm_source=clarice`);
    for (const e of a.expect) err(`  ${e.found ? "✓" : "✗"} expect ${JSON.stringify(e.marker)}`);
  }
  if (lastSent) {
    err(`última campanha novos enviada: ${lastSent.name} (${lastSent.sentDate}) — assunto ${JSON.stringify(lastSent.subject ?? "")}`);
  }
  if (result.diff) {
    const d = result.diff;
    if (!d.changed) err("vs referência: nada mudou em título, destaques, caixas ou legendas.");
    else {
      err("vs referência:");
      if (d.titleChanged) err(`  título: ${JSON.stringify(d.titleChanged.from)} → ${JSON.stringify(d.titleChanged.to)}`);
      for (const [label, ld] of [["destaques", d.headlines], ["caixas", d.boxes], ["legendas", d.captions]] as const) {
        for (const x of ld.removed) err(`  - ${label}: ${x}`);
        for (const x of ld.added) err(`  + ${label}: ${x}`);
      }
    }
  }
  for (const w of result.warnings) err(`⚠️  ${w}`);
  for (const f of result.failures) err(`❌ ${f}`);

  if (hasFlag(argv, "json")) {
    log(JSON.stringify({ cycle, htmlPath, mtime: mtime?.toISOString() ?? null, ...result }, null, 2));
  }
  log(result.reportLine);
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  runPreflight(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("[clarice-novos-preflight] erro:", e);
      process.exit(1);
    });
}
