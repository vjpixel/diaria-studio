#!/usr/bin/env npx tsx
/**
 * scripts/check-pr-removal-declaration.ts (#7115)
 *
 * Roda em GH Action `pr-checks.yml` pra cada PR. Se o diff adiciona mais
 * linhas do que `REMOVAL_DECLARATION_ADDED_LINES_THRESHOLD`
 * (`scripts/lib/pr-removal-declaration.ts`), exige o marcador
 * `removal-declaration: <...>` no corpo do PR — mesmo padrão do marcador
 * `no-regression-test: <razão>` já usado neste repo (#3327 Rec 7).
 *
 * "Não recusar PR por tamanho, não impor cota de remoção, não bloquear
 * rodada autônoma. O objetivo é tornar a decisão explícita e registrada" —
 * o guard falha só quando a declaração está AUSENTE, nunca por causa do
 * TAMANHO do diff em si.
 *
 * FALHA ALTO de propósito — o dado (diff numstat entre 2 SHAs do próprio
 * checkout + body do PR, já disponíveis via `pull_request` event) é 100%
 * local, sem dependência de rede/API externa; não há fail-soft aplicável
 * além de erro de invocação (env vars ausentes) ou falha real de `git`.
 *
 * Env vars (passados pelo GH Action):
 *   PR_BODY   — body do PR — FALLBACK DECLARADO (#7140): o gate busca o
 *               body ATUAL pela API (`gh pr view --json body`) com retry/backoff;
 *               `PR_BODY` só é usado se a API falhar após as tentativas.
 *               `PR_BODY` vem do payload do evento, que fica CONGELADO no
 *               estado do PR quando o evento foi emitido (ver
 *               `scripts/lib/pr-body-fetch.ts`).
 *   PR_NUMBER — número do PR (#7140 — obrigatório pra buscar o body pela API)
 *   BASE_SHA  — sha do base (master) na hora do PR
 *   HEAD_SHA  — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (diff abaixo do limiar, OU acima do limiar com declaração presente)
 *   1 — falha (diff acima do limiar sem declaração)
 *   2 — input inválido / erro de git irrecuperável / API indisponível (#7140)
 */
import { isMainModule } from "./lib/cli-args.ts";
import { getDiffLineStats } from "./lib/diff-line-stats.ts";
import { evaluateRemovalDeclaration, missingRemovalDeclarationMessage } from "./lib/pr-removal-declaration.ts";
import { fetchPrBody, resolvePrBody } from "./lib/pr-body-fetch.ts";

async function main(): Promise<void> {
  const prBody = process.env.PR_BODY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!prNumber) {
    console.error("[#7115] env var ausente: PR_NUMBER é obrigatória (#7140 — o body é buscado pela API).");
    process.exit(2);
  }

  if (!baseSha || !headSha) {
    console.error("[#7115] env vars ausentes: BASE_SHA, HEAD_SHA são obrigatórias.");
    process.exit(2);
  }

  let stats;
  try {
    stats = getDiffLineStats(baseSha, headSha);
  } catch (e) {
    console.error(`[#7115] git diff falhou: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  // #7140: buscar o body ATUAL do PR pela API (com retry/backoff) em vez de
  // usar `PR_BODY` do payload, que fica congelado no estado do PR quando o
  // evento foi emitido — um body editado após não é visto até um push novo,
  // e `gh run rerun` replaya o mesmo payload. `PR_BODY` é fallback declarado.
  const { body: prBodyActual, source: bodySource } = await resolvePrBody(
    prNumber,
    prBody,
    (n) => fetchPrBody(n),
  );
  if (bodySource === "env-fallback") {
    console.warn(
      `[#7115] body do PR #${prNumber} vem do PAYLOAD do evento (possivelmente ` +
        `desatualizado, #7140) — a API não pôde ser consultada.`,
    );
  }

  const evaluation = evaluateRemovalDeclaration(stats, prBodyActual);

  if (evaluation.status === "not-required") {
    console.log(`[#7115] diff adiciona ${evaluation.addedLines} linhas (≤ ${evaluation.threshold}) — sem exigência de declaração. Pass.`);
    return;
  }
  if (evaluation.status === "ok") {
    console.log(`[#7115] diff adiciona ${evaluation.addedLines} linhas (> ${evaluation.threshold}) e o PR declara remoção. Pass.`);
    return;
  }

  console.error(missingRemovalDeclarationMessage(evaluation));
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[#7115] erro não-tratado: ${(e as Error).message}`);
    process.exit(2);
  });
}
