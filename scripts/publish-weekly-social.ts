/**
 * publish-weekly-social.ts (#4101, restrito ao Instagram + seleção por
 * clique pelo #4483)
 *
 * Post semanal do Instagram — os itens mais clicados da semana (segunda a
 * sexta), produzido no sábado e AGENDADO. **#4483 substitui as duas decisões
 * anteriores do #4101:**
 *
 *   1. Canal: era LinkedIn + Facebook + Instagram + Threads (+ X à parte) —
 *      agora é SÓ Instagram. O recap semanal do LinkedIn passou a ser
 *      coberto por `/diaria-linkedin-semanal` (#4456, artigo de newsletter
 *      nativa, publicado segunda) — manter o post de sábado no LinkedIn
 *      duplicaria o recap com 2 dias de distância. Facebook/Threads/X saíram
 *      de escopo junto (nenhuma decisão do editor os resgatou).
 *   2. Seleção: era "os 5 D1, sem ranking por clique" — agora é "os N mais
 *      clicados da semana, de qualquer posição elegível (D1/D2/D3)". Ver
 *      `scripts/lib/weekly-instagram-select.ts` pra metodologia completa e
 *      pra por que RADAR/USE MELHOR NÃO competem aqui (diferente do
 *      LinkedIn) — o carrossel do Instagram precisa de um card 4:5 com
 *      título embutido, que só existe pra D1/D2/D3.
 *
 * Quantidade de itens: a issue deixou em aberto, decisão do editor
 * (comentário 260802 do #4483): continua 5 — muda a DEFINIÇÃO ("os 5 mais
 * clicados", não "1 por edição"), não o número. `WEEKLY_EXPECTED_ITEMS`
 * abaixo é o parâmetro fácil de ajustar se isso mudar depois.
 *
 * GUARD DE PUBLICAÇÃO: este script SEMPRE agenda (nunca publica imediato).
 * Sem `--schedule`, o script só IMPRIME o preview (seleção + caption +
 * horário planejado) e retorna — nenhuma chamada de rede é feita. Com
 * `--schedule`, despacha pelo MESMO caminho agendado que os publishers
 * diários já usam: Worker queue `diaria-linkedin-cron`
 * (`scripts/lib/worker-queue-client.ts`, endpoint `/queue`, `channel:
 * "instagram"`).
 *
 * Carrossel (#4146, redesenhado pelo #4483): 1 card 4:5 por item
 * selecionado, na mesma ordem numerada da caption — mas desde o #4483 cada
 * card vem da imagem PRÓPRIA do destaque selecionado (`d{n}_4x5` da edição
 * de origem, `n` = número do destaque), não mais "1 card por dia da
 * semana". Se QUALQUER item não resolver imagem, o post inteiro FALHA (não
 * publica um carrossel parcial) — ver `resolveWeeklyImageUrls` abaixo.
 *
 * `--manifest-only`: só resolve a janela + candidatos + cruza com o cache
 * de cliques pra emitir o manifest de posts que precisam de enriquecimento
 * via MCP (mesmo padrão de `select-linkedin-weekly.ts --manifest-only`,
 * #4456) — NÃO calcula seleção nem agenda. O gate de 7 dias de
 * `identifyPostsNeedingClicks` (`scripts/beehiiv-sync.ts`) nunca enriquece
 * posts com menos de 7 dias, e os posts desta janela têm entre 2 e 6 dias
 * de idade no momento em que a skill roda — sem este passo explícito, a
 * seleção rodaria com clicks zerados pra semana inteira.
 *
 * Horário — `--time` (default "11:00", ver DEFAULT_WEEKLY_TIME abaixo) é uma
 * ASSUNÇÃO da implementação, não uma decisão do editor (herdada do #4101).
 * Timezone vem de `platform.config.json` (`publishing.social.timezone`,
 * leitura apenas — nunca escrito por este script).
 *
 * Uso:
 *   npx tsx scripts/publish-weekly-social.ts --saturday 260801 [--schedule]
 *     [--editions-root data/editions] [--time 11:00]
 *     [--no-skip-existing] [--force-incomplete-week]
 *     [--force-incomplete-click-data] [--manifest-only]
 *
 * `--saturday` é OBRIGATÓRIO e explícito (mesmo invariante de CLAUDE.md pras
 * skills `/diaria-*`: nunca inferir data de `today()`).
 *
 * `--force-incomplete-week`: se menos de `WEEKLY_MIN_ITEMS` itens forem
 * selecionados (pool insuficiente de candidatos elegíveis — poucas edições
 * na semana e/ou muita exclusão comercial), o script imprime um aviso
 * impossível de ignorar e ABORTA — a menos que esta flag seja passada,
 * confirmando que a semana curta é legítima (feriado etc.).
 *
 * `--force-incomplete-click-data` (#4511 fleet review ALTO): se alguma
 * edição da janela estiver ausente do cache local de cliques OU algum post
 * da janela ainda não tiver sido enriquecido por link (`stats.clicks`
 * vazio apesar de `email.clicks>0`), o script imprime um aviso impossível
 * de ignorar e ABORTA — a menos que esta flag seja passada. Sem este gate,
 * um post não-enriquecido entra no ranking com `ratePct: 0` E
 * `hasClickData: true`, indistinguível de "genuinamente zero cliques" — a
 * seleção por clique silenciosamente deixa de competir de verdade pra esses
 * itens. Rode `--manifest-only` + `beehiiv-clicks-enricher` (Passo 1 do
 * SKILL.md) antes de recorrer à flag.
 *
 * Output: appends em `data/weekly/{saturday}/06-weekly-published.json`.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveWeeklyEditionDirs } from "./lib/select-weekly-d1.ts";
import {
  extractInstagramCandidates,
  matchPostsToWindow,
  identifyInstagramPostsNeedingClicks,
  clickCountsForUrl,
  uniqueOpensOf,
  toRankedCandidate,
  selectInstagramWeekly,
  hasSuspiciousCommercialLanguage,
  type BeehiivCachePost,
  type InstagramRankedCandidate,
} from "./lib/weekly-instagram-select.ts";
import { formatInstagramWeekly } from "./lib/format-weekly-social.ts";
import { appendSocialPosts, readSocialPublished, PostEntry } from "./lib/social-published-store.ts";
import { postToWorkerQueue } from "./lib/worker-queue-client.ts";
import { parseEditionDate, timezoneOffsetIso } from "./compute-social-schedule.ts";
import { validateScheduledTime } from "./publish-facebook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Assunção de implementação — ver nota no cabeçalho. Override via `--time`. */
export const DEFAULT_WEEKLY_TIME = "11:00";

/**
 * Limiar de "seleção materialmente incompleta" (herdado do #4101, semântica
 * ajustada pelo #4483): antes media "quantas das 5 EDIÇÕES tinham D1
 * parseável"; agora mede "quantos itens a seleção por clique de fato
 * preencheu" (`selectInstagramWeekly(...).selected.length`) — com o pool não
 * sendo mais 1-por-edição, poucas edições ainda podem preencher 5 itens (2+
 * destaques por dia), e muitas edições podem preencher menos de 5 se a
 * exclusão comercial/própria cortar candidatos demais. Abaixo de
 * `WEEKLY_MIN_ITEMS` exige `--force-incomplete-week` explícito.
 */
export const WEEKLY_MIN_ITEMS = 4;
export const WEEKLY_EXPECTED_ITEMS = 5;

/**
 * Pure: calcula o ISO datetime do agendamento do post semanal — sempre
 * baseado em `saturday` (AAMMDD), nunca `Date.now()` (mesmo invariante de
 * `computeScheduledAt` em compute-social-schedule.ts, #270).
 */
export function computeWeeklyScheduledAt(opts: {
  saturday: string;
  time?: string;
  timezone: string;
}): string {
  const time = opts.time ?? DEFAULT_WEEKLY_TIME;
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    throw new Error(`--time inválido: '${time}' (esperado HH:MM).`);
  }
  const { year, month, day } = parseEditionDate(opts.saturday);
  const target = new Date(year, month - 1, day);
  const dateStr =
    `${target.getFullYear()}-` +
    String(target.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(target.getDate()).padStart(2, "0");
  const [h, m] = time.split(":");
  const offsetStr = timezoneOffsetIso(target, opts.timezone);
  return `${dateStr}T${h.padStart(2, "0")}:${m}:00${offsetStr}`;
}

/**
 * Variante detalhada de `resolveDestaqueImageUrl` (#4511 fleet review MÉDIO,
 * silent-failure-hunter): diferencia "JSON corrompido" de "chave/arquivo
 * genuinamente ausente" — o `catch { return null }` original tratava os dois
 * casos como idênticos, e a mensagem downstream ("ausente/sem d{n}") engana
 * o operador no cenário de corrupção (ele re-roda `upload-images-public.ts`
 * achando que resolve; o problema real pode ser uma race de escrita
 * concorrente, que re-rodar não conserta).
 */
function resolveDestaqueImageDetailed(
  editionDir: string,
  n: 1 | 2 | 3,
): { url: string | null; corruptError?: string } {
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  if (!existsSync(publicImagesPath)) return { url: null };
  try {
    const data = JSON.parse(readFileSync(publicImagesPath, "utf8")) as {
      images?: Record<string, { url?: string }>;
    };
    return { url: data.images?.[`d${n}_4x5`]?.url ?? data.images?.[`d${n}`]?.url ?? null };
  } catch (e: any) {
    return { url: null, corruptError: e.message };
  }
}

/**
 * Lê a URL pública 4x5 (fallback 1x1) do destaque `n` de uma edição, pro
 * card do carrossel. Diferente do `resolvePublicImageUrl` pré-#4483 (que só
 * sabia ler D1), esta versão é paramétrica em `n` porque a seleção por
 * clique pode escolher D1, D2 OU D3 de uma mesma edição.
 *
 * Wrapper fino sobre `resolveDestaqueImageDetailed` — mantém a assinatura
 * `string | null` pros callers que não precisam diferenciar corrupt vs.
 * missing (ex: chamada direta em teste). `resolveWeeklyImageUrls` abaixo usa
 * a variante detalhada pra poder distinguir a causa no `reason` reportado.
 */
export function resolveDestaqueImageUrl(editionDir: string, n: 1 | 2 | 3): string | null {
  return resolveDestaqueImageDetailed(editionDir, n).url;
}

/**
 * Resolve 1 URL pública por item selecionado (#4146 — carrossel Instagram,
 * redesenhado pelo #4483 pra resolver por destaque/edição de origem de CADA
 * item em vez de 1 por dia da semana). Falha o post inteiro se QUALQUER
 * item não resolver imagem (mesmo racional do #4153: carrossel incompleto é
 * pior que não publicar, porque o texto promete N itens). Retorna qual
 * item (por edição+destaque) falhou, pra auditoria — `corruptError` presente
 * quando a causa raiz foi JSON corrompido, em vez de chave genuinamente
 * ausente (#4511 fleet review MÉDIO).
 */
export function resolveWeeklyImageUrls(
  items: InstagramRankedCandidate[],
  editionsRoot: string,
):
  | { ok: true; urls: string[] }
  | { ok: false; missingEditionDate: string; missingDestaqueNumber: 1 | 2 | 3; corruptError?: string } {
  const urls: string[] = [];
  for (const item of items) {
    const dir = resolve(editionsRoot, item.editionDate);
    const resolved = resolveDestaqueImageDetailed(dir, item.destaqueNumber);
    if (!resolved.url) {
      return {
        ok: false,
        missingEditionDate: item.editionDate,
        missingDestaqueNumber: item.destaqueNumber,
        ...(resolved.corruptError ? { corruptError: resolved.corruptError } : {}),
      };
    }
    urls.push(resolved.url);
  }
  return { ok: true, urls };
}

/** Lê `data/beehiiv-cache/posts/*.json` (cache local, populado por `scripts/beehiiv-sync.ts` + MCP `list_post_clicks`). */
function loadBeehiivCache(beehiivPostsDir: string): BeehiivCachePost[] {
  if (!existsSync(beehiivPostsDir)) return [];
  const out: BeehiivCachePost[] = [];
  for (const f of readdirSync(beehiivPostsDir)) {
    if (f === "index.json" || !f.endsWith(".json")) continue;
    const filePath = resolve(beehiivPostsDir, f);
    try {
      out.push(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (e: any) {
      // cache corrompido — ignora (mesmo comportamento de monthly-click-sections.ts / select-linkedin-weekly.ts),
      // mas nomeia o arquivo específico (#4511 fleet review MÉDIO) — sem isso, um cache
      // corrompido some em silêncio e o operador não sabe qual arquivo investigar.
      console.warn(`[publish-weekly-social] SKIP cache corrompido: ${filePath} — ${e.message}`);
    }
  }
  return out;
}

/**
 * `dataRoot` é injetável (default `{ROOT}/data`, #4101 finding 7) — permite
 * testes de dispatch redirecionarem `data/weekly/{saturday}/` E
 * `data/beehiiv-cache/posts/` pra um tmpdir em vez de escrever no `data/`
 * real do projeto.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  opts: { dataRoot?: string } = {},
) {
  const dataRoot = opts.dataRoot ?? resolve(ROOT, "data");
  const { flags, values } = parseArgs(argv);
  const saturday = values["saturday"];
  if (!saturday) {
    console.error("ERRO: --saturday AAMMDD é obrigatório (data explícita, nunca inferida de today()).");
    process.exit(1);
    return;
  }
  // Valida formato/existência da data cedo (fail-fast, mensagem clara).
  try {
    parseEditionDate(saturday);
  } catch (e: any) {
    console.error(`ERRO: ${e.message}`);
    process.exit(1);
    return;
  }

  const editionsRoot = resolve(ROOT, values["editions-root"] ?? "data/editions");
  const beehiivPostsDir = resolve(dataRoot, "beehiiv-cache/posts");
  const time = values["time"] ?? DEFAULT_WEEKLY_TIME;
  const doSchedule = flags.has("schedule");
  const skipExisting = !flags.has("no-skip-existing");
  const forceIncompleteWeek = flags.has("force-incomplete-week"); // herdado do #4101 finding 6
  // #4511 fleet review ALTO: confirmação explícita pra prosseguir com dado
  // de clique incompleto (post ausente do cache OU não-enriquecido por
  // link) — ver gate abaixo, logo após montar `warnings`.
  const forceIncompleteClickData = flags.has("force-incomplete-click-data");
  const manifestOnly = flags.has("manifest-only");

  const { year, month, day } = parseEditionDate(saturday);
  const saturdayDate = new Date(year, month - 1, day);
  const weekCandidates = resolveWeeklyEditionDirs(saturdayDate, editionsRoot);
  const contentWindow = weekCandidates.map((c) => c.date);
  const missingEditions = weekCandidates.filter((c) => !c.exists);
  const existingCandidates = weekCandidates.filter((c) => c.exists);

  const cachePosts = loadBeehiivCache(beehiivPostsDir);
  const windowPosts = matchPostsToWindow(cachePosts, contentWindow);

  // #4456-style manifest mode (mesmo padrão de `select-linkedin-weekly.ts
  // --manifest-only`): resolvido ANTES de qualquer console.log narrativo,
  // pra stdout ficar JSON puro e parseável pelo caller (a skill dispatcha
  // `beehiiv-clicks-enricher` a partir deste output).
  if (manifestOnly) {
    const manifest = identifyInstagramPostsNeedingClicks(windowPosts);
    console.log(
      JSON.stringify(
        { saturday, contentWindow, editionsFound: existingCandidates.map((c) => c.date), posts_needing_clicks: manifest },
        null,
        2,
      ),
    );
    return;
  }

  if (missingEditions.length > 0) {
    console.log(
      `[publish-weekly-social] ${missingEditions.length} edição(ões) da semana sem 02-reviewed.md — ` +
        `fora do pool de candidatos: ${missingEditions.map((c) => c.date).join(", ")}`,
    );
  }

  const rawCandidates = existingCandidates.flatMap((c) => {
    try {
      return extractInstagramCandidates(readFileSync(resolve(c.dir, "02-reviewed.md"), "utf8"), c.date);
    } catch (e: any) {
      console.warn(`[publish-weekly-social] SKIP ${c.dir} — falha ao ler/parsear 02-reviewed.md: ${e.message}`);
      return [];
    }
  });

  if (rawCandidates.length === 0) {
    console.log(
      `[publish-weekly-social] Nenhum candidato (DESTAQUE 1/2/3 com URL) na semana anterior a ${saturday} — ` +
        `post semanal NÃO será publicado (nenhum publisher chamado).`,
    );
    return;
  }

  const ranked: InstagramRankedCandidate[] = rawCandidates.map((c) => {
    const post = windowPosts.get(c.editionDate);
    const clicks = clickCountsForUrl(c.url, post?.stats?.clicks);
    const opens = uniqueOpensOf(post);
    return toRankedCandidate(c, clicks, opens, windowPosts.has(c.editionDate));
  });

  const selection = selectInstagramWeekly(ranked, WEEKLY_EXPECTED_ITEMS);
  const items = selection.selected;

  const editionsMissingClickData = existingCandidates.filter((c) => !windowPosts.has(c.date)).map((c) => c.date);
  const warnings = [...selection.warnings];
  for (const date of editionsMissingClickData) {
    warnings.push(
      `Sem dados de clique pra edição ${date} — post não encontrado/confirmado no cache Beehiiv; candidatos dessa edição não competiram por clique real.`,
    );
  }
  const manifest = identifyInstagramPostsNeedingClicks(windowPosts);
  if (manifest.length > 0) {
    warnings.push(
      `${manifest.length} post(s) da janela ainda sem clicks enriquecidos no cache — rode --manifest-only, dispatche beehiiv-clicks-enricher, e re-rode antes de confiar na seleção.`,
    );
  }
  const suspiciousPicks = items.filter((c) => hasSuspiciousCommercialLanguage(`${c.title} ${c.body}`));
  for (const c of suspiciousPicks) {
    warnings.push(
      `"${c.title}" (${c.editionDate}) contém linguagem comercial (parceria/patrocinado/divulgação/cupom/desconto) apesar de não estar na blocklist de domínio — confira antes de aprovar.`,
    );
  }

  // #4511 fleet review ALTO (silent-failure-hunter): dado de clique
  // NÃO-enriquecido é indistinguível de "genuinamente zero cliques" —
  // `toRankedCandidate` marca `hasClickData:true` baseado em "o post existe
  // no cache local" (`windowPosts.has(...)`), não em "o clique POR LINK foi
  // de fato enriquecido" (`stats.clicks` preenchido). Um post presente mas
  // não-enriquecido entra no ranking com `ratePct: 0` E `hasClickData: true`
  // — igual a um post que genuinamente teve zero cliques. Os warnings acima
  // (`editionsMissingClickData`/`manifest`) documentavam isso mas nunca
  // bloqueavam — só `WEEKLY_MIN_ITEMS` (contagem) tinha `process.exit(1)` —
  // e em `--no-gates` ninguém via o warning antes do `--schedule` disparar.
  // Mesmo rigor (banner + exit(1) a menos de flag explícita) do bloco
  // WEEKLY_MIN_ITEMS logo abaixo.
  if (editionsMissingClickData.length > 0 || manifest.length > 0) {
    const banner = [
      "",
      "=".repeat(72),
      `ATENÇÃO: dado de clique INCOMPLETO para o post semanal de ${saturday}.`,
      ...(editionsMissingClickData.length > 0
        ? [`${editionsMissingClickData.length} edição(ões) sem post confirmado no cache Beehiiv: ${editionsMissingClickData.join(", ")}.`]
        : []),
      ...(manifest.length > 0
        ? [
            `${manifest.length} post(s) da janela ainda sem clicks enriquecidos por link (stats.clicks vazio, ` +
              `apesar de email.clicks>0): ${manifest.map((m) => m.title || m.id).join(", ")}.`,
          ]
        : []),
      "",
      "Candidatos dessas edições entram no ranking com ratePct=0 e hasClickData=true —",
      "indistinguível de 'genuinamente zero cliques'. A seleção por clique NÃO está",
      "competindo de verdade pra esses itens.",
      "",
      forceIncompleteClickData
        ? "--force-incomplete-click-data presente: prosseguindo mesmo assim (confirmação explícita do editor)."
        : "Rode --manifest-only, dispatche beehiiv-clicks-enricher (Passo 1 do SKILL.md), e re-rode antes de confiar na seleção. Se esta incompletude for aceitável (edição genuinamente ainda não confirmada, etc.), rode de novo com --force-incomplete-click-data para confirmar e publicar assim mesmo. Sem a flag, o script aborta.",
      "=".repeat(72),
      "",
    ].join("\n");
    console.error(banner);
    if (!forceIncompleteClickData) {
      process.exit(1);
      return;
    }
  }

  // #4101 self-review finding 6 (semântica ajustada pelo #4483 — ver
  // WEEKLY_MIN_ITEMS acima): a seleção preencheu menos que o mínimo aceito
  // sem confirmação explícita.
  if (items.length < WEEKLY_MIN_ITEMS) {
    const banner = [
      "",
      "=".repeat(72),
      `ATENÇÃO: seleção MATERIALMENTE INCOMPLETA para o post semanal de ${saturday}.`,
      `Selecionados ${items.length} de ${WEEKLY_EXPECTED_ITEMS} itens esperados (mínimo aceito sem confirmação: ${WEEKLY_MIN_ITEMS}).`,
      `Edições ausentes no disco: ${missingEditions.map((c) => c.date).join(", ") || "(nenhuma — o pool ficou pequeno por exclusão comercial/própria ou falta de candidatos elegíveis)"}`,
      "",
      "O valor do post semanal é 'os itens mais clicados da semana' — publicar",
      "menos que isso entrega ao leitor algo diferente do prometido.",
      "",
      forceIncompleteWeek
        ? "--force-incomplete-week presente: prosseguindo mesmo assim (confirmação explícita do editor)."
        : "Se esta for uma semana curta LEGÍTIMA (feriado, etc.), rode de novo com --force-incomplete-week para confirmar e publicar assim mesmo. Sem a flag, o script aborta.",
      "=".repeat(72),
      "",
    ].join("\n");
    console.error(banner);
    if (!forceIncompleteWeek) {
      process.exit(1);
      return;
    }
  }

  console.log(
    `[publish-weekly-social] ${items.length} item(ns) selecionado(s) por clique: ` +
      items.map((i) => `[${i.ratePct.toFixed(2)}%] ${i.title} (${i.editionDate})`).join("; "),
  );
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const timezone = platformConfig?.publishing?.social?.timezone ?? "America/Sao_Paulo";
  const scheduledAt = computeWeeklyScheduledAt({ saturday, time, timezone });
  const caption = formatInstagramWeekly(items);

  if (!doSchedule) {
    console.log(`\n[publish-weekly-social] PREVIEW (--schedule ausente — nenhuma chamada de rede feita).`);
    console.log(`Agendamento planejado: ${scheduledAt}\n`);
    console.log(`── instagram ──\n${caption}\n`);
    return;
  }

  mkdirSync(resolve(dataRoot, "weekly", saturday), { recursive: true });
  const publishedPath = resolve(dataRoot, "weekly", saturday, "06-weekly-published.json");

  const tagAndAppend = (entry: PostEntry): void => appendSocialPosts(publishedPath, [entry]);

  if (skipExisting) {
    const published = readSocialPublished(publishedPath);
    const existing = published.posts.find(
      (p) => p.platform === "instagram" && p.destaque === "weekly" && (p.status === "draft" || p.status === "scheduled"),
    );
    if (existing) {
      console.log(`SKIP instagram/weekly — already ${existing.status}`);
      return;
    }
  }

  // #4101 self-review finding 10: valida scheduled_at ANTES de qualquer
  // chamada de rede — agendar pro passado falharia mais adiante no Worker,
  // ou pior, publicaria imediato.
  try {
    validateScheduledTime(scheduledAt);
  } catch (e: any) {
    console.error(`ERRO: scheduled_at "${scheduledAt}" inválido para o post semanal: ${e.message}`);
    tagAndAppend({
      platform: "instagram",
      destaque: "weekly",
      url: null,
      status: "failed",
      scheduled_at: scheduledAt,
      reason: `scheduled_time_invalid: ${e.message}`,
    });
    process.exit(1);
    return;
  }

  const workerUrl =
    process.env.DIARIA_LINKEDIN_CRON_URL ??
    platformConfig?.publishing?.social?.instagram?.cloudflare_worker_url ??
    platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
    "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  if (!workerUrl || !workerToken) {
    console.error(`ERRO instagram/weekly: Worker não configurado (DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN).`);
    tagAndAppend({ platform: "instagram", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "worker_not_configured" });
    return;
  }

  // Carrossel: 1 imagem por item selecionado (#4146/#4483) — ver
  // resolveWeeklyImageUrls acima; falha o post inteiro se qualquer item não
  // resolver imagem (não publica carrossel parcial).
  const resolvedImages = resolveWeeklyImageUrls(items, editionsRoot);
  if (!resolvedImages.ok) {
    // #4511 fleet review MÉDIO: distingue JSON corrompido (re-rodar
    // upload-images-public.ts NÃO resolve — investigar race de escrita
    // concorrente/corrupção de disco) de chave genuinamente ausente
    // (re-rodar upload-images-public.ts resolve).
    const reason = resolvedImages.corruptError
      ? `public_image_json_corrupt:${resolvedImages.missingEditionDate}:${resolvedImages.corruptError}`
      : `public_image_url_missing:${resolvedImages.missingEditionDate}:d${resolvedImages.missingDestaqueNumber}`;
    console.error(
      resolvedImages.corruptError
        ? `ERRO instagram/weekly: 06-public-images.json da edição ${resolvedImages.missingEditionDate} ESTÁ CORROMPIDO ` +
            `(${resolve(editionsRoot, resolvedImages.missingEditionDate)}): ${resolvedImages.corruptError} — re-rodar upload-images-public.ts ` +
            `NÃO resolve isso; investigue escrita concorrente/corrupção de disco antes. Carrossel de ${items.length} itens cancelado inteiro, não publica parcial.`
        : `ERRO instagram/weekly: 06-public-images.json ausente/sem d${resolvedImages.missingDestaqueNumber} pra edição ${resolvedImages.missingEditionDate} ` +
            `(${resolve(editionsRoot, resolvedImages.missingEditionDate)}) — carrossel de ${items.length} itens cancelado inteiro, não publica parcial.`,
    );
    tagAndAppend({
      platform: "instagram",
      destaque: "weekly",
      url: null,
      status: "failed",
      scheduled_at: null,
      reason,
    });
    return;
  }

  // #4511 fleet review CRÍTICO (silent-failure-hunter): o bookkeeping de
  // SUCESSO (`tagAndAppend` com status:"scheduled") vive num try/catch
  // SEPARADO do publish em si. `postToWorkerQueue` falhando é uma falha REAL
  // de publish (nada foi agendado) — `status:"failed"` é correto. Mas
  // `tagAndAppend`/`appendSocialPosts` pode lançar por conta própria (lock,
  // disco cheio, JSON corrompido) DEPOIS do post já ter sido agendado com
  // sucesso no Worker — nesse caso rotular como "failed" seria FALSO (o post
  // real não falhou) e escondería do editor que o Instagram já tem o
  // carrossel na fila. Pior: sem a entrada `status:"scheduled"` em disco, o
  // guard `skipExisting` (acima) não detecta o sucesso anterior, e um re-run
  // bem-intencionado agenda um SEGUNDO carrossel duplicado na conta real.
  let response: { key: string };
  try {
    response = await postToWorkerQueue(workerUrl, workerToken, {
      text: caption,
      image_url: null,
      image_urls: resolvedImages.urls,
      scheduled_at: scheduledAt,
      destaque: "weekly",
      channel: "instagram",
    });
  } catch (e: any) {
    console.error(`FAILED instagram/weekly: ${e.message}`);
    tagAndAppend({ platform: "instagram", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: e.message });
    console.log(`\n[publish-weekly-social] out_path: ${publishedPath}`);
    return;
  }

  console.log(`OK instagram/weekly — scheduled at ${scheduledAt} (worker_queue_key=${response.key})`);
  try {
    tagAndAppend({
      platform: "instagram",
      destaque: "weekly",
      url: null,
      status: "scheduled",
      scheduled_at: scheduledAt,
      worker_queue_key: response.key,
    });
  } catch (e: any) {
    // NUNCA mascarar como falha de publish — o post JÁ está agendado no
    // Worker. Propaga como erro FATAL (não mascarado) pra garantir que o
    // operador veja isso e não simplesmente re-rode o script.
    console.error(
      `\nSCHEDULED mas falhou ao persistir localmente (worker_queue_key=${response.key}): ${e.message} — ` +
        `NÃO re-rode, isso duplicaria o post.`,
    );
    throw e;
  }

  console.log(`\n[publish-weekly-social] out_path: ${publishedPath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
