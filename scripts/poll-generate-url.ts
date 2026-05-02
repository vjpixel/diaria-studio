/**
 * poll-generate-url.ts (#469)
 *
 * Gera URLs assinadas (HMAC) para votação no sistema É IA?.
 * Usadas pelo render-newsletter-html.ts para incluir links de voto na newsletter.
 *
 * Uso:
 *   npx tsx scripts/poll-generate-url.ts --email leitor@ex.com --edition 260502 --choice A
 *   npx tsx scripts/poll-generate-url.ts --edition 260502  # gera template com {{email}} para merge tag
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

/**
 * Gera a URL de template com placeholder de email para merge tags do Kit/Beehiiv.
 * O placeholder será substituído pela plataforma antes do envio.
 */
export function generatePollTemplate(edition: string, choice: "A" | "B"): string {
  // O sig não pode ser pré-computado para placeholder — usar modo sem HMAC ou HMAC com email real
  // Para merge tags, retornar URL base sem sig (Worker aceita sem sig em modo "open")
  // TODO: implementar geração em batch de URLs assinadas por assinante via Kit API
  return `${POLL_WORKER_URL}/vote?edition=${edition}&choice=${choice}`;
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

  if (email && choice) {
    const url = generatePollUrl(email, edition, choice, secret);
    console.log(url);
  } else {
    console.log("Template A:", generatePollTemplate(edition, "A"));
    console.log("Template B:", generatePollTemplate(edition, "B"));
    console.log("\nPara URL assinada: --email leitor@exemplo.com --choice A|B");
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main();
}
