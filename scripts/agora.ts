#!/usr/bin/env node
/**
 * scripts/agora.ts (#7346)
 *
 * Imprime a hora ATUAL em BRT (America/Sao_Paulo) e UTC lado a lado —
 * helper canônico pra qualquer diagnóstico ad-hoc que precise saber "que
 * horas são agora", sem depender do `date` do shell.
 *
 * Por que isto existe: no Git Bash (MSYS2, Windows), `TZ=America/Sao_Paulo
 * date '+%H:%M %Z'` IGNORA o `TZ` e devolve UTC/GMT sem aviso nenhum — o
 * `%Z` imprime "GMT", não "-03", e a saída é plausível o bastante pra ser
 * lida como hora local por engano (achado ao vivo #7346, 03/09/2026 —
 * aconteceu mesmo já estando registrado em memória de sessão; ler a nota
 * não impediu de cair nela porque nada no comando sinaliza que o `TZ` foi
 * descartado). Node resolve `America/Sao_Paulo` corretamente em qualquer
 * plataforma via `Intl` — o problema é do `date` do MSYS, não da
 * plataforma. Usar este script em vez de `date` (com ou sem `TZ=`) em
 * qualquer investigação/diagnóstico que precise da hora atual.
 *
 * Reusa `BRT_TIMEZONE` de `next-edition-date.ts` (fonte única do fuso
 * canônico do projeto) — nenhuma constante nova duplicando
 * "America/Sao_Paulo".
 *
 * Uso:
 *   npx tsx scripts/agora.ts          # BRT + UTC, formato humano
 *   npx tsx scripts/agora.ts --json   # { brt, utc, epochMs }
 */
import { BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import { isMainModule } from "./lib/cli-args.ts";

/**
 * BRT formatado `AAAA-MM-DD HH:MM:SS -03` — o sufixo `-03` é literal e
 * explícito de propósito, nunca derivado de `Intl` `timeZoneName`: alguns
 * runtimes/locales resolvem o nome do fuso como "GMT-3"/"-03:00"/
 * "Horário Padrão de Brasília" de forma inconsistente, e o ponto inteiro
 * deste helper é nunca produzir uma saída ambígua com UTC — ao contrário
 * do `%Z` do `date` do Git Bash, que imprime "GMT" mesmo quando o fuso foi
 * corretamente resolvido para BRT (ver docstring do módulo). BRT é UTC-3
 * fixo desde 2019 (mesma premissa documentada em `next-edition-date.ts`).
 * @pure
 */
export function formatBrtNow(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: BRT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return `${fmt.format(now)} -03`;
}

/** UTC formatado `AAAA-MM-DD HH:MM:SS UTC` — par de `formatBrtNow`, pro
 * lado-a-lado que faz o offset saltar aos olhos. @pure */
export function formatUtcNow(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Relatório completo — usado tanto pelo modo texto quanto `--json`. @pure */
export function agoraReport(now: Date = new Date()): { brt: string; utc: string; epochMs: number } {
  return { brt: formatBrtNow(now), utc: formatUtcNow(now), epochMs: now.getTime() };
}

function main(): void {
  const report = agoraReport();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  process.stdout.write(`BRT: ${report.brt}\nUTC: ${report.utc}\n`);
}

if (isMainModule(import.meta.url)) main();
