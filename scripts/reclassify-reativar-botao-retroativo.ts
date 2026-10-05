#!/usr/bin/env node
/**
 * scripts/reclassify-reativar-botao-retroativo.ts (#9663 item 3)
 *
 * Reclassifica no store local (`data/brevo-diaria/contacts.json`) os contatos
 * `self_confirmed_kit` que confirmaram pelo botão da reativação Brevo mas
 * ficaram sem `self_confirmed_kit_botao` porque o custom field
 * `confirmou_via` não existia no Kit (#9663). Fonte: Brevo
 * `GET /v3/contacts/{email}/campaignStats` (links clicados por campanha).
 * Lógica pura em `scripts/lib/reativar-botao-retroativo.ts`.
 *
 * **DRY-RUN POR PADRÃO.** Sem `--apply` só imprime o que mudaria — não grava
 * nada. Com `--apply`, grava SÓ o store local; nunca escreve na Brevo nem no
 * Kit (a Brevo é só lida). Não rodar em paralelo com `evaluate-brevo-diaria.ts`
 * (os dois escrevem o mesmo store).
 *
 * Uso:
 *   npx tsx scripts/reclassify-reativar-botao-retroativo.ts [--since AAAA-MM-DD]            # dry-run
 *   npx tsx scripts/reclassify-reativar-botao-retroativo.ts [--since AAAA-MM-DD] --apply    # grava o store
 *
 * `--since` (default 2026-09-16, primeiro dia do token assinado #8194): só
 * contatos com `promoted_at` a partir dessa data. A Brevo só aceita janela de
 * até 90 dias no `campaignStats`; a janela é recortada por contato.
 *
 * Env: `platform.config.json → brevo_diaria.api_key_env` (BREVO_DIARIA_API_KEY).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { brevoGet } from "./lib/brevo-client.ts";
import { readStore, writeStore, DEFAULT_STORE_PATH } from "./lib/brevo-diaria-store.ts";
import {
  selectRetroCandidates,
  findReativarClickBefore,
  campaignStatsWindow,
  applyRetroBotaoReclassification,
  type BrevoContactCampaignStats,
} from "./lib/reativar-botao-retroativo.ts";
import type { BrevoDiariaStore } from "./lib/brevo-diaria-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SINCE = "2026-09-16";

export interface RetroDeps {
  store: BrevoDiariaStore;
  since: string;
  /** GET read-only do `campaignStats`; `null` = contato não existe na Brevo (404). */
  fetchStats: (email: string, startDate: string, endDate: string) => Promise<BrevoContactCampaignStats | null>;
  log: (msg: string) => void;
}

export interface RetroOutcome {
  candidates: number;
  matched: Array<{ email: string; clickedAt: string; url: string }>;
  notFound: string[];
  errors: Array<{ email: string; error: string }>;
}

/** Varre os candidatos e decide quem reclassificar. Não grava nada. */
export async function planRetroReclassification(deps: RetroDeps): Promise<RetroOutcome> {
  const candidates = selectRetroCandidates(deps.store, deps.since);
  const out: RetroOutcome = { candidates: candidates.length, matched: [], notFound: [], errors: [] };
  for (const c of candidates) {
    const { startDate, endDate } = campaignStatsWindow(c.added_at, c.promoted_at!);
    try {
      const stats = await deps.fetchStats(c.email, startDate, endDate);
      if (stats === null) {
        out.notFound.push(c.email);
        continue;
      }
      const click = findReativarClickBefore(stats, c.promoted_at!);
      if (click) out.matched.push({ email: c.email, clickedAt: click.eventTime, url: click.url });
    } catch (e) {
      // Erro de leitura NÃO vira "não clicou": fica listado à parte, e o
      // contato simplesmente não é reclassificado nesta rodada.
      out.errors.push({ email: c.email, error: (e as Error).message });
    }
  }
  return out;
}

function parseSince(argv: string[]): string {
  const i = argv.indexOf("--since");
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (v === undefined) return DEFAULT_SINCE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since precisa ser AAAA-MM-DD (recebido: ${v})`);
  return v;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const since = parseSince(argv);
  const log = (msg: string) => process.stderr.write(`[reclassify-reativar-botao] ${msg}\n`);

  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    brevo_diaria?: { api_key_env?: string };
  };
  const envName = cfg.brevo_diaria?.api_key_env;
  const apiKey = envName ? process.env[envName] : undefined;
  if (!apiKey) {
    log(`ERRO: ${envName ?? "brevo_diaria.api_key_env"} não definido.`);
    process.exitCode = 2;
    return;
  }

  const store = readStore(DEFAULT_STORE_PATH);
  const outcome = await planRetroReclassification({
    store,
    since,
    log,
    fetchStats: async (email, startDate, endDate) => {
      const path = `/contacts/${encodeURIComponent(email)}/campaignStats?startDate=${startDate}&endDate=${endDate}`;
      const { status, body } = await brevoGet(apiKey, path);
      if (status === 404) return null;
      return body as BrevoContactCampaignStats;
    },
  });

  log(`${outcome.candidates} candidato(s) self_confirmed_kit desde ${since}.`);
  for (const m of outcome.matched) log(`  botão: ${m.email} — clique em ${m.clickedAt}`);
  if (outcome.notFound.length) log(`${outcome.notFound.length} contato(s) ausente(s) na Brevo (404): ${outcome.notFound.join(", ")}`);
  if (outcome.errors.length) {
    log(`${outcome.errors.length} erro(s) de leitura — NÃO reclassificados:`);
    for (const e of outcome.errors) log(`  ${e.email}: ${e.error}`);
  }

  if (!apply) {
    log(`DRY-RUN: reclassificaria ${outcome.matched.length} contato(s) → self_confirmed_kit_botao. Nada gravado (use --apply).`);
    return;
  }
  const { store: next, changed } = applyRetroBotaoReclassification(
    readStore(DEFAULT_STORE_PATH), // relê: minimiza janela de corrida com outro escritor
    outcome.matched.map((m) => m.email),
  );
  writeStore(next, DEFAULT_STORE_PATH);
  log(`--apply: ${changed} contato(s) reclassificado(s) → self_confirmed_kit_botao em ${DEFAULT_STORE_PATH}.`);
  if (outcome.errors.length) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[reclassify-reativar-botao] erro:", e);
    process.exitCode = 1;
  });
}
