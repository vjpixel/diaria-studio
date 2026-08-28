#!/usr/bin/env node
/**
 * dmarc-enforcement-engine.ts (#6442) — leitura AO VIVO de sinal próprio de
 * plataforma (Kit/bounce/complaint) pra decidir enforcement DMARC de
 * `news.diar.ia.br`.
 *
 * READ-ONLY / DECISÃO APENAS (mesma disciplina do guard de publicação,
 * `context/overnight-dispatch-rules.md` item 1): este script NUNCA escreve
 * DNS, NUNCA chama a API do Kit em modo de escrita. A saída é sempre uma
 * RECOMENDAÇÃO (`DmarcEnforcementDecision`, ver `scripts/lib/
 * dmarc-enforcement-policy.ts`) — subir `_dmarc.news.diar.ia.br` no
 * Cloudflare continua ação manual do editor.
 *
 * ## Escopo desta unidade (#6442) — deliberadamente PARCIAL
 *
 * A issue-mãe deixou 3 perguntas em aberto "a definir antes de implementar":
 * quais sinais o Kit expõe, quais limiares usar, e ONDE este script mora
 * (task agendada vs standalone). Esta unidade resolve as 2 primeiras (ver
 * docstring de `dmarc-enforcement-policy.ts` pra análise completa dos sinais
 * disponíveis e a analogia com o freio Clarice) e entrega o motor + o
 * script, mas **não** o integra a nenhuma task agendada — isso fica pra
 * quando o editor decidir a cadência (diária? semanal? só sob demanda?).
 * Rodar manualmente: `npx tsx scripts/dmarc-enforcement-engine.ts [--json]`.
 *
 * ## Sinais lidos
 *
 * 1. **Bounce/complaint cumulativo** — `GET /v4/subscribers?status=all`
 *    (Kit), contando `state === "bounced"` / `state === "complained"` sobre
 *    o total de assinantes em qualquer estado terminal. Não é uma janela de
 *    dias (o Kit não expõe bounce/complaint por broadcast — só o estado
 *    cumulativo do assinante, ver ponto 1 da docstring do módulo de
 *    política) — limitação documentada, não escondida.
 * 2. **Maturidade do domínio** — `GET /v4/broadcasts?status=completed`,
 *    achando o broadcast mais antigo pra calcular há quantos dias o domínio
 *    envia de verdade.
 * 3. **Política DMARC atual** — `dns.resolveTxt("_dmarc.news.diar.ia.br")`,
 *    lida direto do DNS público (sem precisar de API do Cloudflare) e
 *    parseada pro valor de `p=`.
 *
 * Exit codes: 0 sempre que a leitura terminou (mesmo com sinal
 * `insufficient-volume`/`unhealthy` — isso é reportado no JSON, não erro de
 * processo); 1 se qualquer fetch/DNS falhar por erro estrutural.
 */
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { listBroadcasts, type KitBroadcastSummary } from "./lib/kit-client.ts";
import {
  decideDmarcEnforcement,
  type DmarcEnforcementDecision,
  type DmarcPolicy,
  type DmarcSignals,
} from "./lib/dmarc-enforcement-policy.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveTxt } from "node:dns/promises";

loadProjectEnv();

/** Domínio de envio do Kit sob avaliação (#6046/#6111) — único domínio deste
 *  motor por ora; parametrizar se um dia cobrir mais de um. */
export const DMARC_TARGET_DOMAIN = "news.diar.ia.br";

/**
 * Lê e parseia o registro TXT `_dmarc.{domain}` pro valor de `p=` — a
 * política DMARC vigente. Um domínio pode ter mais de um TXT em `_dmarc.`
 * (raro, mas possível); pega o primeiro que contém `v=DMARC1`, mesma
 * convenção de qualquer parser DMARC (RFC 7489 §6.6.3 — implementações
 * ignoram registros que não comecem com a tag `v`).
 *
 * `null` = nenhum registro DMARC encontrado (equivalente a `p=none` pra
 * efeito de enforcement, mas reportado separadamente — "sem registro" e
 * "registro explícito p=none" são estados diferentes que o caller deve
 * poder distinguir no relatório).
 */
export async function readCurrentDmarcPolicy(
  domain: string,
  resolveTxtFn: typeof resolveTxt = resolveTxt,
): Promise<{ policy: DmarcPolicy | null; raw: string | null }> {
  let records: string[][];
  try {
    records = await resolveTxtFn(`_dmarc.${domain}`);
  } catch {
    // ENODATA/ENOTFOUND — nenhum registro DMARC publicado.
    return { policy: null, raw: null };
  }
  const flat = records.map((chunks) => chunks.join(""));
  const dmarcRecord = flat.find((r) => r.trim().toLowerCase().startsWith("v=dmarc1"));
  if (!dmarcRecord) return { policy: null, raw: null };

  const match = dmarcRecord.match(/(?:^|;)\s*p=(none|quarantine|reject)\b/i);
  const policy = match ? (match[1].toLowerCase() as DmarcPolicy) : null;
  return { policy, raw: dmarcRecord };
}

/** Assinantes por `state` (Kit) — conta `bounced`/`complained`/total sobre
 *  `status=all` (todos os estados terminais observáveis, ver docstring de
 *  `DmarcSignals.totalConsidered`). */
export function summarizeSubscriberStates(subs: { state: string }[]): {
  totalConsidered: number;
  bouncedCount: number;
  complainedCount: number;
} {
  let bouncedCount = 0;
  let complainedCount = 0;
  for (const s of subs) {
    if (s.state === "bounced") bouncedCount++;
    else if (s.state === "complained") complainedCount++;
  }
  return { totalConsidered: subs.length, bouncedCount, complainedCount };
}

/** Dias corridos entre o `send_at`/`published_at` do broadcast COMPLETADO
 *  mais antigo e `now` — `null` se não houver nenhum broadcast completado. */
export function daysSinceFirstCompletedBroadcast(
  broadcasts: Pick<KitBroadcastSummary, "status" | "published_at" | "created_at">[],
  now: Date,
): number | null {
  const completed = broadcasts.filter((b) => b.status === "completed");
  if (completed.length === 0) return null;
  const timestamps = completed
    .map((b) => Date.parse(b.published_at ?? b.created_at))
    .filter((ms) => Number.isFinite(ms));
  if (timestamps.length === 0) return null;
  const earliest = Math.min(...timestamps);
  const diffMs = now.getTime() - earliest;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / 86_400_000);
}

export interface FetchDmarcSignalsOptions {
  readonly domain: string;
  readonly now: Date;
  readonly resolveTxtFn?: typeof resolveTxt;
}

export interface DmarcEnforcementReport {
  readonly domain: string;
  readonly currentPolicy: DmarcPolicy | null;
  readonly currentPolicyRaw: string | null;
  readonly signals: DmarcSignals;
  readonly decision: DmarcEnforcementDecision;
}

/** Orquestra a leitura completa (Kit + DNS) e devolve o relatório pronto. */
export async function buildDmarcEnforcementReport(
  opts: FetchDmarcSignalsOptions,
): Promise<DmarcEnforcementReport> {
  const [subs, broadcastsPage, dmarc] = await Promise.all([
    listAllKitSubscribers(undefined, { status: "all" }),
    listBroadcasts({ status: "completed", perPage: 50 }),
    readCurrentDmarcPolicy(opts.domain, opts.resolveTxtFn),
  ]);

  const { totalConsidered, bouncedCount, complainedCount } = summarizeSubscriberStates(subs);
  const daysSinceFirstSend = daysSinceFirstCompletedBroadcast(broadcastsPage.broadcasts, opts.now);

  const signals: DmarcSignals = { totalConsidered, bouncedCount, complainedCount, daysSinceFirstSend };
  // `p=none` é o comportamento efetivo tanto pra "registro ausente" quanto
  // pra "registro presente com p=none explícito" — o motor de decisão só
  // precisa da política EFETIVA; a distinção entre os dois casos continua
  // visível em `currentPolicyRaw` pro relatório.
  const currentPolicy: DmarcPolicy = dmarc.policy ?? "none";
  const decision = decideDmarcEnforcement(signals, currentPolicy);

  return {
    domain: opts.domain,
    currentPolicy: dmarc.policy,
    currentPolicyRaw: dmarc.raw,
    signals,
    decision,
  };
}

if (isMainModule(import.meta.url)) {
  const asJson = hasFlag(process.argv.slice(2), "json");
  const domain = getArg(process.argv.slice(2), "domain") || DMARC_TARGET_DOMAIN;
  buildDmarcEnforcementReport({ domain, now: new Date() })
    .then((report) => {
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`DMARC enforcement — ${report.domain}`);
        console.log(
          `Política atual: ${report.currentPolicy ?? "(nenhum registro DMARC — efetivo p=none)"}${report.currentPolicyRaw ? ` [${report.currentPolicyRaw}]` : ""}`,
        );
        console.log(
          `Sinais: bounce ${report.decision.bounceRatePct.toFixed(2)}% (${report.signals.bouncedCount}/${report.signals.totalConsidered}), complaint ${report.decision.complaintRatePct.toFixed(2)}% (${report.signals.complainedCount}/${report.signals.totalConsidered}), maturidade: ${report.signals.daysSinceFirstSend ?? "sem broadcast completado"} dia(s).`,
        );
        console.log(`Nível: ${report.decision.level} — recomendação: ${report.decision.recommendation}${report.decision.nextPolicy ? ` (${report.decision.nextPolicy})` : ""}`);
        for (const r of report.decision.reasons) console.log(`  - ${r}`);
        console.log("\nREAD-ONLY: nenhuma alteração de DNS foi feita. Aplicar manualmente no Cloudflare se decidir seguir a recomendação.");
      }
      process.exitCode = 0;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
