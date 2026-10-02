/**
 * scripts/publish-retrospectiva-linkedin.ts (#9474)
 *
 * Canal `linkedin_pagina` de `/diaria-mensal-apoiadores`: agenda o post
 * PÚBLICO de chamada da Retrospectiva do Mês na página diar.ia.br via Worker
 * LinkedIn — análogo a `publish-artigo-especial-linkedin.ts` (#5979/#6014),
 * reusando `dispatchEntry` (`publish-linkedin.ts`, sem modificação) e a
 * reconciliação `verifyWorkerDispatch`.
 *
 * ## Só a PÁGINA
 *
 * O perfil pessoal (`linkedin_perfil`, D+2 09:30 BRT) é MANUAL, igual ao
 * Artigo Especial: o Worker rejeita `webhook_target=pixel` + `action=post`
 * ("supports only action='comment'", `workers/linkedin-cron/src/index.ts`).
 * O texto fica em `divulgacao/linkedin-perfil.md` pro editor colar no
 * composer; o canal é marcado com `mark-retrospectiva-channel.ts`.
 *
 * ## Guards antes de despachar (cada um aborta SEM despachar)
 *
 *   1. **CTA** (`publicPostCtaProblems`): o texto precisa trazer a linha
 *      literal `Apoie nosso trabalho e leia a retrospectiva completa em:
 *      apoia.se/diaria` e NUNCA a URL da retrospectiva paywalled
 *      (`retrospectiva.diar.ia.br`/`artigo.diar.ia.br`) — decisão do editor no
 *      #9474, herdada do Artigo Especial.
 *   2. **Worker configurado** (`DIARIA_LINKEDIN_CRON_URL`/`_TOKEN`): sem ele a
 *      rota de `dispatchEntry` seria `make_now` — publicaria AGORA, ignorando
 *      a agenda. Além disso o dispatch usa `allowImmediateFallback: false`
 *      (#6015): falha do Worker vira `failed`, nunca post imediato.
 *   3. **Destaque válido** pro Worker (`especial-retrospectiva` casa o regex
 *      `especial(-[a-z]+)?` do Worker publicado). Dos namespaces que o Worker
 *      deployado aceita (`d[123]`, `weekly[-x]`, `especial[-x]`, `eia-AAMMDD`),
 *      `especial-{sufixo}` é o único que comporta um identificador próprio sem
 *      semântica alheia — os outros são da diária, do carrossel semanal e do
 *      "É IA?". Ampliar o regex exigiria deploy (fora de escopo); o store
 *      desta skill é por ciclo, sem colisão com o do Artigo Especial.
 *
 * Uso:
 *   npx tsx scripts/publish-retrospectiva-linkedin.ts --cycle 2609-10 \
 *     [--base-date 2026-10-03] [--at ISO] [--image-url URL] [--force] [--dry-run]
 *
 * `--base-date` = data do ENVIO do e-mail (âncora do D+1 09:00 BRT). Omitido =
 * data do 1º sábado do mês de envio pela regra #9473 (`monthly_send_schedule`),
 * se o e-mail ainda puder sair agendado por ela (>=24h); senão hoje, com banner.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { dispatchEntry, type DispatchContext, type DispatchInput } from "./publish-linkedin.ts";
import { readSocialPublished, type PostEntry, type SocialPublished } from "./lib/social-published-store.ts";
import { verifyWorkerDispatch, formatVerifySummary } from "./verify-social-worker-dispatch.ts";
import { decideChannelAction, buildDoneChannelState, buildFailedChannelState, withChannelState } from "./lib/artigo-especial-state.ts";
import { WORKER_DESTAQUE_RE } from "./publish-artigo-especial-linkedin.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { monthlyDir, requireMonthlyCycleArg } from "./lib/mensal/monthly-paths.ts";
import { resolveRetrospectivaScheduledAts, resolveRetrospectivaBaseDate } from "./lib/mensal/retrospectiva-schedule.ts";
import { resolveMonthlySendSchedule, type MonthlySendScheduleConfig } from "./lib/mensal/monthly-send-schedule.ts";
import {
  publicPostCtaProblems,
  retrospectivaDivulgacaoStatePath,
  readRetrospectivaDivulgacaoState,
  writeRetrospectivaDivulgacaoState,
} from "./lib/mensal/retrospectiva-divulgacao.ts";
import { logEvent } from "./lib/run-log.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** `destaque` enviado ao Worker (ver docstring, guard 3). */
export const RETROSPECTIVA_LINKEDIN_DESTAQUE = "especial-retrospectiva";

/**
 * Lê a imagem do D1 de `_internal/public-images.json` do ciclo, ou `null`.
 * Arquivo ilegível e URL não-https avisam em stderr com a causa real — "sem
 * imagem" por arquivo corrompido não pode parecer "campo ausente".
 */
export function readD1ImageUrl(cycleDir: string): string | null {
  const p = resolve(cycleDir, "_internal", "public-images.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { images?: { d1?: { url?: unknown } } };
    const url = j.images?.d1?.url;
    if (typeof url === "string" && url.startsWith("https://")) return url;
    if (url !== undefined) console.warn(`[publish-retrospectiva-linkedin] AVISO: images.d1.url em ${p} não é https (${JSON.stringify(url)}) — ignorada.`);
    return null;
  } catch (e) {
    console.warn(`[publish-retrospectiva-linkedin] AVISO: ${p} ilegível (${(e as Error).message}) — post sem imagem.`);
    return null;
  }
}

/**
 * Pura: há no store de dispatch uma entry viva (agendada/publicada) deste post?
 * Segundo guard de idempotência, independente do state por canal: se a escrita
 * do state falhou depois de um dispatch bem-sucedido (lock do OneDrive,
 * EPERM), o state não registra nada e só o store sabe que o post JÁ está na
 * fila do Worker (achado do review do PR #9475).
 */
export function findLiveDispatch(published: SocialPublished): PostEntry | null {
  return (
    published.posts.find(
      (p) =>
        p.platform === "linkedin" &&
        p.destaque === RETROSPECTIVA_LINKEDIN_DESTAQUE &&
        (p.status === "scheduled" || p.status === "published"),
    ) ?? null
  );
}

export interface RunRetrospectivaLinkedinOptions {
  cycle: string;
  cycleDir: string;
  text: string;
  imageUrl: string | null;
  scheduledAt: string;
  force: boolean;
  dryRun: boolean;
  ctx: DispatchContext;
  /** Injetável pra teste (default: `dispatchEntry` real). */
  dispatch?: (input: DispatchInput, ctx: DispatchContext) => Promise<PostEntry>;
  /** Injetável pra teste (default: `verifyWorkerDispatch` real). */
  verifyWorker?: (published: SocialPublished) => Promise<{ updated: SocialPublished; changes: number; inQueue?: number }>;
  now?: number;
}

export type RunRetrospectivaLinkedinResult =
  | { action: "skipped"; reason: string }
  | { action: "dry-run" }
  /** Agendado. `verifyError` = a reconciliação com o Worker não rodou (o post
   *  está na fila, mas não foi confirmado lá) — o caller sinaliza exit != 0. */
  | { action: "dispatched"; entry: PostEntry; verifyError: string | null }
  /** Falhou no dispatch ou caiu no DLQ na reconciliação — canal `failed`. */
  | { action: "failed"; entry: PostEntry; reason: string };

/**
 * Corpo testável. Aplica os guards de CTA e destaque (o de Worker configurado
 * vive no `main()`, onde as env vars são lidas), despacha a página e
 * reconcilia contra o Worker.
 */
export async function runRetrospectivaLinkedinDispatch(o: RunRetrospectivaLinkedinOptions): Promise<RunRetrospectivaLinkedinResult> {
  const statePath = retrospectivaDivulgacaoStatePath(o.cycleDir);
  let state = readRetrospectivaDivulgacaoState(statePath, o.cycle);

  const decision = decideChannelAction(state, "linkedin_pagina", o.force);
  if (decision.action === "skip") {
    console.log(`[linkedin_pagina] pulado — ${decision.reason}`);
    return { action: "skipped", reason: decision.reason };
  }
  const live = o.force ? null : findLiveDispatch(readSocialPublished(o.ctx.publishedPath));
  if (live) {
    const reason =
      `o store ${o.ctx.publishedPath} já tem o post na fila (status ${live.status}, ` +
      `worker_queue_key ${String(live.worker_queue_key ?? "?")}, ${live.scheduled_at ?? "?"}) — o state por canal não registrou ` +
      "(escrita anterior falhou?). Confira no Worker; --force despacha de novo.";
    console.log(`[linkedin_pagina] pulado — ${reason}`);
    return { action: "skipped", reason };
  }

  const problems = publicPostCtaProblems(o.text);
  if (problems.length > 0) {
    throw new Error(`post da página recusado ANTES do dispatch: ${problems.join("; ")}.`);
  }
  if (!WORKER_DESTAQUE_RE.test(RETROSPECTIVA_LINKEDIN_DESTAQUE)) {
    throw new Error(`destaque "${RETROSPECTIVA_LINKEDIN_DESTAQUE}" incompatível com o Worker LinkedIn (${WORKER_DESTAQUE_RE}).`);
  }
  const now = o.now ?? Date.now();
  if (!(Date.parse(o.scheduledAt) > now)) {
    throw new Error(`scheduled_at ${o.scheduledAt} não está no futuro — recusando (o Worker publicaria fora da agenda).`);
  }

  const input: DispatchInput = {
    destaque: RETROSPECTIVA_LINKEDIN_DESTAQUE,
    subtype: "main",
    text: o.text,
    imageUrl: o.imageUrl,
    scheduledAt: o.scheduledAt,
    webhookTarget: "diaria",
    action: "post",
    allowImmediateFallback: false,
  };

  if (o.dryRun) {
    console.log(`[dry-run] dispatch linkedin_pagina para ${o.scheduledAt} (imagem: ${o.imageUrl ?? "nenhuma"}) — texto:\n${o.text}\n`);
    return { action: "dry-run" };
  }

  const entry = await (o.dispatch ?? dispatchEntry)(input, o.ctx);
  const at = new Date().toISOString();
  if (entry.status === "failed") {
    const reason = entry.reason ?? "dispatch falhou";
    writeRetrospectivaDivulgacaoState(statePath, withChannelState(state, "linkedin_pagina", buildFailedChannelState(at, reason)));
    return { action: "failed", entry, reason };
  }
  state = withChannelState(state, "linkedin_pagina", buildDoneChannelState(at, null));
  try {
    writeRetrospectivaDivulgacaoState(statePath, state);
  } catch (e) {
    throw new Error(
      `post JÁ ESTÁ na fila do Worker (worker_queue_key ${String(entry.worker_queue_key ?? "?")}, ${o.scheduledAt}), ` +
        `mas o state por canal não foi gravado: ${(e as Error).message}. NÃO rode de novo sem conferir — ` +
        `o store ${o.ctx.publishedPath} segura uma 2ª execução.`,
    );
  }

  let verifyError: string | null = null;
  if (entry.status === "scheduled") {
    try {
      const published = readSocialPublished(o.ctx.publishedPath);
      const verify = o.verifyWorker ?? ((p: SocialPublished) => verifyWorkerDispatch(p, o.ctx.workerUrl, o.ctx.workerToken));
      const result = await verify(published);
      console.log(`[verify] reconciliação Worker: ${formatVerifySummary(result)}`);
      if (result.changes > 0) {
        writeFileSync(o.ctx.publishedPath, JSON.stringify(result.updated, null, 2) + "\n", "utf8");
        const failed = result.updated.posts.find(
          (p) => p.platform === "linkedin" && p.destaque === RETROSPECTIVA_LINKEDIN_DESTAQUE && p.status === "failed",
        );
        if (failed) {
          const reason = typeof failed.failure_reason === "string" ? failed.failure_reason : "reconciliação pós-dispatch: Worker reportou falha (DLQ).";
          state = withChannelState(state, "linkedin_pagina", buildFailedChannelState(new Date().toISOString(), reason));
          writeRetrospectivaDivulgacaoState(statePath, state);
          return { action: "failed", entry: failed, reason };
        }
      }
    } catch (e) {
      // O dispatch foi aceito e está gravado; o que falhou foi CONFIRMAR na
      // fila. Não vira `failed` (retentar despacharia de novo), mas o caller
      // sai != 0 pra que "agendado e confirmado" nunca se confunda com
      // "agendado, sem confirmação" (achado do review do PR #9475).
      verifyError = (e as Error).message;
      console.warn(`[verify] falhou — o post está na fila, mas não foi confirmado no Worker: ${verifyError}`);
    }
  }
  return { action: "dispatched", entry, verifyError };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const { values, flags } = parseArgs(argv);
  const cycleDir = monthlyDir(cycle);
  const textPath = resolve(cycleDir, "divulgacao", "linkedin-pagina.md");
  if (!existsSync(textPath)) {
    console.error(`${textPath} não encontrado — o Passo de geração de textos da skill precisa rodar antes.`);
    process.exit(2);
  }
  const text = readFileSync(textPath, "utf8").trim();

  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as Parameters<
    typeof resolveRetrospectivaScheduledAts
  >[0] & { publishing?: { social?: { linkedin?: { make_webhook_url?: string; cloudflare_worker_url?: string } } } };
  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? config.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  const webhookUrl = process.env.MAKE_LINKEDIN_WEBHOOK_URL ?? config.publishing?.social?.linkedin?.make_webhook_url ?? "";
  const dryRun = flags.has("dry-run");
  if (!dryRun && (!workerUrl || !workerToken)) {
    console.error(
      "ERRO: Worker LinkedIn não configurado (DIARIA_LINKEDIN_CRON_URL/_TOKEN). Sem ele o dispatch publicaria AGORA via Make, " +
        "ignorando a agenda — abortando sem despachar.",
    );
    process.exit(2);
  }

  const ruleConfig = (config as { monthly_send_schedule?: MonthlySendScheduleConfig }).monthly_send_schedule;
  const { baseDate, fromRule: baseDateFromRule } = resolveRetrospectivaBaseDate(cycle, {
    baseDate: values["base-date"],
    at: values["at"],
    rule: resolveMonthlySendSchedule(ruleConfig),
  });
  const ats = resolveRetrospectivaScheduledAts(config, { at: values["at"], baseDate });
  if (!values["at"]) {
    console.log(
      `Agenda (#9474): página=${ats.pagina} | perfil (manual)=${ats.perfil}` +
        (baseDate
          ? ` — âncora: envio em ${baseDate}${baseDateFromRule ? " (regra do 1º sábado, #9473)" : ""}`
          : " — âncora: HOJE (regra do 1º sábado indisponível p/ este ciclo; passe --base-date com a data do envio do e-mail)"),
    );
  }

  const imageUrl = values["image-url"] ?? readD1ImageUrl(cycleDir);
  if (!imageUrl) console.warn("AVISO: sem imagem (nem --image-url nem images.d1 em _internal/public-images.json) — post sai sem capa.");

  const ctx: DispatchContext = {
    publishedPath: resolve(cycleDir, "_internal", "divulgacao-linkedin-published.json"),
    webhookUrl,
    apiKey: process.env.MAKE_WEBHOOK_API_KEY || undefined,
    workerUrl,
    workerToken,
    useWorkerForScheduled: true,
    editionDate: `retrospectiva-${cycle}`,
    rootDir: ROOT,
  };

  const r = await runRetrospectivaLinkedinDispatch({
    cycle,
    cycleDir,
    text,
    imageUrl,
    scheduledAt: ats.pagina,
    force: flags.has("force"),
    dryRun,
    ctx,
  });
  if (r.action === "dispatched" || r.action === "failed") {
    logEvent(
      {
        edition: cycle,
        stage: null,
        agent: "publish-retrospectiva-linkedin",
        level: r.action === "failed" || r.verifyError ? "warn" : "info",
        message: `linkedin_pagina ${r.action} (${r.entry.status}) para ${ats.pagina}`,
        details: {
          worker_queue_key: r.entry.worker_queue_key ?? null,
          route: r.entry.route ?? null,
          ...(r.action === "failed" ? { reason: r.reason } : { verifyError: r.verifyError }),
        },
      },
      ROOT,
    );
    if (r.action === "failed") {
      console.error(`linkedin_pagina falhou (${r.reason}) — ver ${ctx.publishedPath}.`);
      process.exitCode = 1;
    } else if (r.verifyError) {
      console.error(
        `linkedin_pagina agendada para ${ats.pagina}, mas NÃO confirmada no Worker — confira a fila do Worker ` +
          `(worker_queue_key em ${ctx.publishedPath}) antes de considerar feito.`,
      );
      process.exitCode = 1;
    } else {
      console.log(`OK — página agendada para ${ats.pagina}.`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`publish-retrospectiva-linkedin: ${(e as Error).message}`);
    process.exit(1);
  });
}
