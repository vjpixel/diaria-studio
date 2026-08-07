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
 * Exit (invocação manual, default): 0 sempre que rodar sem exceção
 * não-tratada (mesmo se todos os providers estiverem sem key — isso é
 * reportado, não é erro fatal: rodar este script sem NENHUMA key configurada
 * ainda é um estado válido, só sem trabalho a fazer). `--dry-run` também sai 0.
 *
 * `--strict` (#4754): sai != 0 quando NENHUMA medição foi registrada —
 * 2 se nenhum provider está configurado, 1 se 100% das consultas falharam.
 * Falha parcial continua saindo 0 (o fail-soft por provedor é desenhado).
 *
 * Por que a rigidez é opcional em vez de virar o default: na mão, "sem key
 * configurada" é mesmo um estado válido e o comportamento acima é deliberado
 * (#4616). Já no caminho AGENDADO o mesmo exit 0 vira mentira — a task
 * reportaria verde para sempre enquanto `history.jsonl` congelava, que é o
 * modo de falha que deixou este monitor inerte por semanas. Quem liga é
 * `run-geo-citation-monitor.ps1`, e só ele.
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
import type { GeoCitationRecord } from "./lib/geo-citation-monitor.ts";

export interface StrictOutcome {
  code: number;
  /** `null` quando não há nada a dizer (caminho saudável). */
  message: string;
  level: "none" | "warn" | "error";
}

/**
 * Decide o exit code de uma execução JÁ REALIZADA, a partir dos registros.
 *
 * Extraída de `main()` pra ser testável (achado do fleet review da PR #4754):
 * `main()` chama `runGeoCitationMonitor(process.env)` sem ponto de injeção,
 * então a decisão embutida ali só seria exercitável com rede real — mesma
 * armadilha do guard inline apontada no review da #4751.
 *
 * @pure
 */
export function resolveStrictOutcome(
  records: readonly GeoCitationRecord[],
  strict: boolean,
): StrictOutcome {
  const total = records.length;
  const comErro = records.filter((r) => r.error);

  if (!strict || total === 0 || comErro.length !== total) {
    return { code: 0, message: "", level: "none" };
  }

  // Rate limit NÃO reprova a run. As 8 perguntas de um provider saem em
  // sequência com um único retry de 1,5s; num free tier com RPM baixo (o
  // Gemini é o caso concreto hoje) isso pode estourar o limite TODA semana sem
  // nada estar quebrado. Exit != 0 recorrente em cenário benigno treina o
  // editor a ignorar o alarme — o oposto do que a #4558 quer.
  if (comErro.every((r) => r.errorKind === "http" && r.httpStatus === 429)) {
    return {
      code: 0,
      level: "warn",
      message:
        `[geo-citation-monitor] AVISO: as ${total} consultas retornaram HTTP 429 (rate limit). ` +
        "Provável limite de throughput do provider, não configuração quebrada — costuma normalizar sozinho. " +
        "Se persistir por semanas, revise a cadência ou o plano do provider.",
    };
  }

  // Nomeia as causas em vez de um genérico "verifique as keys": o dado já está
  // em cada registro (`errorKind`/`httpStatus`), e descartá-lo faz 401 (ação
  // necessária) e falha de DNS (esperar) lerem igual.
  const causas = new Map<string, number>();
  for (const r of comErro) {
    const chave = r.errorKind === "http" ? `HTTP ${r.httpStatus ?? "?"}` : (r.errorKind ?? "desconhecido");
    causas.set(chave, (causas.get(chave) ?? 0) + 1);
  }
  const resumo = [...causas.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([causa, n]) => `${causa} (${n})`)
    .join(", ");

  return {
    code: 1,
    level: "error",
    message:
      `[geo-citation-monitor] ERRO: as ${total} consultas falharam — nenhuma medição válida nesta execução. ` +
      `Causas: ${resumo}.`,
  };
}

async function main(): Promise<number> {
  const { flags, values } = parseCliArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  // Ver docstring do topo: rigidez é opt-in porque na mão "sem key" é estado
  // válido (#4616), mas no caminho agendado exit 0 sem medição é mentira.
  const strict = flags.has("strict");
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

  // Este caminho não escreve NADA em history.jsonl — nem um marcador de
  // "rodou e pulou tudo". Sob `--strict` (caminho agendado) isso vira exit 2:
  // com 0, a task reportaria verde para sempre enquanto a série congelava, que
  // é o modo de falha que deixou este monitor inerte desde o #4616. Na mão,
  // continua sendo 0 — "sem key configurada" é estado válido, decisão
  // deliberada do #4616 que esta PR não reverte. Achado do fleet review #4754.
  if (configured.length === 0) {
    const msg =
      "[geo-citation-monitor] nenhum provider configurado — nenhuma medição foi feita. " +
      "Configure ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY (ver .env.example) e rode de novo.";
    if (strict) {
      console.error(`ERRO: ${msg}`);
      return 2;
    }
    console.log(msg);
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

  // Falha TOTAL (100% das consultas erraram) sob `--strict`. Key expirada,
  // cartão recusado, DNS/firewall bloqueando — tudo isso produzia o mesmo
  // exit 0 de uma semana saudável. Falha PARCIAL continua saindo 0 de
  // propósito: o fail-soft por provedor é desenhado, e a execução de 07/ago
  // teve 1 erro em 16 e é medição legítima.
  const veredito = resolveStrictOutcome(records, strict);
  if (veredito.level === "error") console.error(veredito.message);
  else if (veredito.level === "warn") console.warn(veredito.message);
  return veredito.code;
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
