/**
 * smoke-test-vote.ts (#1366 — Stage 5 part, merge-tag mode #1186)
 *
 * Confirma que `valid_editions` no Worker KV inclui a edição corrente,
 * fazendo um POST de teste no endpoint /vote?...&test=1 com o email do
 * editor — SEM sig HMAC (modo merge-tag, #1186). Se Worker rejeitar com
 * 410 ("Essa edição não aceita mais votos"), a edição está fora do set —
 * halt Stage 5 antes de mandar email pra 482 subscribers com botões A/B
 * inutilizados.
 *
 * Caso real 260519: maintain-valid-editions-window read_failed=true,
 * 260519 nunca foi adicionado ao set. Sem smoke test, descobrimos só
 * quando o editor pediu pra testar voto manualmente pós-publicação.
 *
 * Uso:
 *   npx tsx scripts/smoke-test-vote.ts --edition 260519
 *
 * Env:
 *   POLL_WORKER_URL - default https://poll.diaria.workers.dev
 *   (POLL_SECRET não é mais necessário — modo merge-tag, sem sig HMAC)
 *
 * Exit codes:
 *   0 — smoke test passou (Worker aceitou test vote)
 *   1 — args inválidos
 *   2 — Worker rejeitou (410 = edição inválida ou outro erro HTTP)
 *   3 — network/timeout (verificar conectividade)
 */

import "dotenv/config";

import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { dohFetch } from "./lib/doh-fetch.ts"; // #1365 — DoH fallback pra UDP/53 broken

const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";

async function main(): Promise<void> {
  const { values } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  const email = values["email"] ?? "vjpixel@gmail.com"; // editor default
  const choice = (values["choice"] ?? "A").toUpperCase();

  if (!edition) {
    console.error("Uso: smoke-test-vote.ts --edition AAMMDD [--email <e>] [--choice A|B]");
    process.exit(1);
  }

  // #1186: modo merge-tag — URL sem &sig=. POLL_SECRET não é necessário.
  const url =
    `${POLL_WORKER_URL}/vote?email=${encodeURIComponent(email)}` +
    `&edition=${edition}&choice=${choice}&test=1`;

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await dohFetch(url);
  } catch (e) {
    console.error(`[smoke-test-vote] network error: ${(e as Error).message}`);
    process.exit(3);
  }

  const body = await res.text();
  const result = {
    edition,
    email,
    choice,
    status: res.status,
    ok: res.ok,
    body_snippet: body.slice(0, 200),
  };

  if (res.status === 410) {
    console.error(
      `[smoke-test-vote] FATAL: Worker retornou 410 — edição "${edition}" não está em valid_editions. ` +
        `Rode \`npx tsx scripts/add-valid-edition.ts --edition ${edition}\` ANTES de publicar. ` +
        `Sem isso 100% dos votos vão ser rejeitados silenciosamente.`,
    );
    console.error(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[smoke-test-vote] FATAL: status ${res.status} inesperado. Ver stderr.`);
    console.error(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  console.log(JSON.stringify({ ...result, status_label: "vote_accepted" }, null, 2));
}

main().catch((err) => {
  console.error(`[smoke-test-vote] unexpected error: ${err}`);
  process.exit(3);
});
