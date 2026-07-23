/**
 * publish-monthly.ts
 *
 * @deprecated (#2009) Fluxo legado de campanha única. O fluxo canônico
 * multi-campanha usa: clarice-build-edition-sends → clarice-split-cells →
 * clarice-schedule-sends (com close-poll --brand clarice --cycle {cycle}
 * ANTES do --schedule). Este script será removido em release futuro.
 *
 * Cria uma campanha de email Brevo para o digest mensal e envia email de teste.
 *
 * Uso:
 *   npx tsx scripts/publish-monthly.ts --yymm 2604 [flags]
 *
 * Flags:
 *   --yymm                 Mês no formato YYMM (obrigatório)
 *   --list-id N            Override da lista Brevo (sobrepõe platform.config.json → brevo_monthly.list_id)
 *   --send-test            Envia email de teste após criar a campanha
 *   --send-test-to <email> Override do destinatário do test email (default: brevo_monthly.test_email)
 *   --send-now             Dispara campanha IMEDIATAMENTE pra lista (irreversível)
 *   --schedule-at <ISO>    Agenda dispatch pra timestamp futuro (ISO 8601, com timezone)
 *                          Ex: --schedule-at 2026-05-09T12:00:00-03:00
 *   --update-existing N    Atualiza campanha existente (id N) em vez de criar nova
 *   --dry-run              Valida inputs e gera HTML preview local sem chamar a API
 *
 * Mutuamente exclusivos: --send-test, --send-now, --schedule-at.
 *
 * Output: data/monthly/{YYMM}/_internal/05-published.json
 *
 * Pré-requisitos:
 *   - BREVO_CLARICE_API_KEY definido no ambiente (ou .env)
 *   - platform.config.json → brevo_monthly.sender_email preenchido
 *   - list_id resolvido: --list-id N ou brevo_monthly.list_id (CLI tem prioridade)
 *   - data/monthly/{YYMM}/draft.md existente (Etapa 2)
 *
 * #3455: diferente do fluxo canônico (clarice-import-waves.ts /
 * clarice-import-sends.ts, que injetam scripts/lib/editor-copy.ts ->
 * EDITOR_COPY_EMAIL determinística em todo CSV de import), este script
 * dispara pra `recipients: { listIds: [effectiveListId] }` — uma lista Brevo
 * ESTÁTICA já existente na conta (não um CSV montado por este pipeline).
 * Garantir que o editor receba cópia aqui exigiria uma chamada de API contra
 * dados AO VIVO (adicionar contato à lista de produção), fora do escopo de
 * uma mudança só-de-código. Ação manual (1x, se necessário enquanto este
 * script legado não é removido): adicionar EDITOR_COPY_EMAIL
 * (vjpixel@gmail.com) à lista Brevo `brevo_monthly.list_id` via UI.
 */

import { config as dotenvConfig } from "dotenv";
// override: true necessário pois shell pode ter CLOUDFLARE_ACCOUNT_ID=<placeholder> setado,
// e dotenv sem override não sobrescreve vars já existentes no processo.
dotenvConfig({ override: true });
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  parseMonthlyCycleArg,
  isValidMonthlyCycle,
  yymmToCycle,
  cycleToYymm,
  monthlyDir as resolveMonthlyDir,
} from "./lib/mensal/monthly-paths.ts";
import { readEiaAnswerSidecar, aiSideFromAnswer } from "./lib/eia-answer.ts"; // #927
import { parseEiaMeta } from "./lib/schemas/eia-meta.ts"; // #1012
import {
  uploadDestaqueImages as uploadDestaqueImagesDefault,
  uploadEiaImages as uploadEiaImagesDefault,
  uploadLivrosImage as uploadLivrosImageDefault,
} from "./lib/mensal/monthly-image-upload.ts"; // #1914 #1916 #2802
import { fetchMonthlyEiaPrevResultLine as fetchMonthlyEiaPrevResultLineDefault } from "./lib/mensal/monthly-eia-prev-result.ts"; // #2948
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts"; // #3904
// #1844: camada de render (md → HTML do email) extraída pra módulo dedicado.
// main() usa só eiaEditionFromYymm + draftToEmail + parseEiaLegend; o resto vai no re-export.
import {
  eiaEditionFromYymm,
  draftToEmail,
  parseEiaLegend,
  captionForGenerator, // #2018-fix: extraído pra evitar duplicação com monthly-preview-cloudflare
} from "./lib/mensal/monthly-render.ts";
// #1844: cliente HTTP Brevo (transporte) — wrappers que main() usa pra campanha.
import {
  brevoPost,
  brevoGetCampaign,
  brevoGetList,
  brevoPut,
} from "./lib/brevo-client.ts";
// Re-export pra back-compat (publish-monthly.test + -mock-fetch/-integration/-brevo-put importam por nome).
export {
  escHtml,
  stripBackslashEscapes,
  renderInline,
  renderParagraphs,
  renderDestaque,
  renderIntro,
  renderLaboratorio,
  renderClarice,
  renderLinkListSection,
  renderOutrasNoticias,
  eiaEditionFromYymm,
  renderEia,
  normalizeLabel,
  parseHeaderChunk,
  wrapEmail,
  isSectionLabel,
  splitByLabels,
  draftToEmail,
} from "./lib/mensal/monthly-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Types ─────────────────────────────────────────────────────────────────

interface BrevoConfig {
  api_key_env: string;
  list_id: number | null;
  sender_email: string | null;
  sender_name: string;
  test_email: string;
}

interface PlatformConfig {
  newsletter_monthly?: string;
  brevo_monthly?: BrevoConfig;
  image_generator?: string; // #2018: "gemini" | "comfyui" | "cloudflare" | etc.
}

interface MonthlyPublished {
  campaign_id: number;
  campaign_name: string;
  subject: string;
  preview_text: string;
  status: "draft" | "test_sent" | "sent" | "scheduled" | "failed";
  brevo_dashboard_url: string;
  list_id: number;
  list_name: string;
  list_subscribers: number;
  test_email?: string;
  test_sent_at?: string;
  sent_at?: string;
  scheduled_at?: string;       // #1015: agendamento futuro
  updated_existing?: boolean;  // #1015: campanha reusada (não criada nova)
  created_at: string;
  error?: string;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

interface ParsedArgs {
  yymm: string;
  cycle: string;        // ciclo {conteúdo}-{envio} (ex: 2605-06), derivado de yymm se necessário
  sendTest: boolean;
  sendNow: boolean;
  dryRun: boolean;
  listIdOverride: number | null;
  sendTestTo: string | null;       // override do destinatário do test email (#1015)
  scheduleAt: string | null;       // timestamp ISO 8601 pra agendamento (#1015)
  updateExisting: number | null;   // campaign_id pra reusar (#1015)
}

/**
 * Parse args. Aceita `argv` opcional pra testabilidade — em produção usa
 * `process.argv.slice(2)` (CLI). Em testes, pass `["--yymm", "2604", ...]`.
 *
 * Side-effect: chama `process.exit(1)` em casos inválidos. Tests precisam
 * cuidar com try/catch ou interceptar process.exit se testar errors.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  let yymm = "";
  let cycleRaw = "";
  let sendTest = false;
  let sendNow = false;
  let dryRun = false;
  let listIdOverride: number | null = null;
  let sendTestTo: string | null = null;
  let scheduleAt: string | null = null;
  let updateExisting: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yymm" && i + 1 < argv.length) {
      yymm = argv[++i];
    } else if (argv[i] === "--cycle" && i + 1 < argv.length) {
      cycleRaw = argv[++i];
    } else if (argv[i] === "--send-test") {
      sendTest = true;
    } else if (argv[i] === "--send-now") {
      sendNow = true;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--list-id" && i + 1 < argv.length) {
      const raw = argv[++i];
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n <= 0) {
        process.stderr.write(`ERRO: --list-id inválido: "${raw}"\n`);
        process.exit(1);
      }
      listIdOverride = n;
    } else if (argv[i] === "--send-test-to" && i + 1 < argv.length) {
      const raw = argv[++i].trim();
      // Validação básica de email (não hard, só checa que tem @ e .)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        process.stderr.write(`ERRO: --send-test-to inválido: "${raw}"\n`);
        process.exit(1);
      }
      sendTestTo = raw;
    } else if (argv[i] === "--schedule-at" && i + 1 < argv.length) {
      const raw = argv[++i];
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        process.stderr.write(`ERRO: --schedule-at não é ISO 8601 válido: "${raw}"\n`);
        process.exit(1);
      }
      if (d.getTime() <= Date.now()) {
        process.stderr.write(
          `ERRO: --schedule-at deve estar no futuro. Recebido: ${d.toISOString()}, agora: ${new Date().toISOString()}\n`,
        );
        process.exit(1);
      }
      scheduleAt = d.toISOString();
    } else if (argv[i] === "--update-existing" && i + 1 < argv.length) {
      const raw = argv[++i];
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n <= 0) {
        process.stderr.write(`ERRO: --update-existing inválido: "${raw}"\n`);
        process.exit(1);
      }
      updateExisting = n;
    }
  }

  // Aceita --cycle 2605-06 (novo) ou --yymm 2605 (legado).
  // --cycle tem prioridade; --yymm deriva o ciclo com aviso.
  let cycle = "";
  if (cycleRaw && isValidMonthlyCycle(cycleRaw)) {
    cycle = cycleRaw;
    if (!yymm) yymm = cycleToYymm(cycle);
  } else if (yymm && /^\d{4}$/.test(yymm)) {
    cycle = yymmToCycle(yymm);
    process.stderr.write(
      `[publish-monthly] warn: --yymm "${yymm}" é formato legado — ` +
      `derivando ciclo "${cycle}". Use --cycle ${cycle} para suprimir.\n`,
    );
  } else if (!yymm && !cycleRaw) {
    // Nenhum dos dois: tenta parseMonthlyCycleArg com argumento posicional
    const derived = parseMonthlyCycleArg(argv);
    if (derived) {
      cycle = derived;
      yymm = cycleToYymm(cycle);
    }
  }

  if (!yymm || !cycle) {
    process.stderr.write(
      "Uso: publish-monthly.ts --cycle YYMM-MM [--list-id N]\n" +
      "                         [--send-test [--send-test-to <email>]]\n" +
      "                         [--send-now] [--schedule-at <ISO>]\n" +
      "                         [--update-existing <campaign_id>] [--dry-run]\n" +
      "Legado: --yymm YYMM (deriva ciclo automaticamente)\n" +
      "Exemplo: --cycle 2605-06 --list-id 9 --send-test --send-test-to felipe@clarice.ai\n",
    );
    process.exit(1);
  }

  return { yymm, cycle, sendTest, sendNow, dryRun, listIdOverride, sendTestTo, scheduleAt, updateExisting };
}

// #1844: camada de render (escHtml/render*/draftToEmail/parse) → scripts/lib/mensal/monthly-render.ts. Re-export no topo; main() importa.

// ─── Brevo API ─────────────────────────────────────────────────────────────

/**
 * Lê o ai_side do É IA? mensal e pré-registra o gabarito no Worker.
 * Isso permite que o leitor veja o resultado imediatamente ao votar,
 * sem esperar até a próxima edição.
 *
 * Tenta ler de (em ordem):
 *   1. data/monthly/{YYMM}/_internal/01-eia-answer.json — sidecar (#927)
 *   2. data/monthly/{YYMM}/_internal/01-eia-meta.json — campo ai_side
 *   3. data/monthly/{YYMM}/01-eia.md — frontmatter eia_answer
 */
async function registerEiaAnswer(monthlyDir: string, edition: string): Promise<void> {
  const workerUrl = process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL; // #3904
  // #3226: Worker /admin/correct valida sig contra ADMIN_SECRET (workers/poll
  // src/index.ts:325), não POLL_SECRET — mesmo fix aplicado em close-poll.ts
  // (#1176). Aceitar tanto ADMIN_SECRET (canonical) quanto POLL_ADMIN_SECRET
  // (alias usado em alguns ambientes).
  const secret = process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET;
  if (!secret) {
    process.stderr.write("warn: ADMIN_SECRET não definido — gabarito É IA? não pré-registrado\n");
    return;
  }

  // #927: sidecar JSON é canonical (sobrevive Drive round-trip).
  let aiSide: string | null = null;
  const sidecar = readEiaAnswerSidecar(monthlyDir);
  if (sidecar) {
    aiSide = aiSideFromAnswer(sidecar);
  }

  // Fallback 1: ler ai_side de 01-eia-meta.json (schema-validado, #1012)
  if (!aiSide) {
    const metaPath = resolve(monthlyDir, "_internal", "01-eia-meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = parseEiaMeta(JSON.parse(readFileSync(metaPath, "utf8")));
        aiSide = meta.ai_side;
      } catch { /* ignorar — schema drift cai no fallback 2 (frontmatter) */ }
    }
  }

  // Fallback 2: parsear frontmatter de 01-eia.md
  if (!aiSide) {
    const eiaPath = resolve(monthlyDir, "01-eia.md");
    if (existsSync(eiaPath)) {
      const text = readFileSync(eiaPath, "utf8");
      const m = text.match(/^---[\s\S]*?eia_answer:\s*([AB])/m);
      if (m) aiSide = m[1];
    }
  }

  if (!aiSide || !["A", "B"].includes(aiSide)) {
    process.stderr.write("warn: ai_side não encontrado — gabarito É IA? não pré-registrado (leitor verá resultado na próxima edição)\n");
    return;
  }

  // Calcular HMAC admin (mesmo algoritmo de close-poll.ts)
  // #3118 item 8: mensagem assinada inclui o brand ("clarice", sempre, aqui)
  // — mesmo fix espelhado em close-poll.ts e workers/poll/src/index.ts
  // (handleAdminCorrect). Sem o brand na assinatura, um sig gerado aqui
  // também validaria contra o brand=diaria do mesmo Worker.
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", secret).update(`clarice:${edition}:${aiSide}`).digest("hex");
  // #1905: brand=clarice — gabarito do É IA? mensal atualiza o leaderboard da
  // Clarice News (namespace isolado do diário).
  const url = `${workerUrl}/admin/correct?edition=${edition}&answer=${aiSide}&sig=${sig}&brand=clarice`;

  try {
    const res = await fetch(url, { method: "POST" });
    const data = await res.json() as { ok?: boolean; updated_votes?: number };
    if (res.ok && data.ok) {
      process.stdout.write(`Gabarito registrado: É IA? edição ${edition} = ${aiSide} (${data.updated_votes ?? 0} votos retroativos)\n`);
    } else {
      process.stderr.write(`warn: falha ao registrar gabarito: ${JSON.stringify(data)}\n`);
    }
  } catch (e) {
    process.stderr.write(`warn: erro ao registrar gabarito É IA? — ${(e as Error).message}\n`);
  }
}

// #1914: monthlyEiaImageKey extraído pra lib/mensal/monthly-image-upload.ts
// (compartilhado com monthly-preview-cloudflare.ts). Re-export mantém back-compat
// (test/monthly-eia-image-key importa daqui).
// #2802: uploadEiaImages/uploadDestaqueImages/uploadLivrosImage (também da lib) agora
// cobrem todos os uploads deste script — o wrapper local uploadMonthlyImage foi removido
// por ficar sem callers.
export { monthlyEiaImageKey } from "./lib/mensal/monthly-image-upload.ts";

// #1844: cliente Brevo (brevoPost/GetCampaign/GetList/Put) → scripts/lib/brevo-client.ts. main() importa.

// ─── Main ──────────────────────────────────────────────────────────────────

/**
 * Main entrypoint do script.
 *
 * @param monthlyDirOverride Opcional. Default = `data/monthly/{yymm}`.
 *                           Em testes, passar tempdir com fixture controlado
 *                           pra evitar tocar dados reais (#1029).
 * @param uploadDeps Opcional (#2802). Overrides das funções de upload de imagem
 *                    pro KV (lib/mensal/monthly-image-upload.ts). Em testes,
 *                    injetar mocks que retornam URL fake em vez de fazer upload
 *                    real — evita rede real (GUARD DE PUBLICAÇÃO) e permite testar
 *                    a wiring do livrosImageUrl até o draftToEmail sem depender de
 *                    credenciais Cloudflare.
 *                    `fetchEiaPrevResultLine` (#2948) segue o mesmo padrão —
 *                    override opcional pra testar a wiring do "% acertaram"
 *                    sem tocar o Worker poll real.
 */
export async function main(
  monthlyDirOverride?: string,
  uploadDeps: {
    uploadEiaImages: typeof uploadEiaImagesDefault;
    uploadDestaqueImages: typeof uploadDestaqueImagesDefault;
    uploadLivrosImage: typeof uploadLivrosImageDefault;
    fetchEiaPrevResultLine?: typeof fetchMonthlyEiaPrevResultLineDefault;
  } = {
    uploadEiaImages: uploadEiaImagesDefault,
    uploadDestaqueImages: uploadDestaqueImagesDefault,
    uploadLivrosImage: uploadLivrosImageDefault,
  },
): Promise<void> {
  // #2009: aviso de deprecação em runtime — fluxo canônico é multi-campanha.
  process.stderr.write(
    `\n⚠️  DEPRECATED (#2009): publish-monthly.ts é o fluxo legado de campanha única.\n` +
    `   O fluxo canônico é:\n` +
    `     clarice-build-edition-sends → clarice-split-cells → clarice-schedule-sends\n` +
    `   + npx tsx scripts/close-poll.ts --brand clarice --cycle {cycle} --edition {AAMMDD} [--answer A|B]\n` +
    `     (ANTES do clarice-schedule-sends --schedule)\n` +
    `   Este script será removido em release futuro.\n\n`,
  );

  const { yymm, cycle, sendTest, sendNow, dryRun, listIdOverride, sendTestTo, scheduleAt, updateExisting } = parseArgs();

  // #1015: --send-test, --send-now e --schedule-at são 3 ações mutuamente exclusivas.
  const actions = [sendTest && "--send-test", sendNow && "--send-now", scheduleAt && "--schedule-at"].filter(Boolean);
  if (actions.length > 1) {
    process.stderr.write(`ERRO: ${actions.join(", ")} são mutuamente exclusivos.\n`);
    process.exit(1);
  }
  // --send-test-to só faz sentido com --send-test
  if (sendTestTo && !sendTest) {
    process.stderr.write("ERRO: --send-test-to requer --send-test.\n");
    process.exit(1);
  }

  // Load platform config
  const configPath = resolve(ROOT, "platform.config.json");
  const platformConfig: PlatformConfig = JSON.parse(
    readFileSync(configPath, "utf8")
  );

  if (platformConfig.newsletter_monthly !== "brevo") {
    process.stderr.write(
      `newsletter_monthly é "${platformConfig.newsletter_monthly}", esperado "brevo"\n`
    );
    process.exit(1);
  }

  const brevo = platformConfig.brevo_monthly;
  if (!brevo) {
    process.stderr.write(
      "brevo_monthly não configurado em platform.config.json\n"
    );
    process.exit(1);
  }

  // Resolve list_id: CLI override (--list-id) tem prioridade sobre platform.config.json.
  const effectiveListId = listIdOverride ?? brevo.list_id;
  const listSource = listIdOverride !== null ? "--list-id flag" : "platform.config.json";

  if (!dryRun) {
    if (effectiveListId === null) {
      process.stderr.write(
        "ERRO: list_id não definido. Passe --list-id N ou configure brevo_monthly.list_id em platform.config.json.\n"
      );
      process.exit(1);
    }

    if (brevo.sender_email === null) {
      process.stderr.write(
        "ERRO: brevo_monthly.sender_email é null.\n" +
        "Configure o remetente verificado no painel Brevo e preencha sender_email em platform.config.json (#653).\n"
      );
      process.exit(1);
    }
  }

  const apiKeyRaw = process.env[brevo.api_key_env];
  if (!apiKeyRaw && !dryRun) {
    process.stderr.write(
      `ERRO: ${brevo.api_key_env} não está definido no ambiente.\n` +
      `Adicione ao .env: ${brevo.api_key_env}=<chave>\n`
    );
    process.exit(1);
  }
  // After this point we're either dry-run (apiKey unused) or apiKeyRaw is non-empty.
  const apiKey = apiKeyRaw ?? "";

  // Load draft (#1029: monthlyDirOverride permite injetar fixture em testes;
  // #1962: usar resolveMonthlyDir com ciclo pra suportar o novo formato de pasta;
  // #2048 item 2: escrita usa allowLegacyFallback=false — contrato explícito.)
  const monthlyDir = monthlyDirOverride ?? resolveMonthlyDir(cycle, { allowLegacyFallback: false });
  const draftPath = resolve(monthlyDir, "draft.md");

  if (!existsSync(draftPath)) {
    process.stderr.write(
      `draft.md não encontrado: ${draftPath}\n` +
      "Rode a Etapa 2 do /diaria-mensal primeiro.\n"
    );
    process.exit(1);
  }

  const draft = readFileSync(draftPath, "utf8");

  // Load chosen subject if available
  const chosenSubjectPath = resolve(
    monthlyDir,
    "_internal/02-chosen-subject.txt"
  );
  const chosenSubject = existsSync(chosenSubjectPath)
    ? readFileSync(chosenSubjectPath, "utf8").trim()
    : null;

  // Upload É IA? images to Cloudflare KV (Brevo não expõe API de upload de arquivos)
  let eiaImageUrlA: string | undefined;
  let eiaImageUrlB: string | undefined;
  // #1908: a key da imagem usa a edição (último dia do mês) — mesma que a
  // result page do voto monta. Computar antes do upload.
  const eiaEdition = eiaEditionFromYymm(yymm);
  if (!dryRun) {
    try {
      process.stdout.write(`Uploading É IA? images to Cloudflare KV...\n`);
      // #2802: busca com fallback legado extraída pra lib/mensal/monthly-image-upload.ts
      // (compartilhada com monthly-preview-cloudflare.ts — divergência era o bug do #1908).
      const eia = await uploadDeps.uploadEiaImages(monthlyDir, eiaEdition, ROOT);
      eiaImageUrlA = eia.a;
      eiaImageUrlB = eia.b;
      if (eiaImageUrlA) {
        process.stdout.write(`Imagens enviadas:\n  A: ${eiaImageUrlA}\n  B: ${eiaImageUrlB}\n`);
      } else {
        process.stderr.write("warn: imagens É IA? não encontradas — seção sem imagens\n");
      }
    } catch (e) {
      process.stderr.write(`warn: upload de imagens É IA? falhou — ${(e as Error).message}\n`);
    }

    // Pré-registrar gabarito no Worker para resultado imediato ao votar
    await registerEiaAnswer(monthlyDir, eiaEdition);
  }

  // #1916: imagens 2x1 dos destaques (D1/D2/D3) → URLs públicas no KV.
  let destaqueImageUrls: Record<number, string> = {};
  if (!dryRun) {
    try {
      destaqueImageUrls = await uploadDeps.uploadDestaqueImages(monthlyDir, eiaEdition, ROOT);
      const ns = Object.keys(destaqueImageUrls);
      process.stdout.write(ns.length ? `Imagens de destaque enviadas: D${ns.join(", D")}\n` : "warn: sem imagens de destaque (04-d{N}-2x1.jpg)\n");
    } catch (e) {
      process.stderr.write(`warn: upload de imagens de destaque falhou — ${(e as Error).message}\n`);
    }
  }

  // #2802: imagem do box de curadoria de livros (04-livros-promo.jpg) → URL pública no
  // KV, igual ao preview (monthly-preview-cloudflare.ts). Antes só o preview subia essa
  // imagem — o email real publicado via Brevo saía sem ela.
  let livrosImageUrl: string | undefined;
  if (!dryRun) {
    try {
      livrosImageUrl = await uploadDeps.uploadLivrosImage(monthlyDir, eiaEdition, ROOT);
      if (livrosImageUrl) {
        process.stdout.write(`Imagem de livros enviada: ${livrosImageUrl}\n`);
      } else {
        process.stderr.write("warn: 04-livros-promo.jpg ausente — box de livros sem imagem\n");
      }
    } catch (e) {
      process.stderr.write(`warn: upload da imagem de livros falhou — ${(e as Error).message}\n`);
    }
  }

  // #1914: legenda do É IA? vem do 01-eia.md (o draft só tem placeholder).
  const eiaMdPath = resolve(monthlyDir, "01-eia.md");
  const eiaCredit = existsSync(eiaMdPath)
    ? parseEiaLegend(readFileSync(eiaMdPath, "utf8"))
    : undefined;

  // #2018-fix: legenda via helper centralizado (evita duplicação com monthly-preview-cloudflare).
  const destaqueImageCaption = captionForGenerator(platformConfig.image_generator ?? "gemini");

  // #2948: "% acertaram" do É IA? mensal do ciclo anterior (brand=clarice) —
  // suporte de render era opt-in desde #2709, este é o fetch real. Fail-soft:
  // sem ciclo anterior elegível (1ª edição, poll sem votos, abaixo do piso de
  // confiança) → null, e a linha é OMITIDA no render (comportamento já opt-in).
  let eiaPrevResultLine: string | null = null;
  if (!dryRun) {
    const fetchEiaPrevResultLineImpl = uploadDeps.fetchEiaPrevResultLine ?? fetchMonthlyEiaPrevResultLineDefault;
    try {
      eiaPrevResultLine = await fetchEiaPrevResultLineImpl(yymm);
    } catch (e) {
      process.stderr.write(`warn: fetch de "% acertaram" (edição anterior) falhou — ${(e as Error).message}\n`);
    }
  }

  // Convert draft to email
  let { subject, previewText, html } = draftToEmail(draft, chosenSubject, yymm, eiaImageUrlA, eiaImageUrlB, eiaCredit, destaqueImageUrls, destaqueImageCaption, livrosImageUrl, eiaPrevResultLine);

  if (!subject) {
    process.stderr.write(
      "Não foi possível extrair subject do draft.\n" +
      "Verifique a seção ASSUNTO em draft.md ou crie _internal/02-chosen-subject.txt.\n"
    );
    process.exit(1);
  }

  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16);
  let campaignName = `Diar.ia Mensal ${yymm} — ${ts}`;

  // Para `--send-test`: PRÉ-COMPUTA o próximo número, prefixa subject + nome
  // com `[Teste N]`. O write em disco do counter só acontece DEPOIS do sucesso
  // do /sendTest API call (mais abaixo) — assim falhas de API não consomem
  // numbers de teste fantasmas.
  let nextTestNumber = 0;
  if (sendTest && !dryRun) {
    const internalDir = resolve(monthlyDir, "_internal");
    if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });
    const counterPath = resolve(internalDir, "test-counter.txt");
    const current = existsSync(counterPath)
      ? parseInt(readFileSync(counterPath, "utf8").trim(), 10) || 0
      : 0;
    nextTestNumber = current + 1;
    subject = `[Teste ${nextTestNumber}] ${subject}`;
    campaignName = `${campaignName} — Teste ${nextTestNumber}`;
  }

  if (dryRun) {
    const internalDir = resolve(monthlyDir, "_internal");
    if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });
    const previewPath = resolve(internalDir, `preview-list${effectiveListId ?? "default"}.html`);
    writeFileSync(previewPath, html);
    const action = updateExisting !== null
      ? `atualizada (id=${updateExisting})`
      : "criada";
    const dispatchLabel = scheduleAt
      ? `\n  Dispatch: AGENDADO pra ${scheduleAt}`
      : sendNow
      ? "\n  Dispatch: ENVIO IMEDIATO"
      : sendTest
      ? `\n  Dispatch: TEST EMAIL pra ${sendTestTo ?? brevo.test_email}`
      : "\n  Dispatch: nenhum (só draft)";
    process.stdout.write(
      `[DRY RUN] Campanha que seria ${action}:\n` +
      `  Nome:     ${campaignName}\n` +
      `  Assunto:  ${subject}\n` +
      `  Preview:  ${previewText}\n` +
      `  List ID:  ${effectiveListId} (fonte: ${listSource})\n` +
      `  Remetente: ${brevo.sender_name} <${brevo.sender_email}>${dispatchLabel}\n` +
      `  HTML completo: ${previewPath}\n`,
    );
    return;
  }

  // Lookup list metadata para confirmar destinatário antes de criar a campanha (#336).
  const listInfo = await brevoGetList(apiKey, effectiveListId as number);
  process.stdout.write(
    `\nDestinatário:\n` +
    `  List ID:        ${listInfo.id} (fonte: ${listSource})\n` +
    `  Nome da lista:  ${listInfo.name}\n` +
    `  Assinantes:     ${listInfo.totalSubscribers}\n\n`
  );

  // #1015: --update-existing reusa campanha existente (PUT), default cria nova (POST).
  let campaignId: number;
  if (updateExisting !== null) {
    // Pre-check: campanha existe e não está em status terminal (sent).
    // Brevo rejeita update em sent campaigns, mas mensagem nativa é confusa.
    const existing = await brevoGetCampaign(apiKey, updateExisting);
    const TERMINAL_STATUSES = new Set(["sent", "archive"]);
    if (TERMINAL_STATUSES.has(existing.status)) {
      process.stderr.write(
        `ERRO: campanha ${updateExisting} está em status "${existing.status}" e não pode ser atualizada.\n` +
        `Crie uma campanha nova (omitir --update-existing) ou use uma diferente.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `Campanha ${updateExisting} encontrada (status: ${existing.status}). Prosseguindo com PUT.\n`,
    );

    await brevoPut(apiKey, `/emailCampaigns/${updateExisting}`, {
      name: campaignName,
      subject,
      previewText,
      sender: {
        name: brevo.sender_name,
        email: brevo.sender_email,
      },
      recipients: { listIds: [effectiveListId] },
      htmlContent: html,
    });
    campaignId = updateExisting;
    process.stdout.write(`Campanha atualizada: id=${campaignId} (--update-existing)\n`);
  } else {
    const campaignResp = await brevoPost(apiKey, "/emailCampaigns", {
      name: campaignName,
      subject,
      previewText,
      sender: {
        name: brevo.sender_name,
        email: brevo.sender_email,
      },
      recipients: { listIds: [effectiveListId] },
      htmlContent: html,
    }) as Record<string, unknown>;

    if (typeof campaignResp.id !== "number") {
      throw new Error(
        `Brevo API retornou resposta inesperada (sem campo 'id'): ${JSON.stringify(campaignResp)}`
      );
    }
    campaignId = campaignResp.id;
    process.stdout.write(`Campanha criada: id=${campaignId}\n`);
  }
  const dashboardUrl = `https://app.brevo.com/campaign/email/${campaignId}/edit`;
  process.stdout.write(`Dashboard: ${dashboardUrl}\n`);

  const published: MonthlyPublished = {
    campaign_id: campaignId,
    campaign_name: campaignName,
    subject,
    preview_text: previewText,
    status: "draft",
    brevo_dashboard_url: dashboardUrl,
    updated_existing: updateExisting !== null ? true : undefined,
    list_id: listInfo.id,
    list_name: listInfo.name,
    list_subscribers: listInfo.totalSubscribers,
    created_at: new Date().toISOString(),
  };

  // Send test email — destinatário pode ser overrideado via --send-test-to (#1015)
  if (sendTest) {
    const testRecipient = sendTestTo ?? brevo.test_email;
    await brevoPost(apiKey, `/emailCampaigns/${campaignId}/sendTest`, {
      emailTo: [testRecipient],
    });

    // Counter só persiste após sucesso do /sendTest — evita "queimar" números
    // se a API falhar (rate limit, sender unverified, etc.).
    if (nextTestNumber > 0) {
      const counterPath = resolve(monthlyDir, "_internal/test-counter.txt");
      writeFileSync(counterPath, String(nextTestNumber));
    }

    published.status = "test_sent";
    published.test_email = testRecipient;
    published.test_sent_at = new Date().toISOString();

    const sourceLabel = sendTestTo ? "--send-test-to flag" : "platform.config.json";
    process.stdout.write(
      `Email de teste enviado para: ${testRecipient} (fonte: ${sourceLabel})\n`,
    );
  }

  // Send campaign now (real dispatch para a lista)
  if (sendNow) {
    await brevoPost(apiKey, `/emailCampaigns/${campaignId}/sendNow`, {});
    published.status = "sent";
    published.sent_at = new Date().toISOString();
    process.stdout.write(
      `Campanha disparada para lista ${listInfo.id} ("${listInfo.name}", ${listInfo.totalSubscribers} assinante${listInfo.totalSubscribers === 1 ? "" : "s"}).\n`,
    );
  }

  // #1015: agenda dispatch futuro via PUT /emailCampaigns/{id} { scheduledAt }
  if (scheduleAt) {
    await brevoPut(apiKey, `/emailCampaigns/${campaignId}`, {
      scheduledAt: scheduleAt,
    });
    published.status = "scheduled";
    published.scheduled_at = scheduleAt;
    const localTime = new Date(scheduleAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    process.stdout.write(
      `Campanha agendada pra ${scheduleAt} (BRT: ${localTime}) → lista ${listInfo.id} ("${listInfo.name}", ${listInfo.totalSubscribers} assinantes).\n`,
    );
  }

  // Save output
  const internalDir = resolve(monthlyDir, "_internal");
  if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });

  const outputPath = resolve(internalDir, "05-published.json");
  writeFileSync(outputPath, JSON.stringify(published, null, 2) + "\n");

  process.stdout.write(`Output salvo: ${outputPath}\n`);
}

// Guard: só roda main() quando invocado como CLI (não em import de test).
// Pattern: import.meta.url vs file:// do argv[1] (entrypoint Node).
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
