/**
 * geo-citation-monitor.ts (#4558 Parte C)
 *
 * CLI do "monitor de citação, feito em casa": pra cada provider com API key
 * configurada (Claude/ChatGPT/Gemini — ver `scripts/lib/geo-citation-monitor.ts`),
 * consulta o conjunto fixo de perguntas pt-BR (`GEO_QUESTIONS`) via API
 * oficial e checa se `diar.ia.br` aparece na resposta. Resultado persiste em
 * `data/geo-citations/history.jsonl` (append-only).
 *
 * **Não executado ao vivo nesta sessão** — sem `ANTHROPIC_API_KEY`/
 * `OPENAI_API_KEY`/`GEMINI_API_KEY` reais no worktree isolado. Mecanismo
 * pronto, testável via injeção de dependência — ver docstring de
 * `scripts/lib/geo-citation-monitor.ts` pro detalhe de cada shape de
 * request/response e o aviso sobre OpenAI/Google não terem sido verificados
 * contra documentação ao vivo (Anthropic foi, via a skill `claude-api`).
 *
 * Uso:
 *   npx tsx scripts/geo-citation-monitor.ts [--dry-run] [--out <path>]
 *
 * `--dry-run`: não faz nenhuma chamada de rede nem escreve o log — só
 * imprime quais providers estão configurados (key presente) e as perguntas
 * que seriam consultadas. Útil pra verificar o mecanismo sem gastar tokens.
 *
 * Exit: 0 sempre que rodar sem exceção não-tratada (mesmo se todos os
 * providers estiverem sem key — isso é reportado, não é erro fatal: rodar
 * este script sem NENHUMA key configurada ainda é um estado válido, só sem
 * trabalho a fazer). `--dry-run` também sai 0.
 */
import "dotenv/config";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  GEO_PROVIDERS,
  GEO_QUESTIONS,
  DEFAULT_GEO_CITATIONS_LOG_PATH,
  appendGeoCitationLog,
  runGeoCitationMonitor,
  summarizeGeoCitationRecords,
} from "./lib/geo-citation-monitor.ts";

async function main(): Promise<number> {
  const { flags, values } = parseCliArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const outPath = values["out"] ?? DEFAULT_GEO_CITATIONS_LOG_PATH;

  const configured = GEO_PROVIDERS.filter((p) => Boolean(process.env[p.envKey]));
  const missing = GEO_PROVIDERS.filter((p) => !process.env[p.envKey]);

  console.log(`[geo-citation-monitor] ${GEO_QUESTIONS.length} perguntas fixas configuradas.`);
  console.log(
    `[geo-citation-monitor] providers com API key: ${configured.length ? configured.map((p) => p.label).join(", ") : "nenhum"}.`,
  );
  if (missing.length > 0) {
    console.log(
      `[geo-citation-monitor] providers SEM API key (pulados, fail-soft): ${missing.map((p) => `${p.label} (${p.envKey})`).join(", ")}.`,
    );
  }

  if (dryRun) {
    console.log("[geo-citation-monitor] --dry-run: nenhuma chamada de rede, nenhuma escrita. Perguntas:");
    for (const q of GEO_QUESTIONS) console.log(`  - ${q}`);
    return 0;
  }

  if (configured.length === 0) {
    console.log(
      "[geo-citation-monitor] nenhum provider configurado — nada a fazer. " +
        "Configure ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY (ver .env.example) e rode de novo.",
    );
    return 0;
  }

  const records = await runGeoCitationMonitor(process.env);
  appendGeoCitationLog(records, outPath);

  const summary = summarizeGeoCitationRecords(records);
  console.log(
    `[geo-citation-monitor] ${summary.total} consultas, ${summary.cited} citaram diar.ia.br, ${summary.errors} erro(s). Log: ${outPath}`,
  );
  for (const [providerId, s] of Object.entries(summary.byProvider)) {
    console.log(`  - ${providerId}: ${s.cited}/${s.total} citaram`);
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main };
