#!/usr/bin/env node
/**
 * scripts/check-site-page-pr-gate.ts (#10160)
 *
 * Trava do fim da Etapa 6 no merge do PR da página do site.
 *
 * ## Por que existe
 *
 * Desde o #10160 o PR da página (`publish-edition-site-page.ts`) é aberto no
 * INÍCIO da Etapa 5 (§5b-site, `--no-wait-merge`) e o dispatch segue sem
 * esperar o merge — CI (~12min) e review andam em paralelo com newsletter,
 * social e Brevo/Kit. O merge passou a ser pré-requisito do FIM da Etapa 6:
 * sem ele, `/p/{slug}` (link de WhatsApp do e-mail) dá 404 no envio.
 *
 * Este script é a checagem determinística (#573 — nunca a prosa do agente)
 * que o Stage 6 roda duas vezes: antes do gate único (§6b-site, `--wait-ms 0`,
 * só pra mostrar o estado no gate) e logo antes do Schedule (§6c-site,
 * `--wait-ms 540000`, a trava). O invariante `site-page-pr-merged`
 * (`STAGE_6_RULES`, bloqueante) fecha o mesmo buraco no sentinel
 * `.step-6-done.json`, caso o passo seja pulado — inclusive o caso de página
 * DEFASADA com PR já mergeado (#10207: mesma `sitePageStaleness`, em
 * `scripts/lib/site-page-staleness.ts`). Pra o invariante não acusar uma
 * página publicada com `--slug` explícito, esta trava grava o
 * `--expected-slug` recebido em `expectedSlug` no state file.
 *
 * ## O que faz
 *
 * Lê `_internal/site-page-published.json` e consulta o PR ao vivo com a MESMA
 * lógica de merge do publisher (`waitAndMergeSitePagePr` — `gh pr view` +
 * `evaluatePrChecksGate`, merge `--squash --match-head-commit` sob o merge
 * lock da máquina):
 *
 *   - `MERGED` → segue (exit 0);
 *   - `OPEN` com CI verde → mergeia agora (regra do #5251) e segue (exit 0);
 *   - CI ainda rodando no fim da janela → exit 3 (re-rodar; nunca "ok");
 *   - CI vermelho, conflito, PR fechado, `gh pr merge` falho → exit 1 (halt);
 *   - `gh pr view` falhou → exit 2 (halt — desconhecido NUNCA vira mergeado);
 *   - sem PR registrado (state ausente/ilegível, `published≠true`, sem
 *     `prUrl`) → exit 4 (rodar o fallback de publicação do §6b-site);
 *   - página DEFASADA (#10190) → exit 5 (rodar o fallback de publicação e
 *     repetir): o slug registrado (`state.slug`) difere do slug esperado
 *     (`--expected-slug`, ou `seoSlug` do título do D1 atual em
 *     `02-reviewed.md` — o link de WhatsApp do e-mail), ou os insumos da
 *     página mudaram desde a publicação (`state.sourceDigest` ≠
 *     `sitePageSourceDigest` atual). Vale MESMO com o PR já mergeado: o
 *     §5b-site congela slug e conteúdo no início da Etapa 5, e o loop de fix
 *     do §5f / `kit-draft-fresh` (#9428) podem mudar o D1 depois — o e-mail
 *     sairia apontando pra `/p/{slug-novo}` com a página em `/p/{slug-velho}`.
 *
 * ## Bypass (#10191)
 *
 * `--bypass-reason "<motivo>"`: qualquer veredito ≠ `merged` vira `bypassed`
 * (exit 0) e fica registrado em `prGateBypass` no state file — o invariante
 * `site-page-pr-merged`/`site-page-published` lê esse registro e rebaixa a
 * violação pra `warning`, então o sentinel da Etapa 6 não exige um 2º bypass.
 * Serve pro caso em que a newsletter não pode deixar de sair por causa da
 * página (CI vermelho alheio à página, guard de merge tag `code: 5` que o
 * fallback não resolve, `--no-gates` sem editor pra responder `retry`). A
 * trava da #10160 continua sendo o default: sem a flag, nada muda. Uma
 * republicação posterior reescreve o state e apaga o bypass (nova tentativa).
 *
 * #10196: bypass de `stale`/`no-pr` é IRRECUPERÁVEL sozinho. O waiter em
 * background (#9593) só mergeia o PR do slug que ele conhece — com `stale` a
 * página no PR é a do slug/conteúdo VELHO (e o `stale` sai antes de qualquer
 * tentativa de merge), com `no-pr` não há PR nenhum. A premissa "o waiter
 * segue tentando até as 06:00" só vale pra `pending`/`blocked`. Nesses dois
 * casos o bypass grava `unrecoverable: true` em `prGateBypass`, loga nível
 * `error` e dispara `notifyEditor` urgente: o `/p/{slug}` do e-mail pode
 * nunca existir sem ação humana.
 *
 * Merge feito aqui é gravado no state file (`merged: true`, `status:
 * "merged"`, `mergeBlocker` limpo) — mesma função do waiter
 * (`applyMergeWaiterResult`), rótulo próprio.
 *
 * ## Uso
 *
 *   npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR}
 *   npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR} --wait-ms 540000
 *   npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR} --expected-slug {slug}
 *   npx tsx scripts/check-site-page-pr-gate.ts --edition-dir {EDITION_DIR} --bypass-reason "<motivo>"
 *
 * ## Guard de publicação
 *
 * Mergeia o PR da página do site (artefato gerado, isento de review — ver
 * `docs/site-page-publish-mechanism.md`) e nada mais. Nunca toca Beehiiv/Kit/
 * redes sociais.
 */
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { readSitePageState } from "./check-site-page-merge.ts";
import { notifyEditor, type NotifyEditorFinding } from "./lib/editor-notify.ts";
import { logEvent, type RunLogEvent } from "./lib/run-log.ts";
import { SITE_PAGE_EXPECTED_SLUG_FIELD, sitePageStaleness } from "./lib/site-page-staleness.ts";
import {
  applyMergeWaiterResult,
  defaultGhRunner,
  deriveSlugFromD1,
  makeSessionRegistryMergeLock,
  parsePrNumberFromUrl,
  sitePageSourceDigest,
  waitAndMergeSitePagePr,
  type GhRunner,
  type MergeAttemptResult,
  type SitePageMergeLock,
  type SleepFn,
} from "./publish-edition-site-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Teto da trava pré-Schedule: abaixo dos 10min de um Bash foreground do harness. */
export const SITE_PAGE_PR_GATE_MAX_WAIT_MS = 540_000;
export const SITE_PAGE_PR_GATE_POLL_MS = 15_000;

type UnmergedVerdict =
  | { kind: "pending"; prNumber: number; reason: string }
  | { kind: "blocked"; prNumber: number; reason: string }
  | { kind: "cannot-verify"; prNumber: number; reason: string }
  | { kind: "no-pr"; reason: string }
  | { kind: "stale"; prNumber?: number; reason: string };

export type SitePagePrGateVerdict =
  | { kind: "merged"; prNumber: number; reason: string }
  | UnmergedVerdict
  | { kind: "bypassed"; bypassReason: string; bypassed: UnmergedVerdict; unrecoverable?: true };

/**
 * #10196: veredito cujo bypass deixa o link do e-mail sem página até alguém
 * agir — nenhum waiter vai mergear a página certa sozinho. Ver docstring.
 */
export function isUnrecoverableBypass(v: UnmergedVerdict): boolean {
  return v.kind === "stale" || v.kind === "no-pr";
}

/** Exit code de cada veredito — ver docstring do módulo. */
export function exitCodeForVerdict(v: SitePagePrGateVerdict): number {
  switch (v.kind) {
    case "merged":
    case "bypassed":
      return 0;
    case "blocked":
      return 1;
    case "cannot-verify":
      return 2;
    case "pending":
      return 3;
    case "no-pr":
      return 4;
    case "stale":
      return 5;
  }
}

/**
 * Pura: classifica o desfecho de `waitAndMergeSitePagePr`. `ghError` (estado
 * desconhecido) e `timedOut` (CI pendente) são os únicos não-mergeados que
 * NÃO são bloqueio definitivo.
 */
export function classifyMergeAttempt(prNumber: number, attempt: MergeAttemptResult): SitePagePrGateVerdict {
  if (attempt.merged) return { kind: "merged", prNumber, reason: attempt.reason };
  if (attempt.ghError) return { kind: "cannot-verify", prNumber, reason: attempt.reason };
  if (attempt.timedOut) return { kind: "pending", prNumber, reason: attempt.reason };
  return { kind: "blocked", prNumber, reason: attempt.reason };
}

/**
 * #10190, pura — vive em `scripts/lib/site-page-staleness.ts` desde o #10207
 * (o invariante `site-page-pr-merged` usa a mesma função). Re-exportada aqui
 * pra manter a superfície pública da trava.
 */
export { sitePageStaleness };

export interface SitePagePrGateDeps {
  gh?: GhRunner;
  sleep?: SleepFn;
  mergeLock?: SitePageMergeLock;
  waitMs?: number;
  pollMs?: number;
  now?: Date;
  /** #10190: slug que o e-mail linka; ausente → `seoSlug` do título do D1 atual. */
  expectedSlug?: string;
  /** #10191: registra o bypass e devolve `bypassed` (exit 0) pra qualquer veredito ≠ merged. */
  bypassReason?: string;
}

function statePathOf(editionDirAbs: string): string {
  return join(editionDirAbs, "_internal", "site-page-published.json");
}

function resolveExpectedSlug(editionDirAbs: string, explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return explicit;
  try {
    return deriveSlugFromD1(editionDirAbs);
  } catch (e) {
    process.stderr.write(`[site-page-pr-gate] aviso: slug do D1 não derivável, checagem de slug pulada (${(e as Error).message})\n`);
    return undefined;
  }
}

/**
 * #10207: registra no state o `--expected-slug` explícito, pro invariante
 * `site-page-pr-merged` conferir contra o MESMO slug que a trava conferiu
 * (sem o registro, ele cai no `seoSlug` do D1 — certo pro caminho Kit, falso
 * positivo pro fallback com `--slug` do post). Muta `state` em memória (o
 * merge feito adiante regrava a partir dele) e grava best-effort: falhar aqui
 * só faz o sentinel ser mais estrito, nunca mais frouxo.
 */
function recordExpectedSlug(editionDirAbs: string, state: Record<string, unknown>, expectedSlug: string): void {
  if (state[SITE_PAGE_EXPECTED_SLUG_FIELD] === expectedSlug) return;
  state[SITE_PAGE_EXPECTED_SLUG_FIELD] = expectedSlug;
  try {
    writeFileAtomic(statePathOf(editionDirAbs), JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write(`[site-page-pr-gate] aviso: --expected-slug não registrado no state file (${(e as Error).message})\n`);
  }
}

function evaluateGate(rootDir: string, editionDirAbs: string, deps: SitePagePrGateDeps): SitePagePrGateVerdict {
  const read = readSitePageState(editionDirAbs);
  if (read.kind === "absent") {
    return { kind: "no-pr", reason: "_internal/site-page-published.json ausente — §5b-site não rodou" };
  }
  if (read.kind === "unreadable") return { kind: "no-pr", reason: read.reason };
  const state = read.state;
  if (state.published !== true) {
    return {
      kind: "no-pr",
      reason: `página não publicada (published=${String(state.published)}, code=${String(state.code ?? "?")}): ${String(state.reason ?? "sem motivo")}`,
    };
  }
  const prNumber = parsePrNumberFromUrl(typeof state.prUrl === "string" ? state.prUrl : undefined);
  if (deps.expectedSlug !== undefined) recordExpectedSlug(editionDirAbs, state, deps.expectedSlug);
  // #10190: antes do merge — página defasada não serve nem mergeada.
  let digest: string | undefined;
  try {
    digest = sitePageSourceDigest(editionDirAbs);
  } catch {
    digest = undefined;
  }
  const stale = sitePageStaleness(state, resolveExpectedSlug(editionDirAbs, deps.expectedSlug), digest);
  if (stale) return { kind: "stale", ...(prNumber !== undefined ? { prNumber } : {}), reason: stale };
  if (prNumber === undefined) {
    return { kind: "no-pr", reason: `PR da página não identificado no state file (branch site-publish/${String(state.slug ?? "?")})` };
  }
  // O publisher e o waiter só gravam `merged: true` depois de confirmar o merge.
  if (state.merged === true) {
    return { kind: "merged", prNumber, reason: `state file já registra o merge do PR #${prNumber}` };
  }
  const sleep: SleepFn = deps.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const attempt = waitAndMergeSitePagePr(
    rootDir,
    prNumber,
    deps.gh ?? defaultGhRunner,
    sleep,
    deps.waitMs ?? 0,
    deps.pollMs ?? SITE_PAGE_PR_GATE_POLL_MS,
    deps.mergeLock,
  );
  const verdict = classifyMergeAttempt(prNumber, attempt);
  if (verdict.kind === "merged") {
    const next = applyMergeWaiterResult(state, prNumber, attempt, deps.now ?? new Date(), "trava do Stage 6 (#10160)");
    if (next) {
      try {
        writeFileAtomic(statePathOf(editionDirAbs), JSON.stringify(next, null, 2));
      } catch (e) {
        // O merge aconteceu; o state defasado só faz o invariante consultar o PR ao vivo.
        process.stderr.write(`[site-page-pr-gate] aviso: merge feito, mas o state file não foi regravado (${(e as Error).message})\n`);
      }
    }
  }
  return verdict;
}

/**
 * #10191: grava o bypass no state file (cria um mínimo se ausente/ilegível).
 * Lança se não conseguir gravar — um bypass não registrado deixaria o
 * sentinel recusar a Etapa 6 depois do Schedule já feito, então o chamador
 * precisa saber que ele não valeu.
 */
function recordBypass(editionDirAbs: string, bypassReason: string, bypassed: UnmergedVerdict, now: Date): void {
  const read = readSitePageState(editionDirAbs);
  const base: Record<string, unknown> =
    read.kind === "ok" ? read.state : { published: false, reason: bypassed.reason };
  const next = {
    ...base,
    prGateBypass: {
      reason: bypassReason,
      verdict: bypassed.kind,
      verdictReason: bypassed.reason,
      at: now.toISOString(),
      ...(isUnrecoverableBypass(bypassed) ? { unrecoverable: true } : {}),
    },
  };
  writeFileAtomic(statePathOf(editionDirAbs), JSON.stringify(next, null, 2));
}

/** Corpo do CLI, injetável. */
export function runSitePagePrGate(
  rootDir: string,
  editionDirAbs: string,
  deps: SitePagePrGateDeps = {},
): SitePagePrGateVerdict {
  const verdict = evaluateGate(rootDir, editionDirAbs, deps);
  const bypassReason = deps.bypassReason?.trim();
  if (verdict.kind === "merged" || verdict.kind === "bypassed" || !bypassReason) return verdict;
  recordBypass(editionDirAbs, bypassReason, verdict, deps.now ?? new Date());
  return {
    kind: "bypassed",
    bypassReason,
    bypassed: verdict,
    ...(isUnrecoverableBypass(verdict) ? { unrecoverable: true as const } : {}),
  };
}

function editionIdOf(editionDirAbs: string): string | null {
  const id = basename(editionDirAbs);
  return /^\d{6}$/.test(id) ? id : null;
}

/**
 * #10196 (pura): achado `urgente` do bypass irrecuperável — o e-mail sai com
 * um link `/p/{slug}` que nenhum processo automático vai fazer existir.
 */
export function buildUnrecoverableBypassFinding(
  editionDirAbs: string,
  verdict: Extract<SitePagePrGateVerdict, { kind: "bypassed" }>,
  slug: string | undefined,
): NotifyEditorFinding {
  const edition = editionIdOf(editionDirAbs);
  const page = slug ? `/p/${slug}` : "a página da edição";
  const body = [
    `A trava do Stage 6 (§6c-site) foi contornada com veredito \`${verdict.bypassed.kind}\` — o e-mail foi agendado mesmo assim.`,
    ``,
    `- Edição: ${edition ?? "?"}`,
    `- Bypass: ${verdict.bypassReason}`,
    `- Veredito: ${verdict.bypassed.reason}`,
    ``,
    `Efeito: o link de WhatsApp do e-mail aponta pra ${page}, e NENHUM processo automático vai publicá-la — o waiter em background (#9593) só mergeia o PR do slug que ele conhece, e com \`${verdict.bypassed.kind}\` esse PR não é o da página certa (ou não existe). Sem ação, o link dá 404 no envio das 06:00 e depois.`,
    ``,
    `Ação: republicar a página com o slug do e-mail (\`npx tsx scripts/publish-edition-site-page.ts --edition-dir ${editionDirAbs} --slug-from-d1\`, ou \`--slug {slug-do-post}\` no fallback Beehiiv) e mergear o PR antes das 06:00. Fechar esta issue depois do merge.`,
    ``,
    `Achado automático de \`scripts/check-site-page-pr-gate.ts --bypass-reason\` (#10196).`,
  ].join("\n");
  return {
    check: "site-page-pr-gate-bypass",
    fingerprint: `site-page-pr-gate-bypass:${edition ?? basename(editionDirAbs)}`,
    severity: "urgente",
    family: "evento",
    priority: "P1",
    subject: `Página do site: bypass ${verdict.bypassed.kind} deixa ${page} sem página no e-mail${edition ? ` (${edition})` : ""}`,
    body,
  };
}

export interface UnrecoverableBypassAlertDeps {
  log?: (event: RunLogEvent, rootDir: string) => unknown;
  notify?: (finding: NotifyEditorFinding) => Promise<unknown>;
}

/**
 * #10196: alerta do bypass irrecuperável — `log-event` nível `error` + stderr
 * + `notifyEditor` urgente. No-op pra bypass recuperável. Nunca lança: o
 * bypass já foi gravado e o Schedule depende do exit 0.
 */
export async function alertUnrecoverableBypass(
  rootDir: string,
  editionDirAbs: string,
  verdict: SitePagePrGateVerdict,
  deps: UnrecoverableBypassAlertDeps = {},
): Promise<boolean> {
  if (verdict.kind !== "bypassed" || !verdict.unrecoverable) return false;
  const read = readSitePageState(editionDirAbs);
  const state = read.kind === "ok" ? read.state : {};
  const slug =
    typeof state[SITE_PAGE_EXPECTED_SLUG_FIELD] === "string"
      ? (state[SITE_PAGE_EXPECTED_SLUG_FIELD] as string)
      : resolveExpectedSlug(editionDirAbs, undefined);
  const finding = buildUnrecoverableBypassFinding(editionDirAbs, verdict, slug);
  process.stderr.write(`[site-page-pr-gate] ERRO: ${finding.subject} (#10196)\n`);
  try {
    (deps.log ?? logEvent)(
      {
        edition: editionIdOf(editionDirAbs),
        stage: 6,
        agent: "check-site-page-pr-gate",
        level: "error",
        message: finding.subject,
        details: { verdict: verdict.bypassed.kind, verdictReason: verdict.bypassed.reason, bypassReason: verdict.bypassReason },
      },
      rootDir,
    );
  } catch (e) {
    process.stderr.write(`[site-page-pr-gate] log-event falhou (${(e as Error).message})\n`);
  }
  try {
    await (deps.notify ?? ((f) => notifyEditor(f, { cwd: rootDir, rootDir })))(finding);
  } catch (e) {
    process.stderr.write(`[site-page-pr-gate] notifyEditor falhou (${(e as Error).message})\n`);
  }
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const editionDirArg = getArg(argv, "edition-dir");
  if (!editionDirArg) {
    console.error(
      "uso: npx tsx scripts/check-site-page-pr-gate.ts --edition-dir <dir> [--wait-ms N] [--poll-ms N] [--expected-slug <slug>] [--bypass-reason <motivo>]",
    );
    process.exitCode = 1;
    return;
  }
  let waitMs: number;
  let pollMs: number;
  let expectedSlug: string | undefined;
  let bypassReason: string | undefined;
  try {
    waitMs = getIntArg(argv, "wait-ms", { min: 0, max: SITE_PAGE_PR_GATE_MAX_WAIT_MS }) ?? 0;
    pollMs = getIntArg(argv, "poll-ms", { min: 1 }) ?? SITE_PAGE_PR_GATE_POLL_MS;
    expectedSlug = getStringArg(argv, "expected-slug", { example: "titulo-da-edicao" });
    bypassReason = getStringArg(argv, "bypass-reason", { example: "CI vermelho alheio à página (flake)" });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  const editionDirAbs = resolve(ROOT, editionDirArg);
  const state = readSitePageState(editionDirAbs);
  const prNumber =
    state.kind === "ok" ? parsePrNumberFromUrl(typeof state.state.prUrl === "string" ? state.state.prUrl : undefined) : undefined;
  let verdict: SitePagePrGateVerdict;
  try {
    verdict = runSitePagePrGate(ROOT, editionDirAbs, {
      waitMs,
      pollMs,
      mergeLock: prNumber !== undefined ? makeSessionRegistryMergeLock(ROOT, prNumber) : undefined,
      expectedSlug,
      bypassReason,
    });
  } catch (e) {
    // Inclui o `recordBypass` falho: bypass pedido e NÃO gravado não vale.
    console.error(`[site-page-pr-gate] erro (nenhum bypass foi registrado): ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  await alertUnrecoverableBypass(ROOT, editionDirAbs, verdict);
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = exitCodeForVerdict(verdict);
}

if (isMainModule(import.meta.url)) {
  await main();
}
