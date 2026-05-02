/**
 * poll-generate-url.ts (#469)
 *
 * Gera URLs assinadas (HMAC) para votação no sistema É IA?.
 *
 * **Fluxo correto:** como o sig depende do email de cada leitor, não é possível
 * usar um único template com merge tag (o sig não pode ser pré-computado).
 * O fluxo esperado é gerar URLs assinadas em batch via Kit API antes do envio
 * (um par de URLs A/B por assinante, injetadas como custom fields).
 *
 * Uso (por assinante):
 *   npx tsx scripts/poll-generate-url.ts --email leitor@ex.com --edition 260502 --choice A
 *
 * Variáveis de ambiente:
 *   POLL_SECRET        HMAC key (ver .env)
 *   POLL_WORKER_URL    URL base do Worker (default: https://diar-ia-poll.diaria.workers.dev)
 */

import { createHmac } from "node:crypto";

const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

export function generatePollUrl(email: string, edition: string, choice: "A" | "B", secret: string): string {
  const message = `${email.toLowerCase().trim()}:${edition}`;
  const sig = createHmac("sha256", secret).update(message).digest("hex");
  return `${POLL_WORKER_URL}/vote?email=${encodeURIComponent(email)}&edition=${edition}&choice=${choice}&sig=${sig}`;
}


function main(): void {
  const args = process.argv.slice(2);
  const idx = (flag: string) => args.indexOf(flag);
  const get = (flag: string) => idx(flag) !== -1 ? args[idx(flag) + 1] : undefined;

  const email = get("--email");
  const edition = get("--edition");
  const choice = get("--choice")?.toUpperCase() as "A" | "B" | undefined;
  const secret = process.env.POLL_SECRET;

  if (!secret) {
    console.error("POLL_SECRET não definido no ambiente. Ver .env.");
    process.exit(1);
  }

  if (!edition) {
    console.error("Uso: poll-generate-url.ts --edition AAMMDD [--email X] [--choice A|B]");
    process.exit(1);
  }

  if (!email || !choice) {
    console.error("Uso: poll-generate-url.ts --edition AAMMDD --email X --choice A|B");
    console.error("Nota: URLs devem ser geradas por assinante (sig depende do email).");
    process.exit(1);
  }

  const url = generatePollUrl(email, edition, choice, secret);
  console.log(url);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main();
}
