/**
 * publish-eia-social.ts
 *
 * Agenda o post do "É IA?" nas redes. Existe porque os publishers da Etapa 5
 * leem os destaques (`## d{N}` / `# Curto`) de `03-social.md` — não há
 * caminho pro É IA? por lá, e até agora ele só saía à mão.
 *
 * Não substitui a Etapa 5: é dispatch AVULSO, disparado pelo editor quando
 * ele quer o quiz nas redes. Ver `context/publishers/linkedin.md` §É IA?.
 *
 * Entradas (ambas da edição):
 *   01-eia-social.md          textos por canal (`## linkedin`, `## facebook`,
 *                             `## instagram`, `## threads`, `## twitter`) —
 *                             o link com UTM já vem escrito ali, nada é
 *                             injetado aqui.
 *   01-eia-linkedin-*.jpg     arte carimbada A/B (`gen-eia-linkedin-cards.ts`)
 *
 * Canais e como cada um agenda:
 *   linkedin, instagram, threads → fila do Worker `diaria-linkedin-cron`
 *                                  (`postToWorkerQueue`), mesma usada pela
 *                                  Etapa 5.
 *   facebook                    → Graph API com `scheduled_publish_time`.
 *   twitter                     → NÃO daqui: a API da Buffer só é alcançável
 *                                 por MCP, de dentro de uma sessão de agente
 *                                 (mesma razão do `prep-twitter-posts.ts`).
 *                                 O payload sai impresso em
 *                                 `twitter_handoff` pra sessão despachar.
 *
 * Arte por canal: Instagram leva o carrossel A→B (dois 1:1); os demais levam
 * o composto 4:5. Motivo em `scripts/lib/eia-linkedin-card.ts`.
 *
 * Uso:
 *   npx tsx scripts/publish-eia-social.ts --edition AAMMDD \
 *     --at 2026-08-26T09:50:00-03:00 [--skip canal[,canal]] [--dry-run]
 *
 * `--at` é obrigatório e precisa ser ISO com offset — nada de "amanhã 9h"
 * resolvido aqui: o fuso da máquina que dispara não é necessariamente o do
 * editor, e errar isso publica na hora errada em conta pública.
 *
 * `--dry-run` faz TUDO menos as chamadas de escrita (nem upload de imagem,
 * nem enfileiramento, nem Graph API) e imprime o plano.
 *
 * Best-effort por canal: falha de um canal não aborta os demais — o resumo
 * final lista `scheduled` e `failed` separados, e o exit code é != 0 se
 * qualquer canal falhou (senão uma falha parcial passa por sucesso).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { runMain } from "./lib/exit-handler.ts";
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { postToWorkerQueue } from "./lib/worker-queue-client.ts";

export const EIA_CHANNELS = ["linkedin", "facebook", "instagram", "threads", "twitter"] as const;
export type EiaChannel = (typeof EIA_CHANNELS)[number];

/** Canais que a fila do Worker sabe despachar. */
const WORKER_CHANNELS = new Set<EiaChannel>(["linkedin", "instagram", "threads"]);

export interface EiaDispatchPlan {
  channel: EiaChannel;
  text: string;
  /** Carrossel (Instagram) ou imagem única (resto). */
  images: string[];
}

/**
 * Pure: extrai o corpo de `## {canal}` de `01-eia-social.md`.
 *
 * Não reusa `extractSection` de `lib/extract-section.ts` porque aquele casa
 * `# Titulo` (nível 1) e aqui as seções são de nível 2, irmãs sob um `#`
 * único — mesma forma dos `## d{N}` de `03-social.md`.
 */
export function extractChannelText(md: string, channel: string): string | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const re = new RegExp(`(?:^|\\n)## ${channel}\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`, "i");
  const body = normalized.match(re)?.[1]?.trim();
  if (!body) return null;
  // Uma citação `>` no topo é comentário do arquivo, nunca corpo de post.
  if (body.startsWith(">")) return null;
  return body;
}

/** Pure: qual arte cada canal leva. */
export function imagesForChannel(channel: EiaChannel, art: { composite: string; a: string; b: string }): string[] {
  return channel === "instagram" ? [art.a, art.b] : [art.composite];
}

export function buildPlans(md: string, art: { composite: string; a: string; b: string }, skip: Set<string>): EiaDispatchPlan[] {
  const plans: EiaDispatchPlan[] = [];
  for (const channel of EIA_CHANNELS) {
    if (skip.has(channel)) continue;
    const text = extractChannelText(md, channel);
    if (!text) throw new Error(`01-eia-social.md sem seção "## ${channel}" — escreva o texto ou passe --skip ${channel}`);
    plans.push({ channel, text, images: imagesForChannel(channel, art) });
  }
  return plans;
}

/** Pure: valida que `--at` é ISO com offset e está no futuro. */
export function parseScheduledAt(raw: string, now: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(raw)) {
    throw new Error(`--at inválido: ${JSON.stringify(raw)} — use ISO com offset, ex: 2026-08-26T09:50:00-03:00`);
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`--at não é uma data válida: ${raw}`);
  if (at.getTime() <= now.getTime()) throw new Error(`--at está no passado: ${raw}`);
  return at.toISOString();
}

async function scheduleFacebook(
  text: string,
  imageUrl: string,
  scheduledAtIso: string,
): Promise<string> {
  const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
  const apiVersion = process.env.FACEBOOK_API_VERSION ?? "v25.0";
  let token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? "";
  if (!token) {
    const credsPath = resolve(process.cwd(), "data/.fb-credentials.json");
    if (existsSync(credsPath)) token = JSON.parse(readFileSync(credsPath, "utf8")).page_access_token ?? "";
  }
  if (!pageId || !token) throw new Error("Facebook sem credencial (FACEBOOK_PAGE_ID + token no env ou data/.fb-credentials.json)");

  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: imageUrl,
      caption: text,
      published: false,
      scheduled_publish_time: Math.floor(new Date(scheduledAtIso).getTime() / 1000),
      access_token: token,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Graph API HTTP ${res.status}: ${body.slice(0, 300)}`);
  return (JSON.parse(body).id as string) ?? "(sem id)";
}

export interface EiaDispatchResult {
  scheduled: { channel: string; ref: string }[];
  failed: { channel: string; error: string }[];
  twitter_handoff: { text: string; image_url: string; due_at: string } | null;
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const dir = values["out-dir"] ? resolve(values["out-dir"]) : editionDir(values.edition ?? "");
  const dryRun = flags.has("dry-run");
  const skip = new Set((values.skip ?? "").split(",").map((s) => s.trim()).filter(Boolean));

  const scheduledAtIso = parseScheduledAt(values.at ?? "", new Date());

  const mdPath = resolve(dir, "01-eia-social.md");
  if (!existsSync(mdPath)) throw new Error(`Faltando ${mdPath} — escreva os textos por canal antes.`);

  const files = {
    composite: resolve(dir, "01-eia-linkedin-ab.jpg"),
    a: resolve(dir, "01-eia-linkedin-A.jpg"),
    b: resolve(dir, "01-eia-linkedin-B.jpg"),
  };
  for (const [k, p] of Object.entries(files)) {
    if (!existsSync(p)) throw new Error(`Arte ausente (${k}): ${p} — rode gen-eia-linkedin-cards.ts antes.`);
  }

  const plans = buildPlans(readFileSync(mdPath, "utf8"), files, skip);
  const edition = values.edition ?? "eia";

  console.log(`[eia-social] ${plans.length} canal(is), agendado para ${scheduledAtIso}${dryRun ? " (DRY-RUN)" : ""}`);

  const result: EiaDispatchResult = { scheduled: [], failed: [], twitter_handoff: null };

  // Upload das artes ANTES de qualquer dispatch: se o KV falhar, ninguém é
  // agendado apontando pra imagem que não existe.
  const publicUrl: Record<string, string> = {};
  const kvNamespaceId = JSON.parse(readFileSync(resolve(process.cwd(), "platform.config.json"), "utf8"))?.poll?.kv_namespace_id;
  if (!kvNamespaceId) throw new Error("platform.config.json → poll.kv_namespace_id ausente");

  for (const [slot, path] of Object.entries(files)) {
    const key = `img-${edition}-eia-${slot}.jpg`;
    if (dryRun) {
      publicUrl[path] = `https://eia.diar.ia.br/img/${key}`;
      continue;
    }
    publicUrl[path] = await uploadImageToWorkerKV(path, key, { kvNamespaceId });
    console.log(`[eia-social] arte ${slot} → ${publicUrl[path]}`);
  }

  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";

  for (const plan of plans) {
    const urls = plan.images.map((p) => publicUrl[p]);
    try {
      if (plan.channel === "twitter") {
        result.twitter_handoff = { text: plan.text, image_url: urls[0], due_at: scheduledAtIso };
        console.log("[eia-social] twitter: handoff pra sessão (Buffer via MCP)");
        continue;
      }

      if (dryRun) {
        console.log(`[eia-social] ${plan.channel}: ${urls.length} imagem(ns), ${plan.text.length} chars — DRY-RUN, nada enviado`);
        result.scheduled.push({ channel: plan.channel, ref: "(dry-run)" });
        continue;
      }

      if (WORKER_CHANNELS.has(plan.channel)) {
        if (!workerUrl || !workerToken) throw new Error("DIARIA_LINKEDIN_CRON_URL/TOKEN ausentes");
        const queued = await postToWorkerQueue(workerUrl, workerToken, {
          text: plan.text,
          ...(urls.length > 1 ? { image_urls: urls } : { image_url: urls[0] }),
          scheduled_at: scheduledAtIso,
          destaque: `eia-${edition}`,
          channel: plan.channel as "linkedin" | "instagram" | "threads",
        });
        result.scheduled.push({ channel: plan.channel, ref: queued.key });
      } else {
        result.scheduled.push({ channel: plan.channel, ref: await scheduleFacebook(plan.text, urls[0], scheduledAtIso) });
      }
      console.log(`[eia-social] ${plan.channel}: agendado`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[eia-social] ${plan.channel}: FALHOU — ${msg}`);
      result.failed.push({ channel: plan.channel, error: msg });
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length > 0) {
    throw new Error(`${result.failed.length} canal(is) falharam: ${result.failed.map((f) => f.channel).join(", ")}`);
  }
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
