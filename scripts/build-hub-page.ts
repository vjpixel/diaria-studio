/**
 * build-hub-page.ts (#4558 Parte A)
 *
 * Gera o HTML de um hub temático a partir do módulo de conteúdo em
 * `scripts/lib/hubs/{slug}.ts` e escreve um arquivo GERADO — NÃO EDITAR À
 * MÃO — em `workers/arquivo/src/hubs/{slug}.generated.ts`, exportando o HTML
 * como `const` (mesmo padrão de `workers/cursos/src/courses-full.generated.ts`,
 * #4052). O Worker `arquivo` importa esse const estaticamente (bundlado pelo
 * esbuild do Wrangler) — nunca gera HTML em runtime pra um hub.
 *
 * Registry de hubs (`HUB_LOADERS`) fica NESTE arquivo (não em
 * `scripts/lib/hubs/`) porque só o builder precisa enumerar todos os hubs;
 * o Worker só importa o registry PRÓPRIO dele
 * (`workers/arquivo/src/hubs/registry.ts`), escrito à mão e atualizado 1x
 * por hub novo — 2 registries deliberadamente separados, mesma fronteira de
 * `lib/shared/` vs Worker já usada por `titles-cache.json`/`render-archive.ts`.
 *
 * Uso:
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude
 *   npx tsx scripts/build-hub-page.ts --all
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude --check   # renderiza (valida invariantes via HubContent), não escreve
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude --check-facts   # gate de fact-check (#5102), ver abaixo
 *
 * **`--check-facts` (#5060/#5102) — gate de fact-check ANTES de gerar o asset.**
 * Distinto de `--check` (que é sobre a RENDERIZAÇÃO — valida `HubContent`,
 * não escreve o `.generated.ts`). `--check-facts` é sobre o CONTEÚDO — roda
 * `scripts/extract-hub-facts.ts` pra (re)gerar o manifesto em
 * `data/hub-fact-check/{slug}-facts.json` e então:
 *   - se existir `data/hub-fact-check/{slug}-report.json` (o output do agente
 *     `fact-checker mode:hub`, ver `.claude/agents/fact-checker.md`) MAIS
 *     RECENTE que o manifesto (mtime) — o relatório reflete o conteúdo
 *     ATUAL do hub — recalcula `gate.blocked` deterministicamente via
 *     `recomputeHubFactGate()` (#573: nunca confiar no `gate` que o agente
 *     escreveu sem revalidar) e recusa prosseguir (`process.exit(2)`) se
 *     bloqueado (aprovações em `data/hub-fact-check/{slug}-approvals.json`
 *     destravam claim-a-claim);
 *   - se NÃO existir relatório, ou se existir mas estiver desatualizado
 *     (mais antigo que o manifesto — o hub mudou depois do último
 *     fact-check), avisa que o gate de conteúdo não foi verificado e exige
 *     `--skip-fact-check` explícito pra prosseguir mesmo assim (nunca
 *     silencioso).
 * **O que este script NÃO faz:** dispatchar o agente `fact-checker`
 * (`mode: "hub"`) — é um script sem LLM, não tem como rodar um subagente.
 * Isso continua sendo trabalho do orchestrator/skill top-level (ou do
 * editor, manualmente) sobre o manifesto que este passo prepara. Sem essa
 * invocação manual nunca existir um `{slug}-report.json`, então o gate cai
 * sempre no ramo "sem relatório" — que EXIGE `--skip-fact-check` (não é
 * bloqueio silencioso, mas também não é verificação real; ver
 * `.claude/agents/fact-checker.md` seção "Modo hub" pro estado do wiring).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, statSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { runTsx } from "./lib/run-tsx.ts";
import {
  recomputeHubFactGate,
  type HubFactGateClaim,
  type HubFactGateContradiction,
} from "./lib/shared/hub-fact-gate.ts";
import { renderHubPage, type HubContent } from "./lib/shared/hub-page.ts";
import { getAnthropicClaudeHub } from "./lib/hubs/anthropic-claude.ts";
import { getOpenaiChatgptHub } from "./lib/hubs/openai-chatgpt.ts";
import { getGoogleGeminiHub } from "./lib/hubs/google-gemini.ts";
import { getMetaAiHub } from "./lib/hubs/meta-ai.ts";
import { getBrasilRegulacaoHub } from "./lib/hubs/brasil-regulacao.ts";
import { getMercadoTrabalhoHub } from "./lib/hubs/mercado-trabalho.ts";
// #4913 item 1: só o builder (Node-side) enumera todos os hubs pra montar a
// nav "Outros temas" — `scripts/lib/shared/hub-page.ts` NÃO importa
// `HUB_META` diretamente (inverteria a fronteira que a docstring de
// `meta.ts` estabelece; ver nota de `relatedHubs` em `hub-page.ts`).
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Registry completo de hubs — 1 entrada por tema publicado. Adicionar um
 * hub novo: escrever `scripts/lib/hubs/{slug}.ts` (exportando `HubContent`)
 * e uma linha aqui. Exportado (não só usado localmente) pra
 * `test/hub-registry-completeness.test.ts` cruzar contra
 * `workers/arquivo/src/hubs/registry.ts::HUB_REGISTRY` — pega o caso "hub
 * novo entrou aqui, mas ninguém atualizou o registry do Worker" antes de
 * virar 404 em produção (achado do fleet review). */
export const HUB_LOADERS: Record<string, () => HubContent> = {
  "anthropic-claude": getAnthropicClaudeHub,
  "openai-chatgpt": getOpenaiChatgptHub,
  "google-gemini": getGoogleGeminiHub,
  "meta-ai": getMetaAiHub,
  "brasil-regulacao": getBrasilRegulacaoHub,
  "mercado-trabalho": getMercadoTrabalhoHub,
};

function outPathFor(slug: string): string {
  return resolve(ROOT, `workers/arquivo/src/hubs/${slug}.generated.ts`);
}

/** Nome da constante exportada — `HUB_HTML` + slug em SCREAMING_SNAKE_CASE. */
function constNameFor(slug: string): string {
  return `HUB_HTML_${slug.replace(/-/g, "_").toUpperCase()}`;
}

/** Nome da constante de `<lastmod>` exportada — `HUB_LASTMOD` + slug em
 * SCREAMING_SNAKE_CASE (#4909). Vem de graça do mesmo módulo gerado que já
 * carrega o HTML — nenhum registro manual novo. Valor é `hub.updatedDate`
 * (#4911 — NÃO `publishedDate`: `<lastmod>`/`Last-Modified` descrevem quando
 * o conteúdo mudou, o mesmo campo que já alimenta `dateModified` no JSON-LD;
 * ver docstring de `scripts/lib/shared/hub-page.ts`). */
function lastmodConstNameFor(slug: string): string {
  return `HUB_LASTMOD_${slug.replace(/-/g, "_").toUpperCase()}`;
}

export function renderGeneratedModule(slug: string, html: string, updatedDate: string): string {
  const constName = constNameFor(slug);
  const lastmodConstName = lastmodConstNameFor(slug);
  return `/**
 * ${slug}.generated.ts (#4558) — GERADO, NÃO EDITAR À MÃO.
 *
 * Fonte: scripts/lib/hubs/${slug}.ts → scripts/build-hub-page.ts.
 * HTML completo do hub temático "${slug}", servido pelo Worker \`arquivo\`
 * em GET /temas/${slug}. Regenerar:
 *
 *   npx tsx scripts/build-hub-page.ts --hub ${slug}
 *
 * test/hub-page-drift.test.ts garante que este arquivo reflete o conteúdo.
 */
export const ${constName} = ${JSON.stringify(html)};
export const ${lastmodConstName} = ${JSON.stringify(updatedDate)};
`;
}

/** Carrega o `HubContent` completo de um slug — loader do hub (`get{Hub}Hub()`)
 * MAIS o pós-processamento que só o builder pode fazer (#4913 itens 1/3: nav
 * "Outros temas" com os hubs irmãos, própria página excluída — preenchido
 * aqui, não em `get{Hub}Hub()`, porque só quem enumera `HUB_LOADERS` conhece
 * o registry completo). Exportado pra `test/hub-page-drift.test.ts` chamar o
 * MESMO caminho que `buildOne` usa — sem isso o teste de drift comparava o
 * asset committed (COM a nav, escrito por `buildOne`) contra um render fresco
 * que pulava esse pós-processamento (SEM a nav), acusando divergência falsa
 * toda vez que o conteúdo de um hub estivesse correto. */
export function loadHubContent(slug: string): HubContent {
  const loader = HUB_LOADERS[slug];
  if (!loader) {
    throw new Error(`[build-hub-page] hub desconhecido: "${slug}". Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`);
  }
  const baseHub = loader();
  const relatedHubs = HUB_META.filter((m) => m.slug !== slug);
  return { ...baseHub, relatedHubs };
}

function buildOne(slug: string, check: boolean): void {
  if (!HUB_LOADERS[slug]) {
    console.error(`[build-hub-page] hub desconhecido: "${slug}". Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`);
    process.exit(2);
  }
  const hub = loadHubContent(slug);
  const html = renderHubPage(hub);
  const outPath = outPathFor(slug);
  if (check) {
    process.stderr.write(`[build-hub-page] ${slug}: --check, não escreve.\n`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, renderGeneratedModule(slug, html, hub.updatedDate));
  process.stderr.write(`[build-hub-page] ${slug}: escrito em ${outPath}\n`);
  console.log(outPath);
}

// ---------------------------------------------------------------------------
// --check-facts (#5060/#5102) — gate de fact-check ANTES de gerar o asset.
// Ver docstring do topo do arquivo pra semântica completa.
// ---------------------------------------------------------------------------

/** Default `data/hub-fact-check` (produção); testável via `--fact-check-dir`
 * (só usado por testes — aponta pra um dir temporário e nunca toca o
 * `data/` real, que numa máquina local é a junction OneDrive, #495-adjacent:
 * nada aqui deveria escrever em `data/` durante um test run). */
function factCheckDataDir(override?: string): string {
  return override ? resolve(ROOT, override) : resolve(ROOT, "data/hub-fact-check");
}

/** Manifesto de `extract-hub-facts.ts` — input do agente `fact-checker
 * mode:hub` (`hub_facts_path`, ver `.claude/agents/fact-checker.md`). Nome
 * canônico: nenhum outro caller escreve nesse path hoje, então fixar aqui é
 * o que estabelece a convenção pro resto do wiring (dispatch do agente, que
 * segue fora do escopo deste script — ver docstring do topo). */
function factManifestPath(slug: string, dataDir: string): string {
  return resolve(dataDir, `${slug}-facts.json`);
}

/** Output do agente `fact-checker mode:hub` (`out_path`, mesma convenção já
 * fixada em `.claude/agents/fact-checker.md`). */
function factReportPath(slug: string, dataDir: string): string {
  return resolve(dataDir, `${slug}-report.json`);
}

/** Aprovações explícitas do editor (`approvals_path`, mesma convenção já
 * fixada em `.claude/agents/fact-checker.md`). */
function factApprovalsPath(slug: string, dataDir: string): string {
  return resolve(dataDir, `${slug}-approvals.json`);
}

interface HubFactCheckReportFile {
  claims?: HubFactGateClaim[];
  contradictions?: HubFactGateContradiction[];
}

interface HubFactCheckApprovalsFile {
  approved_claim_ids?: string[];
}

export type HubFactCheckDecision =
  | { action: "proceed" }
  | { action: "warn_and_proceed"; reason: "no_report" | "stale_report" }
  | { action: "abort_missing_verification"; reason: "no_report" | "stale_report" }
  | { action: "abort_blocked"; blockingItems: string[] };

/**
 * Decide o que `--check-facts` faz com o resultado do gate — pure, sem I/O,
 * testável isoladamente (o caller resolve `reportExists`/`reportIsFresh` via
 * filesystem antes de chamar isto; ver `runFactCheckGate`).
 *
 * - Sem relatório, ou relatório mais antigo que o manifesto atual (hub
 *   mudou depois do último fact-check) → `warn_and_proceed` só se
 *   `skipFactCheck`; senão `abort_missing_verification` (nunca silencioso —
 *   #5102, item explícito do briefing).
 * - Relatório fresco → recalcula `gate.blocked` via `recomputeHubFactGate`
 *   (#573, nunca confiar no `gate` que o agente escreveu) → `abort_blocked`
 *   se bloqueado, `proceed` senão.
 */
export function decideHubFactCheckGate(input: {
  reportExists: boolean;
  reportIsFresh: boolean;
  claims: HubFactGateClaim[];
  contradictions: HubFactGateContradiction[];
  approvedClaimIds: string[];
  skipFactCheck: boolean;
}): HubFactCheckDecision {
  if (!input.reportExists || !input.reportIsFresh) {
    const reason = input.reportExists ? "stale_report" : "no_report";
    return input.skipFactCheck ? { action: "warn_and_proceed", reason } : { action: "abort_missing_verification", reason };
  }
  const gate = recomputeHubFactGate(input.claims, input.contradictions, input.approvedClaimIds);
  if (gate.blocked) return { action: "abort_blocked", blockingItems: gate.blocking_items };
  return { action: "proceed" };
}

/** Aplica a decisão de `decideHubFactCheckGate`: imprime a mensagem
 * apropriada em stderr e — para os 2 ramos `abort_*` — `process.exit(2)`
 * (mesmo padrão de saída de `buildOne`/`checkHubFacts`, #5102 briefing).
 * Separado de `decideHubFactCheckGate` pra manter a decisão pura testável
 * sem precisar mockar `process.exit`. */
export function reportFactCheckDecision(
  slug: string,
  decision: HubFactCheckDecision,
  manifestPath: string,
  reportPath: string,
  approvalsPath: string,
): void {
  const staleness =
    "reason" in decision
      ? decision.reason === "no_report"
        ? `nenhum relatório de fact-check encontrado em ${reportPath}`
        : `relatório de fact-check em ${reportPath} está desatualizado (mais antigo que o conteúdo atual do hub)`
      : "";
  switch (decision.action) {
    case "proceed":
      process.stderr.write(`[build-hub-page] ${slug}: --check-facts OK — relatório fresco, gate.blocked=false.\n`);
      return;
    case "warn_and_proceed":
      process.stderr.write(
        `[build-hub-page] ${slug}: AVISO — ${staleness}. Gate de conteúdo NÃO verificado. Rode o fact-checker (mode:hub) sobre ${manifestPath} antes de publicar. Prosseguindo por causa de --skip-fact-check.\n`,
      );
      return;
    case "abort_missing_verification":
      process.stderr.write(
        `[build-hub-page] ${slug}: ${staleness}. Gate de conteúdo NÃO verificado — rode o fact-checker (mode:hub) sobre ${manifestPath}, ou passe --skip-fact-check pra prosseguir mesmo assim (nunca faça isso silenciosamente).\n`,
      );
      process.exit(2);
      return; // unreachable — mantém o switch exaustivo pro TS
    case "abort_blocked":
      process.stderr.write(
        `[build-hub-page] ${slug}: gate de fact-check BLOQUEADO — ${decision.blockingItems.join(", ")}. Aprove explicitamente via ${approvalsPath} (approved_claim_ids) ou corrija o conteúdo antes de publicar.\n`,
      );
      process.exit(2);
      return;
  }
}

/**
 * `--check-facts`: (a) roda `extract-hub-facts.ts` via subprocess
 * (`runTsx` — NÃO import direto de `extract-hub-facts.ts`: esse módulo já
 * importa `HUB_LOADERS`/`loadHubContent` DESTE arquivo, um import direto de
 * volta criaria um ciclo de módulo real; subprocess é o mesmo caminho que
 * `.claude/agents/fact-checker.md` já documenta como a invocação canônica),
 * (b) lê o relatório existente (se houver) e decide via `decideHubFactCheckGate`,
 * (c) aplica a decisão via `reportFactCheckDecision` (pode `process.exit(2)`).
 */
function runFactCheckGate(slug: string, skipFactCheck: boolean, dataDirOverride?: string): void {
  const dataDir = factCheckDataDir(dataDirOverride);
  mkdirSync(dataDir, { recursive: true });

  const manifestPath = factManifestPath(slug, dataDir);
  runTsx(resolve(ROOT, "scripts/extract-hub-facts.ts"), ["--hub", slug, "--out", manifestPath], {
    cwd: ROOT,
    stdout: "ignore",
  });
  const manifestMtimeMs = statSync(manifestPath).mtimeMs;

  const reportPath = factReportPath(slug, dataDir);
  const reportExists = existsSync(reportPath);
  let claims: HubFactGateClaim[] = [];
  let contradictions: HubFactGateContradiction[] = [];
  let reportIsFresh = false;
  if (reportExists) {
    reportIsFresh = statSync(reportPath).mtimeMs > manifestMtimeMs;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as HubFactCheckReportFile;
    claims = report.claims ?? [];
    contradictions = report.contradictions ?? [];
  }

  const approvalsPath = factApprovalsPath(slug, dataDir);
  let approvedClaimIds: string[] = [];
  if (existsSync(approvalsPath)) {
    const approvals = JSON.parse(readFileSync(approvalsPath, "utf8")) as HubFactCheckApprovalsFile;
    approvedClaimIds = approvals.approved_claim_ids ?? [];
  }

  const decision = decideHubFactCheckGate({ reportExists, reportIsFresh, claims, contradictions, approvedClaimIds, skipFactCheck });
  reportFactCheckDecision(slug, decision, manifestPath, reportPath, approvalsPath);
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const checkFacts = argv.includes("--check-facts");
  const skipFactCheck = argv.includes("--skip-fact-check");
  const all = argv.includes("--all");
  const hubIdx = argv.indexOf("--hub");
  const hub = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;
  // Só pra testes (test/build-hub-page-fact-check-5102.test.ts) — aponta o
  // gate de `--check-facts` pra um dir temporário em vez de `data/hub-fact-check`
  // real. Não documentado no --uso público de propósito (não é fluxo editorial).
  const factCheckDirIdx = argv.indexOf("--fact-check-dir");
  const factCheckDirOverride = factCheckDirIdx >= 0 ? argv[factCheckDirIdx + 1] : undefined;

  if (!all && !hub) {
    console.error("[build-hub-page] uso: --hub <slug> ou --all");
    process.exit(2);
  }

  const slugs = all ? Object.keys(HUB_LOADERS) : [hub as string];
  for (const slug of slugs) {
    if (checkFacts) runFactCheckGate(slug, skipFactCheck, factCheckDirOverride);
    buildOne(slug, check);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
