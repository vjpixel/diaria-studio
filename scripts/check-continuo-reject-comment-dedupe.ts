#!/usr/bin/env npx tsx
/**
 * check-continuo-reject-comment-dedupe.ts (#7446 item 1)
 *
 * CLI wrapper de `scripts/lib/continuo-reject-comment.ts` — todo I/O (`gh pr
 * view`) fica aqui; a decisão pura fica na lib. Consumido pelo ramo
 * `gate=reject` de `try_merge_gate()` em `hermes/scripts/continuo-pr-review.sh`
 * ANTES do `gh pr comment`, pra não repetir o mesmo comentário de rejeição a
 * cada tick (medido ao vivo na PR #7404: 9 comentários idênticos em 18h).
 *
 * Uso:
 *   npx tsx scripts/check-continuo-reject-comment-dedupe.ts --pr 7404 \
 *     --candidate "Gate de merge automático (#6926): rejeitado — ..."
 *
 * Saída: JSON `{"skip": boolean, "source": "compared" | "error"}` em stdout.
 * `source: "error"` (gh falhou/PR sem comentários acessível) sempre resolve
 * `skip: false` — fail-OPEN em direção a POSTAR, não a esconder: diferente do
 * gate de merge (onde fail-closed protege contra uma ação irreversível),
 * aqui o pior caso de um falso negativo é 1 comentário a mais, nunca um
 * merge indevido.
 *
 * Exit code sempre 0 exceto uso inválido (`--pr`/`--candidate` ausentes, 2) —
 * o chamador (bash) só lê o JSON, nunca trata "gh falhou" como halt.
 *
 * @see scripts/lib/continuo-reject-comment.ts
 * @see hermes/scripts/continuo-pr-review.sh (ramo `2)` de `try_merge_gate()`)
 */

import { execFileSync } from "node:child_process";
import { shouldSkipDuplicateRejectComment } from "./lib/continuo-reject-comment.ts";

function parseArgs(argv: string[]): { pr: string; candidate: string } | null {
  let pr: string | null = null;
  let candidate: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") pr = argv[++i] ?? null;
    else if (argv[i] === "--candidate") candidate = argv[++i] ?? null;
  }
  if (!pr || !/^\d+$/.test(pr) || candidate == null) return null;
  return { pr, candidate };
}

/** `ok: false` = `gh` falhou de verdade (rede, auth, PR sumiu) — distinto de
 *  "PR sem comentários ainda" (`ok: true, body: null`), que é estado válido,
 *  não erro. */
function fetchLastCommentBody(pr: string): { ok: boolean; body: string | null } {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "view", pr, "--json", "comments", "--jq", ".comments[-1].body // empty"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const trimmed = out.replace(/\n$/, "");
    return { ok: true, body: trimmed.length > 0 ? trimmed : null };
  } catch {
    return { ok: false, body: null };
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("uso: check-continuo-reject-comment-dedupe.ts --pr <N> --candidate <texto>\n");
    process.exitCode = 2;
    return;
  }

  const fetched = fetchLastCommentBody(args.pr);
  const skip = fetched.ok ? shouldSkipDuplicateRejectComment(fetched.body, args.candidate) : false;
  console.log(JSON.stringify({ skip, source: fetched.ok ? "compared" : "error" }));
}

main();
