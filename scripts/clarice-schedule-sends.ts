#!/usr/bin/env node
/**
 * clarice-schedule-sends.ts (#2775 cutover — bloco 1 A/B/C + blocos seguintes assunto único)
 *
 * Cria e agenda as campanhas Brevo do plano de envio de um ciclo de rampa:
 *   - bloco "célula" (default: bloco 1): 3 campanhas/dia (células A/B/C, teste de assunto)
 *   - demais blocos: 1 campanha/dia (assunto único = vencedor A/B/C, via --subject)
 *
 * #2775: lê `sends-summary.json` (via `loadSendsSummary`, `scripts/lib/send-plan.ts`)
 * em vez do array `SENDS` hardcoded — o número de blocos/dias e os horários vêm
 * do plano de envio do ciclo (`send-plan.json`), não mais fixos no código.
 * `--weeks` funciona como alias retrocompat de `--blocks` (mesmo parser
 * compartilhado, `parseBlocksArg`). Qual bloco recebe o teste A/B/C é
 * configurável via `--cell-block N` (default 1 — preserva o comportamento do
 * ciclo 2605-06, onde só a S1 tinha teste A/B/C).
 *
 * Listas: bloco-célula usa listas-célula do cells-summary.json (clarice-split-cells);
 * demais blocos usam dNN do sends-summary.json (IDs Brevo já importados via
 * clarice-import-sends).
 *
 * Fases (cada uma exige flag explícita; default = dry-run que só imprime o plano):
 *   --create         cria as campanhas como RASCUNHO (nada é enviado)
 *   --update-html    re-aplica o HTML render atual nas campanhas em draft
 *                    (pra propagar fix de render pós-create)
 *   --send-test      manda test email do 1º dia do bloco-célula (A/B/C) e do
 *                    1º dia de cada outro bloco pedido, pro test_email
 *   --schedule       agenda TODAS as campanhas criadas (nas datas/horários do plano)
 *                    REQUER que o gabarito É IA? tenha sido setado antes via:
 *                      npx tsx scripts/close-poll.ts --brand clarice --cycle {cycle} --edition {AAMMDD} [--answer A|B]
 *                    Use --skip-eia-guard para pular esta verificação (não recomendado).
 *   --skip-eia-guard pula a verificação de gabarito É IA? no --schedule (ex: após setado manualmente)
 *
 * Flags de escopo:
 *   --blocks 1,2,3   quais blocos processar (default: [--cell-block], ex: [1])
 *   --weeks 1,2,3    alias retrocompat de --blocks (mesmo parser)
 *   --cell-block N   qual bloco recebe o teste A/B/C (default: 1)
 *   --subject "…"    assunto único pros blocos != --cell-block (obrigatório se algum for pedido)
 *
 * Uso típico bloco-célula:
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06                 # plano bloco 1
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --create
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --send-test
 *   # ANTES do --schedule: setar gabarito É IA? (#2009)
 *   npx tsx scripts/close-poll.ts --brand clarice --cycle 2605-06 --edition {AAMMDD} [--answer A|B]
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --schedule
 *
 * Uso típico blocos seguintes (após checkpoint do vencedor A/B/C):
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --blocks 2,3 --subject "Assunto vencedor" # plano
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --blocks 2,3 --subject "Assunto vencedor" --create
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --blocks 2,3 --subject "Assunto vencedor" --send-test
 *   # close-poll já executado no bloco-célula — marker reutilizado automaticamente
 *   npx tsx scripts/clarice-schedule-sends.ts --cycle 2605-06 --blocks 2,3 --subject "Assunto vencedor" --schedule
 *
 * Estado em {ciclo}/sends/cells/campaigns-summary.json (idempotência: --create
 * pula campanhas já criadas; --schedule usa os IDs gravados).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoPut, brevoGetCampaign } from "./lib/brevo-client.ts";
import { clariceCycleDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "./lib/mensal/monthly-paths.ts";
import { loadSendsSummary, parseBlocksArg, type SendsSummaryEntry } from "./lib/send-plan.ts";
import { CELLS } from "./clarice-split-cells.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Assuntos do teste A/B/C da S1 (decisão do editor 2026-06-09; A corrigido — a lei NÃO foi aprovada). */
export const SUBJECTS: Record<string, string> = {
  A: "Notícias do mês sobre IA: marco da IA vai a voto e Brasil ganha unicórnio",
  B: "Notícias do mês sobre IA: Google retoma a liderança na corrida",
  C: "Notícias do mês sobre IA: Agentes tomaram postos de trabalho",
};
export const PREVIEW_TEXT =
  "Marco legal, unicórnio de IA e agentes substituindo equipes: maio foi o mês das decisões.";

/**
 * Retorna o `scheduledAt` (ISO 8601 UTC Z) do envio n (1..N) — lookup em
 * `sends-summary.json` (fonte única do calendário do ciclo, #2775). Guard de
 * range: n fora do conjunto de `sends` lança erro explícito (nunca data
 * silenciosamente errada). (#2007 / #2018 / #2775)
 */
export function scheduledAtFor(sends: SendsSummaryEntry[], n: number): string {
  const total = sends.length;
  if (!Number.isInteger(n) || n < 1 || n > total) {
    throw new Error(`scheduledAtFor: n deve ser inteiro 1..${total}, recebido: ${n}`);
  }
  const send = sends.find((s) => s.n === n);
  if (!send) {
    throw new Error(`scheduledAtFor: n=${n} ausente em sends-summary.json (gap no plano?).`);
  }
  return send.scheduledAt;
}

/**
 * #2101: guard de runtime — lança se scheduledAtFor(n) resultar em data passada/presente.
 * Separa a computação da data (usada no plano informativo, que exibe datas mesmo se passadas)
 * da validação de negócio (usada em --create e --schedule, onde agendar no passado é erro).
 *
 * Caso típico de erro: send-plan.json copiado para o próximo ciclo sem atualizar
 * `scheduledAt` → todas as datas seriam passadas, Brevo recusaria silenciosamente
 * ou agendaria mal.
 *
 * @param sends        Entradas de sends-summary.json (fonte do calendário)
 * @param n            Número do envio
 * @param nowOverride  Clock injetável para testes (default: new Date())
 * @throws se a data computada for <= now
 */
export function assertScheduledAtFuture(sends: SendsSummaryEntry[], n: number, nowOverride?: Date): void {
  const iso = scheduledAtFor(sends, n); // range já validado em scheduledAtFor
  const date = new Date(iso);
  const now = nowOverride ?? new Date();
  if (date <= now) {
    throw new Error(
      `scheduledAtFor: data computada (${iso}) é passado ou presente ` +
      `(now=${now.toISOString()}). ` +
      `send-plan.json do ciclo está desatualizado — atualize scheduledAt ao copiar para o próximo ciclo.`,
    );
  }
}

interface CellEntry { list: string; listId: number; count: number }
// Entrada no campaigns-summary.json; listId é o ID Brevo da lista que recebe a campanha.
interface CampaignEntry {
  key: string; // "d01-A" (bloco-célula) ou "d08" (demais blocos)
  campaignId: number;
  listId: number;
  subject: string;
  scheduledAt: string;
  status: "draft" | "scheduled";
}

/**
 * Calcula o conjunto de chaves de campanha em escopo para os blocos pedidos.
 * Exportado pra testabilidade: --update-html e --schedule devem usar o mesmo conjunto.
 *
 * bloco-célula → chaves "dNN-A", "dNN-B", "dNN-C" (3 campanhas/dia)
 * demais blocos → chaves "dNN" (1 campanha/dia)
 */
export function buildKeysInScope(sends: SendsSummaryEntry[], blocks: number[], cellBlock: number): Set<string> {
  const sendsToProcess = sends.filter((s) => blocks.includes(s.block));
  const keys = new Set<string>();
  for (const s of sendsToProcess) {
    const dNN = `d${String(s.n).padStart(2, "0")}`;
    if (s.block === cellBlock) {
      for (const cell of CELLS) keys.add(`${dNN}-${cell}`);
    } else {
      keys.add(dNN);
    }
  }
  return keys;
}

/**
 * #2018 / regra #573: verifica se o status de campanha retornado pelo GET pós-schedule
 * é "aceito" (agendado de fato no Brevo). Exportado pra testabilidade — o loop
 * de --schedule usa esta lógica, testes mockam o status sem rede.
 *
 * Status aceitos: "queued" (entrou na fila de envio) ou "scheduled" (Brevo usa
 * ambos dependendo da versão de API e do timing do PUT).
 */
export function isScheduledStatus(status: string): boolean {
  return status === "queued" || status === "scheduled";
}

/**
 * #2101: aplica os resultados do Promise.allSettled do GET-verify ao campaigns array.
 * Exportado pra testabilidade — main() delega pra cá; testes injetam resultados mockados.
 *
 * Para cada resultado:
 *   - fulfilled + isScheduledStatus → marca c.status="scheduled" e escreve no disco
 *   - fulfilled + status não aceito → warn, sem escrita (próxima run re-tenta)
 *   - rejected → warn com motivo, sem escrita (próxima run re-tenta)
 *
 * Nunca lança: erros individuais são warns, não exceções globais (sucesso parcial).
 *
 * @param settled    Resultado do Promise.allSettled(...GETs...)
 * @param toVerify   Lista de CampaignEntry na mesma ordem do allSettled
 * @param campaigns  Array mutável de todos os CampaignEntry (para serialização)
 * @param campaignsPath  Caminho do campaigns-summary.json (escrita atômica por sucesso)
 * @param writeFn    Função de escrita (injetável em testes; default: writeFileAtomic)
 * @param logFn      Função de log (injetável em testes; default: console.error)
 */
export function applyVerifyResults(
  settled: PromiseSettledResult<{ status: string }>[],
  toVerify: CampaignEntry[],
  campaigns: CampaignEntry[],
  campaignsPath: string,
  writeFn: (path: string, content: string) => void = (p, c) => writeFileAtomic(p, c),
  logFn: (msg: string) => void = (m) => console.error(m),
): void {
  if (settled.length !== toVerify.length) {
    throw new Error(
      `applyVerifyResults: invariante quebrada — settled.length (${settled.length}) !== toVerify.length (${toVerify.length})`,
    );
  }
  for (let i = 0; i < toVerify.length; i++) {
    const c = toVerify[i];
    const result = settled[i];

    if (result.status === "rejected") {
      logFn(
        `⚠ GET-verify ${c.key} (campanha #${c.campaignId}) falhou: ${String(result.reason)}. ` +
        `Status local NÃO atualizado — re-tente --schedule.`,
      );
      continue;
    }

    const verified = result.value;
    if (!isScheduledStatus(verified.status)) {
      logFn(
        `⚠ GET-verify ${c.key} (campanha #${c.campaignId}): status="${verified.status}" ` +
        `(esperado "queued"/"scheduled" após PUT scheduledAt="${c.scheduledAt}"). ` +
        `Status local NÃO atualizado — re-tente --schedule após checar o Brevo.`,
      );
      continue;
    }

    c.status = "scheduled";
    writeFn(campaignsPath, JSON.stringify(campaigns, null, 2));
    logFn(`✓ ${c.key} agendada → ${c.scheduledAt} (GET-verify: status=${verified.status})`);
  }
}

/**
 * #2009: verifica se o gabarito É IA? foi setado para o ciclo via close-poll
 * --brand clarice. Pura (testável sem rede): só verifica existência do marker.
 *
 * @param cycle           Ciclo no formato {conteúdo}-{envio} (ex: 2605-06)
 * @param skip            Se true, ignora a verificação (--skip-eia-guard)
 * @param markerPathOverride Caminho explícito do marker (para testes)
 *
 * @returns `{ ok: true }` se marker existe ou guard ignorado (skip=true)
 * @returns `{ ok: false; message: string }` se marker ausente e guard ativo
 */
export function checkEiaGuard(
  cycle: string,
  skip: boolean,
  markerPathOverride?: string,
): { ok: true } | { ok: false; message: string } {
  if (skip) return { ok: true };
  let eiaMarkerPath: string;
  if (markerPathOverride !== undefined) {
    eiaMarkerPath = markerPathOverride;
  } else {
    try {
      eiaMarkerPath = resolve(resolveMonthlyDir(cycle), "_internal", ".close-poll-clarice.json");
    } catch (e) {
      return {
        ok: false,
        message: `\n❌  ERRO: ciclo inválido ('${cycle}'): ${(e as Error).message}\n   Formato esperado: YYMM-MM (ex: 2605-06)\n`,
      };
    }
  }
  if (!existsSync(eiaMarkerPath)) {
    return {
      ok: false,
      message:
        `\n❌  ERRO: gabarito É IA? não setado para o ciclo ${cycle}.\n` +
        `   O marker esperado não existe: ${eiaMarkerPath}\n\n` +
        `   Execute ANTES de agendar:\n` +
        `     npx tsx scripts/close-poll.ts --brand clarice --cycle ${cycle} --edition {AAMMDD} [--answer A|B]\n\n` +
        `   (Onde {AAMMDD} é a data do É IA? selecionado para a edição mensal — ex: 260531)\n\n` +
        `   Se o gabarito já foi setado por outro meio, use --skip-eia-guard para pular.\n`,
    };
  }
  return { ok: true };
}

/** Parseia --subject: retorna o valor ou undefined. */
function parseSubjectArg(argv: string[]): string | undefined {
  const idx = argv.indexOf("--subject");
  if (idx === -1) return undefined;
  const val = argv[idx + 1];
  if (!val || val.startsWith("-")) {
    throw new Error(`--subject requer um valor (ex: --subject "Assunto vencedor").`);
  }
  return val;
}

/** Parseia --cell-block N: qual bloco recebe o teste A/B/C (default: 1). */
export function parseCellBlockArg(argv: string[]): number {
  const idx = argv.indexOf("--cell-block");
  if (idx === -1) return 1;
  const val = argv[idx + 1];
  if (!val || val.startsWith("-")) {
    throw new Error(`--cell-block requer um valor (ex: --cell-block 1). Recebido: ${val ?? "(nada)"}`);
  }
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--cell-block deve ser um inteiro >= 1 (recebido: ${val}).`);
  }
  return n;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const doCreate = argv.includes("--create");
  const doUpdateHtml = argv.includes("--update-html");
  const doTest = argv.includes("--send-test");
  const doSchedule = argv.includes("--schedule");
  const skipEiaGuard = argv.includes("--skip-eia-guard");

  const cycleDir = clariceCycleDir(cycle);
  const sendsSummary = loadSendsSummary(cycleDir);
  const validBlocks = [...new Set(sendsSummary.sends.map((s) => s.block))].sort((a, b) => a - b);
  const cellBlock = parseCellBlockArg(argv);
  // default (sem --blocks/--weeks): só o bloco-célula, igual ao comportamento
  // legado do ciclo 2605-06 (default era [1] = S1).
  const blocks = parseBlocksArg(argv, validBlocks, [cellBlock]);
  const subject = parseSubjectArg(argv);

  // Blocos != cellBlock exigem --subject (o vencedor do A/B/C ainda não é conhecido no bloco-célula)
  if (blocks.some((b) => b !== cellBlock) && !subject) {
    throw new Error(`--blocks ${blocks.join(",")} inclui bloco(s) != --cell-block (${cellBlock}): --subject "Assunto vencedor" é obrigatório.`);
  }

  const cellsDir = resolve(cycleDir, "sends", "cells");

  // Carrega cells-summary.json (necessário quando o bloco-célula está em escopo)
  const cellsSummaryPath = resolve(cellsDir, "cells-summary.json");
  const hasCells = existsSync(cellsSummaryPath);
  const listByKey = new Map<string, CellEntry>();
  if (blocks.includes(cellBlock)) {
    if (!hasCells) {
      throw new Error(`cells-summary.json não existe — rode clarice-split-cells.ts --execute antes.`);
    }
    const cells: { label: string; results: CellEntry[] } = JSON.parse(readFileSync(cellsSummaryPath, "utf8"));
    for (const r of cells.results) {
      const m = r.list.match(/d(\d{2})-([ABC])/);
      if (m) listByKey.set(`d${m[1]}-${m[2]}`, r);
    }
  }

  // listId por dia (injetado por clarice-import-sends após importação no Brevo) —
  // necessário pros blocos != cellBlock (assunto único).
  const listByDay = new Map<number, number>(); // n -> listId Brevo
  for (const s of sendsSummary.sends) {
    if (s.listId != null) listByDay.set(s.n, s.listId);
  }
  const nonCellBlocksRequested = blocks.filter((b) => b !== cellBlock);
  if (nonCellBlocksRequested.length > 0) {
    const missingSends = sendsSummary.sends.filter((s) => nonCellBlocksRequested.includes(s.block) && !listByDay.has(s.n));
    if (missingSends.length > 0) {
      const missing = missingSends.map((s) => `d${String(s.n).padStart(2, "0")}`).join(", ");
      throw new Error(`listId ausente p/ ${missing} — rode clarice-import-sends antes (sends-summary.json deve conter listId).`);
    }
  }

  // HTML render para todas as campanhas
  const htmlPath = resolve(resolveMonthlyDir(cycle), "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) throw new Error(`HTML render não existe: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");

  const campaignsPath = resolve(cellsDir, "campaigns-summary.json");
  let campaigns: CampaignEntry[] = [];
  if (existsSync(campaignsPath)) {
    const raw = readFileSync(campaignsPath, "utf8");
    try {
      campaigns = JSON.parse(raw);
    } catch (e) {
      throw new Error(`campaigns-summary.json corrompido (JSON inválido): ${campaignsPath}\n${String(e)}`);
    }
  }
  const byKey = new Map(campaigns.map((c) => [c.key, c]));

  // Monta lista de envios a processar nesta invocação
  const sendsToProcess = sendsSummary.sends.filter((s) => blocks.includes(s.block));

  // --- Plano (sempre imprime) ---
  const cellCount = sendsToProcess.filter((s) => s.block === cellBlock).length * CELLS.length;
  const singleCount = sendsToProcess.filter((s) => s.block !== cellBlock).length;
  const totalCampaigns = cellCount + singleCount;
  console.error(`\n📋 Campanhas blocos ${blocks.join("+")} (bloco-célula=${cellBlock}) — ${totalCampaigns} campanhas`);
  for (const s of sendsToProcess) {
    if (s.block === cellBlock) {
      for (const cell of CELLS) {
        const key = `d${String(s.n).padStart(2, "0")}-${cell}`;
        const entry = listByKey.get(key);
        const existing = byKey.get(key);
        console.error(
          `  ${key} (${s.day} ${scheduledAtFor(sendsSummary.sends, s.n)})  lista #${entry?.listId ?? "?"}  assunto ${cell}` +
            (existing ? `  [campanha #${existing.campaignId} ${existing.status}]` : ""),
        );
      }
    } else {
      const key = `d${String(s.n).padStart(2, "0")}`;
      const listId = listByDay.get(s.n);
      const existing = byKey.get(key);
      console.error(
        `  ${key} (${s.day} ${scheduledAtFor(sendsSummary.sends, s.n)})  lista #${listId ?? "?"}  assunto único` +
          (existing ? `  [campanha #${existing.campaignId} ${existing.status}]` : ""),
      );
    }
  }
  if (!doCreate && !doUpdateHtml && !doTest && !doSchedule) {
    console.error(`\ndry-run — use --create, depois --send-test, depois --schedule.`);
    return;
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const brevo = cfg.brevo_monthly;
  if (!brevo?.sender_email) throw new Error("brevo_monthly.sender_email ausente no platform.config.json");

  // --- create (rascunhos; idempotente) ---
  if (doCreate) {
    for (const s of sendsToProcess) {
      if (s.block === cellBlock) {
        // bloco-célula: 3 campanhas por dia (células A/B/C)
        for (const cell of CELLS) {
          const key = `d${String(s.n).padStart(2, "0")}-${cell}`;
          if (byKey.has(key)) {
            console.error(`↷ ${key} já criada (#${byKey.get(key)!.campaignId}) — pulando`);
            continue;
          }
          assertScheduledAtFuture(sendsSummary.sends, s.n); // #2101: data passada = plano desatualizado
          const entry = listByKey.get(key);
          if (!entry) throw new Error(`lista-célula não encontrada pra ${key}`);
          const resp = (await brevoPost(apiKey, "/emailCampaigns", {
            name: `Clarice News ${cycleToYymm(cycle)} ${key} (${s.day})`,
            subject: SUBJECTS[cell],
            previewText: PREVIEW_TEXT,
            sender: { name: brevo.sender_name, email: brevo.sender_email },
            recipients: { listIds: [entry.listId] },
            htmlContent: html,
          })) as { id?: number };
          if (typeof resp?.id !== "number") throw new Error(`/emailCampaigns shape inesperado: ${JSON.stringify(resp)}`);
          const c: CampaignEntry = {
            key,
            campaignId: resp.id,
            listId: entry.listId,
            subject: SUBJECTS[cell],
            scheduledAt: scheduledAtFor(sendsSummary.sends, s.n),
            status: "draft",
          };
          campaigns.push(c);
          byKey.set(key, c);
          writeFileAtomic(campaignsPath, JSON.stringify(campaigns, null, 2));
          console.error(`✓ ${key} → campanha #${resp.id} (rascunho)`);
        }
      } else {
        // demais blocos: 1 campanha por dia (assunto único = vencedor)
        const key = `d${String(s.n).padStart(2, "0")}`;
        if (byKey.has(key)) {
          console.error(`↷ ${key} já criada (#${byKey.get(key)!.campaignId}) — pulando`);
          continue;
        }
        assertScheduledAtFuture(sendsSummary.sends, s.n); // #2101: data passada = plano desatualizado
        const listId = listByDay.get(s.n);
        if (listId == null) throw new Error(`listId não encontrado pra ${key}`);
        const resp = (await brevoPost(apiKey, "/emailCampaigns", {
          name: `Clarice News ${cycleToYymm(cycle)} ${key} (${s.day})`,
          subject: subject!,
          previewText: PREVIEW_TEXT,
          sender: { name: brevo.sender_name, email: brevo.sender_email },
          recipients: { listIds: [listId] },
          htmlContent: html,
        })) as { id?: number };
        if (typeof resp?.id !== "number") throw new Error(`/emailCampaigns shape inesperado: ${JSON.stringify(resp)}`);
        const c: CampaignEntry = {
          key,
          campaignId: resp.id,
          listId,
          subject: subject!,
          scheduledAt: scheduledAtFor(sendsSummary.sends, s.n),
          status: "draft",
        };
        campaigns.push(c);
        byKey.set(key, c);
        writeFileAtomic(campaignsPath, JSON.stringify(campaigns, null, 2));
        console.error(`✓ ${key} → campanha #${resp.id} (rascunho)`);
      }
    }
  }

  // --- update-html (propaga fix de render pras campanhas em draft dos blocos pedidos) ---
  if (doUpdateHtml) {
    // Aplica o mesmo filtro buildKeysInScope do --schedule: respeita --blocks.
    const updateKeysInScope = buildKeysInScope(sendsSummary.sends, blocks, cellBlock);
    for (const c of campaigns) {
      if (!updateKeysInScope.has(c.key)) continue;
      if (c.status === "scheduled") {
        console.error(`⚠️  ${c.key} já agendada — html NÃO atualizado (desagende primeiro)`);
        continue;
      }
      await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { htmlContent: html });
      console.error(`✓ ${c.key} html atualizado (campanha #${c.campaignId})`);
    }
  }

  // --- send-test (1º dia do bloco-célula em A/B/C; 1º dia de cada outro bloco pedido) ---
  if (doTest) {
    if (blocks.includes(cellBlock)) {
      const firstCellSend = sendsToProcess.filter((s) => s.block === cellBlock).sort((a, b) => a.n - b.n)[0];
      if (!firstCellSend) throw new Error(`bloco-célula ${cellBlock} não tem envios em escopo.`);
      for (const cell of CELLS) {
        const key = `d${String(firstCellSend.n).padStart(2, "0")}-${cell}`;
        const c = byKey.get(key);
        if (!c) throw new Error(`campanha ${key} não criada — rode --create antes.`);
        await brevoPost(apiKey, `/emailCampaigns/${c.campaignId}/sendTest`, { emailTo: [brevo.test_email] });
        console.error(`✓ test email ${key} (campanha #${c.campaignId}) → ${brevo.test_email}`);
      }
    }
    // demais blocos: manda test do primeiro dia de cada bloco pedido
    for (const b of nonCellBlocksRequested) {
      const firstSend = sendsToProcess.filter((s) => s.block === b).sort((a, b2) => a.n - b2.n)[0];
      if (!firstSend) continue;
      const key = `d${String(firstSend.n).padStart(2, "0")}`;
      const c = byKey.get(key);
      if (!c) throw new Error(`campanha ${key} não criada — rode --create antes.`);
      await brevoPost(apiKey, `/emailCampaigns/${c.campaignId}/sendTest`, { emailTo: [brevo.test_email] });
      console.error(`✓ test email ${key} (campanha #${c.campaignId}) → ${brevo.test_email}`);
    }
  }

  // --- schedule (todas as criadas nos blocos pedidos) ---
  if (doSchedule) {
    // #2009: guard — gabarito É IA? deve ser setado antes de agendar os envios.
    // checkEiaGuard verifica marker gravado por close-poll --brand clarice --cycle {cycle}.
    const eiaCheck = checkEiaGuard(cycle, skipEiaGuard, /* markerPathOverride */ undefined);
    if (!eiaCheck.ok) {
      console.error(eiaCheck.message);
      process.exit(1);
    }
    if (!skipEiaGuard) {
      console.error(`✓ Gabarito É IA? verificado`);
    } else {
      console.error(`⚠  --skip-eia-guard ativo — verificação de gabarito É IA? ignorada.`);
    }

    const keysInScope = buildKeysInScope(sendsSummary.sends, blocks, cellBlock);
    // #2061: PUTs sequenciais (ordem importa — Brevo pode ter rate-limit por
    // rajada, e a escrita atômica do campaigns-summary após cada verify precisa
    // do resultado individual). GETs de verify independentes → Promise.all.
    const toVerify: CampaignEntry[] = [];
    for (const c of campaigns) {
      if (!keysInScope.has(c.key)) continue;
      if (c.status === "scheduled") {
        console.error(`↷ ${c.key} já agendada — pulando`);
        continue;
      }
      // #2101: guard simétrico ao --create — scheduledAt passado (herança/edição manual)
      // seria PUTado no Brevo sem validação. Abortar com mensagem clara antes do PUT.
      if (new Date(c.scheduledAt) <= new Date()) {
        throw new Error(
          `--schedule: ${c.key} (campanha #${c.campaignId}) tem scheduledAt no passado/presente ` +
          `(${c.scheduledAt}). Atualize o campaigns-summary.json ou o send-plan.json do ciclo ` +
          `antes de agendar.`,
        );
      }
      await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { scheduledAt: c.scheduledAt });
      toVerify.push(c);
    }

    // #2018 / regra #573 / #2061 / #2101: GET-verify em paralelo pós-PUTs — confirma que
    // o Brevo realmente recebeu o scheduledAt antes de marcar "scheduled" localmente.
    // Brevo pode aceitar PUT 204 mas não persistir em edge cases — divergência logada
    // e flag local NÃO atualizada (próximo --schedule re-tenta).
    //
    // #2101: Promise.allSettled (era Promise.all) — se 1 GET lançar, os demais não
    // são descartados. Delegado a applyVerifyResults (exportado, testável sem rede).
    const verifySettled = await Promise.allSettled(
      toVerify.map((c) => brevoGetCampaign(apiKey, c.campaignId)),
    );
    applyVerifyResults(verifySettled, toVerify, campaigns, campaignsPath);
  }

  console.log(JSON.stringify({ created: campaigns.length, scheduled: campaigns.filter((c) => c.status === "scheduled").length }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
