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
 * além do legado AAMMDD 260531. Ambos funcionam: as chaves KV são opacas.
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
 *   POLL_WORKER_URL    URL base do Worker (default: https://poll.diaria.workers.dev)
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";

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

  // Ler ai_side de 01-eia-meta.json se não foi passado manualmente
  if (!answer) {
    if (brand === "clarice") {
      console.error("[close-poll] --brand clarice requer --answer A|B explícito (fluxo mensal não usa 01-eia-meta.json da edição diária). Use --answer A ou --answer B.");
      process.exit(1);
    }
    // #3031: resolveEditionDir resolve o path REAL da edição (flat ou nested,
    // #3024) em vez de montar data/editions/{edition} à força — que só existe
    // no layout flat legado e some pós-migração pro layout nested.
    const editionDirPath = resolveEditionDir(editionsRootDir, edition);
    const metaPath = resolve(editionDirPath, "_internal", "01-eia-meta.json");
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
  const statsRes = await dohFetch(`${POLL_WORKER_URL}/stats?edition=${edition}${brandQ}`);
  const stats = await statsRes.json() as { correct_answer?: string | null };
  if (!statsRes.ok || stats.correct_answer !== answer) {
    console.error(
      `[close-poll] FATAL: sanity check falhou — /stats retornou correct_answer=${JSON.stringify(stats.correct_answer)} ` +
        `esperado="${answer}". Worker pode ter rejeitado silenciosamente ou retornou stale.`,
    );
    process.exit(1);
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
          sanity_check: { correct_answer: stats.correct_answer },
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
        sanity_check: { correct_answer: stats.correct_answer },
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
      const webData = await webRes.json().catch(() => ({})) as { ok?: boolean };
      if (!webRes.ok || !webData.ok) {
        console.error(`[close-poll] aviso (#3516): mirror --brand web falhou (status ${webRes.status}) para edition=${edition} — não bloqueia close-poll da diária.`);
      } else {
        console.error(`[close-poll] gabarito espelhado pro brand=web (edition=${edition}) — #3516.`);
      }
    } catch (e) {
      console.error(`[close-poll] aviso (#3516): mirror --brand web lançou exceção para edition=${edition}: ${(e as Error).message} — não bloqueia close-poll.`);
    }
  }

  // #3031: mesmo fix do metaPath acima — resolve o path REAL da edição (flat
  // ou nested) em vez de montar data/editions/{edition} à força. Sem isso, o
  // marker era gravado num diretório flat órfão que o resume-check e o
  // Stage 5 §5g (que buscam o marker via resolveEditionDir) nunca encontram.
  const editionDirPath = resolveEditionDir(editionsRootDir, edition);
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
        sanity_check: { correct_answer: stats.correct_answer },
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
      sanity_check: { correct_answer: stats.correct_answer },
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
