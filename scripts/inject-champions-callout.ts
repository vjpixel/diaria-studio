#!/usr/bin/env tsx
/**
 * inject-champions-callout.ts (#2725)
 *
 * Auto-gera e injeta o box de início de mês (campeões do É IA? + sorteio do
 * erro intencional — criado manualmente na edição 260701, #2725) em
 * `02-reviewed.md`, na 1ª edição do mês — MESMO gate de
 * `scripts/fetch-leaderboard-top1.ts` (#1753): nenhuma edição publicada
 * (`data/past-editions-raw.json`) cai no mesmo ano-mês com data anterior.
 * Reusa `isFirstEditionOfMonth`/`readPublishedDates`/`editionToMonthSlug`/
 * `previousMonthSlug` de `fetch-leaderboard-top1.ts` — não duplica a lógica
 * de detecção.
 *
 * Roda no Stage 3, DEPOIS de `fetch-leaderboard-top1.ts` popular
 * `_internal/04-leaderboard-top1.json` (fonte do `podium` top-3) e DEPOIS do
 * Stage 2 já ter escrito `02-reviewed.md` (fonte do texto onde o box é
 * injetado).
 *
 * Precedência (#2725 item — "não sobrescrever um introCallout que já exista
 * por outro motivo, ex: patrocínio"): se `extractIntroCallout` já encontra um
 * callout na região de intro de `02-reviewed.md` (patrocínio 📣, ou qualquer
 * 🎉 colado manualmente), a injeção é PULADA — o callout existente vence.
 * `extractIntroCallout` é greedy e assume um único bloco na região de intro
 * (#2727); tentar fundir os dois corrompe o parse (risco documentado como F3
 * em #2727, ainda sem lint dedicado). Skip é a opção segura.
 *
 * Graceful (mesmo padrão de fetch-leaderboard-top1.ts): qualquer pré-condição
 * AUSENTE (não é 1ª edição do mês, leaderboard.json ausente/vazio, pódio
 * incompleto, bloco `raffle` ausente em platform.config.json) é um NO-OP —
 * loga o motivo e sai 0. Nunca bloqueia o pipeline.
 *
 * #4583: exceção deliberada — `raffle.sorteio_do_mes.mes` PRESENTE mas
 * divergente do mês da edição corrente NÃO é tratado como no-op gracioso.
 * O dia do sorteio muda todo mês (não existe "dia fixo"); se o campo não foi
 * atualizado, renderizar o `dia` herdado do mês anterior publicaria uma data
 * errada em silêncio pra base inteira — pior que abortar. Mesma severidade
 * do `02-reviewed.md` ausente abaixo (fatal, exit 1).
 *
 * Uso:
 *   npx tsx scripts/inject-champions-callout.ts --edition AAMMDD [--edition-dir path] \
 *     [--leaderboard-json path] [--reviewed path] [--past-editions path] [--platform-config path] \
 *     [--editions-dir path]  # override do editions root — só para testes (#3491)
 *
 * Exit codes:
 *   0  sucesso — injetado, OU no-op gracioso (motivo no stdout)
 *   1  fatal — 02-reviewed.md ausente (Stage 2 deveria ter escrito),
 *      raffle.sorteio_do_mes.mes divergente do mês da edição corrente (#4583),
 *      ou I/O error inesperado
 *   2  arg inválido
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import {
  editionToMonthSlug,
  previousMonthSlug,
  isFirstEditionOfMonth,
  readPublishedDates,
} from "./fetch-leaderboard-top1.ts";
import {
  buildChampionsCallout,
  monthLabelFromSlug,
  raffleDateLabel,
  type PodiumEntry,
  type RaffleConfig,
} from "./lib/build-champions-callout.ts";
import { extractIntroCallout } from "./lib/newsletter-parse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface LeaderboardJson {
  podium?: PodiumEntry[];
}

interface PlatformConfigShape {
  raffle?: RaffleConfig;
  poll?: { worker_url?: string };
}

/** Boundary exata usada por `stitch-newsletter.ts` entre a região de intro
 * (coverage line + eventual callout) e o 1º destaque — `\n\n---\n\n` seguido
 * IMEDIATAMENTE por `**DESTAQUE` (lookahead garante que é o separador certo
 * mesmo havendo outros `---` mais acima na região de intro, ex: entre
 * TÍTULO/SUBTÍTULO e a coverage line). */
const SEP_BEFORE_DESTAQUE = /\n\n---\n\n(?=\*\*DESTAQUE)/;

export function parseCliArgs(argv: string[]) {
  const { values } = parseArgs(argv);
  const edition = values.edition ?? "";
  if (!edition) return null;
  // #3491: sem --edition-dir, o default construía `data/editions/{AAMMDD}`
  // à mão (layout FLAT) — mesma classe de bug de #3483/#3484. Na prática o
  // orchestrator (Stage 3, `.claude/agents/orchestrator-stage-3.md`) SEMPRE
  // passa `--edition-dir` explícito, então este fallback não é exercitado em
  // produção hoje — corrigido por defesa em profundidade (invocação manual
  // futura, ou mudança no orchestrator que esqueça a flag). `--editions-dir`
  // (plural, raiz) é override só de teste (mesmo padrão de close-poll.ts
  // #3031) — distinto de `--edition-dir` (singular, dir completo).
  const editionDir = values["edition-dir"] ?? (() => {
    const editionsRootDir = values["editions-dir"]
      ? resolve(process.cwd(), values["editions-dir"])
      : resolve(ROOT, "data", "editions");
    return resolveEditionDir(editionsRootDir, edition);
  })();
  return {
    edition,
    leaderboardJson: values["leaderboard-json"] ??
      join(editionDir, "_internal", "04-leaderboard-top1.json"),
    reviewedPath: values.reviewed ?? join(editionDir, "02-reviewed.md"),
    pastEditions: values["past-editions"] ?? join("data", "past-editions-raw.json"),
    platformConfig: values["platform-config"] ?? "platform.config.json",
  };
}

/** Lê JSON graciosamente — arquivo ausente/inválido → `null` (caller trata
 * como precondição não atendida, no-op). */
function readJsonGraceful<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Pure (#2725): insere `calloutInner` (texto já preenchido, sem `**` de wrap)
 * como `**🎉 ...**` na região de intro de `reviewedText`, imediatamente antes
 * do separador `---` que precede o 1º `**DESTAQUE`.
 *
 * O box fica delimitado por `---` em AMBOS os lados (#4310): um fechando a
 * região de intro/coverage line logo antes dele, outro reabrindo antes de
 * DESTAQUE 1. Necessário para que `captureUntilCoverageBoundary`
 * (`newsletter-parse.ts`) não estenda a coverage line pra dentro do box —
 * sem o `---` de abertura, o box some dentro da coverage line E
 * `extractIntroCallout` extrai o mesmo bloco de novo, duplicando no HTML.
 *
 * Retorna `null` se:
 *  - já existe um introCallout na região de intro (precedência — caller loga
 *    e pula, #2725);
 *  - o separador esperado (`SEP_BEFORE_DESTAQUE`) não é encontrado (formato
 *    inesperado de `02-reviewed.md` — fail-safe, não corrompe o arquivo).
 */
export function insertChampionsCallout(
  reviewedText: string,
  calloutInner: string,
): { text: string; skippedReason: null } | { text: null; skippedReason: string } {
  const existing = extractIntroCallout(reviewedText);
  if (existing !== null) {
    return {
      text: null,
      skippedReason:
        `callout já presente na região de intro ("${existing.slice(0, 40)}..."); ` +
        "precedência: callout existente vence (patrocínio ou outro motivo) — box de campeões NÃO injetado nesta edição.",
    };
  }
  if (!SEP_BEFORE_DESTAQUE.test(reviewedText)) {
    return {
      text: null,
      skippedReason: "separador '---' antes de '**DESTAQUE' não encontrado — formato inesperado de 02-reviewed.md, injeção abortada (fail-safe).",
    };
  }
  // #4310: SEP_BEFORE_DESTAQUE CONSOME o `---` que separava a região de intro
  // do DESTAQUE 1 (lookahead não devolve o que veio antes dele no match). O
  // `block` precisa devolver esse separador — sem ele, a região de intro
  // (`captureUntilCoverageBoundary`) se estende até DEPOIS do box de
  // campeões (não encontra o `---` que deveria fechá-la logo antes do box),
  // e `extractIntroCallout` extrai o MESMO bloco de novo — duplicação no
  // HTML final. Com a coverage line legada (linha única), o bug não se
  // manifestava porque o regex de coverage line dela não se estende por
  // boundary — só a coverage line multi-parágrafo (#3461/#3691, formato
  // padrão desde 260715) expõe o bug.
  const block = `\n\n---\n\n**${calloutInner}**\n\n---\n\n`;
  const text = reviewedText.replace(SEP_BEFORE_DESTAQUE, block);
  return { text, skippedReason: null };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: inject-champions-callout.ts --edition AAMMDD [--edition-dir path] [--leaderboard-json path] [--reviewed path] [--past-editions path] [--platform-config path]");
    process.exit(2);
  }

  const slug = editionToMonthSlug(args.edition);
  if (!slug) {
    console.error(`[inject-champions-callout] edição inválida: ${args.edition} (esperado AAMMDD)`);
    process.exit(2);
  }

  // Mesmo gate do leaderboard (#1753): só a 1ª edição do mês.
  const publishedAt = readPublishedDates(resolve(ROOT, args.pastEditions));
  if (!isFirstEditionOfMonth(args.edition, publishedAt)) {
    console.log(`[inject-champions-callout] edição ${args.edition} não é a 1ª do mês — box de campeões não é aplicável (mesmo gate do leaderboard). No-op.`);
    return;
  }

  const leaderboard = readJsonGraceful<LeaderboardJson>(resolve(ROOT, args.leaderboardJson));
  const podium = leaderboard?.podium ?? [];
  if (podium.length === 0) {
    console.log(`[inject-champions-callout] pódio vazio ou ${args.leaderboardJson} ausente/ilegível — sem dados pra montar o box. No-op.`);
    return;
  }

  const platformConfig = readJsonGraceful<PlatformConfigShape>(resolve(ROOT, args.platformConfig));
  const raffle = platformConfig?.raffle;
  if (!raffle) {
    console.log(`[inject-champions-callout] bloco 'raffle' ausente em ${args.platformConfig} — sem config de sorteio pra montar o box. No-op.`);
    return;
  }

  // #4583: o dia do sorteio muda todo mês — não existe "dia fixo". Diferente
  // das precondições graciosas acima (dado FALTANTE — no-op silencioso é
  // seguro), aqui o dado está PRESENTE mas pode estar STALE (herdado do mês
  // anterior): publicar a data errada pra base inteira é pior que abortar.
  // Fatal, mesma severidade/exit code do "02-reviewed.md ausente" abaixo —
  // nunca renderiza silenciosamente um `dia` que não é deste mês.
  if (raffle.sorteio_do_mes?.mes !== slug) {
    console.error(
      `[inject-champions-callout] FATAL: raffle.sorteio_do_mes.mes ("${raffle.sorteio_do_mes?.mes ?? "ausente"}") não bate com o mês da edição corrente ("${slug}") em ${args.platformConfig}. ` +
      `Peça ao editor o dia do sorteio de ${slug} e atualize platform.config.json → raffle.sorteio_do_mes para { "mes": "${slug}", "dia": N } antes de rodar de novo.`,
    );
    process.exit(1);
  }

  const championsMonthLabel = monthLabelFromSlug(previousMonthSlug(slug));
  const raffleDate = raffleDateLabel(slug, raffle.sorteio_do_mes.dia);
  if (!championsMonthLabel || !raffleDate) {
    console.log("[inject-champions-callout] falha ao resolver label de mês/data — no-op (fail-safe).");
    return;
  }

  // Achado 260803: `/leaderboard` (bare) resolve pro mês CORRENTE no momento
  // em que o leitor clica (`handleLeaderboard` no worker, currentMonthSlugBrt),
  // não pro mês que este box celebra. O box de campeões é publicado no início
  // do mês seguinte ("campeões de julho" saindo em agosto) — sem o slug do
  // mês, o link mudaria de assunto sozinho assim que o mês virasse de novo.
  // `previousMonthSlug(slug)` já é calculado acima (linha da championsMonthLabel)
  // no formato YYYY-MM exigido pela rota `/leaderboard/{YYYY-MM}` do worker.
  const leaderboardUrl = platformConfig?.poll?.worker_url
    ? `${platformConfig.poll.worker_url}/leaderboard/${previousMonthSlug(slug)}`
    : undefined;
  const calloutInner = buildChampionsCallout(podium, raffle, championsMonthLabel, raffleDate, leaderboardUrl);
  if (!calloutInner) {
    console.log(`[inject-champions-callout] pódio incompleto (esperado ranks 1-3 em ${args.leaderboardJson}) — box de campeões requer top-3 completo. No-op.`);
    return;
  }

  const reviewedPathAbs = resolve(ROOT, args.reviewedPath);
  if (!existsSync(reviewedPathAbs)) {
    console.error(`[inject-champions-callout] FATAL: ${args.reviewedPath} não existe — Stage 2 deveria ter escrito antes do Stage 3 rodar este script.`);
    process.exit(1);
  }
  const reviewedText = readFileSync(reviewedPathAbs, "utf8");

  const result = insertChampionsCallout(reviewedText, calloutInner);
  if (result.text === null) {
    console.log(`[inject-champions-callout] ${result.skippedReason}`);
    return;
  }

  writeFileSync(reviewedPathAbs, result.text, "utf8");
  console.log(`[inject-champions-callout] box de campeões (${championsMonthLabel}) + sorteio (${raffleDate}) injetado em ${args.reviewedPath}`);
}

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  await main();
}
