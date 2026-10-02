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
 *      `especial(-[a-z]+)?` do Worker publicado). Namespace `especial` porque
 *      é o único valor não-diário que o Worker deployado já aceita — ampliar o
 *      regex exigiria deploy (fora de escopo); o store desta skill é por ciclo,
 *      sem colisão com o do Artigo Especial.
 *
 * Uso:
 *   npx tsx scripts/publish-retrospectiva-linkedin.ts --cycle 2609-10 \
 *     [--base-date 2026-10-03] [--at ISO] [--image-url URL] [--force] [--dry-run]
 *
 * `--base-date` = data do ENVIO do e-mail (âncora do D+1 09:00 BRT; #9473 vai
 * fixar o 1º sábado do mês). Omitido = hoje, com banner.
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
import { resolveRetrospectivaScheduledAts } from "./lib/mensal/retrospectiva-schedule.ts";
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

/** Pura: lê a imagem do D1 de `_internal/public-images.json` do ciclo, ou `null`. */
export function readD1ImageUrl(cycleDir: string): string | null {
  const p = resolve(cycleDir, "_internal", "public-images.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { images?: { d1?: { url?: unknown } } };
    const url = j.images?.d1?.url;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
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
  | { action: "dispatched"; entry: PostEntry; channelStatus: "done" | "failed" };

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
  let channelStatus: "done" | "failed" = entry.status === "failed" ? "failed" : "done";
  const at = new Date().toISOString();
  state = withChannelState(
    state,
    "linkedin_pagina",
    channelStatus === "done" ? buildDoneChannelState(at, null) : buildFailedChannelState(at, entry.reason ?? "dispatch falhou"),
  );
  writeRetrospectivaDivulgacaoState(statePath, state);

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
          channelStatus = "failed";
          const reason = typeof failed.failure_reason === "string" ? failed.failure_reason : "reconciliação pós-dispatch: Worker reportou falha (DLQ).";
          state = withChannelState(state, "linkedin_pagina", buildFailedChannelState(new Date().toISOString(), reason));
          writeRetrospectivaDivulgacaoState(statePath, state);
        }
      }
    } catch (e) {
      console.warn(`[verify] falhou (non-fatal, o dispatch já foi gravado): ${(e as Error).message}`);
    }
  }
  return { action: "dispatched", entry, channelStatus };
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

  const ats = resolveRetrospectivaScheduledAts(config, { at: values["at"], baseDate: values["base-date"] });
  if (!values["at"]) {
    console.log(
      `Agenda (#9474): página=${ats.pagina} | perfil (manual)=${ats.perfil}` +
        (values["base-date"] ? ` — âncora: envio em ${values["base-date"]}` : " — âncora: HOJE (passe --base-date com a data do envio do e-mail)"),
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
  if (r.action === "dispatched") {
    logEvent(
      {
        edition: cycle,
        stage: null,
        agent: "publish-retrospectiva-linkedin",
        level: r.channelStatus === "failed" ? "warn" : "info",
        message: `linkedin_pagina ${r.channelStatus} (${r.entry.status}) para ${ats.pagina}`,
        details: { worker_queue_key: r.entry.worker_queue_key ?? null, route: r.entry.route ?? null },
      },
      ROOT,
    );
    if (r.channelStatus === "failed") {
      console.error(`linkedin_pagina falhou — ver ${ctx.publishedPath}.`);
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
