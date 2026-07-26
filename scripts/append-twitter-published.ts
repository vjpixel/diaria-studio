/**
 * append-twitter-published.ts (#3994)
 *
 * Grava o resultado de UM post no X (publicado via Buffer MCP pelo
 * orchestrator — ver `prep-twitter-posts.ts` pro contexto de por que a
 * publicação em si não é mais um script) em 06-social-published.json,
 * usando o mesmo store atômico dos demais canais (#758).
 *
 * Uso:
 *   npx tsx scripts/append-twitter-published.ts \
 *     --published-path {edition-dir}/_internal/06-social-published.json \
 *     --destaque d1 \
 *     --status published \
 *     [--url https://x.com/diariabr/status/...] \
 *     [--buffer-post-id 6a668bb2ecad4329a917a05f] \
 *     [--reason "texto excede 280 chars"]
 *
 * `--status` ∈ {published, scheduled, draft, failed}. `--url`/`--buffer-post-id`
 * fazem sentido pra published/scheduled/draft; `--reason` pra failed.
 */

import { appendSocialPosts, PostEntry } from "./lib/social-published-store.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

const VALID_STATUSES = new Set(["published", "scheduled", "draft", "failed"]);

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const publishedPath = values["published-path"];
  const destaque = values["destaque"];
  const status = values["status"];

  if (!publishedPath || !destaque || !status) {
    console.error(
      "ERRO: --published-path, --destaque e --status são obrigatórios.",
    );
    process.exit(1);
  }
  if (!VALID_STATUSES.has(status)) {
    console.error(`ERRO: --status inválido: ${status}. Use: ${[...VALID_STATUSES].join(", ")}.`);
    process.exit(1);
  }

  const entry: PostEntry = {
    platform: "twitter",
    destaque,
    url: values["url"] ?? null,
    status: status as PostEntry["status"],
    scheduled_at: null,
    ...(values["reason"] ? { reason: values["reason"] } : {}),
    ...(values["buffer-post-id"] ? { buffer_post_id: values["buffer-post-id"] } : {}),
  };

  appendSocialPosts(publishedPath, [entry]);
  console.log(`OK twitter/${destaque} — ${status} — gravado em ${publishedPath}`);
}

if (isMainModule(import.meta.url)) {
  main();
}
