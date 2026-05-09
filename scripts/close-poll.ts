/**
 * close-poll.ts (#469)
 *
 * Fecha a votação de uma edição: envia a resposta correta para o Worker de poll,
 * que retroativamente atualiza scores dos votos já gravados.
 *
 * Chamado pelo pipeline após publicação da newsletter (Stage 4).
 *
 * Uso:
 *   npx tsx scripts/close-poll.ts --edition 260502
 *   npx tsx scripts/close-poll.ts --edition 260502 --answer A  # override manual
 *
 * Se --answer não for passado, lê ai_side de _internal/01-eia-meta.json da edição.
 *
 * Variáveis de ambiente:
 *   POLL_SECRET        HMAC key (ver .env)
 *   POLL_WORKER_URL    URL base do Worker (default: https://diar-ia-poll.diaria.workers.dev)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import { parseEiaMeta } from "./lib/schemas/eia-meta.ts"; // #1031

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

function adminSig(secret: string, edition: string, answer: string): string {
  return createHmac("sha256", secret).update(`${edition}:${answer}`).digest("hex");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { values } = parseCliArgs(args); // #535: fix indexOf+1 bug

  const edition = values["edition"];
  let answer = values["answer"]?.toUpperCase();
  const secret = process.env.POLL_SECRET;

  if (!secret) {
    console.error("[close-poll] POLL_SECRET não definido. Ver .env.");
    process.exit(1);
  }
  if (!edition) {
    console.error("Uso: close-poll.ts --edition AAMMDD [--answer A|B]");
    process.exit(1);
  }

  // Ler ai_side de 01-eia-meta.json se não foi passado manualmente
  if (!answer) {
    const metaPath = resolve(ROOT, "data", "editions", edition, "_internal", "01-eia-meta.json");
    if (!existsSync(metaPath)) {
      console.error(`[close-poll] 01-eia-meta.json não encontrado em ${metaPath}. Use --answer A|B.`);
      process.exit(1);
    }
    // #1031: schema-validated parse — Zod garante ai_side ∈ {A, B}
    try {
      const meta = parseEiaMeta(JSON.parse(readFileSync(metaPath, "utf8")));
      answer = meta.ai_side;
      console.log(`[close-poll] Leu ai_side="${answer}" de ${metaPath}`);
    } catch (e) {
      console.error(`[close-poll] schema inválido em ${metaPath}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  const sig = adminSig(secret, edition, answer);
  const url = `${POLL_WORKER_URL}/admin/correct?edition=${edition}&answer=${answer}&sig=${sig}`;

  const res = await fetch(url, { method: "POST" });
  const data = await res.json() as { ok?: boolean; updated_votes?: number; error?: string };

  if (!res.ok || !data.ok) {
    console.error(`[close-poll] Erro ao fechar poll: ${JSON.stringify(data)}`);
    process.exit(1);
  }

  console.log(`[close-poll] Poll da edição ${edition} fechado. Resposta correta: ${answer}. Scores atualizados: ${data.updated_votes ?? 0}`);
}

main().catch(err => { console.error(err); process.exit(1); });
