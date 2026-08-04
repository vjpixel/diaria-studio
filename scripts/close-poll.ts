/**
 * close-poll.ts (#469)
 *
 * Fecha a votação de uma edição: envia a resposta correta para o Worker de poll,
 * que retroativamente atualiza scores dos votos já gravados.
 *
 * Chamado pelo pipeline após publicação da newsletter (Stage 4).
 *
 * Uso:
 *   npx tsx scripts/close-poll.ts --edition 260502
 *   npx tsx scripts/close-poll.ts --edition 260502 --answer A  # override manual
 *
 * Para o É IA? mensal (fluxo multi-campanha Clarice):
 *   npx tsx scripts/close-poll.ts --edition 2605-06 --brand clarice --cycle 2605-06
 *
 * #2115: --edition agora aceita o formato de ciclo 2605-06 (novo canônico)
 * além do legado AAMMDD 260531 — mas não intercambiáveis para todo brand.
 * #4157: --brand clarice (ou qualquer brand anual) + --edition no formato
 * AAMMDD é REJEITADO pelo Worker (400) — só o diária (`leaderboardPeriod
 * "month"`) aceita AAMMDD; a mensal precisa do formato de ciclo, senão
 * sobrescreveria o gabarito de uma edição diária real que compartilha o
 * mesmo AAMMDD. Ver workers/poll/src/index.ts (handleAdminCorrect).
 *
 * O --cycle é obrigatório quando --brand clarice para gravar o marker de gabarito
 * em data/monthly/{cycle}/_internal/.close-poll-clarice.json. Este marker é
 * verificado pelo clarice-schedule-sends --schedule antes de agendar os envios.
 *
 * Se --answer não for passado, lê ai_side de _internal/01-eia-meta.json da edição.
 *
 * --editions-dir <path>  Override do editions root da diária (default:
 *                        data/editions/ do repo). Só para testes — produção
 *                        nunca passa essa flag. (#3031)
 *
 * Variáveis de ambiente:
 *   ADMIN_SECRET       HMAC key pro endpoint /admin/correct (ver .env). Worker
 *                      valida sig contra ADMIN_SECRET (workers/poll/src/index.ts:325).
 *                      Pode estar como `ADMIN_SECRET` ou `POLL_ADMIN_SECRET`.
 *   POLL_WORKER_URL    URL base do Worker (default: https://eia.diar.ia.br —
 *                      domínio de marca, #3904; poll.diaria.workers.dev segue
 *                      ativo só por compat de links já enviados)
 */

import "dotenv/config"; // #1204 — sem isso, ADMIN_SECRET do .env nao chega no processo

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts"; // #535 / #3516
import { parseEiaMeta } from "./lib/schemas/eia-meta.ts"; // #1031
import { dohFetch } from "./lib/doh-fetch.ts"; // #1365 — DoH fallback pra ISPs com UDP/53 broken
import { monthlyDir as resolveMonthlyDir, isValidMonthlyCycle } from "./lib/mensal/monthly-paths.ts"; // #2009 — marker mensal
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3024/#3031: layout flat+nested
import { runSyncIntentionalError } from "./sync-intentional-error.ts"; // #3210
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts"; // #3904

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL;

// #3118 (item 8): mensagem assinada agora inclui o brand — antes era só
// `${edition}:${answer}`, o que tornava o sig replayable pra sempre E válido
// CROSS-BRAND (um sig gerado pra brand=diaria também validava com
// ?brand=clarice contra o mesmo Worker, gravando o gabarito no namespace
// errado). Fix espelhado em workers/poll/src/index.ts (handleAdminCorrect)
// e em scripts/publish-monthly.ts (registerEiaAnswer, que também assina
// /admin/correct — sempre com brand=clarice).
function adminSig(secret: string, brand: string, edition: string, answer: string): string {
  return createHmac("sha256", secret).update(`${brand}:${edition}:${answer}`).digest("hex");
}

/**
 * #4125 (item 5): `/stats` agora omite `correct_answer` publicamente enquanto
 * `edition >= hoje` (BRT) — mesmo racional anti-spoiler do 403 que
 * `handleQuizAnswer` já aplicava ao mesmo fato (workers/poll/src/jogar.ts).
 * `close-poll.ts` FECHA a edição no mesmo dia em que ela é publicada (a
 * convenção D+1 do projeto: pesquisa em D, edição datada D+1 — o dia em que o
 * e-mail sai É o dia da edição), então o sanity check logo abaixo (linha
 * ~190) SEMPRE roda com `edition === hoje` — a omissão pública quebraria essa
 * checagem sem um bypass autenticado.
 *
 * `statsSig` assina `stats:{brand}:{edition}` com o MESMO `ADMIN_SECRET` já
 * usado por `adminSig` — o Worker (`handleStats`, vote.ts) aceita esse `sig`
 * como prova de que o caller é autorizado (mesmo operador que acabou de
 * fechar o gabarito via `/admin/correct`) e devolve `correct_answer` mesmo
 * pra edição de hoje. Sem sig (qualquer leitor público), a omissão vale
 * normalmente.
 */
function statsSig(secret: string, brand: string, edition: string): string {
  return createHmac("sha256", secret).update(`stats:${brand}:${edition}`).digest("hex");
}

/**
 * #3984: assina o payload de `POST /admin/eiameta` (descrição+crédito da
 * imagem, gravados em `eiameta:{edition}` — chave COMPARTILHADA, sem prefixo
 * de brand, ver rationale em jogar.ts). O conteúdo inteiro (description +
 * credit) entra no material assinado — não só `edition` — pra que o sig não
 * seja replayable com um conteúdo DIFERENTE do que foi de fato autorizado
 * (mesma disciplina de integridade que `/admin/correct` já aplica ao incluir
 * `answer` no material assinado, #3118 item 8). Espelhado em
 * `workers/poll/src/index.ts` (`handleAdminEiaMeta`) — mudar um lado sem o
 * outro quebra a verificação.
 */
export function adminEiaMetaSig(secret: string, edition: string, description: string, credit: string): string {
  return createHmac("sha256", secret).update(`eiameta:${edition}:${description}:${credit}`).digest("hex");
}

/**
 * Pure (#3516): decide se o close-poll da diária deve TAMBÉM espelhar o
 * gabarito pro brand `web` (jogo standalone, EPIC #3514). Só o branch
 * DEFAULT (fecha a diária, `--brand` omitido) dispara o mirror — `clarice`
 * é um ciclo mensal sem relação com o par diário do standalone, e qualquer
 * outro `--brand` explícito (ex: `web` direto, pra correção manual) já é o
 * PRÓPRIO alvo do mirror, não faz sentido espelhar de novo pra si mesmo.
 * Extraída como função pura testável sem precisar spawnar o CLI inteiro
 * (que tocaria `data/monthly/` de verdade pro branch clarice).
 */
export function shouldMirrorToWeb(brand: string | null): boolean {
  return brand === null;
}

/**
 * #4563: input do sanity check pós-correção — os campos que `/stats` (Worker
 * de poll) devolve depois de `close-poll.ts` chamar `/admin/correct`.
 */
export interface CorrectCountSanityInput {
  /** Gabarito que ACABAMOS de setar (A ou B). */
  answer: string;
  /** `stats.total` de `/stats`. */
  totalVotes: number;
  /** `stats.voted_a` de `/stats`. */
  votedA: number;
  /** `stats.voted_b` de `/stats`. */
  votedB: number;
  /** `stats.correct_count` de `/stats`, LIDO DEPOIS da correção. */
  correctCountFromStats: number;
  /** `updated_votes` que `/admin/correct` reportou ter mudado. */
  updatedVotes: number;
}

export interface CorrectCountSanityResult {
  ok: boolean;
  /** Contagem de acertos esperada pro gabarito setado (voted_a ou voted_b). */
  expectedCorrectCount: number;
  /** Presente só quando ok=false — mensagem de diagnóstico pronta pra log. */
  message?: string;
  /**
   * #4563 item 2: true quando updated_votes=0 mas o check acima passou —
   * o caso legítimo de "gabarito já batia com o crédito existente, nenhum
   * voto precisava mudar" (ex: re-rodar close-poll com o MESMO --answer).
   * Nunca true quando ok=false (nesse caso updated_votes=0 é sintoma do bug,
   * não um no-op legítimo).
   */
  legitimateNoop: boolean;
}

/**
 * Pure (#4563), testável sem rede/KV: decide se o `correct_count` que
 * `/stats` devolveu DEPOIS de `close-poll.ts` fechar o gabarito bate com o
 * esperado — quem votou no lado que ACABOU de virar o gabarito.
 *
 * Bug real que motivou este guard (issue #4563, ciclo 2607-08): o sanity
 * check pré-existente (#1367) só conferia que `/stats.correct_answer`
 * refletia o gabarito GRAVADO — nunca que o CRÉDITO (`correct_count`) tinha
 * sido de fato recalculado. `close-poll.ts --answer B` sobre 10 votos A / 4
 * votos B reportava `ok:true` com `/stats.correct_count` ainda em 10 (os que
 * ACERTARAM o gabarito ERRADO anterior) em vez de 4 — e `updated_votes: 0`
 * não acusava nada porque o script nunca comparava contra o valor esperado.
 *
 * `expectedCorrectCount` = `votedA` quando `answer === "A"`, senão `votedB`
 * — é sempre um dos dois, nunca uma soma; o gabarito define qual dos dois
 * lados "ganhou".
 *
 * `updatedVotes === 0` SÓ é aceito como no-op legítimo (`legitimateNoop:
 * true`) quando `correctCountFromStats` já bate com o esperado — ou seja,
 * nenhum voto precisava mudar porque já estava certo (ex: reexecução com o
 * mesmo --answer). Quando não bate, é sempre reportado como erro
 * (`ok: false`), independente de updated_votes ter sido 0 ou não — o mismatch
 * em si já é suficiente pra provar que o crédito não foi aplicado
 * corretamente (causas candidatas documentadas na issue: DO StatsCounter
 * stale, ou votos individuais não encontrados pra recreditar — diagnóstico
 * bloqueado por falta de acesso ao KV, ver #4563).
 */
export function checkCorrectCountSanity(input: CorrectCountSanityInput): CorrectCountSanityResult {
  const { answer, totalVotes, votedA, votedB, correctCountFromStats, updatedVotes } = input;
  const expectedCorrectCount = answer === "A" ? votedA : votedB;
  const matches = correctCountFromStats === expectedCorrectCount;

  if (!matches) {
    return {
      ok: false,
      expectedCorrectCount,
      legitimateNoop: false,
      message:
        `correct_count pós-correção (${correctCountFromStats}) não bate com o esperado para o gabarito "${answer}" ` +
        `(esperado=${expectedCorrectCount}, voted_a=${votedA}, voted_b=${votedB}, total=${totalVotes}, updated_votes=${updatedVotes}). ` +
        `O Worker respondeu ok:true no /admin/correct mas o crédito não foi aplicado corretamente aos votos — ` +
        `ver #4563 (causas candidatas: DO StatsCounter stale ou votos individuais não encontrados pra recreditar).`,
    };
  }

  return {
    ok: true,
    expectedCorrectCount,
    legitimateNoop: updatedVotes === 0 && totalVotes > 0,
  };
}

/** Campos numéricos de `/stats` já validados como `number` de verdade. */
export interface StatsNumericFields {
  total: number;
  votedA: number;
  votedB: number;
  correctCount: number;
}

/**
 * #4566 (review fleet, achado MEDIUM): valida que os 4 campos numéricos que
 * `/stats` devolve pós-correção (`total`, `voted_a`, `voted_b`,
 * `correct_count`) são de fato `number` antes de virarem input de
 * `checkCorrectCountSanity`. Ausência ou tipo errado indica regressão de
 * schema no Worker — sem este guard, todos cairiam em `?? 0`, `matches`
 * bateria sempre 0 === 0 e `checkCorrectCountSanity` nunca acusaria nada:
 * a MESMA classe de "fallback que mascara o problema real" que #4563 existe
 * pra eliminar, só que um nível abaixo (o CAMINHO que popula o input a
 * partir do JSON de rede, não o guard em si — o tipo de
 * `CorrectCountSanityInput` já exige `number`, nunca `number|undefined`).
 *
 * Pure, testável sem rede/spawn — `main()` usa isto tanto no sanity check
 * principal (FATAL se inválido) quanto na releitura pós-mirror --brand web
 * (fail-soft, só warning — ver #4566 achado HIGH).
 */
export function validateStatsNumericFields(stats: {
  total?: unknown;
  voted_a?: unknown;
  voted_b?: unknown;
  correct_count?: unknown;
}): { ok: true; fields: StatsNumericFields } | { ok: false; message: string } {
  if (
    typeof stats.total !== "number" ||
    typeof stats.voted_a !== "number" ||
    typeof stats.voted_b !== "number" ||
    typeof stats.correct_count !== "number"
  ) {
    return {
      ok: false,
      message:
        `resposta /stats malformada — total/voted_a/voted_b/correct_count ausente(s) ou de tipo inválido ` +
        `(total=${JSON.stringify(stats.total)}, voted_a=${JSON.stringify(stats.voted_a)}, ` +
        `voted_b=${JSON.stringify(stats.voted_b)}, correct_count=${JSON.stringify(stats.correct_count)}). ` +
        `Worker pode ter regressão de schema — ver #4566.`,
    };
  }
  return {
    ok: true,
    fields: { total: stats.total, votedA: stats.voted_a, votedB: stats.voted_b, correctCount: stats.correct_count },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { values } = parseCliArgs(args); // #535: fix indexOf+1 bug

  const edition = values["edition"];
  let answer = values["answer"]?.toUpperCase();
  // #1176: Worker /admin/correct valida sig contra ADMIN_SECRET (workers/poll
  // src/index.ts:325), não POLL_SECRET. Aceitar tanto ADMIN_SECRET (canonical)
  // quanto POLL_ADMIN_SECRET (alias usado em alguns ambientes).
  const secret = process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET;

  if (!secret) {
    console.error("[close-poll] ADMIN_SECRET não definido. Ver .env.");
    process.exit(1);
  }
  if (!edition) {
    console.error("Uso: close-poll.ts --edition AAMMDD [--answer A|B]");
    process.exit(1);
  }

  // #3031: editions root da diária — testável via --editions-dir (default: o
  // real data/editions da instalação). Sem override em uso de produção.
  const editionsRootDir = values["editions-dir"]
    ? resolve(process.cwd(), values["editions-dir"])
    : resolve(ROOT, "data", "editions");

  // #3210: path do JSONL de erros intencionais — testável via
  // --intentional-errors-jsonl (default: o real data/intentional-errors.jsonl
  // da instalação). Sem override em uso de produção.
  const intentionalErrorsJsonlPath = values["intentional-errors-jsonl"]
    ? resolve(process.cwd(), values["intentional-errors-jsonl"])
    : resolve(ROOT, "data", "intentional-errors.jsonl");

  // #2006: brand opcional (clarice = É IA? da mensal). Sem isso, o gabarito da
  // mensal escreveria a key da DIÁRIA `correct:{edition}` (colisão real: 260531
  // é uma data de edição diária válida). A sig não muda (HMAC só de edition:answer).
  // #2009: parsed early so the answer-resolution block can emit a clear error for
  // the monthly flow (01-eia-meta.json lives in data/editions/, irrelevant here).
  // #3516: generaliza de "só 'clarice'" pra QUALQUER brand não-diaria — o
  // branch genérico logo abaixo ("brand não-clarice futuro") já existia
  // antecipando isso, mas o parse só deixava "clarice" passar. Permite
  // `--brand web` (jogo standalone, EPIC #3514) usar o MESMO endpoint
  // /admin/correct genérico sem precisar de um branch dedicado aqui — útil
  // pro editor corrigir manualmente o gabarito do brand `web` se necessário
  // (o caminho normal é o mirror automático logo abaixo, no branch default).
  const brand = values["brand"] && values["brand"] !== "diaria" ? values["brand"] : null;

  // #3031: resolveEditionDir resolve o path REAL da edição (flat ou nested,
  // #3024) em vez de montar data/editions/{edition} à força — que só existe
  // no layout flat legado e some pós-migração pro layout nested. Hoisted pra
  // escopo de função (#3984): antes era recalculado localmente 2x (aqui e no
  // marker da diária mais abaixo) — o push de eiameta precisa do MESMO path
  // num 3º ponto, então centraliza o cálculo em vez de uma 3ª cópia.
  const editionDirPath = resolveEditionDir(editionsRootDir, edition);
  const metaPath = resolve(editionDirPath, "_internal", "01-eia-meta.json");

  // Ler ai_side de 01-eia-meta.json se não foi passado manualmente
  if (!answer) {
    if (brand === "clarice") {
      console.error("[close-poll] --brand clarice requer --answer A|B explícito (fluxo mensal não usa 01-eia-meta.json da edição diária). Use --answer A ou --answer B.");
      process.exit(1);
    }
    if (!existsSync(metaPath)) {
      console.error(`[close-poll] 01-eia-meta.json não encontrado em ${metaPath}. Use --answer A|B.`);
      process.exit(1);
    }
    // #1031: schema-validated parse — Zod garante ai_side ∈ {A, B}
    try {
      const meta = parseEiaMeta(JSON.parse(readFileSync(metaPath, "utf8")));
      answer = meta.ai_side;
      console.error(`[close-poll] Leu ai_side="${answer}" de ${metaPath}`); // #2018-fix: stderr (não polui stdout JSON)
    } catch (e) {
      console.error(`[close-poll] schema inválido em ${metaPath}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const brandQ = brand ? `&brand=${brand}` : "";

  // #3118 item 8: brand efetivo é sempre "diaria" quando --brand não é passado
  // (mesmo default do Worker, ver parseBrandParam em lib.ts) — precisa bater
  // exatamente com o valor que handleAdminCorrect usa na mensagem assinada.
  const sig = adminSig(secret, brand ?? "diaria", edition, answer);
  const url = `${POLL_WORKER_URL}/admin/correct?edition=${edition}&answer=${answer}&sig=${sig}${brandQ}`;

  const res = await dohFetch(url, { method: "POST" });
  const data = await res.json() as { ok?: boolean; updated_votes?: number; error?: string };

  if (!res.ok || !data.ok) {
    console.error(`[close-poll] Erro ao fechar poll: ${JSON.stringify(data)}`);
    process.exit(1);
  }

  // #1367: sanity check pós-close — confirmar que /stats retorna correct_answer
  // não-null. Sem isso, exit 0 não garante que o gabarito ficou registrado
  // (caso real 260518: close-poll falhou silencioso, total=3 mas correct_answer=null).
  // #4125 (item 5): `sig` autenticado — sem ele, `/stats` omitiria
  // correct_answer publicamente pra edição de hoje (anti-spoiler), fazendo
  // este sanity check FATAL mesmo com o gabarito corretamente gravado. Ver
  // rationale completo no header de `statsSig` acima.
  const statsSigQ = `&sig=${statsSig(secret, brand ?? "diaria", edition)}`;
  const statsRes = await dohFetch(`${POLL_WORKER_URL}/stats?edition=${edition}${brandQ}${statsSigQ}`);
  const stats = await statsRes.json() as {
    correct_answer?: string | null;
    total?: number;
    voted_a?: number;
    voted_b?: number;
    correct_count?: number;
  };
  if (!statsRes.ok || stats.correct_answer !== answer) {
    console.error(
      `[close-poll] FATAL: sanity check falhou — /stats retornou correct_answer=${JSON.stringify(stats.correct_answer)} ` +
        `esperado="${answer}". Worker pode ter rejeitado silenciosamente ou retornou stale.`,
    );
    process.exit(1);
  }

  // #4563: o check acima só confirma que o GABARITO foi gravado — não que o
  // CRÉDITO (correct_count) foi de fato aplicado aos votos já registrados.
  //
  // #4566 (review fleet, achado MEDIUM): `validateStatsNumericFields` (pure,
  // acima) garante que os 4 campos são `number` de verdade — sem isso,
  // campos ausentes/malformados cairiam silenciosamente em `?? 0` e
  // mascarariam uma regressão de schema do Worker. FATAL, não silencioso.
  const statsFields = validateStatsNumericFields(stats);
  if (!statsFields.ok) {
    console.error(`[close-poll] FATAL: ${statsFields.message}`);
    process.exit(1);
  }

  const correctCountSanity = checkCorrectCountSanity({
    answer,
    totalVotes: statsFields.fields.total,
    votedA: statsFields.fields.votedA,
    votedB: statsFields.fields.votedB,
    correctCountFromStats: statsFields.fields.correctCount,
    updatedVotes: data.updated_votes ?? 0,
  });
  if (!correctCountSanity.ok) {
    console.error(`[close-poll] FATAL: ${correctCountSanity.message}`);
    process.exit(1);
  }
  if (correctCountSanity.legitimateNoop) {
    console.error(
      `[close-poll] updated_votes=0 — nenhum voto precisou de ajuste (correct_count já batia com o esperado=` +
        `${correctCountSanity.expectedCorrectCount} pro gabarito "${answer}").`,
    );
  }

  // #1367: marker de sucesso pra Stage 5 invariant checar.
  // #2006: brand não-default (mensal) não tem edição diária — não criar pasta em
  // data/editions/{AAMMDD}/ (seria fantasma; invariant é só da diária).
  // #2009: brand=clarice grava marker na pasta mensal para que clarice-schedule-sends
  // --schedule possa verificar que o gabarito foi setado antes de agendar os envios.
  if (brand === "clarice") {
    const cycle = values["cycle"];
    if (!cycle || !isValidMonthlyCycle(cycle)) {
      console.error(
        `[close-poll] --cycle é obrigatório com --brand clarice (ex: --cycle 2605-06). ` +
        `Sem ele, o marker de gabarito não pode ser gravado e clarice-schedule-sends --schedule irá falhar.`,
      );
      process.exit(1);
    }
    const monthlyDirPath = resolveMonthlyDir(cycle);
    const markerDir = resolve(monthlyDirPath, "_internal");
    mkdirSync(markerDir, { recursive: true });
    const markerPath = resolve(markerDir, ".close-poll-clarice.json");
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          cycle,
          edition,
          answer,
          brand: "clarice",
          updated_votes: data.updated_votes ?? 0,
          closed_at: new Date().toISOString(),
          // #4563: expected_correct_count/correct_count registrados pra
          // auditoria (correct_count é o valor JÁ CORRIGIDO lido de /stats —
          // não confundir com correctCountFromStats, nome interno camelCase
          // do parâmetro de CorrectCountSanityInput) — sanity check
          // pós-correção já validou que batem (senão o script teria saído
          // com FATAL acima).
          sanity_check: {
            correct_answer: stats.correct_answer,
            correct_count: stats.correct_count ?? 0,
            expected_correct_count: correctCountSanity.expectedCorrectCount,
          },
        },
        null,
        2,
      ),
    );
    console.error(
      `[close-poll] gabarito É IA? ${answer} setado para edition=${edition} brand=clarice cycle=${cycle}. ` +
      `Marker: ${markerPath}`,
    );
    // #2018: stdout JSON — contrato idêntico ao da diária (abaixo), parseable
    // por orchestrators/skills que capturam stdout do script.
    console.log(
      JSON.stringify({
        ok: true,
        brand: "clarice",
        cycle,
        edition,
        answer,
        updated_votes: data.updated_votes ?? 0,
        marker_path: markerPath,
        sanity_check: {
          correct_answer: stats.correct_answer,
          correct_count: stats.correct_count ?? 0,
          expected_correct_count: correctCountSanity.expectedCorrectCount,
        },
      }),
    );
    return;
  }
  if (brand) {
    // brand não-clarice futuro: log e retornar (sem marker de diária nem mensal)
    console.error(`[close-poll] gabarito ${answer} setado pra edition=${edition} brand=${brand} (marker pulado)`);
    console.log(JSON.stringify({ ok: true, brand, edition, answer, updated_votes: data.updated_votes ?? 0 }));
    return;
  }

  // #3516 (EPIC #3514, fundação do "É IA?" standalone): espelha o MESMO
  // gabarito pro brand "web" — o jogo público em /jogar reusa literalmente o
  // par de imagens da diária (mesma edição, mesmos arquivos em /img/), então
  // fechar o poll da diária é o sinal natural de que o par do dia também
  // pode revelar resultado no standalone. Best-effort e FAIL-SOFT (mesma
  // filosofia de `drive-sync.ts`/sync scripts do pipeline — nunca bloqueia o
  // close-poll principal): uma falha aqui só vira warning em stderr, o
  // fluxo de publicação da diária (branch acima, já concluído com sucesso
  // neste ponto) segue intocado. `shouldMirrorToWeb` (pure, testável) é
  // sempre true neste ponto do código (só chega aqui quando `brand` é null —
  // os dois `if` acima já retornaram pros outros casos) — o guard explícito
  // documenta a intenção em vez de depender só do fallthrough estrutural.
  if (shouldMirrorToWeb(brand)) {
    try {
      const webSig = adminSig(secret, "web", edition, answer);
      const webUrl = `${POLL_WORKER_URL}/admin/correct?edition=${edition}&answer=${answer}&sig=${webSig}&brand=web`;
      const webRes = await dohFetch(webUrl, { method: "POST" });
      const webData = await webRes.json().catch(() => ({})) as { ok?: boolean; updated_votes?: number };
      if (!webRes.ok || !webData.ok) {
        console.error(`[close-poll] aviso (#3516): mirror --brand web falhou (status ${webRes.status}) para edition=${edition} — não bloqueia close-poll da diária.`);
      } else {
        console.error(`[close-poll] gabarito espelhado pro brand=web (edition=${edition}) — #3516.`);

        // #4566 (review fleet, achado HIGH): o /admin/correct acima só
        // confirma que o GABARITO do brand `web` foi gravado — StatsCounter
        // é instanciado por `{brand}:{edition}`, então o DO do brand `web` é
        // uma instância TOTALMENTE separada da diária, e um resultado limpo
        // lá em cima não garante nada sobre o mirror. Mesma classe de bug do
        // #4563 (`ok:true` sem o CRÉDITO ter sido de fato aplicado), agora
        // reproduzível aqui. Relê `/stats?brand=web` e roda o MESMO guard
        // puro (`checkCorrectCountSanity`) — mas fail-soft (aviso em stderr,
        // NUNCA FATAL/exit): o close-poll da diária já terminou com sucesso
        // neste ponto, e o mirror inteiro é best-effort por natureza (#3516)
        // — um mismatch aqui não deve derrubar o processo, só alertar.
        try {
          const webStatsSigQ = `&sig=${statsSig(secret, "web", edition)}`;
          const webStatsRes = await dohFetch(`${POLL_WORKER_URL}/stats?edition=${edition}&brand=web${webStatsSigQ}`);
          const webStats = await webStatsRes.json().catch(() => ({})) as {
            total?: number;
            voted_a?: number;
            voted_b?: number;
            correct_count?: number;
          };
          const webStatsFields = webStatsRes.ok ? validateStatsNumericFields(webStats) : { ok: false as const, message: `status ${webStatsRes.status}` };
          if (!webStatsFields.ok) {
            console.error(
              `[close-poll] aviso (#4566): não foi possível validar o crédito do mirror --brand web (resposta ` +
                `/stats malformada ou indisponível para edition=${edition}: ${webStatsFields.message}).`,
            );
          } else {
            const webSanity = checkCorrectCountSanity({
              answer,
              totalVotes: webStatsFields.fields.total,
              votedA: webStatsFields.fields.votedA,
              votedB: webStatsFields.fields.votedB,
              correctCountFromStats: webStatsFields.fields.correctCount,
              updatedVotes: webData.updated_votes ?? 0,
            });
            if (!webSanity.ok) {
              console.error(`[close-poll] aviso (#4566): mirror --brand web reportou ok:true mas o crédito diverge — ${webSanity.message}`);
            }
          }
        } catch (e) {
          console.error(`[close-poll] aviso (#4566): validação pós-mirror --brand web lançou exceção para edition=${edition}: ${(e as Error).message} — não bloqueia close-poll.`);
        }
      }
    } catch (e) {
      console.error(`[close-poll] aviso (#3516): mirror --brand web lançou exceção para edition=${edition}: ${(e as Error).message} — não bloqueia close-poll.`);
    }
  }

  // #3984: push best-effort de descrição+crédito pro Worker (`eiameta:{edition}`,
  // chave COMPARTILHADA/sem prefixo de brand — mesmo racional de `correct:{edition}`,
  // ver rationale em workers/poll/src/jogar.ts). Roda no MESMO branch default
  // do mirror --brand web acima (só quando `brand` é null — fechar a diária),
  // porque é a fonte que TEM `01-eia-meta.json` (a mensal usa --answer
  // explícito, sem esse arquivo, ver guard mais acima). Fail-soft: qualquer
  // falha (meta ausente, schema inválido, Worker fora do ar) vira warning em
  // stderr — nunca bloqueia o close-poll principal, mesma filosofia do mirror
  // web. Sem descrição/crédito disponíveis (edição composta ANTES do #3984,
  // ou wikimedia.credit ausente), o push é pulado silenciosamente — nada útil
  // a compartilhar, e o Worker já trata `eiameta:{edition}` ausente como
  // fallback gracioso (revelação sem descrição, igual hoje).
  if (shouldMirrorToWeb(brand)) {
    try {
      if (existsSync(metaPath)) {
        const meta = parseEiaMeta(JSON.parse(readFileSync(metaPath, "utf8")));
        const description = meta.wikimedia?.description ?? "";
        const credit = meta.wikimedia?.credit ?? "";
        if (description || credit) {
          const eiaMetaSig = adminEiaMetaSig(secret, edition, description, credit);
          const eiaMetaUrl = `${POLL_WORKER_URL}/admin/eiameta`;
          const eiaMetaRes = await dohFetch(eiaMetaUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ edition, description, credit, sig: eiaMetaSig }),
          });
          const eiaMetaData = await eiaMetaRes.json().catch(() => ({})) as { ok?: boolean };
          if (!eiaMetaRes.ok || !eiaMetaData.ok) {
            console.error(`[close-poll] aviso (#3984): push de eiameta falhou (status ${eiaMetaRes.status}) para edition=${edition} — não bloqueia close-poll.`);
          } else {
            console.error(`[close-poll] eiameta (descrição+crédito) gravado pra edition=${edition} — #3984.`);
          }
        } else {
          console.error(`[close-poll] eiameta pulado (#3984): sem descrição/crédito em ${metaPath}.`);
        }
      } else {
        console.error(`[close-poll] eiameta pulado (#3984): ${metaPath} não encontrado.`);
      }
    } catch (e) {
      console.error(`[close-poll] aviso (#3984): push de eiameta lançou exceção para edition=${edition}: ${(e as Error).message} — não bloqueia close-poll.`);
    }
  }

  const markerDir = resolve(editionDirPath, "_internal");
  mkdirSync(markerDir, { recursive: true });
  const markerPath = resolve(markerDir, ".close-poll-done.json");
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        edition,
        answer,
        updated_votes: data.updated_votes ?? 0,
        closed_at: new Date().toISOString(),
        // #4563: mesma auditoria do marker clarice acima — check já validado.
        sanity_check: {
          correct_answer: stats.correct_answer,
          correct_count: stats.correct_count ?? 0,
          expected_correct_count: correctCountSanity.expectedCorrectCount,
        },
      },
      null,
      2,
    ),
  );

  // #3210: close-poll.ts roda em AMBOS os fluxos de publicação — automático
  // (Stage 4 pré-render, beehiiv-playbook.md) E manual (prep-manual-publish.ts
  // imprime "Após publicar: npx tsx scripts/close-poll.ts --edition {edição}"
  // como próximo passo). O fluxo automático já chama sync-intentional-error.ts
  // explicitamente (§0.1 do playbook) ANTES de close-poll — mas o fluxo manual
  // nunca chamava, deixando data/intentional-errors.jsonl sem entry pra
  // edições publicadas manualmente (#3210: edição 260709, jsonl pulou direto
  // de 260708 pra 260710). Chamando o sync aqui também garante que TODA
  // publicação — automática ou manual, presente ou futura — sincroniza,
  // fechando o gap "o passo inteiro nunca roda" em vez de só cobrir falha
  // transiente de I/O (que sync-intentional-error.ts já cobria). Idempotente
  // (no-op se o playbook automático já sincronizou) e fail-soft (mesma
  // filosofia de beehiiv-playbook.md §0.1 — nunca bloqueia close-poll).
  //
  // Nota: `runSyncIntentionalError` documenta/garante "nunca lança" (captura
  // suas próprias exceções e retorna exitCode!=0) — o try/catch aqui é
  // defesa em profundidade contra uma regressão futura nesse contrato, não
  // um caminho que se espera exercitar hoje. Também nunca escreve em stdout
  // (só stderr) — mantém o contrato de "1 linha JSON" do close-poll (#2018)
  // intacto mesmo com o sync rodando no meio da função.
  try {
    const syncResult = runSyncIntentionalError({
      md: resolve(editionDirPath, "02-reviewed.md"),
      edition,
      jsonl: intentionalErrorsJsonlPath,
    });
    if (syncResult.exitCode === 0) {
      console.error(
        `[close-poll] sync-intentional-error ok para edição ${edition} (#3210): added=${syncResult.added} updated=${syncResult.updated}.`,
      );
    } else {
      console.error(
        `[close-poll] aviso (#3210): sync-intentional-error retornou exit ${syncResult.exitCode} para edição ${edition} — não bloqueia close-poll.`,
      );
    }
  } catch (e) {
    console.error(
      `[close-poll] aviso (#3210): sync-intentional-error lançou exceção para edição ${edition}: ${(e as Error).message} — não bloqueia close-poll.`,
    );
  }

  console.error(`[close-poll] Poll da edição ${edition} fechado. Resposta correta: ${answer}. Scores atualizados: ${data.updated_votes ?? 0}`);
  console.error(`[close-poll] Sanity check OK: /stats retornou correct_answer="${stats.correct_answer}". Marker: ${markerPath}`);
  // #2018: stdout JSON — contrato parseable por orchestrators/scripts que capturam stdout.
  console.log(
    JSON.stringify({
      ok: true,
      brand: "diaria",
      edition,
      answer,
      updated_votes: data.updated_votes ?? 0,
      marker_path: markerPath,
      sanity_check: {
        correct_answer: stats.correct_answer,
        correct_count: stats.correct_count ?? 0,
        expected_correct_count: correctCountSanity.expectedCorrectCount,
      },
    }),
  );
}

// #3516: guard de main-module — antes `main()` rodava incondicionalmente em
// QUALQUER import do arquivo (nunca era um problema porque nada importava
// close-poll.ts, só invocava via CLI). `shouldMirrorToWeb` (pure, acima)
// precisa ser importável em teste sem disparar `main()` (que faria parse de
// `process.argv` do processo de TESTE e abortaria com `process.exit(1)` por
// falta de `--edition`). Mesmo padrão de `eia-compose.ts`/outros scripts do
// repo (`isMainModule` de `./lib/cli-args.ts`). Comportamento do CLI real
// (`npx tsx scripts/close-poll.ts ...`) inalterado — `import.meta.url` só
// bate com o entrypoint quando rodado diretamente.
if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
