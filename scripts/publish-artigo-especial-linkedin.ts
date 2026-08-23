/**
 * publish-artigo-especial-linkedin.ts (#5979)
 *
 * Passo 4 da skill `/diaria-artigo-especial`: agenda os 2 posts de anúncio
 * do artigo especial do mês — página diar.ia.br (`webhook_target: "diaria"`)
 * e perfil pessoal (`webhook_target: "pixel"`) — via `dispatchEntry`
 * (`scripts/publish-linkedin.ts`, reusado sem modificação, mesma rota
 * Worker/Make que o Stage 5 diário já usa).
 *
 * ## Onde este script diverge do texto original da issue #5979
 *
 * O plano da issue apontava `ctx.publishedPath` de `dispatchEntry` direto pro
 * `published.json` genérico do artigo (o mesmo state file que
 * `scripts/lib/artigo-especial-state.ts` usa como guard de idempotência
 * cross-canal no Passo 0). Na implementação, os dois ficaram SEPARADOS:
 *
 *   - `linkedin-published.json` (este script, formato `SocialPublished` de
 *     `scripts/lib/social-published-store.ts`) — o DETALHE de cada dispatch
 *     (`worker_queue_key`, `route`, `scheduled_at`, etc.), no mesmo formato
 *     que `dispatchEntry`/`verifyWorkerDispatch` já sabem ler e escrever sem
 *     nenhuma adaptação.
 *   - `published.json` (`artigo-especial-state.ts`) — o STATUS agregado por
 *     canal (`apoiase`/`linkedin_pagina`/`linkedin_perfil`/`box`), que
 *     `apoiase` e `box` também escrevem e que não tem `worker_queue_key`/
 *     `scheduled_at` — vocabulário de PostEntry não serve pra eles.
 *
 * Motivo: `PostEntry`/`SocialPublished` têm um contrato de campos (`status:
 * "draft"|"scheduled"|"failed"|"published"|"deleted"`, chave
 * `(platform,destaque,subtype)`) desenhado pra canais que passam pelo Worker
 * LinkedIn/Instagram/Threads — forçar `apoiase` (sem agendamento, sem
 * worker_queue_key) e `box` (é um PR git, não um post agendado) nesse mesmo
 * formato exigiria ou campos sempre `null`/inventados ou perder a
 * reconciliação via `verifyWorkerDispatch` (que só sabe olhar
 * `worker_queue_key`). Este script escreve nos DOIS arquivos — o
 * `published.json` genérico é atualizado logo após cada `dispatchEntry`
 * retornar, derivando o `ChannelStatus` do `PostEntry.status` (ver
 * `deriveChannelStatusFromPostEntry`).
 *
 * ## Fail-fast antes de despachar (webhook_target=pixel sem Worker)
 *
 * `dispatchEntry` já lança se `webhookTarget: "pixel"` e o Worker não está
 * configurado (sem fallback Make pro perfil pessoal — a URL do webhook Make
 * do Pixel só existe como Worker secret, nunca local). Mas rodar os 2
 * dispatches em sequência sem checar isso ANTES abriria uma janela ruim: a
 * página sai (dispatch 1 ok) e só o perfil falha (dispatch 2), publicando
 * metade do anúncio sem o editor perceber que a outra metade não saiu. Este
 * script checa `useWorkerForScheduled` ANTES do 1º dispatch e aborta os 2 se
 * faltar — mesma disciplina de fail-fast de `publish-linkedin.ts` (#923).
 *
 * Uso:
 *   npx tsx scripts/publish-artigo-especial-linkedin.ts \
 *     --dir data/artigo-especial/2026-engenharia-de-ilusao \
 *     --at 2026-09-02T17:30:00-03:00 \
 *     [--image-url URL] [--only pagina|perfil] [--force] [--dry-run]
 *
 * `--image-url` é opcional — o default é o `og:image` do próprio artigo
 * (`workers/artigos/public/{ano}/{slug}/index.html`, `{ano}`/`{slug}`
 * derivados de `--dir`), lido via `scripts/lib/artigo-especial-meta.ts`.
 *
 * Lê `{dir}/linkedin-pagina.md` e `{dir}/linkedin-perfil.md` (texto já
 * humanizado/corrigido pela Clarice no Passo 1 da skill) como corpo dos 2
 * posts.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { dispatchEntry, type DispatchContext, type DispatchInput } from "./publish-linkedin.ts";
import { readSocialPublished } from "./lib/social-published-store.ts";
import type { PostEntry } from "./lib/social-published-store.ts";
import { verifyWorkerDispatch } from "./verify-social-worker-dispatch.ts";
import {
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  decideChannelAction,
  buildDoneChannelState,
  buildFailedChannelState,
  withChannelState,
  type ArtigoEspecialChannel,
} from "./lib/artigo-especial-state.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { readArtigoMeta } from "./lib/artigo-especial-meta.ts";

const ROOT = resolve(import.meta.dirname, "..");

type LinkedinTarget = "pagina" | "perfil";

const TARGET_TO_CHANNEL: Record<LinkedinTarget, ArtigoEspecialChannel> = {
  pagina: "linkedin_pagina",
  perfil: "linkedin_perfil",
};

/** Pura: deriva o `ChannelStatus` agregado (Passo 0) a partir do `PostEntry`
 *  que `dispatchEntry` gravou. `draft`/`scheduled` (qualquer rota que saiu
 *  sem lançar) → `done`; `failed` → `failed`. */
export function deriveChannelStatusFromPostEntry(entry: PostEntry): "done" | "failed" {
  return entry.status === "failed" ? "failed" : "done";
}

interface ArgsParsed {
  dir: string;
  /** Override — normalmente derivado do og:image do artigo (ver `resolveImageUrl`). */
  imageUrl?: string;
  at?: string;
  only: LinkedinTarget[];
  force: boolean;
  dryRun: boolean;
}

export function parseCliArgs(argv: string[]): ArgsParsed | { error: string } {
  const { values, flags } = parseArgs(argv);
  const dir = values["dir"];
  if (!dir) return { error: "--dir obrigatório (ex: data/artigo-especial/2026-slug)" };
  const onlyArg = values["only"];
  const only: LinkedinTarget[] = onlyArg
    ? onlyArg
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is LinkedinTarget => s === "pagina" || s === "perfil")
    : ["pagina", "perfil"];
  if (only.length === 0) return { error: "--only deve conter pagina e/ou perfil" };
  return {
    dir,
    imageUrl: values["image-url"],
    at: values["at"],
    only,
    force: flags.has("force"),
    dryRun: flags.has("dry-run"),
  };
}

/** Deriva `{ano, slug}` do nome de `--dir` (convenção `{ano}-{slug}` — mesma
 *  que `artigoEspecialStatePath` usa). Slug pode conter hífens; ano é
 *  sempre os 4 primeiros dígitos. */
export function parseAnoSlugFromDir(dirName: string): { ano: string; slug: string } | null {
  const m = /^(\d{4})-(.+)$/.exec(dirName);
  if (!m) return null;
  return { ano: m[1], slug: m[2] };
}

/** Resolve a `og:image` do artigo já deployado — fonte única, evita exigir
 *  `--image-url` na maioria das invocações (issue #5979: "imageUrl = og:image"). */
export function resolveImageUrl(rootDir: string, ano: string, slug: string, override?: string): string | null {
  if (override) return override;
  const htmlPath = resolve(rootDir, "workers/artigos/public", ano, slug, "index.html");
  if (!existsSync(htmlPath)) return null;
  return readArtigoMeta(htmlPath).image;
}

function readPostBody(dir: string, target: LinkedinTarget): string {
  const filename = target === "pagina" ? "linkedin-pagina.md" : "linkedin-perfil.md";
  const path = resolve(dir, filename);
  if (!existsSync(path)) {
    throw new Error(`${path} não encontrado — Passo 1 da skill (geração de texto) precisa rodar antes.`);
  }
  return readFileSync(path, "utf8").trim();
}

export interface RunDispatchOptions {
  /** Diretório absoluto do artigo (`data/artigo-especial/{ano}-{slug}`). */
  artigoDir: string;
  ano: string;
  slug: string;
  imageUrl: string | null;
  scheduledAt: string;
  only: LinkedinTarget[];
  force: boolean;
  dryRun: boolean;
  ctx: DispatchContext;
  statePath: string;
  /** Injetável pra teste — default `readArtigoEspecialState`/`writeArtigoEspecialState`. */
  verifyWorker?: (published: ReturnType<typeof readSocialPublished>) => Promise<{ changes: number }>;
}

export interface RunDispatchResult {
  results: Array<{ target: LinkedinTarget; entry: PostEntry | null; skipped: boolean }>;
  failedCount: number;
}

/**
 * Corpo testável do dispatch (extraído de `main()` — #5979 self-review: sem
 * isso, a única forma de testar seria spawnar o CLI de verdade contra rede
 * mockada, o que este repo não faz pra scripts com `fetch` embutido em
 * módulo importado). Não lê env/config/argv — tudo explícito em `options`.
 */
export async function runArtigoEspecialLinkedinDispatch(
  options: RunDispatchOptions,
): Promise<RunDispatchResult> {
  const { artigoDir, ano, slug, imageUrl, scheduledAt, only, force, dryRun, ctx, statePath } = options;
  let state = readArtigoEspecialState(statePath, ano, slug);

  const targetToWebhook: Record<LinkedinTarget, "diaria" | "pixel"> = { pagina: "diaria", perfil: "pixel" };
  const results: RunDispatchResult["results"] = [];

  for (const target of only) {
    const channel = TARGET_TO_CHANNEL[target];
    const decision = decideChannelAction(state, channel, force);
    if (decision.action === "skip") {
      console.log(`[${target}] pulado — ${decision.reason}`);
      results.push({ target, entry: null, skipped: true });
      continue;
    }

    const text = readPostBody(artigoDir, target);
    const input: DispatchInput = {
      destaque: target, // "pagina" | "perfil" — não é d1/d2/d3, ver DispatchInput.destaque: string.
      subtype: "main",
      text,
      imageUrl,
      scheduledAt,
      webhookTarget: targetToWebhook[target],
      action: "post",
    };

    if (dryRun) {
      console.log(`[dry-run] dispatch ${target} (webhook_target=${input.webhookTarget}) — texto:\n${text}\n`);
      results.push({ target, entry: null, skipped: false });
      continue;
    }

    const entry = await dispatchEntry(input, ctx);
    results.push({ target, entry, skipped: false });

    const attemptedAt = new Date().toISOString();
    const channelState =
      deriveChannelStatusFromPostEntry(entry) === "done"
        ? buildDoneChannelState(attemptedAt, null)
        : buildFailedChannelState(attemptedAt, entry.reason ?? "dispatch falhou");
    state = withChannelState(state, channel, channelState);
    writeArtigoEspecialState(statePath, state);
  }

  if (dryRun) return { results, failedCount: 0 };

  // Verificação pós-dispatch (#5979 Passo 4 — reusa o helper de
  // verify-social-worker-dispatch.ts, mesma reconciliação Worker /list+/dlq
  // do Stage 5 diário, sem reinventar).
  if (results.some((r) => r.entry?.status === "scheduled")) {
    try {
      const published = readSocialPublished(ctx.publishedPath);
      const verify = options.verifyWorker ?? ((p) => verifyWorkerDispatch(p, ctx.workerUrl, ctx.workerToken));
      const { changes } = await verify(published);
      console.log(`[verify] reconciliação Worker: ${changes} entrada(s) confirmada(s) na fila.`);
    } catch (e) {
      console.warn(`[verify] falhou (non-fatal, resultado do dispatch já foi gravado): ${(e as Error).message}`);
    }
  }

  const failedCount = results.filter((r) => r.entry?.status === "failed").length;
  return { results, failedCount };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`Erro: ${parsed.error}`);
    process.exit(2);
  }
  const { dir, imageUrl: imageUrlOverride, at, only, force, dryRun } = parsed;
  const artigoDir = resolve(ROOT, dir);

  // {ano}-{slug} vem do nome do diretório (mesma convenção que quem chamou
  // este script já usou pra criá-lo — ver artigoEspecialStatePath).
  const dirName = artigoDir.split(/[/\\]/).pop() ?? "";
  const anoSlug = parseAnoSlugFromDir(dirName);
  if (!anoSlug) {
    console.error(`Erro: --dir "${dir}" não segue o padrão {ano}-{slug} (ex: 2026-engenharia-de-ilusao).`);
    process.exit(2);
    return;
  }
  const { ano, slug } = anoSlug;
  const imageUrl = resolveImageUrl(ROOT, ano, slug, imageUrlOverride);

  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    publishing?: { social?: { linkedin?: { make_webhook_url?: string; cloudflare_worker_url?: string } } };
  };
  const webhookUrl = process.env.MAKE_LINKEDIN_WEBHOOK_URL ?? config.publishing?.social?.linkedin?.make_webhook_url ?? "";
  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? config.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  const useWorkerForScheduled = workerUrl !== "" && workerToken !== "";

  // Fail-fast (ver docstring do módulo): sem Worker, "perfil" (pixel) não
  // tem como sair de jeito nenhum — abortar os 2 antes de despachar a
  // página, pra não publicar só metade do anúncio.
  if (!useWorkerForScheduled) {
    console.error(
      "ERRO: Cloudflare Worker do LinkedIn não configurado (DIARIA_LINKEDIN_CRON_URL/_TOKEN ausentes).\n" +
        "webhook_target=pixel (perfil pessoal) exige o Worker — não há fallback Make pro perfil.\n" +
        "Abortando os 2 dispatches (página + perfil) para não publicar só metade do anúncio.",
    );
    process.exit(2);
  }
  if (!webhookUrl) {
    console.error("ERRO: MAKE_LINKEDIN_WEBHOOK_URL / publishing.social.linkedin.make_webhook_url ausente.");
    process.exit(2);
  }

  if (!at) {
    console.error(
      "Erro: --at obrigatório aqui (resolva o default D+1 17:30 BRT via " +
        "scripts/lib/artigo-especial-schedule.ts::resolveArtigoEspecialScheduledAt antes de chamar este script).",
    );
    process.exit(2);
    return;
  }
  const scheduledAt = at;

  const linkedinPublishedPath = resolve(artigoDir, "linkedin-published.json");
  const statePath = artigoEspecialStatePath(resolve(ROOT, "data"), ano, slug);

  const webhookApiKey = process.env.MAKE_WEBHOOK_API_KEY || undefined;
  const ctx: DispatchContext = {
    publishedPath: linkedinPublishedPath,
    webhookUrl,
    apiKey: webhookApiKey,
    workerUrl,
    workerToken,
    useWorkerForScheduled,
    editionDate: `${ano}-${slug}`,
    rootDir: ROOT,
  };

  const { failedCount } = await runArtigoEspecialLinkedinDispatch({
    artigoDir,
    ano,
    slug,
    imageUrl,
    scheduledAt,
    only,
    force,
    dryRun,
    ctx,
    statePath,
  });

  if (failedCount > 0) {
    console.error(`${failedCount} dispatch(es) falharam — ver ${linkedinPublishedPath} e ${statePath}.`);
    process.exitCode = 1;
  } else if (!dryRun) {
    console.log("OK — dispatch(es) concluído(s).");
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
