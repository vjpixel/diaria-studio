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

  // Exit 2 (config inválida), não 0. Este caminho não escreve NADA em
  // history.jsonl — nem um marcador de "rodou e pulou tudo". Com exit 0, a
  // task agendada reportaria verde para sempre enquanto a série congelava, que
  // é exatamente o modo de falha que deixou este monitor inerte desde o #4616.
  // Achado do fleet review da PR #4754.
  if (configured.length === 0) {
    console.error(
      "[geo-citation-monitor] ERRO: nenhum provider configurado — nenhuma medição foi feita. " +
        "Configure ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY (ver .env.example) e rode de novo.",
    );
    return 2;
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

  // Falha TOTAL (100% das consultas erraram) sai != 0. Key expirada, cartão
  // recusado no provedor, DNS/firewall bloqueando — tudo isso produz 24 de 24
  // com `error`, e antes devolvia o mesmo exit 0 de uma semana saudável. O dado
  // bruto até fica em history.jsonl, mas ninguém é avisado a olhar.
  //
  // Falha PARCIAL continua saindo 0 de propósito: o fail-soft por provedor é
  // desenhado, e um timeout isolado não é motivo pra reprovar a semana — a
  // execução de 07/ago teve 1 erro em 16 e é uma medição legítima.
  if (summary.total > 0 && summary.errors === summary.total) {
    console.error(
      `[geo-citation-monitor] ERRO: as ${summary.total} consultas falharam — nenhuma medição válida nesta execução. ` +
        "Verifique validade das API keys e conectividade.",
    );
    return 1;
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      // Alinha com o padrão dos scripts irmãos agendáveis via Task Scheduler
      // (postmaster-spam-sync.ts, apoios-diff-alarm.ts, cursos-error-alarm.ts,
      // achado #4616): sem isso, uma exceção não tratada vira stack trace cru
      // em vez de log estruturado que o `.ps1` wrapper capturaria.
      console.error("[geo-citation-monitor] erro:", e);
      process.exit(1);
    });
}

export { main };
