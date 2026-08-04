#!/usr/bin/env node
/**
 * scripts/publish-monthly-apoiadores-brevo.ts (#4593, Passo 2 da skill
 * `/diaria-mensal-apoiadores`)
 *
 * Publisher FINO sobre `brevo-client.ts` pro canal Brevo dos apoiadores
 * Mantenedor/Patrono (`platform.config.json` → `brevo_apoiadores`) — espelha
 * a ESTRUTURA (auth via `api_key_env`, guard de rascunho, `emailCampaigns`
 * API) de `scripts/publish-daily-brevo.ts`, que a issue #4593 pede como
 * referência de transporte. NÃO generaliza aquele script — reusa só o
 * PADRÃO (guards + `brevoPost("/emailCampaigns", ...)`), não sua lógica de
 * cap diário/token de voto opaco (que é específica do segmento Pending
 * `brevo_diaria`, #4266/#4517 — os apoiadores são contatos JÁ IDENTIFICADOS
 * na lista dedicada, não anônimos, então o merge tag de voto pode ser o
 * e-mail cru do contato, `{{ contact.EMAIL }}` — mesmo padrão que
 * `CLARICE_UTM_PROFILE` já usa pro envio mensal Clarice regular).
 *
 * Substitui o Passo 2 (Publicar) antigo do SKILL.md, que era só instrução
 * textual de paste manual no Custom HTML block da Beehiiv (#4482/#4521) —
 * canal abandonado por bloqueio de plano (#4572).
 *
 * ## Pipeline
 *
 *   1. `renderMonthlyApoiadoresBrevoEmail(cycle)` (via `deps.renderEmail`,
 *      injetável pra teste — `render-monthly-apoiadores-brevo.ts`) monta o
 *      HTML final (filtro Clarice-only + UTM próprio + relink pra edição
 *      diária de origem), a partir do MESMO `draft.md` que a skill já usa.
 *   2. Guards de pré-condição (`checkApoiadoresBrevoGuards`) fora de
 *      `--dry-run`: `brevo_apoiadores` configurado, `list_id` NÃO-null
 *      (pré-requisito real ainda pendente — ver #4572/#4593: a lista
 *      dedicada ainda não foi criada na conta Brevo do editor),
 *      `sender_email` preenchido, API key no ambiente.
 *   3. Cria a campanha Brevo (`POST /emailCampaigns`) — SEM `--send-now`/
 *      `--schedule-at`: fica como RASCUNHO na conta Brevo, mesma cautela do
 *      publisher mensal legado (`publish-monthly.ts`) e do publisher diário
 *      Brevo (`publish-daily-brevo.ts`) — nunca agenda/envia sozinho. A
 *      confirmação final (test email, Audience/Schedule) é SEMPRE ação
 *      manual do editor no painel Brevo.
 *
 * Exit codes: 1 uso/erro fatal genérico; 2 guard de config/list_id/sender/
 * API key ausente OU guard de idempotência (campanha já criada/ciclo já
 * enviado) barrando fora de `--dry-run`.
 *
 * ## Idempotência Passo 1 ↔ Passo 2 (#4572/#4593, fecha o "Gap conhecido")
 *
 * Antes desta unidade, este script criava a campanha Brevo sem consultar nem
 * gravar `data/monthly/{ciclo}/_internal/beehiiv-apoiadores-state.json`
 * (mesmo state file do Passo 1/Passo 3, `scripts/lib/mensal/monthly-apoiadores-state.ts`)
 * — rodar o Passo 2 2x pro mesmo ciclo criava DOIS rascunhos duplicados na
 * Brevo. Agora, fora de `--dry-run`, `main()` lê o state ANTES de criar a
 * campanha (`decidePublishBrevoAction`): se já existe `brevoCampaignId`
 * gravado pra este ciclo, ou o ciclo já foi marcado `sent`, aborta com
 * exit(2) — `--force` ignora os dois guards. Depois de criar a campanha com
 * sucesso, grava o `brevoCampaignId` de volta no state
 * (`buildApoiadoresBrevoPublishedState`), fechando o laço. `--dry-run` nunca
 * toca o state (nem lê nem grava) — só o Passo 2 real cria/consulta o
 * registro.
 *
 * Uso:
 *   npx tsx scripts/publish-monthly-apoiadores-brevo.ts --cycle 2607-08 --dry-run
 *   npx tsx scripts/publish-monthly-apoiadores-brevo.ts --cycle 2607-08
 *   npx tsx scripts/publish-monthly-apoiadores-brevo.ts --cycle 2607-08 --force  # ignora idempotência
 *
 * `--dry-run`: monta o HTML/assunto/preview e imprime o que SERIA criado,
 * sem chamar a API Brevo — não exige `list_id`/`sender_email`/API key
 * preenchidos (mesmo contrato de `publish-daily-brevo.ts --dry-run`), nem
 * consulta o state de idempotência.
 *
 * PRÉ-REQUISITO REAL (documentado, não resolvido nesta unidade, #4572/#4593):
 * `platform.config.json` → `brevo_apoiadores.list_id` continua `null` — a
 * lista dedicada ainda não foi criada na conta Brevo do editor. Rodar este
 * script fora de `--dry-run` sem isso ABORTA de forma clara (exit 2), nunca
 * tenta criar a campanha com uma lista inexistente.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { requireMonthlyCycleArg, monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { brevoPost } from "./lib/brevo-client.ts";
import { renderMonthlyApoiadoresBrevoEmail, type RenderedMonthlyApoiadoresBrevoEmail } from "./render-monthly-apoiadores-brevo.ts";
import {
  readApoiadoresState,
  writeApoiadoresState,
  decidePublishBrevoAction,
  buildApoiadoresBrevoPublishedState,
  type ApoiadoresState,
} from "./lib/mensal/monthly-apoiadores-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BrevoApoiadoresPublishConfig {
  api_key_env: string;
  list_id: number | null;
  sender_email?: string | null;
  sender_name?: string | null;
}
interface PlatformConfig {
  brevo_apoiadores?: BrevoApoiadoresPublishConfig;
}

// ── conteúdo pronto pra virar campanha (formato mínimo, desacoplado de I/O) ─

export type ApoiadoresBrevoEmailContent = Pick<RenderedMonthlyApoiadoresBrevoEmail, "subject" | "previewText" | "html">;

// ── guards de pré-condição fora de --dry-run (puro) ───────────────────────

export type PreflightGuardCheck = { ok: true } | { ok: false; reason: string };

/**
 * Pura — os 4 guards de pré-condição pra rodar fora de `--dry-run`. Mesma
 * disciplina de `checkBrevoDiariaGuards` (`publish-daily-brevo.ts`): mensagem
 * explícita/didática por campo ausente, em vez de deixar a falha estourar
 * como exceção genérica da API Brevo no meio do fluxo. Roda ANTES do render
 * (`renderMonthlyApoiadoresBrevoEmail`, que toca `data/monthly/` real) — por
 * isso é 100% testável sem fixture de ciclo/draft.md.
 */
export function checkApoiadoresBrevoGuards(params: {
  dryRun: boolean;
  config: BrevoApoiadoresPublishConfig | undefined;
  apiKey: string | undefined;
}): PreflightGuardCheck {
  const { dryRun, config, apiKey } = params;
  if (!config) {
    return { ok: false, reason: "brevo_apoiadores não configurado em platform.config.json." };
  }
  if (!dryRun && config.list_id == null) {
    return {
      ok: false,
      reason:
        "brevo_apoiadores.list_id não definido em platform.config.json — a lista dedicada aos apoiadores " +
        "Mantenedor/Patrono ainda não foi criada na conta Brevo do editor (pré-requisito real do #4572/#4593, " +
        "mesmo bloqueio de scripts/sync-apoio-nivel-brevo.ts --push). Crie a lista na Brevo, grave o list_id " +
        "aqui, e rode de novo.",
    };
  }
  if (!dryRun && !config.sender_email) {
    return { ok: false, reason: "brevo_apoiadores.sender_email não definido em platform.config.json." };
  }
  if (!dryRun && !apiKey) {
    return { ok: false, reason: `${config?.api_key_env ?? "a env var de API key"} não definido no ambiente.` };
  }
  return { ok: true };
}

// ── montagem + criação da campanha (puro/quase-puro, mockável em teste) ────

/**
 * Pura — monta o body de `POST /emailCampaigns`. SEMPRE sem `scheduledAt`/
 * flag de envio: a campanha resultante é SEMPRE rascunho — mesma cautela de
 * `publish-daily-brevo.ts`/`publish-monthly.ts` (nunca agenda/envia sozinho).
 */
export function buildApoiadoresBrevoCampaignBody(
  content: ApoiadoresBrevoEmailContent,
  config: Pick<BrevoApoiadoresPublishConfig, "sender_email" | "sender_name">,
  listId: number,
  campaignName: string,
): Record<string, unknown> {
  return {
    name: campaignName,
    subject: content.subject,
    previewText: content.previewText,
    sender: { name: config.sender_name ?? "diar.ia.br", email: config.sender_email },
    recipients: { listIds: [listId] },
    htmlContent: content.html,
  };
}

/** Nome da campanha na conta Brevo — inclui o ciclo pra rastreabilidade (diferente do
 * publisher diário, que não tem ciclo — só timestamp). */
export function buildApoiadoresBrevoCampaignName(cycle: string): string {
  return `diar.ia.br mensal apoiadores — ${cycle}`;
}

/**
 * Cria a campanha na Brevo (`POST /emailCampaigns`) e valida a resposta —
 * lança se a API não devolver um `id` numérico (mesmo guard de
 * `publish-daily-brevo.ts`). Nunca passa `scheduledAt`/dispara envio — a
 * campanha criada aqui é SEMPRE rascunho.
 */
export async function createApoiadoresBrevoCampaign(
  apiKey: string,
  config: BrevoApoiadoresPublishConfig,
  content: ApoiadoresBrevoEmailContent,
  cycle: string,
): Promise<{ id: number }> {
  // Achado do self-review (#4593): `main()` já valida `list_id` não-null via
  // `checkApoiadoresBrevoGuards` antes de chegar aqui, mas essa função é
  // exportada — reforça o mesmo invariante localmente, pra não depender só
  // da disciplina do único call site atual.
  if (config.list_id == null) {
    throw new Error("createApoiadoresBrevoCampaign: config.list_id é null — rode checkApoiadoresBrevoGuards antes.");
  }
  const body = buildApoiadoresBrevoCampaignBody(content, config, config.list_id, buildApoiadoresBrevoCampaignName(cycle));
  const resp = (await brevoPost(apiKey, "/emailCampaigns", body)) as Record<string, unknown>;
  if (typeof resp.id !== "number") {
    throw new Error(`Brevo API retornou resposta inesperada (sem campo 'id'): ${JSON.stringify(resp)}`);
  }
  return { id: resp.id };
}

// ── main ─────────────────────────────────────────────────────────────────

export interface ApoiadoresBrevoDeps {
  /** Injetável pra teste — produção sempre chama `renderMonthlyApoiadoresBrevoEmail(cycle)`
   * de verdade (toca `data/monthly/` real, não fixture-ável — mesma limitação já aceita por
   * `test/render-monthly-beehiiv.test.ts`/`test/send-monthly-apoiadores.test.ts`). */
  renderEmail: (cycle: string) => RenderedMonthlyApoiadoresBrevoEmail;
  /** Injetável pra teste (#4572/#4593 — guard de idempotência) — produção sempre chama
   * `readApoiadoresState`/`writeApoiadoresState` de verdade, que resolvem contra
   * `data/monthly/` real via `monthlyDir(cycle)` (mesma limitação de fixture do `renderEmail`
   * acima — `monthlyDir()` não aceita um root override). */
  readState: (monthlyDirPath: string) => ApoiadoresState | null;
  writeState: (monthlyDirPath: string, state: ApoiadoresState) => void;
}

const defaultDeps: ApoiadoresBrevoDeps = {
  renderEmail: renderMonthlyApoiadoresBrevoEmail,
  readState: readApoiadoresState,
  writeState: writeApoiadoresState,
};

/**
 * @param rootDirOverride Opcional. Default = raiz do repo. Em testes, passar
 *   tempdir com `platform.config.json` fixture (mesmo padrão de
 *   `publish-daily-brevo.ts::main(rootDirOverride)`, #4532).
 * @param deps Opcional. Injeta `renderEmail`/`readState`/`writeState` em
 *   teste pra não depender de `data/monthly/` real (`monthlyDir()` resolve
 *   sempre contra o repo real, não é fixture-ável — ver docstring de
 *   `ApoiadoresBrevoDeps`).
 */
export async function main(rootDirOverride?: string, deps: ApoiadoresBrevoDeps = defaultDeps): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const force = hasFlag(argv, "force");
  const cycle = requireMonthlyCycleArg(argv);
  const log = (msg: string) => process.stderr.write(`[publish-monthly-apoiadores-brevo] ${msg}\n`);

  const platformConfigPath = resolve(rootDir, "platform.config.json");
  const platformConfig = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as PlatformConfig)
    : {};
  const config = platformConfig.brevo_apoiadores;
  const apiKey = config ? process.env[config.api_key_env] : undefined;

  const guardCheck = checkApoiadoresBrevoGuards({ dryRun, config, apiKey });
  if (!guardCheck.ok) {
    log(`ERRO: ${guardCheck.reason}`);
    process.exit(2);
    return;
  }

  // #4572/#4593 — guard de idempotência Passo 1 ↔ Passo 2 (fecha o "Gap
  // conhecido" do SKILL.md): fora de --dry-run, recusa criar uma 2ª campanha
  // Brevo pro mesmo ciclo (ver decidePublishBrevoAction). --dry-run nunca
  // toca o state (nem lê nem grava) — é só preview local.
  const dir = monthlyDir(cycle);
  const existingState = dryRun ? null : deps.readState(dir);
  if (!dryRun) {
    const publishDecision = decidePublishBrevoAction(existingState, force);
    if (publishDecision.action === "blocked") {
      log(`ERRO: ${publishDecision.reason}`);
      process.exit(2);
      return;
    }
  }

  const rendered = deps.renderEmail(cycle);
  const content: ApoiadoresBrevoEmailContent = { subject: rendered.subject, previewText: rendered.previewText, html: rendered.html };

  if (dryRun) {
    // `deps.renderEmail` (renderMonthlyApoiadoresBrevoEmail em produção) já
    // escreveu o HTML local em `rendered.htmlPath` — dry-run aqui só reporta
    // o que SERIA criado na Brevo, sem escrever uma 2ª cópia nem chamar a API.
    log(`[DRY RUN] HTML já escrito em ${rendered.htmlPath}`);
    log(`  Assunto: ${content.subject}`);
    log(`  Preview: ${content.previewText}`);
    log(
      `  Campanha que SERIA criada: nome="${buildApoiadoresBrevoCampaignName(cycle)}", ` +
        `list_id=${config?.list_id ?? "(não configurado)"}, sender=${config?.sender_email ?? "(não configurado)"}`,
    );
    return;
  }

  const campaign = await createApoiadoresBrevoCampaign(apiKey!, config!, content, cycle);
  log(
    `campanha criada: id=${campaign.id} (rascunho — schedule/send é ação manual separada no painel Brevo, ` +
      "mesma cautela de publish-daily-brevo.ts/publish-monthly.ts).",
  );

  // #4572/#4593 — grava o brevoCampaignId de volta no state, fechando o laço
  // de idempotência: a próxima invocação pra este ciclo verá `decidePublishBrevoAction`
  // bloquear sem --force (guard acima).
  deps.writeState(
    dir,
    buildApoiadoresBrevoPublishedState(existingState, cycle, new Date().toISOString(), rendered.htmlPath, content.subject, campaign.id),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[publish-monthly-apoiadores-brevo] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
