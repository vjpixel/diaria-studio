/**
 * clarice-novos-run-status.ts (#5405)
 *
 * Snapshot do desfecho da ÚLTIMA invocação de `clarice-novos-run.ts` — não
 * confundir com `clarice-novos-state.ts` (`novos-state.json`), que só
 * avança em envio CONFIRMADO (Passos 4-7): uma rodada que aborta no
 * semáforo (Passo 3, D4) nunca toca aquele state, então `lastRunAt` de lá
 * reflete o último ENVIO bem-sucedido, não a última TENTATIVA — exatamente o
 * gap que fazia o aviso do `plan-wave` dizer "considere rodar" quando o
 * `novos` tinha rodado e abortado (#5405).
 *
 * Persistido em `data/clarice-subscribers/last-novos-run-status.json`,
 * escrito por `clarice-novos-run.ts` em TODA invocação real (não em
 * `--dry-run` nem quando o kill switch está pausado — nenhum dos dois é uma
 * tentativa de produção). Consumido por:
 *   - `clarice-wave-plan.ts`/`clarice-plan-wave.ts` (#5405 item 2) — corrige
 *     o texto do aviso de frescor quando a última tentativa abortou.
 *   (O consumidor original #5405 item 1 — streak do alarme de abort — foi
 *   removido no #5922 junto com o próprio alarme: o único status que ele
 *   rastreava, `semaphore-red`, deixou de ser produzido quando o guard D4
 *   saiu do caminho `novos` no #5660.)
 *
 * Fail-soft (mesmo padrão de `clarice-novos-state.ts`/`clarice-novos-cutoff.ts`):
 * leitura tolerante — ausente/corrompido → `null`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE, clariceSegmentsDir } from "./clarice-paths.ts";
import { hasFlag, isMainModule } from "./cli-args.ts";

/**
 * `other-error` — abortou por qualquer motivo (guard de custo MV, teto D13,
 * erro de sub-script) — não é "sucesso" (não confirma envio).
 * `empty`/`sent`/`uncertain` — rodada real, sem abort (0 candidatos, envio
 * confirmado, ou disparo cujo status final não foi confirmado — mesma
 * semântica de exit 2 de `clarice-novos-run.ts`).
 * (`semaphore-red` existiu até #5922 — status produzido pelo guard D4 que o
 * #5660 retirou do caminho `novos`; arquivos antigos com esse valor passam a
 * ler como `null`, que é o tratamento correto pra um status sem significado.)
 */
export type NovosRunStatusValue = "sent" | "empty" | "uncertain" | "other-error";

export interface NovosRunStatus {
  status: NovosRunStatusValue;
  /** ISO — quando esta rodada terminou (mesmo `now()` usado no relatório). */
  checkedAt: string;
  /** Trecho da mensagem de abort (só presente em `other-error`), auditoria. */
  detail?: string;
  /** #13098: contatos PRESOS por uma rodada que caiu depois de gravar a
   * seleção. Campo À PARTE do `status`: atravessa as rodadas seguintes
   * (vazia, 105, `sent`/`uncertain` de outra key) até a key presa ser
   * disparada (`resolveStrandedCarry`) ou o editor limpar à mão
   * (`--clear-stranded`, depois de liberar a seleção). */
  stranded?: NovosStranded;
}

export interface NovosStranded {
  /** ISO da rodada que deixou os contatos presos. */
  at: string;
  /** Key da campanha presa (ausente quando a rodada caiu antes de resolvê-la). */
  key?: string;
  /** Ciclo de ENVIO (`{ciclo}/segments/group-campaigns.json`). */
  cycle?: string;
  detail?: string;
}

function parseStranded(raw: unknown): NovosStranded | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "string") return undefined;
  return {
    at: r.at,
    ...(typeof r.key === "string" ? { key: r.key } : {}),
    ...(typeof r.cycle === "string" ? { cycle: r.cycle } : {}),
    ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
  };
}

/**
 * #13098: `stranded` que a próxima gravação carrega. `next` (presos desta
 * rodada) vence; sem ele, herda o anterior, salvo quando a key presa já saiu
 * (`group-campaigns.json` do ciclo com `status: "sent"` ou
 * `sendNowAcceptedAt` gravado). Registro ilegível conserva o aviso.
 */
export function resolveStrandedCarry(
  prev: NovosStranded | undefined,
  next: NovosStranded | undefined,
  baseDir: string = CLARICE_BASE,
): NovosStranded | undefined {
  if (next) return next;
  if (!prev?.key || !prev.cycle) return prev;
  const path = resolve(clariceSegmentsDir(prev.cycle, baseDir), "group-campaigns.json");
  try {
    const entries = JSON.parse(readFileSync(path, "utf8")) as Array<{ key?: string; status?: string; sendNowAcceptedAt?: string }>;
    const fired = entries.some((e) => e.key === prev.key && (e.status === "sent" || typeof e.sendNowAcceptedAt === "string"));
    return fired ? undefined : prev;
  } catch {
    return prev;
  }
}

export function novosRunStatusPath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "last-novos-run-status.json");
}

const KNOWN_STATUSES: readonly NovosRunStatusValue[] = ["sent", "empty", "uncertain", "other-error"];

/** Lê o status persistido. Tolerante: ausente/corrompido/shape inesperado → `null` (nunca lança). */
export function readNovosRunStatus(baseDir: string = CLARICE_BASE): NovosRunStatus | null {
  const path = novosRunStatusPath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NovosRunStatus>;
    if (typeof parsed.status !== "string" || !KNOWN_STATUSES.includes(parsed.status as NovosRunStatusValue)) return null;
    if (typeof parsed.checkedAt !== "string") return null;
    return {
      status: parsed.status as NovosRunStatusValue,
      checkedAt: parsed.checkedAt,
      detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
      ...(parseStranded(parsed.stranded) ? { stranded: parseStranded(parsed.stranded) } : {}),
    };
  } catch {
    return null;
  }
}

/** Escreve o status (escrita atômica). Cria o diretório se faltar. */
export function writeNovosRunStatus(status: NovosRunStatus, baseDir: string = CLARICE_BASE): void {
  mkdirSync(baseDir, { recursive: true });
  writeFileAtomic(novosRunStatusPath(baseDir), JSON.stringify(status, null, 2) + "\n");
}

/** #13098: limpa o aviso de presos (o editor liberou a seleção ou disparou a
 * key por fora). Mantém o resto do status. Devolve se havia o que limpar. */
export function clearNovosStranded(baseDir: string = CLARICE_BASE): boolean {
  const prev = readNovosRunStatus(baseDir);
  if (!prev?.stranded) return false;
  const { stranded: _drop, ...rest } = prev;
  writeNovosRunStatus(rest, baseDir);
  return true;
}

// CLI: `npx tsx scripts/lib/clarice-novos-run-status.ts [--clear-stranded]`
if (isMainModule(import.meta.url)) {
  if (hasFlag(process.argv.slice(2), "clear-stranded")) {
    console.log(clearNovosStranded() ? "aviso de presos limpo" : "nenhum aviso de presos gravado");
  } else {
    console.log(JSON.stringify(readNovosRunStatus(), null, 2));
  }
}
