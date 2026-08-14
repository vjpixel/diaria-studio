#!/usr/bin/env node
/**
 * scripts/refresh-pending-pool.ts (#5183)
 *
 * O pool de entrada do canal `brevo_diaria` (fila de reativação do segmento
 * Pending da Beehiiv) é um snapshot MANUAL congelado de 260802
 * (`data/pending-reativacao/pending-scored.csv`). Nenhum passo do pipeline
 * trazia pra esse pool os contatos que ficaram Pending DEPOIS daquele dia —
 * eles apareciam na paginação da Beehiiv, mas eram descartados em silêncio
 * antes de virarem candidatos (3 camadas silenciosas, ver issue #5183: o
 * filtro MillionVerifier nunca os via, o guard de cobertura reportava
 * "completo" ignorando-os, e a seleção sem score os jogava pro fim da fila
 * pra sempre). Este script é a ETAPA NOVA, entre o Passo 1
 * (`evaluate-brevo-diaria.ts`) e o Passo 2 (`sync-pending-to-brevo.ts`) de
 * `/diaria-brevo-diaria`, que fecha esse gap.
 *
 * ## Decisões do editor (briefing ao vivo, sessão overnight 260814)
 *
 * 1. **Filtro de origem SparkLoop é OBRIGATÓRIO** — reusa o fingerprint já
 *    validado em `sync-sparkloop-exclusion-segment-beehiiv.ts`
 *    (`RH_SOURCE === "sparkloop-upscribe"`, via `isSparkloopUpscribeSource`).
 *    Contato dessa origem NUNCA entra no pool por este script.
 * 2. **Lane própria, sem competir por score com o pool antigo.** Um contato
 *    novo é marcado `lane: "recency"` (`score-pending-origin.ts::LANE_RECENCY`)
 *    em vez de ganhar um `pts_*`/`score` inventado — cadastro recente e
 *    orgânico é mais "quente" que um contato frio de 2023, mas nunca foi
 *    medido pela mesma fórmula manual, então não é comparável numericamente.
 *    `selectContactsForBackfill` (`sync-pending-to-brevo.ts`) dá prioridade
 *    de fila pra essa lane sem misturar os dois critérios.
 * 3. **Cota/ritmo conservador, sem número do editor.** `DEFAULT_REFRESH_LIMIT`
 *    (25/rodada) — nenhum piso numérico foi dado pelo editor nesta unidade;
 *    valor escolhido por analogia ao mesmo espírito conservador do piso de
 *    retomada de 15% de abertura agregada já documentado no Passo 2 da skill
 *    (`/diaria-brevo-diaria` SKILL.md) — pequeno o bastante pra nunca dominar
 *    uma rodada de backfill (cap normal de 300), overridável via `--limit N`
 *    se o editor quiser ajustar depois de ver os números reais em produção.
 *
 * ## Pipeline (ORDEM FIXA — #5183)
 *
 *   npx tsx scripts/refresh-pending-pool.ts               # dry-run
 *   npx tsx scripts/refresh-pending-pool.ts --push         # append no pool bruto
 *   npx tsx scripts/score-pending-origin.ts                # regenera o computado
 *   npx tsx scripts/verify-pending-emails-mv.ts            # verifica o delta (skip-forever)
 *   # → só então sync-pending-to-brevo.ts enxerga os novos como candidatos
 *
 * Contato novo só é visível pra MillionVerifier depois de entrar no pool —
 * nenhum atalho contorna essa ordem (`sync-pending-to-brevo.ts::computeContactsToIngest`
 * continua exigindo `verifiedEmails.has(email)`, inalterado por esta unidade).
 *
 * ## Diff — 3 fontes de "já conhecido"
 *
 * Um Pending da Beehiiv só é candidato se estiver ausente de TODAS: (a)
 * `pending-scored.csv` (pool bruto), (b) `pending-scored-computed.csv` (pool
 * computado — pode estar um passo à frente do bruto se alguém rodou
 * `score-pending-origin.ts` sem antes rodar este script, ou vice-versa) e
 * (c) o store `data/brevo-diaria/contacts.json` (qualquer status — já foi
 * tratado por este canal, ainda que nunca tenha passado pelo CSV).
 *
 * ## RH_SOURCE/`created` via `expand[]=custom_fields` (#5183)
 *
 * `fetchPendingBeehiivSubscriptions` (`sync-pending-to-brevo.ts`) agora
 * SEMPRE pede `expand[]=custom_fields` e popula `rhSource`/`subscribedOn`
 * (aditivo — não muda paginação nem quebra o consumidor original). O campo
 * `created` (unix epoch segundos) que alimenta `subscribedOn` **nunca foi
 * confirmado contra a API real nesta sessão** (guard de publicação — mesma
 * ressalva já registrada em `sync-sparkloop-exclusion-segment-beehiiv.ts`
 * pro dialeto do endpoint de segmentos): se o campo não existir/tiver outro
 * nome, `subscribedOn` degrada pra `""` sem quebrar nada (só perde a
 * ordenação por recência dentro da lane — `lane`/filtro SparkLoop continuam
 * funcionando normalmente).
 *
 * ## Uso
 *
 *   npx tsx scripts/refresh-pending-pool.ts                    # dry-run (default)
 *   npx tsx scripts/refresh-pending-pool.ts --push              # aplica (append no CSV bruto)
 *   npx tsx scripts/refresh-pending-pool.ts --limit 50           # muda a cota da rodada (default 25)
 *
 * Env: BEEHIIV_API_KEY (leitura — mesma config de `sync-pending-to-brevo.ts`).
 * Este script NUNCA escreve na Beehiiv nem na Brevo — só lê a Beehiiv e
 * grava localmente em `data/pending-reativacao/pending-scored.csv`.
 *
 * Guard de publicação (overnight/develop): nunca executado contra a API real
 * nesta sessão — validado só via testes com `fetchImpl` mockado.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { fetchPendingBeehiivSubscriptions, type BeehiivPendingSubscription } from "./sync-pending-to-brevo.ts";
import { parseLimitArg } from "./verify-pending-emails-mv.ts";
import {
  DEFAULT_INPUT_PATH as RAW_POOL_CSV_PATH,
  DEFAULT_OUTPUT_PATH as COMPUTED_POOL_CSV_PATH,
  RAW_POOL_CSV_FIELDS,
  LANE_RECENCY,
} from "./score-pending-origin.ts";
import { isSparkloopUpscribeSource, RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE } from "./sync-sparkloop-exclusion-segment-beehiiv.ts";
import { readStore, DEFAULT_STORE_PATH } from "./lib/brevo-diaria-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** #5183 decisão 3 — ver header do módulo pro racional (sem número do
 * editor, valor conservador escolhido por analogia). */
export const DEFAULT_REFRESH_LIMIT = 25;

/** Origem gravada em `origem`/pool bruto pra contato ingerido por este
 * script — nunca confundir com uma origem real de campanha (o pool antigo
 * usa nomes como "canal-proprio"); serve só pra auditoria ("de onde veio
 * essa linha"), o `score`/`pts_*` zerados + `lane: "recency"` são o sinal
 * que a seleção de fato usa. */
export const NEW_CONTACT_ORIGIN_LABEL = "beehiiv-pending-recente";

// ── diff puro (3 fontes de "já conhecido") ──────────────────────────────────

/**
 * Pura — quais Pending da Beehiiv ainda NÃO estão em `knownPoolEmails`
 * (união do pool bruto + computado) nem em `knownStoreEmails` (store do
 * canal `brevo_diaria`, qualquer status). Dedup interno da própria página
 * Pending (mesmo padrão de `computeContactsToIngest`).
 */
export function computeNewPoolCandidates(
  pending: readonly BeehiivPendingSubscription[],
  knownPoolEmails: ReadonlySet<string>,
  knownStoreEmails: ReadonlySet<string>,
): BeehiivPendingSubscription[] {
  const seen = new Set<string>();
  const out: BeehiivPendingSubscription[] = [];
  for (const p of pending) {
    if (knownPoolEmails.has(p.email) || knownStoreEmails.has(p.email) || seen.has(p.email)) continue;
    seen.add(p.email);
    out.push(p);
  }
  return out;
}

export interface SparkloopFilterResult {
  kept: BeehiivPendingSubscription[];
  excluded: BeehiivPendingSubscription[];
}

/** Pura (#5183 decisão 1) — separa candidatos de origem SparkLoop Upscribe
 * (NUNCA entram no pool) dos demais. Reusa o mesmo fingerprint validado em
 * `sync-sparkloop-exclusion-segment-beehiiv.ts` — não reimplementa. */
export function filterOutSparkloop(candidates: readonly BeehiivPendingSubscription[]): SparkloopFilterResult {
  const kept: BeehiivPendingSubscription[] = [];
  const excluded: BeehiivPendingSubscription[] = [];
  for (const c of candidates) {
    (isSparkloopUpscribeSource(c.rhSource) ? excluded : kept).push(c);
  }
  return { kept, excluded };
}

/** Pura — corta a lista de candidatos elegíveis na cota da rodada (#5183
 * decisão 3). `limit` já resolvido (flag ou `DEFAULT_REFRESH_LIMIT`) —
 * nunca negativo no resultado. */
export function applyRefreshLimit<T>(candidates: readonly T[], limit: number): T[] {
  return candidates.slice(0, Math.max(0, limit));
}

/** Pura — monta a linha nova pro pool BRUTO (`RAW_POOL_CSV_FIELDS`,
 * `pending-scored.csv` — nomenclatura `origem`, não `origin`, ver header do
 * módulo de `score-pending-origin.ts`). `score`/`pts_*` zerados passam
 * trivialmente na checagem de consistência de `parseScoredRow` (soma 0 bate
 * com score 0) — `lane: LANE_RECENCY` é o sinal real que a seleção usa. */
export function buildNewPoolRow(candidate: BeehiivPendingSubscription): Record<string, string> {
  return {
    email: candidate.email,
    origem: NEW_CONTACT_ORIGIN_LABEL,
    score: "0",
    pts_confirmacao: "0",
    pts_ativo: "0",
    pts_abertura: "0",
    pts_clique: "0",
    pts_recencia: "0",
    penalidade_bounce: "0",
    lane: LANE_RECENCY,
    subscribed_on: candidate.subscribedOn,
  };
}

/**
 * Pura — faz APPEND de `newRows` ao texto CSV do pool bruto, preservando
 * TODAS as linhas/valores existentes intactos (round-trip via Papa.parse
 * mantém os valores como STRING, sem reformatar números — nunca altera o
 * conteúdo que o editor digitou manualmente, só acrescenta linhas/colunas
 * novas). Se o header existente não tiver `lane`/`subscribed_on`, as duas
 * colunas são acrescentadas (linhas antigas recebem `""` automaticamente —
 * comportamento padrão do Papa.unparse pra chave ausente num objeto de
 * dados). CSV vazio/ausente (1ª vez rodando este script, sem pool manual
 * ainda) → cria o arquivo do zero com `RAW_POOL_CSV_FIELDS`. Lança se o CSV
 * existente estiver malformado — nunca faz append sobre um arquivo que não
 * dá pra ler de volta com segurança.
 */
export function appendRowsToPoolCsv(csvText: string, newRows: readonly Record<string, string>[]): string {
  // newline:"\n" explícito nos dois ramos abaixo — Papa.unparse usa "\r\n"
  // por default; sem forçar consistência com o "\n" final que este função
  // sempre acrescenta, a última linha real e o terminador de arquivo usam
  // convenções DIFERENTES e um re-parse (Papa.parse auto-detecta "\r\n" pelas
  // linhas anteriores) engole o "\n" isolado como parte do último campo em
  // vez de tratá-lo como fim de linha (achado ao vivo escrevendo o teste
  // desta unidade, #5183).
  if (csvText.trim() === "") {
    return Papa.unparse({ fields: [...RAW_POOL_CSV_FIELDS], data: newRows as Record<string, string>[] }, { newline: "\n" }) + "\n";
  }
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
  if (parsed.errors.length > 0) {
    throw new Error(`pool CSV malformado — não é seguro fazer append: ${JSON.stringify(parsed.errors.slice(0, 3))}`);
  }
  const existingFields = parsed.meta.fields && parsed.meta.fields.length > 0 ? parsed.meta.fields : [...RAW_POOL_CSV_FIELDS];
  const fields = existingFields.includes("lane") ? existingFields : [...existingFields, "lane", "subscribed_on"];
  const rows = [...parsed.data, ...(newRows as Record<string, string>[])];
  return Papa.unparse({ fields, data: rows }, { newline: "\n" }) + "\n";
}

/** I/O — lê só a coluna `email` de um CSV do pool (bruto OU computado —
 * ambos têm coluna `email`). Fail-soft: arquivo ausente/malformado →
 * conjunto vazio (nunca lança — pool ainda não existe nesta máquina é um
 * estado normal, não um erro). */
export function readPoolEmailColumn(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const csvText = readFileSync(path, "utf8");
    const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
    const set = new Set<string>();
    for (const row of parsed.data) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (email) set.add(email);
    }
    return set;
  } catch {
    return new Set();
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[refresh-pending-pool] ${msg}\n`);

  let limitArg: number | undefined;
  try {
    limitArg = parseLimitArg(argv);
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(2);
  }
  const limit = limitArg ?? DEFAULT_REFRESH_LIMIT;

  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[refresh-pending-pool]");

  log("buscando assinantes Pending na Beehiiv…");
  const pending = await fetchPendingBeehiivSubscriptions(publicationId, beehiivApiKey);
  log(`${pending.length} assinante(s) Pending encontrado(s) na Beehiiv.`);

  const knownPoolEmails = new Set<string>([
    ...readPoolEmailColumn(RAW_POOL_CSV_PATH),
    ...readPoolEmailColumn(COMPUTED_POOL_CSV_PATH),
  ]);
  const store = readStore(DEFAULT_STORE_PATH);
  const knownStoreEmails = new Set(store.contacts.map((c) => c.email));

  const newCandidates = computeNewPoolCandidates(pending, knownPoolEmails, knownStoreEmails);
  log(`${newCandidates.length} contato(s) Pending FORA do pool (bruto+computado) e do store — candidato(s) a entrar.`);

  const { kept, excluded } = filterOutSparkloop(newCandidates);
  // #5183 self-review: sempre loga a contagem de exclusão SparkLoop (mesmo
  // 0) — o critério de aceite pede "quantos seriam excluídos", e "0" é uma
  // resposta tão informativa quanto qualquer outro número (silenciar esse
  // caso deixaria o operador sem saber se o filtro rodou).
  log(`${excluded.length} excluído(s) por origem SparkLoop Upscribe (RH_SOURCE="${RH_SOURCE_SPARKLOOP_UPSCRIBE_VALUE}") — nunca entram no pool (#5183 decisão 1).`);

  const selected = applyRefreshLimit(kept, limit);
  log(
    `${selected.length} de ${kept.length} elegível(is) selecionado(s) nesta rodada (cota ${limit}` +
      (limitArg === undefined ? `, default DEFAULT_REFRESH_LIMIT=${DEFAULT_REFRESH_LIMIT} — use --limit N pra mudar` : "") +
      ").",
  );

  if (!push) {
    // #5183 self-review: lista TODOS os elegíveis (`kept`), não só os
    // dentro da cota (`selected`) — o critério de aceite pede que o dry-run
    // liste "N Pending fora do pool, com origem e data" (o N total, não só
    // o que cabe na rodada); a marca "(dentro da cota)"/"(além da cota)"
    // deixa claro o que de fato seria adicionado num `--push` agora.
    const selectedEmails = new Set(selected.map((c) => c.email));
    for (const c of kept) {
      const cotaMark = selectedEmails.has(c.email) ? "dentro da cota" : "além da cota";
      log(`  + ${c.email} (RH_SOURCE="${c.rhSource || "(vazio)"}", subscribed_on=${c.subscribedOn || "(desconhecido)"}, ${cotaMark})`);
    }
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar.");
    return;
  }

  if (selected.length === 0) {
    log("nenhum contato novo a adicionar — nada a fazer.");
    return;
  }

  const rows = selected.map(buildNewPoolRow);
  const currentCsv = existsSync(RAW_POOL_CSV_PATH) ? readFileSync(RAW_POOL_CSV_PATH, "utf8") : "";
  let nextCsv: string;
  try {
    nextCsv = appendRowsToPoolCsv(currentCsv, rows);
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(RAW_POOL_CSV_PATH, nextCsv, "utf8");
  log(
    `${selected.length} contato(s) adicionado(s) a ${RAW_POOL_CSV_PATH}. ` +
      "Próximo passo OBRIGATÓRIO: rode scripts/score-pending-origin.ts e scripts/verify-pending-emails-mv.ts " +
      "antes de sync-pending-to-brevo.ts (ver .claude/skills/diaria-brevo-diaria/SKILL.md).",
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[refresh-pending-pool] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
