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
 * **Esse guard vive só em `main()` (o entrypoint CLI), não em
 * `runArtigoEspecialLinkedinDispatch`** (achado do comment-analyzer, review
 * #5979/PR #6000). A função exportada/testável é mais permissiva de
 * propósito — chamada com `only: ["pagina"]` ela despacha só a página sem
 * exigir Worker (via fallback Make), o que é o comportamento CORRETO nesse
 * caso (não há "metade" de um único canal). O guard "aborte os 2" só faz
 * sentido no ponto de entrada que decide QUAIS canais rodar por padrão
 * (ambos) — não pertence à função reusável, que já não teria como saber se
 * o caller pediu 1 ou 2 canais de propósito.
 *
 * **`fallback_used` (Make fire-now em vez do Worker agendado) gera warning
 * explícito no terminal**, não só no `linkedin-published.json` — ver
 * `runArtigoEspecialLinkedinDispatch` (achado do silent-failure-hunter,
 * mesmo review): sem isso, "postado no horário certo via Worker" e "postado
 * JÁ, ignorando o `--at`, porque o Worker falhou" colapsavam no mesmo
 * `status: "done"` do guard agregado, silenciosamente.
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

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { dispatchEntry, type DispatchContext, type DispatchInput } from "./publish-linkedin.ts";
import { readSocialPublished } from "./lib/social-published-store.ts";
import type { PostEntry, SocialPublished } from "./lib/social-published-store.ts";
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

/**
 * Pura: o `destaque` que vai NO PAYLOAD DO WORKER (não o do nosso store).
 *
 * O Worker LinkedIn valida `destaque` contra `/^(d[123]|weekly(-[a-z]+)?)$/`
 * (`workers/linkedin-cron/src/index.ts`) e rejeita "pagina"/"perfil" com HTTP
 * 400 — incidente da 1ª execução ao vivo, 23/08/2026, ver o comentário longo
 * no call site de `dispatchEntry`. `weekly-{target}` casa com o regex e é
 * puro carimbo de auditoria do lado do Worker.
 *
 * O nosso `linkedin-published.json` NÃO pode herdar esse valor: a
 * reconciliação lê `post.destaque` de volta e mapeia por `TARGET_TO_CHANNEL`
 * (`weekly-pagina` não é chave válida lá, o canal viraria `undefined` e a
 * correção de status silenciosamente não aconteceria). Por isso o retorno do
 * `dispatchEntry` é normalizado de volta pra "pagina"/"perfil" antes de ser
 * gravado — ver `normalizeEntryDestaque`.
 */
export function dispatchDestaqueFor(target: LinkedinTarget): string {
  return `weekly-${target}`;
}

/**
 * Espelho do regex de validação do Worker (`workers/linkedin-cron/src/index.ts`,
 * handler `/queue`). Duplicado aqui de propósito: o Worker é outro deployable
 * e não dá pra importar dele: o objetivo é falhar ANTES do dispatch em vez de
 * descobrir via HTTP 400 no meio da sequência.
 */
const WORKER_DESTAQUE_RE = /^(d[123]|weekly(-[a-z]+)?)$/;

/**
 * Guard de pré-voo: valida o `destaque` de TODOS os targets desta run contra o
 * contrato do Worker antes de despachar QUALQUER um.
 *
 * Existe por causa do incidente de 23/08/2026: o `destaque` inválido só era
 * descoberto quando o Worker devolvia 400, e aí já era tarde — o dispatch da
 * página caía no fallback Make (que publica NA HORA, ignorando
 * `scheduled_at`) enquanto o do perfil falhava seco, publicando exatamente a
 * "metade do anúncio" que o fail-fast do topo deste script existe pra evitar.
 * O fail-fast original não cobria este caso porque ele checa se o Worker está
 * CONFIGURADO/alcançável, e um 400 é uma resposta válida de um Worker no ar.
 */
export function assertDispatchDestaquesValid(targets: readonly LinkedinTarget[]): void {
  const invalid = targets.map((t) => [t, dispatchDestaqueFor(t)] as const).filter(([, d]) => !WORKER_DESTAQUE_RE.test(d));
  if (invalid.length > 0) {
    const detail = invalid.map(([t, d]) => `${t} → "${d}"`).join(", ");
    throw new Error(
      `destaque incompatível com o Worker LinkedIn (${detail}); esperado casar ${WORKER_DESTAQUE_RE}. ` +
        `Abortando ANTES de despachar — um dispatch parcial publicaria a página fora do horário via fallback Make ` +
        `e deixaria o perfil sem post (incidente 23/08/2026).`,
    );
  }
}

/**
 * Pura: resolve o canal a partir do `destaque` COMO ESTÁ GRAVADO no store.
 *
 * Aceita as duas grafias de propósito. `dispatchEntry` persiste a entry por
 * dentro, com o `destaque` que foi enviado ao Worker (`weekly-pagina`), então
 * é esse o valor que aparece em `linkedin-published.json` a partir de
 * 23/08/2026 — mas o arquivo também guarda entries ANTERIORES ao incidente,
 * gravadas como "pagina"/"perfil" cru. Ler só uma das grafias faria a
 * reconciliação pular entries silenciosamente (canal `undefined` → `continue`),
 * que é justamente o modo de falha invisível que este arquivo tenta evitar.
 */
export function channelForStoredDestaque(destaque: string): ArtigoEspecialChannel | null {
  const bare = destaque.startsWith("weekly-") ? destaque.slice("weekly-".length) : destaque;
  return TARGET_TO_CHANNEL[bare as LinkedinTarget] ?? null;
}

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
  let only: LinkedinTarget[];
  if (onlyArg) {
    const tokens = onlyArg
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Erro EXPLÍCITO em token não reconhecido, nunca filtro silencioso —
    // um typo aqui (ex: "perfiil") produzia metade do anúncio dispatchada
    // sem nenhum sinal do outro alvo nunca ter sido tentado, exatamente a
    // classe de falha que o guard de Worker (main(), abaixo) já existe pra
    // evitar (achado do silent-failure-hunter, review #5979/PR #6000).
    const invalid = tokens.filter((t) => t !== "pagina" && t !== "perfil");
    if (invalid.length > 0) {
      return {
        error: `--only contém valor(es) não reconhecido(s): ${invalid.join(", ")} (esperado: pagina e/ou perfil).`,
      };
    }
    only = tokens as LinkedinTarget[];
    if (only.length === 0) return { error: "--only deve conter pagina e/ou perfil" };
  } else {
    only = ["pagina", "perfil"];
  }
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
 *  `--image-url` na maioria das invocações (issue #5979: "imageUrl = og:image").
 *  `null` quando o HTML não existe (ex: `--dir`/deploy incorretos) — nesse
 *  caso o post sai SEM imagem, então avisa explicitamente em vez de falhar
 *  silenciosamente (achado do silent-failure-hunter, review #5979/PR #6000:
 *  sem este aviso, um `--dir` errado produzia um post agendado sem capa e
 *  exit 0, sem nenhum log apontando a causa). */
export function resolveImageUrl(rootDir: string, ano: string, slug: string, override?: string): string | null {
  if (override) return override;
  const htmlPath = resolve(rootDir, "workers/artigos/public", ano, slug, "index.html");
  if (!existsSync(htmlPath)) {
    console.warn(
      `[publish-artigo-especial-linkedin] AVISO: ${htmlPath} não encontrado — post(s) sairão SEM imagem (og:image). ` +
        "Confirme --dir/o deploy do artigo antes de prosseguir, ou passe --image-url explicitamente.",
    );
    return null;
  }
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
  /** Injetável pra teste — default `verifyWorkerDispatch` real (Worker HTTP).
   *  Contrato igual ao de `verify-social-worker-dispatch.ts::verifyWorkerDispatch`:
   *  devolve `updated` (o `SocialPublished` reconciliado) — o caller É quem
   *  decide persistir, não o helper (mesmo contrato do call site canônico). */
  verifyWorker?: (published: SocialPublished) => Promise<{ updated: SocialPublished; changes: number }>;
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

  assertDispatchDestaquesValid(only);

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
      // INCIDENTE 23/08/2026 (1ª execução ao vivo desta skill): aqui passava
      // `destaque: target` ("pagina"/"perfil") na premissa de que
      // `DispatchInput.destaque: string` era livre. É livre no TIPO, mas o
      // Worker VALIDA em runtime — `workers/linkedin-cron/src/index.ts`,
      // regex `/^(d[123]|weekly(-[a-z]+)?)$/` — e devolveu HTTP 400 pros 2
      // dispatches. Consequência real: o dispatch da PÁGINA caiu no fallback
      // Make, que publica NA HORA e ignora `scheduled_at`, então o post saiu
      // às 23h em vez do horário agendado (foi apagado à mão); o do PERFIL
      // falhou seco (sem fallback Make pro `webhook_target=pixel`). O
      // fail-fast do topo deste script não pegou porque ele testa se o
      // Worker está CONFIGURADO/alcançável — e o Worker respondeu, só que
      // 400: erro de validação passa por aquele guard.
      //
      // Correção mínima e sem deploy: usar um valor que o Worker JÁ aceita.
      // `weekly-{target}` casa com `weekly(-[a-z]+)?`. Escolhido em vez de
      // ampliar o regex do Worker porque a versão publicada estava ~1 mês
      // atrás do master (checado via `wrangler deployments list`) — um
      // deploy pra corrigir isto subiria drift não relacionado no canal que
      // publica a edição diária. `destaque` no Worker é só carimbo de
      // auditoria (não há ramificação por prefixo `weekly`, conferido em
      // index.ts), então o efeito colateral é cosmético no log dele.
      // Nosso store local (`linkedin-published.json`) continua gravando
      // "pagina"/"perfil" — ver `dispatchDestaqueFor`.
      destaque: dispatchDestaqueFor(target),
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

    // `published.json` (o guard agregado) só grava status "done"/"failed" —
    // não distingue "agendado no horário via Worker" de "postado JÁ, agora,
    // via fallback Make porque o Worker falhou" (`entry.fallback_used`).
    // `linkedin-published.json` preserva o detalhe completo (`route`,
    // `fallback_used`, `fallback_reason`); este warning garante que a
    // diferença também apareça no terminal, não só enterrada nesse arquivo
    // — achado do silent-failure-hunter, review #5979/PR #6000 (#573 do
    // CLAUDE.md: nunca só o gloss, validar o estado real antes de relayar).
    if (entry.fallback_used) {
      console.warn(
        `[${target}] AVISO: Worker falhou, post saiu via fallback Make AGORA (${scheduledAt} ignorado) — motivo: ${entry.fallback_reason ?? "não registrado"}.`,
      );
    }

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
      const verify = options.verifyWorker ?? ((p: SocialPublished) => verifyWorkerDispatch(p, ctx.workerUrl, ctx.workerToken));
      const { updated, changes } = await verify(published);
      console.log(`[verify] reconciliação Worker: ${changes} entrada(s) confirmada(s) na fila.`);
      if (changes > 0) {
        // Persistir o resultado reconciliado (#5979 review, PR #6000, achado
        // do code-reviewer): o call site canônico
        // (verify-social-worker-dispatch.ts::main()) sempre reescreve
        // `linkedin-published.json` quando `changes > 0` — este script só
        // logava e descartava `updated`. Sem a escrita, uma entry que o
        // Worker rejeitou (DLQ) depois de `dispatchEntry` reportar
        // "scheduled" ficava presa como sucesso pra sempre.
        writeFileSync(ctx.publishedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");

        // Propagar reconciliações que viraram "failed" pro guard agregado
        // (published.json) e pro RunDispatchResult retornado — sem isso o
        // canal continuava "done" (gravado a partir do status ORIGINAL de
        // `dispatchEntry`, linha ~253 acima) mesmo depois da reconciliação
        // descobrir a falha real, e um resume (`decideChannelAction`) nunca
        // retentaria.
        //
        // #5979 review, PR #6000 (achado convergente: silent-failure-hunter
        // + code-reviewer, independentemente): `updated.posts` cobre AMBOS
        // os targets (pagina/perfil) sempre — `linkedin-published.json` é
        // compartilhado — mas `results` só cobre os targets do `--only`
        // desta invocação. Gatear em `resultEntry?.entry` (como a versão
        // anterior fazia) deixava de fora o cenário: run A despacha os 2
        // (ambos "done" em published.json) e uma run B posterior com `--only
        // pagina` reconcilia e descobre que `perfil` caiu no DLQ nesse
        // ínterim — `linkedin-published.json` era corrigido corretamente,
        // mas `published.json` (o guard que `decideChannelAction` lê pra
        // decidir se retenta) ficava com `perfil: done` pra sempre. Iterar
        // TODO post de `updated.posts` contra `TARGET_TO_CHANNEL` — não só
        // os presentes em `results` — fecha essa lacuna: o guard agregado é
        // corrigido mesmo pra canais fora do `--only` desta run, sem exigir
        // que uma correspondência em `results` exista.
        for (const post of updated.posts) {
          if (post.platform !== "linkedin" || post.status !== "failed") continue;
          const channel = channelForStoredDestaque(post.destaque);
          if (!channel) continue;
          const target = (post.destaque.startsWith("weekly-") ? post.destaque.slice("weekly-".length) : post.destaque) as LinkedinTarget;
          if (state.channels[channel]?.status === "failed") continue; // já refletido, evita write redundante
          const reason =
            typeof post.failure_reason === "string" ? post.failure_reason : "reconciliação pós-dispatch: Worker reportou falha (DLQ).";
          state = withChannelState(state, channel, buildFailedChannelState(new Date().toISOString(), reason));
          const resultEntry = results.find((r) => r.target === target);
          if (resultEntry) resultEntry.entry = post; // só atualiza o retorno se o target fazia parte desta invocação
        }
        writeArtigoEspecialState(statePath, state);
      }
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
