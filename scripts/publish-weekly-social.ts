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
 *      clicados da semana, de qualquer posição elegível (D1/D2/D3, e desde
 *      o #4513 também RADAR/USE MELHOR)". Ver
 *      `scripts/lib/weekly-instagram-select.ts` pra metodologia completa.
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
 * semana". Desde o #4513, um item de RADAR/USE MELHOR (sem card
 * pré-gerado) tem o card gerado SOB DEMANDA nesse momento — ver
 * `scripts/lib/weekly-instagram-ondemand-card.ts`. Se QUALQUER item não
 * resolver imagem (falha de leitura OU de geração sob demanda), o post
 * inteiro FALHA (não publica um carrossel parcial) — ver
 * `resolveWeeklyImageUrls` abaixo.
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
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import {
  extractInstagramCandidates,
  matchPostsToWindow,
  identifyInstagramPostsNeedingClicks,
  clickCountsForUrl,
  uniqueOpensOf,
  toRankedCandidate,
  selectInstagramWeekly,
  selectInstagramHighlights,
  hasSuspiciousCommercialLanguage,
  type BeehiivCachePost,
  type InstagramRankedCandidate,
} from "./lib/weekly-instagram-select.ts";
import {
  resolveOrGenerateSectionCardUrl,
  defaultSectionCardGenerator,
  type SectionCardGenerator,
} from "./lib/weekly-instagram-ondemand-card.ts";
import { resolveOrGenerateFlatCardUrl, type FlatCardGenerator } from "./lib/weekly-flat-card.ts";
import { resolveOrGenerateNewsCardUrl, type NewsCardGenerator } from "./lib/weekly-carousel-news-card.ts";
import { computeCarouselTitleFontSize } from "./lib/weekly-carousel-font-size.ts";
import { formatInstagramWeekly, formatFacebookWeekly, formatThreadsWeekly, type WeeklyInstagramMode } from "./lib/format-weekly-social.ts";
import { appendSocialPosts, readSocialPublished, PostEntry } from "./lib/social-published-store.ts";
import { postToWorkerQueue } from "./lib/worker-queue-client.ts";
import { parseEditionDate, timezoneOffsetIso } from "./compute-social-schedule.ts";
import { validateScheduledTime, publishFacebookCarouselByUrl } from "./publish-facebook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Assunção de implementação — ver nota no cabeçalho. Override via `--time`. */
export const DEFAULT_WEEKLY_TIME = "11:00";

/**
 * Dois carrosséis semanais (#5330, decisão do editor 260815): "highlights"
 * (os 5 D1 da semana, sem ranking por clique) publica no PRÓPRIO sábado
 * (`--saturday`); "clicked" (ranking por clique, comportamento original do
 * #4483) publica no domingo seguinte — dias separados pra não competir pelo
 * mesmo slot de feed. `DEFAULT_MODE_DAY_OFFSET` é dias somados à data de
 * `--saturday` pra chegar na data de agendamento de cada modo; `--day-offset`
 * sobrescreve pra quem quiser testar/ajustar sem editar código.
 */
export const DEFAULT_MODE_DAY_OFFSET: Record<WeeklyInstagramMode, number> = {
  highlights: 0,
  clicked: 1,
};

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
  /** Dias somados a `saturday` antes de aplicar `time` — ver `DEFAULT_MODE_DAY_OFFSET` (#5330). Default 0 (o próprio sábado). */
  dayOffset?: number;
}): string {
  const time = opts.time ?? DEFAULT_WEEKLY_TIME;
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    throw new Error(`--time inválido: '${time}' (esperado HH:MM).`);
  }
  const { year, month, day } = parseEditionDate(opts.saturday);
  const target = new Date(year, month - 1, day + (opts.dayOffset ?? 0));
  const dateStr =
    `${target.getFullYear()}-` +
    String(target.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(target.getDate()).padStart(2, "0");
  const [h, m] = time.split(":");
  const offsetStr = timezoneOffsetIso(target, opts.timezone);
  return `${dateStr}T${h.padStart(2, "0")}:${m}:00${offsetStr}`;
}

const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** Pure: `["260810", ..., "260814"]` → `"10–14 ago"` (rodapé do card capa/CTA). */
export function weekRangeLabel(contentWindow: string[]): string {
  if (contentWindow.length === 0) return "";
  const first = contentWindow[0];
  const last = contentWindow[contentWindow.length - 1];
  const { month: m1, day: d1 } = parseEditionDate(first);
  const { month: m2, day: d2 } = parseEditionDate(last);
  // Semana pode cruzar mês (ex: seg 260831 → sex 260904) — rotular só com o
  // mês do ÚLTIMO dia mislabelava o primeiro (achado do review do #5330:
  // "31–4 set" pra uma janela que começa em 31 de AGOSTO).
  if (m1 === m2) return `${d1}–${d2} ${MESES_ABREV[m1 - 1]}`;
  return `${d1} ${MESES_ABREV[m1 - 1]}–${d2} ${MESES_ABREV[m2 - 1]}`;
}

/** Pure: texto dos slides sem foto (capa + CTA), por modo (#5330). */
export function buildFlatCardTexts(
  mode: WeeklyInstagramMode,
  contentWindow: string[],
): { cover: { kicker: string; title: string; footer: string }; cta: { kicker: string; title: string; footer: string } } {
  const range = weekRangeLabel(contentWindow);
  const coverTitle = mode === "highlights" ? "Os principais destaques de IA da semana" : "Os mais clicados da semana";
  return {
    cover: { kicker: "Resumo semanal", title: coverTitle, footer: range ? `${range} · diar.ia.br` : "diar.ia.br" },
    cta: {
      kicker: "Grátis, toda manhã",
      title: "A edição completa chega no seu e-mail. Assine no link da bio.",
      footer: "diar.ia.br",
    },
  };
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
 * Resultado de `resolveWeeklyImageUrls` — discriminado por `ok`.
 * `missingDestaqueNumber` só existe pra falha de destaque D1/D2/D3
 * pré-gerado; falha de card sob demanda (RADAR/USE MELHOR, #4513) reporta
 * `onDemandError` em vez disso — os 2 nunca coexistem.
 */
export type WeeklyImageResolution =
  | { ok: true; urls: string[] }
  | {
      ok: false;
      missingEditionDate: string;
      missingDestaqueNumber?: 1 | 2 | 3;
      corruptError?: string;
      onDemandError?: string;
    };

/**
 * Resolve 1 URL pública por item selecionado (#4146 — carrossel Instagram,
 * redesenhado pelo #4483 pra resolver por destaque/edição de origem de CADA
 * item em vez de 1 por dia da semana). Falha o post inteiro se QUALQUER
 * item não resolver imagem (mesmo racional do #4153: carrossel incompleto é
 * pior que não publicar, porque o texto promete N itens). Retorna qual
 * item (por edição+destaque) falhou, pra auditoria — `corruptError` presente
 * quando a causa raiz foi JSON corrompido, em vez de chave genuinamente
 * ausente (#4511 fleet review MÉDIO).
 *
 * #4513: itens sem `destaqueNumber` (RADAR/USE MELHOR, `kind === "section"`)
 * não têm card pré-gerado — a URL é resolvida via
 * `resolveOrGenerateSectionCardUrl` (cache hit em `06-public-images.json`
 * OU geração sob demanda + upload). `opts.sectionCardGenerator` é seam de
 * teste (default `defaultSectionCardGenerator`, que chama a API de imagem
 * de verdade — NUNCA invocado em teste, ver docstring de
 * `weekly-instagram-ondemand-card.ts`).
 */
export async function resolveWeeklyImageUrls(
  items: InstagramRankedCandidate[],
  editionsRoot: string,
  opts: {
    sectionCardGenerator?: SectionCardGenerator;
    /**
     * Tamanho de fonte único do carrossel (#5330, ver
     * `weekly-carousel-font-size.ts`). Quando presente (junto de `dataRoot` +
     * `carouselKey`), itens de DESTAQUE (D1/D2/D3) são RECOMPOSTOS com esse
     * tamanho (via `resolveOrGenerateNewsCardUrl`) em vez de reusar o card
     * `04-{destaque}-4x5.jpg` já publicado no feed diário tal como está —
     * standardiza visualmente o carrossel sem tocar no card diário original.
     * Omitido (comportamento pré-#5330, ainda usado por chamadores/testes
     * que só querem ler o card diário): lê `04-{destaque}-4x5.jpg` direto.
     */
    fontSize?: number;
    dataRoot?: string;
    carouselKey?: string;
    newsCardGenerator?: NewsCardGenerator;
  } = {},
): Promise<WeeklyImageResolution> {
  const sectionCardGenerator = opts.sectionCardGenerator ?? defaultSectionCardGenerator;
  const urls: string[] = [];
  for (const item of items) {
    // resolveEditionDir (dual flat/nested, #2463) em vez de resolve() cru —
    // mesmo fix de resolveWeeklyEditionDirs em select-weekly-d1.ts, ver docstring lá.
    const dir = resolveEditionDir(editionsRoot, item.editionDate);
    if (item.destaqueNumber != null) {
      if (opts.fontSize != null && opts.dataRoot && opts.carouselKey) {
        const recomposed = await resolveOrGenerateNewsCardUrl(
          opts.dataRoot,
          opts.carouselKey,
          {
            editionDate: item.editionDate,
            editionDir: dir,
            destaque: `d${item.destaqueNumber}`,
            title: item.title,
            category: item.category,
            fontSize: opts.fontSize,
          },
          opts.newsCardGenerator,
        );
        if (!recomposed.url) {
          return {
            ok: false,
            missingEditionDate: item.editionDate,
            missingDestaqueNumber: item.destaqueNumber,
            onDemandError: recomposed.error ?? "recomposição do card de notícia não retornou URL nem erro",
          };
        }
        urls.push(recomposed.url);
        continue;
      }
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
      continue;
    }
    // RADAR/USE MELHOR — card 4:5 sob demanda (#4513), tamanho fixo do
    // carrossel repassado (#5330) quando disponível.
    const resolved = await resolveOrGenerateSectionCardUrl(item, dir, sectionCardGenerator, opts.fontSize);
    if (!resolved.url) {
      return {
        ok: false,
        missingEditionDate: item.editionDate,
        onDemandError: resolved.error ?? "geração sob demanda não retornou URL nem erro",
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
 * real do projeto. `sectionCardGenerator` (#4513) é a mesma seam pro card
 * sob demanda de RADAR/USE MELHOR — testes injetam um fake em vez do
 * gerador real (custo de API paga).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  opts: {
    dataRoot?: string;
    sectionCardGenerator?: SectionCardGenerator;
    flatCardGenerator?: FlatCardGenerator;
    newsCardGenerator?: NewsCardGenerator;
  } = {},
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

  // #5330: dois carrosséis, "clicked" (comportamento original do #4483,
  // default — back-compat com quem já chama sem --mode) ou "highlights" (os
  // 5 D1 da semana, sem ranking por clique). Ver DEFAULT_MODE_DAY_OFFSET.
  const modeArg = values["mode"] ?? "clicked";
  if (modeArg !== "clicked" && modeArg !== "highlights" && modeArg !== "both") {
    console.error(`ERRO: --mode inválido: '${modeArg}' (esperado 'clicked', 'highlights' ou 'both').`);
    process.exit(1);
    return;
  }

  // #5349: --mode both dispara os 2 modos em sequência, cada um reportando
  // sucesso/falha independente (falha em um NÃO impede o outro) — reusa a
  // mesma lógica de runOneMode, chamada 2x DENTRO do mesmo processo (nunca
  // spawna 2 processos filhos — perderia os seams de teste injetados em
  // `opts`, ex: dataRoot/sectionCardGenerator/flatCardGenerator). --day-offset
  // (override manual de agendamento) não compõe com --mode both — cada modo
  // usa seu próprio offset padrão (DEFAULT_MODE_DAY_OFFSET); quem precisar
  // sobrescrever roda os modos separadamente.
  if (modeArg === "both") {
    if (values["day-offset"] != null) {
      console.error(
        "ERRO: --day-offset não é compatível com --mode both (cada modo usa seu próprio offset padrão). Rode cada modo separadamente para sobrescrever.",
      );
      process.exit(1);
      return;
    }
    // #5349: --manifest-only espera 1 objeto JSON puro no stdout (o caller —
    // Passo 1 do SKILL.md — faz JSON.parse direto) — "both" emitiria 2
    // objetos em sequência, quebrando esse contrato. "highlights" também
    // sempre devolve manifest vazio (não ranqueia por clique, #5330), então
    // não há ganho real em rodar os 2 nesse modo mesmo se o parse não fosse
    // um problema — direciona pro uso single-mode explícito.
    if (flags.has("manifest-only")) {
      console.error(
        "ERRO: --manifest-only não é compatível com --mode both (emitiria 2 JSONs em sequência). Rode --mode clicked --manifest-only — 'highlights' não ranqueia por clique, não tem nada pra enriquecer.",
      );
      process.exit(1);
      return;
    }
    console.log(
      '[publish-weekly-social] --mode both — rodando "highlights" e "clicked" em sequência (falha em um não impede o outro).',
    );
    const okHighlights = await runOneMode("highlights", saturday, flags, values, dataRoot, opts);
    const okClicked = await runOneMode("clicked", saturday, flags, values, dataRoot, opts);
    if (!okHighlights || !okClicked) {
      process.exit(1);
      return;
    }
    return;
  }

  const mode = modeArg as WeeklyInstagramMode;
  const ok = await runOneMode(mode, saturday, flags, values, dataRoot, opts);
  if (!ok) {
    process.exit(1);
  }
}

/**
 * Corpo do processamento de UM modo (#5349) — extraído de `main()` pra
 * permitir `--mode both` rodar os 2 modos em sequência dentro do MESMO
 * processo (preservando os seams de teste injetados via `opts`). Retorna
 * `false` em todo caminho que antes chamava `process.exit(1)` diretamente —
 * quem decide se aborta o PROCESSO é o caller (`main()` solo aborta na
 * hora; `--mode both` só aborta depois de tentar os 2 modos, e só se pelo
 * menos 1 falhou). `true` cobre sucesso real E os no-ops legítimos que já
 * saíam com código 0 antes do #5349 (preview sem `--schedule`, nenhum
 * candidato na semana, `--manifest-only`, skip-existing).
 */
async function runOneMode(
  mode: WeeklyInstagramMode,
  saturday: string,
  flags: Set<string>,
  values: Record<string, string>,
  dataRoot: string,
  opts: {
    dataRoot?: string;
    sectionCardGenerator?: SectionCardGenerator;
    flatCardGenerator?: FlatCardGenerator;
    newsCardGenerator?: NewsCardGenerator;
  },
): Promise<boolean> {
  const editionsRoot = resolve(ROOT, values["editions-root"] ?? "data/editions");
  const beehiivPostsDir = resolve(dataRoot, "beehiiv-cache/posts");
  const time = values["time"] ?? DEFAULT_WEEKLY_TIME;
  let dayOffset = DEFAULT_MODE_DAY_OFFSET[mode];
  if (values["day-offset"] != null) {
    const parsed = Number(values["day-offset"]);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      console.error(`ERRO: --day-offset inválido: '${values["day-offset"]}' (esperado inteiro, ex: 0, 1, -1).`);
      return false;
    }
    dayOffset = parsed;
  }
  const doSchedule = flags.has("schedule");
  const skipExisting = !flags.has("no-skip-existing");
  const forceIncompleteWeek = flags.has("force-incomplete-week"); // herdado do #4101 finding 6
  // #4511 fleet review ALTO: confirmação explícita pra prosseguir com dado
  // de clique incompleto (post ausente do cache OU não-enriquecido por
  // link) — ver gate abaixo, logo após montar `warnings`. Só se aplica ao
  // modo "clicked" — "highlights" não ranqueia por clique (#5330).
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
    // #5330: "highlights" não ranqueia por clique — não há nada pra
    // enriquecer, o manifest sai sempre vazio (evita rodar
    // beehiiv-clicks-enricher à toa quando o modo nem usa esse dado).
    const manifest = mode === "highlights" ? [] : identifyInstagramPostsNeedingClicks(windowPosts);
    console.log(
      JSON.stringify(
        { saturday, mode, contentWindow, editionsFound: existingCandidates.map((c) => c.date), posts_needing_clicks: manifest },
        null,
        2,
      ),
    );
    return true;
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
    return true;
  }

  const ranked: InstagramRankedCandidate[] = rawCandidates.map((c) => {
    const post = windowPosts.get(c.editionDate);
    const clicks = clickCountsForUrl(c.url, post?.stats?.clicks);
    const opens = uniqueOpensOf(post);
    return toRankedCandidate(c, clicks, opens, windowPosts.has(c.editionDate));
  });

  // #5330: "highlights" pega os 5 D1 em ordem cronológica, sem ranking por
  // clique — dado de clique não entra na conta, então nem carrega os
  // warnings/gates de completude de clique abaixo (só fazem sentido pra
  // "clicked").
  const selection = mode === "highlights" ? selectInstagramHighlights(ranked) : selectInstagramWeekly(ranked, WEEKLY_EXPECTED_ITEMS);
  const items = selection.selected;

  const editionsMissingClickData =
    mode === "clicked" ? existingCandidates.filter((c) => !windowPosts.has(c.date)).map((c) => c.date) : [];
  const warnings = [...selection.warnings];
  for (const date of editionsMissingClickData) {
    warnings.push(
      `Sem dados de clique pra edição ${date} — post não encontrado/confirmado no cache Beehiiv; candidatos dessa edição não competiram por clique real.`,
    );
  }
  const manifest = mode === "clicked" ? identifyInstagramPostsNeedingClicks(windowPosts) : [];
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
      return false;
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
      mode === "highlights"
        ? "O valor do post semanal é 'os principais destaques da semana' — publicar"
        : "O valor do post semanal é 'os itens mais clicados da semana' — publicar",
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
      return false;
    }
  }

  const modeLabel = mode === "highlights" ? "destaque(s)" : "item(ns) selecionado(s) por clique";
  console.log(
    `[publish-weekly-social] modo=${mode} — ${items.length} ${modeLabel}: ` +
      items.map((i) => (mode === "highlights" ? `${i.title} (${i.editionDate})` : `[${i.ratePct.toFixed(2)}%] ${i.title} (${i.editionDate})`)).join("; "),
  );
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const timezone = platformConfig?.publishing?.social?.timezone ?? "America/Sao_Paulo";
  const scheduledAt = computeWeeklyScheduledAt({ saturday, time, timezone, dayOffset });
  const caption = formatInstagramWeekly(items, mode);
  // #5348: MESMO carrossel/itens/ordem — só a linha final de CTA difere
  // (Facebook aceita link clicável no corpo, Instagram não). Mesmo
  // `scheduledAt`/`carouselImageUrls` que o Instagram — ver dispatch abaixo.
  const fbCaption = formatFacebookWeekly(items, mode);
  // #5348 (unidade Threads): MESMO carrossel/itens/ordem, caption compacta
  // (orçamento de 500 chars da Threads API, ver format-weekly-social.ts) —
  // mesmo `scheduledAt`/`carouselImageUrls` dos outros 2 canais.
  const threadsCaption = formatThreadsWeekly(items, mode);
  // Chave do carrossel (#5330) — "highlights" e "clicked" do MESMO sábado
  // nunca colidem em cache de card sem foto, persisted store, nem
  // skip-existing (destaqueKey abaixo).
  const carouselKey = `${saturday}-${mode}`;
  const destaqueKey = `weekly-${mode}`;

  if (!doSchedule) {
    console.log(`\n[publish-weekly-social] PREVIEW (--schedule ausente — nenhuma chamada de rede feita).`);
    console.log(`Agendamento planejado: ${scheduledAt}\n`);
    console.log(`── instagram (${mode}) ──\n${caption}\n`);
    console.log(`── facebook (${mode}) ──\n${fbCaption}\n`);
    console.log(`── threads (${mode}) ──\n${threadsCaption}\n`);
    return true;
  }

  mkdirSync(resolve(dataRoot, "weekly", saturday), { recursive: true });
  const publishedPath = resolve(dataRoot, "weekly", saturday, "06-weekly-published.json");

  const tagAndAppend = (entry: PostEntry): void => appendSocialPosts(publishedPath, [entry]);

  // #5348: skip-existing agora é POR CANAL (3 canais desde a unidade
  // Threads) — um já publicado (re-run parcial após uma falha anterior) não
  // deveria impedir os outros de tentar.
  let skipInstagram = false;
  let skipFacebook = false;
  let skipThreads = false;
  if (skipExisting) {
    const published = readSocialPublished(publishedPath);
    const existingIg = published.posts.find(
      (p) => p.platform === "instagram" && p.destaque === destaqueKey && (p.status === "draft" || p.status === "scheduled"),
    );
    const existingFb = published.posts.find(
      (p) => p.platform === "facebook" && p.destaque === destaqueKey && (p.status === "draft" || p.status === "scheduled"),
    );
    const existingThreads = published.posts.find(
      (p) => p.platform === "threads" && p.destaque === destaqueKey && (p.status === "draft" || p.status === "scheduled"),
    );
    if (existingIg) {
      console.log(`SKIP instagram/${destaqueKey} — already ${existingIg.status}`);
      skipInstagram = true;
    }
    if (existingFb) {
      console.log(`SKIP facebook/${destaqueKey} — already ${existingFb.status}`);
      skipFacebook = true;
    }
    if (existingThreads) {
      console.log(`SKIP threads/${destaqueKey} — already ${existingThreads.status}`);
      skipThreads = true;
    }
    if (skipInstagram && skipFacebook && skipThreads) return true;
  }

  // #4101 self-review finding 10: valida scheduled_at ANTES de qualquer
  // chamada de rede — agendar pro passado falharia mais adiante no
  // Worker/Graph API, ou pior, publicaria imediato. #5348: mesmo horário
  // pros 2 canais, então 1 validação basta — mas cada canal grava sua
  // PRÓPRIA entry de falha (se não foi pulado por skip-existing).
  try {
    validateScheduledTime(scheduledAt);
  } catch (e: any) {
    console.error(`ERRO: scheduled_at "${scheduledAt}" inválido para o post semanal: ${e.message}`);
    if (!skipInstagram) {
      tagAndAppend({
        platform: "instagram",
        destaque: destaqueKey,
        url: null,
        status: "failed",
        scheduled_at: scheduledAt,
        reason: `scheduled_time_invalid: ${e.message}`,
      });
    }
    if (!skipFacebook) {
      tagAndAppend({
        platform: "facebook",
        destaque: destaqueKey,
        url: null,
        status: "failed",
        scheduled_at: scheduledAt,
        reason: `scheduled_time_invalid: ${e.message}`,
      });
    }
    if (!skipThreads) {
      tagAndAppend({
        platform: "threads",
        destaque: destaqueKey,
        url: null,
        status: "failed",
        scheduled_at: scheduledAt,
        reason: `scheduled_time_invalid: ${e.message}`,
      });
    }
    return false;
  }

  // #5330: capa/CTA (texto) calculado ANTES da resolução de imagem. O
  // tamanho de fonte único (abaixo) padroniza só os 5 títulos de NOTÍCIA
  // entre si — capa/CTA usam auto-size próprio (`buildFlatCardSvg`,
  // preenche o card, não precisa bater com o tamanho das notícias: são um
  // tipo de slide visualmente diferente de propósito, decisão do editor
  // 260815 2ª rodada).
  const flatTexts = buildFlatCardTexts(mode, contentWindow);
  const carouselFontSize = computeCarouselTitleFontSize(items.map((i) => i.title));

  // Carrossel: 1 imagem por item selecionado (#4146/#4483) — ver
  // resolveWeeklyImageUrls acima; falha o post inteiro se qualquer item não
  // resolver imagem (não publica carrossel parcial). #4513: itens de
  // RADAR/USE MELHOR sem card pré-gerado passam pela geração sob demanda
  // (assíncrona) dentro de resolveWeeklyImageUrls. #5330: `fontSize` +
  // `dataRoot` + `carouselKey` acionam a RECOMPOSIÇÃO do título de D1/D2/D3
  // com o tamanho único do carrossel (nunca sobrescreve o card diário
  // publicado — ver `weekly-carousel-news-card.ts`). #5348: computado ANTES
  // do check de credenciais de qualquer canal — Facebook e Instagram usam o
  // MESMO `carouselImageUrls`, resolvido 1x só.
  const resolvedImages = await resolveWeeklyImageUrls(items, editionsRoot, {
    sectionCardGenerator: opts.sectionCardGenerator,
    newsCardGenerator: opts.newsCardGenerator,
    fontSize: carouselFontSize,
    dataRoot,
    carouselKey,
  });
  if (!resolvedImages.ok) {
    // #4511 fleet review MÉDIO: distingue JSON corrompido (re-rodar
    // upload-images-public.ts NÃO resolve — investigar race de escrita
    // concorrente/corrupção de disco) de chave genuinamente ausente
    // (re-rodar upload-images-public.ts resolve). #4513: distingue também
    // falha de GERAÇÃO SOB DEMANDA (RADAR/USE MELHOR) das duas anteriores
    // (exclusivas de destaque D1/D2/D3 pré-gerado).
    const reason = resolvedImages.onDemandError
      ? `on_demand_card_generation_failed:${resolvedImages.missingEditionDate}:${resolvedImages.onDemandError}`
      : resolvedImages.corruptError
        ? `public_image_json_corrupt:${resolvedImages.missingEditionDate}:${resolvedImages.corruptError}`
        : `public_image_url_missing:${resolvedImages.missingEditionDate}:d${resolvedImages.missingDestaqueNumber}`;
    console.error(
      resolvedImages.onDemandError
        ? `ERRO ${destaqueKey}: geração SOB DEMANDA do card 4:5 (item RADAR/USE MELHOR da edição ${resolvedImages.missingEditionDate}) falhou: ` +
            `${resolvedImages.onDemandError} — carrossel de ${items.length} itens cancelado inteiro (Instagram + Facebook + Threads), não publica parcial.`
        : resolvedImages.corruptError
          ? `ERRO ${destaqueKey}: 06-public-images.json da edição ${resolvedImages.missingEditionDate} ESTÁ CORROMPIDO ` +
              `(${resolveEditionDir(editionsRoot, resolvedImages.missingEditionDate)}): ${resolvedImages.corruptError} — re-rodar upload-images-public.ts ` +
              `NÃO resolve isso; investigue escrita concorrente/corrupção de disco antes. Carrossel de ${items.length} itens cancelado inteiro (Instagram + Facebook + Threads), não publica parcial.`
          : `ERRO ${destaqueKey}: 06-public-images.json ausente/sem d${resolvedImages.missingDestaqueNumber} pra edição ${resolvedImages.missingEditionDate} ` +
              `(${resolveEditionDir(editionsRoot, resolvedImages.missingEditionDate)}) — carrossel de ${items.length} itens cancelado inteiro (Instagram + Facebook + Threads), não publica parcial.`,
    );
    if (!skipInstagram) tagAndAppend({ platform: "instagram", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason });
    if (!skipFacebook) tagAndAppend({ platform: "facebook", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason });
    if (!skipThreads) tagAndAppend({ platform: "threads", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason });
    return true;
  }

  // #5330: capa (sem foto, kicker+título de apresentação) e CTA final (sem
  // foto, convite pra assinar) — envolvem os itens de notícia no carrossel.
  // Sem cache hit em `data/weekly/{saturday}-{mode}/_internal/06-flat-cards.json`,
  // renderiza + faz upload agora (nunca custa API paga — é composição local,
  // só o upload pro KV é rede). #5330 fleet review (test-coverage): falha
  // aqui (fonte de marca ausente, platform.config.json sem kv_namespace_id,
  // erro de rede no upload) precisa do MESMO bookkeeping de falha que
  // `resolveWeeklyImageUrls` acima — sem isso, a exceção propagava sem
  // gravar status:"failed", e um re-run bem-intencionado não tinha como
  // saber que a tentativa anterior não chegou a publicar nada. #5348: cache
  // compartilhado (`carouselKey`) — o mesmo capa/CTA serve os 2 canais.
  let coverUrl: string;
  let ctaUrl: string;
  try {
    coverUrl = await resolveOrGenerateFlatCardUrl(dataRoot, carouselKey, "cover", flatTexts.cover, opts.flatCardGenerator);
    ctaUrl = await resolveOrGenerateFlatCardUrl(dataRoot, carouselKey, "cta", flatTexts.cta, opts.flatCardGenerator);
  } catch (e: any) {
    console.error(
      `ERRO ${destaqueKey}: geração do card sem foto (capa/CTA) falhou: ${e.message} — ` +
        `carrossel de ${items.length} itens cancelado inteiro (Instagram + Facebook + Threads), não publica parcial.`,
    );
    const reason = `flat_card_generation_failed:${e.message}`;
    if (!skipInstagram) tagAndAppend({ platform: "instagram", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason });
    if (!skipFacebook) tagAndAppend({ platform: "facebook", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason });
    if (!skipThreads) tagAndAppend({ platform: "threads", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason });
    return true;
  }
  const carouselImageUrls = [coverUrl, ...resolvedImages.urls, ctaUrl];

  // ── Instagram (#4146/#4483/#5330) ──
  //
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
  if (!skipInstagram) {
    const workerUrl =
      process.env.DIARIA_LINKEDIN_CRON_URL ??
      platformConfig?.publishing?.social?.instagram?.cloudflare_worker_url ??
      platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
      "";
    const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
    if (!workerUrl || !workerToken) {
      console.error(`ERRO instagram/${destaqueKey}: Worker não configurado (DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN).`);
      tagAndAppend({ platform: "instagram", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason: "worker_not_configured" });
    } else {
      let response: { key: string } | null = null;
      try {
        response = await postToWorkerQueue(workerUrl, workerToken, {
          text: caption,
          image_url: null,
          image_urls: carouselImageUrls,
          scheduled_at: scheduledAt,
          destaque: destaqueKey,
          channel: "instagram",
        });
      } catch (e: any) {
        console.error(`FAILED instagram/${destaqueKey}: ${e.message}`);
        tagAndAppend({ platform: "instagram", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason: e.message });
      }
      if (response) {
        console.log(`OK instagram/${destaqueKey} — scheduled at ${scheduledAt} (worker_queue_key=${response.key})`);
        try {
          tagAndAppend({
            platform: "instagram",
            destaque: destaqueKey,
            url: null,
            status: "scheduled",
            scheduled_at: scheduledAt,
            worker_queue_key: response.key,
          });
        } catch (e: any) {
          // NUNCA mascarar como falha de publish — o post JÁ está agendado
          // no Worker. Propaga como erro FATAL (não mascarado) pra garantir
          // que o operador veja isso e não simplesmente re-rode o script —
          // mesmo em `--mode both`, isso interrompe o dispatch do Facebook
          // (ainda não tentado nesta rodada) e do 2º modo (highlights/clicked):
          // estado bom demais raro pra valer a pena mascarar (#4511 CRÍTICO).
          console.error(
            `\nSCHEDULED mas falhou ao persistir localmente (worker_queue_key=${response.key}): ${e.message} — ` +
              `NÃO re-rode, isso duplicaria o post.`,
          );
          throw e;
        }
      }
    }
  }

  // ── Facebook (#5348) ──
  //
  // Diferente do Instagram, a Graph API do Facebook agenda nativamente
  // (`scheduled_publish_time`) — não precisa do Worker queue nem de cron
  // externo pra disparar no horário certo; o publish acontece 1x, agora,
  // direto na Graph API (mesmo padrão de `publish-facebook.ts` no publisher
  // diário). Mesmo racional de bookkeeping do Instagram acima: sucesso e
  // gravação local são passos separados por design, mas aqui não há
  // `SCHEDULED-mas-falhou-ao-persistir` fatal separado — `tagAndAppend`
  // roda sempre dentro do MESMO try/catch (consistente com o padrão do
  // publisher diário, `publishPhoto`/`main()` em publish-facebook.ts).
  if (!skipFacebook) {
    const fbPageId = process.env.FACEBOOK_PAGE_ID || "";
    const fbPageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";
    const fbApiVersion = process.env.FACEBOOK_API_VERSION || "v25.0";
    if (!fbPageId || !fbPageToken) {
      console.error(`ERRO facebook/${destaqueKey}: Facebook não configurado (FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN).`);
      tagAndAppend({ platform: "facebook", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason: "facebook_not_configured" });
    } else {
      try {
        const result = await publishFacebookCarouselByUrl(fbPageId, fbPageToken, fbApiVersion, carouselImageUrls, fbCaption, scheduledAt);
        const postId = result.post_id || result.id;
        const postUrl = `https://www.facebook.com/${fbPageId}/posts/${postId}`;
        console.log(`OK facebook/${destaqueKey} — scheduled at ${scheduledAt} — ${postUrl}`);
        tagAndAppend({
          platform: "facebook",
          destaque: destaqueKey,
          url: postUrl,
          status: "scheduled",
          scheduled_at: scheduledAt,
          fb_post_id: postId,
        });
      } catch (e: any) {
        console.error(`FAILED facebook/${destaqueKey}: ${e.message}`);
        tagAndAppend({ platform: "facebook", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason: e.message });
      }
    }
  }

  // ── Threads (#5348, unidade dedicada de carrossel de imagem) ──
  //
  // Mesmo caminho do Instagram — Worker queue (`channel: "threads"`), que já
  // suporta `image_urls` (validado de forma genérica pelo enqueue, ver
  // index.ts::handleEnqueue) e agora dispatcha o carrossel de imagem com
  // polling obrigatório de status (`fireThreadsCarousel` em
  // `workers/linkedin-cron/src/dispatch.ts`) — a publicação real (e o poll)
  // acontece no MOMENTO do disparo agendado, não aqui no enqueue. Mesmo
  // racional de bookkeeping do Instagram: sucesso vs falha de persistência
  // local são passos separados, e uma falha de `appendSocialPosts` DEPOIS de
  // um enqueue bem-sucedido é FATAL (propaga) — nunca mascarada como
  // "failed" (o post já está na fila do Worker).
  if (!skipThreads) {
    const workerUrl =
      process.env.DIARIA_LINKEDIN_CRON_URL ??
      platformConfig?.publishing?.social?.instagram?.cloudflare_worker_url ??
      platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
      "";
    const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
    if (!workerUrl || !workerToken) {
      console.error(`ERRO threads/${destaqueKey}: Worker não configurado (DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN).`);
      tagAndAppend({ platform: "threads", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason: "worker_not_configured" });
    } else {
      let response: { key: string } | null = null;
      try {
        response = await postToWorkerQueue(workerUrl, workerToken, {
          text: threadsCaption,
          image_url: null,
          image_urls: carouselImageUrls,
          scheduled_at: scheduledAt,
          destaque: destaqueKey,
          channel: "threads",
        });
      } catch (e: any) {
        console.error(`FAILED threads/${destaqueKey}: ${e.message}`);
        tagAndAppend({ platform: "threads", destaque: destaqueKey, url: null, status: "failed", scheduled_at: null, reason: e.message });
      }
      if (response) {
        console.log(`OK threads/${destaqueKey} — scheduled at ${scheduledAt} (worker_queue_key=${response.key})`);
        try {
          tagAndAppend({
            platform: "threads",
            destaque: destaqueKey,
            url: null,
            status: "scheduled",
            scheduled_at: scheduledAt,
            worker_queue_key: response.key,
          });
        } catch (e: any) {
          console.error(
            `\nSCHEDULED mas falhou ao persistir localmente (worker_queue_key=${response.key}): ${e.message} — ` +
              `NÃO re-rode, isso duplicaria o post.`,
          );
          throw e;
        }
      }
    }
  }

  console.log(`\n[publish-weekly-social] out_path: ${publishedPath}`);
  return true;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
