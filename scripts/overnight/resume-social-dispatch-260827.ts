/**
 * scripts/overnight/resume-social-dispatch-260827.ts (#6323/#6343)
 *
 * One-off: retoma o dispatch social da edição 260827, que ficou pausado no
 * Stage 5 porque o backend `kit` só atribui `public_url` (com slug) a um
 * broadcast quando ele sai do status `draft` de verdade — nem `public: true`
 * nem `published_at` setado (sem enviar) mudam isso; testado ao vivo mesmo
 * em `status: scheduled`. Decisão do editor (260826): esperar o envio real
 * (amanhã 09:00 UTC) e só então disparar o social com o link correto.
 *
 * Fluxo:
 *   1. Poll GET /broadcasts/25622689 até status === "completed" (retry).
 *   2. Extrair public_url real, gravar em _internal/05-edition-url.txt.
 *   3. Substituir {edition_url} em 03-social.md (resolve-edition-url.ts).
 *   4. Re-upload de imagens sociais (garante cache atualizado).
 *   5. Dispatch Facebook/LinkedIn/Instagram/Threads (scripts próprios).
 *   6. Spawna uma sessão `claude --print` headless pra: Twitter via Buffer
 *      MCP (não dá pra rodar de um script puro), fechar o resto do Stage 5
 *      (verify dispatch, sentinel) e retomar o Stage 6 (auto-reporter,
 *      Brevo diária) — ver _internal/pending-kit-social-dispatch.json.
 *
 * Task Scheduler roda isto 1x (setup-resume-social-260827.ps1), sem
 * repetição — este script não é genérico, é específico desta edição.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBroadcast } from "../lib/kit-client.ts";
import { resolveKitConfig } from "../lib/kit-config.ts";
import { resolveClaudeBin } from "../lib/resolve-claude-bin.ts";
import { claudeCliEnv } from "./run-scheduled-edicao.ts";

const BROADCAST_ID = 25622689;
const EDITION = "260827";
const EDITION_DIR = resolve(process.cwd(), "data/editions/2608/260827");
const LOG_PATH = resolve(process.cwd(), "data/task-scheduler-resume-social-260827.log");
const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 5 * 60 * 1000;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    writeFileSync(LOG_PATH, line, { flag: "a" });
  } catch {
    // best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<number> {
  const r = resolveKitConfig();
  if (!r.ok) {
    log(`FATAL: config Kit ausente — ${r.reason}`);
    return 1;
  }

  let publicUrl: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const b = await getBroadcast(BROADCAST_ID, r.config);
    log(`tentativa ${attempt}/${MAX_ATTEMPTS}: status=${b.status} public_url=${b.public_url ?? "(vazio)"}`);
    if (b.status === "completed" && b.public_url && !b.public_url.endsWith("/posts/")) {
      publicUrl = b.public_url;
      break;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  if (!publicUrl) {
    log("FATAL: esgotou as tentativas sem um public_url com slug. Editor precisa investigar manualmente.");
    return 1;
  }

  log(`URL real obtida: ${publicUrl}`);
  writeFileSync(resolve(EDITION_DIR, "_internal/05-edition-url.txt"), publicUrl);

  const run = (args: string[]) => {
    log(`$ npx tsx ${args.join(" ")}`);
    execFileSync("npx", ["tsx", ...args], { stdio: "inherit", cwd: process.cwd() });
  };

  run(["scripts/resolve-edition-url.ts", "--edition-dir", `${EDITION_DIR}/`, "--edition-url", publicUrl, "--validate-social"]);
  run(["scripts/upload-images-public.ts", "--edition-dir", `${EDITION_DIR}/`, "--mode", "social"]);
  run(["scripts/publish-facebook.ts", "--edition-dir", `${EDITION_DIR}/`, "--schedule"]);
  run(["scripts/publish-linkedin.ts", "--edition-dir", `${EDITION_DIR}/`, "--schedule"]);
  run(["scripts/publish-instagram.ts", "--edition-dir", `${EDITION_DIR}/`, "--schedule"]);
  run(["scripts/publish-threads.ts", "--edition-dir", `${EDITION_DIR}/`, "--schedule"]);

  log("Canais via script dispatchados. Spawnando claude --print pra Twitter (Buffer MCP) + fechar Stage 5/6.");

  const pendingPath = resolve(EDITION_DIR, "_internal/pending-kit-social-dispatch.json");
  const pendingExists = existsSync(pendingPath);
  const prompt = [
    `Retome a edição ${EDITION} do diar.ia.br studio — dispatch social acabou de ser feito por script`,
    `(Facebook/LinkedIn/Instagram/Threads já dispatchados via publish-*.ts --schedule, edition_url real = ${publicUrl}).`,
    pendingExists ? `Contexto completo em ${pendingPath}.` : "",
    `Faltam: (1) Twitter/X via Buffer MCP — Passo 5c-3b de .claude/agents/orchestrator-stage-5.md;`,
    `(2) resto do Stage 5 (5f-bis verify dispatch, 5h sentinel — newsletter Kit já foi agendada, não repetir 5c-1-kit);`,
    `(3) Stage 6 (auto-reporter, Brevo diária se aplicável — newsletter já agendada via schedule-newsletter-kit.ts, não repetir 6d-kit).`,
    `Rode como sessão autônoma, sem gates (equivalente a --no-gates), já que o editor aprovou tudo ontem e só o timing do Kit travava.`,
  ]
    .filter(Boolean)
    .join(" ");

  const claudeBinResolved = resolveClaudeBin();
  execFileSync(claudeBinResolved, ["--print", prompt], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: claudeCliEnv(process.env),
  });

  log("claude --print concluído.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  });
