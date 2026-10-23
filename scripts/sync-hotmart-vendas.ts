/**
 * sync-hotmart-vendas.ts (#10734, item 4c)
 *
 * Traz as vendas da Hotmart do KV `CURSOS_SUBSCRIBERS` (gravadas pelo Worker
 * `diaria-site`, em `workers/site`, com TTL de 400 dias) para o espelho
 * append-only `data/hotmart/vendas.jsonl`, antes que a retenção do KV as
 * apague. Lê pela rota autenticada `GET {base}/hotmart/vendas?de=&ate=` (token
 * `HOTMART_VENDAS_TOKEN`), nunca pela API do KV: a rota já valida e deduplica
 * os registros, e o token dela só dá leitura das vendas, não do namespace
 * inteiro.
 *
 * Idempotente por transação + evento (`scripts/lib/hotmart-vendas-espelho.ts`):
 * rodar de novo não acrescenta nada; linha já espelhada nunca é reescrita. Só
 * acrescenta ao arquivo (`appendFileSync`), nunca o reescreve, e acrescenta
 * JANELA A JANELA (#10876 item 2): num backfill longo, a falha numa janela não
 * descarta as anteriores. Ao lado do espelho fica o estado
 * (`vendas.estado.json`): cobertura de dias já lidos (o ARPU/LTV só conta a
 * Hotmart de um mês coberto, `ltv.ts`) e as chaves inválidas do KV já
 * avisadas (#10881 item 3). Dia com chave inválida no KV, mesmo já avisada,
 * fica fora da cobertura (#10909): a venda dele não está no espelho — e sai
 * da cobertura já gravada, se estava nela (#10991 item 2). Nenhum dia antes do
 * go-live do webhook de vendas (`hotmart.vendas_desde` em
 * `platform.config.json`, 21/10/2026) entra na cobertura (#10991): o KV não
 * recebia vendas, e "lido sem venda" ali não quer dizer "sem venda".
 *
 * Janela sem período explícito: 35 dias, e 93 dias na rodada dos dias 1-7 do
 * mês (varredura mensal, #10876 item 1: pega evento reenviado com
 * `creation_date` antigo). Evento que chega com `creation_date` mais de 93
 * dias no passado só entra por backfill manual (`--de`). Leitura e
 * acréscimo rodam sob um lock (`{espelho}.lock`, aberto com `wx`): duas
 * rodadas ao mesmo tempo acrescentariam as mesmas linhas duas vezes. Lock com
 * mais de 1h é considerado abandonado e tomado, com aviso.
 *
 * Uso:
 *   npx tsx scripts/sync-hotmart-vendas.ts                       # últimos 35 dias (93 nos dias 1-7 do mês, #10876)
 *   npx tsx scripts/sync-hotmart-vendas.ts --dias 90
 *   npx tsx scripts/sync-hotmart-vendas.ts --de 2026-01-01 --ate 2026-10-22   # backfill (janelas de 93 dias)
 *   npx tsx scripts/sync-hotmart-vendas.ts --de 2026-01-01       # --ate default = hoje (Brasília)
 *   npx tsx scripts/sync-hotmart-vendas.ts --dry-run             # lê e conta, não grava
 *   npx tsx scripts/sync-hotmart-vendas.ts --out /tmp/vendas.jsonl
 *   npx tsx scripts/sync-hotmart-vendas.ts --vendas-desde 2026-01-01   # sobrepõe hotmart.vendas_desde (teste)
 *
 * Em falha (exit 1) as janelas concluídas antes dela já ficaram gravadas.
 *
 * `--ate` sozinho (sem `--de`) é recusado: não há início óbvio para o backfill.
 *
 * Env:
 *   HOTMART_VENDAS_TOKEN      obrigatório (Doppler/.env; o mesmo secret do Worker)
 *   HOTMART_VENDAS_BASE_URL   opcional (default https://diar.ia.br; ou --base-url)
 *
 * Saída:
 *   0 = ok (com ou sem novidade);
 *   1 = falha de leitura/escrita/rede (inclui timeout de 30s por janela e lock
 *       ocupado por outra rodada); só ficam gravadas as janelas concluídas
 *       antes da falha;
 *   2 = configuração ou argumento inválido (token ausente, junction `data/`
 *       não montada sem `--out`, data inválida, período invertido, flags
 *       conflitantes); nada é gravado;
 *   3 = o que era válido foi gravado, mas a rota devolveu registros fora do
 *       formato ou o Worker pulou chaves inválidas NOVAS no KV. Não está em
 *       `successExitCodes` da task: a unit sai `failed` e o alarme pega. A
 *       chave inválida vai para o estado e, nas rodadas seguintes, só gera
 *       aviso (senão a task falharia toda semana até o TTL de 400 dias).
 *
 * Agendado: task `Diaria-Hotmart-Vendas-Sync` (semanal), ver
 * `scripts/lib/scheduled-tasks.ts` e `docs/scheduled-tasks-registry.md`. O
 * guard da task (`guard.requiredFile`) e este script checam o mesmo arquivo
 * sentinela (`SENTINELA_DATA_REL_PATH`), não a existência de `data/`, que o
 * runner cria ao gravar o log mesmo com a junction desmontada.
 */
import "dotenv/config";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { brtDay } from "./lib/shared/hotmart-abandono.ts";
import { HOTMART_VENDAS_PATH } from "./lib/shared/hotmart-vendas.ts";
import {
  ESPELHO_REL_PATH,
  SENTINELA_DATA_REL_PATH,
  diasARetirarDaJanela,
  diasPadraoDoSync,
  estadoPathDoEspelho,
  parseEstadoSync,
  parseRespostaVendas,
  parseVendasDesde,
  periodoPadrao,
  planejarJanelas,
  registrarJanelaNoEstado,
  trechosCobertosDaJanela,
  sincronizarEspelho,
  type EstadoSync,
  type Periodo,
  type RespostaVendas,
} from "./lib/hotmart-vendas-espelho.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadHotmartVendasDesde } from "./lib/hotmart-vendas-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://diar.ia.br";
/** Sem User-Agent a Cloudflare às vezes responde com challenge em vez da rota. */
const USER_AGENT = "diaria-studio-sync-hotmart-vendas/1.0 (+https://diar.ia.br)";
/** Teto por chamada da rota. Sem ele, um servidor que não responde deixa a
 * task pendurada até o systemd matar. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Lock mais velho que isso é de uma rodada que morreu sem limpar. */
export const LOCK_STALE_MS = 60 * 60 * 1000;

export const EXIT_OK = 0;
export const EXIT_FALHA = 1;
export const EXIT_CONFIG = 2;
export const EXIT_REGISTROS_INVALIDOS = 3;

export function urlDaJanela(baseUrl: string, de: string, ate: string): string {
  const u = new URL(HOTMART_VENDAS_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  u.searchParams.set("de", de);
  u.searchParams.set("ate", ate);
  return u.toString();
}

/** `true` quando a junction `data/` está montada sob `root`, medido pelo
 * arquivo sentinela (o store de assinantes), não pela pasta. */
export function dataMontado(root: string): boolean {
  return existsSync(join(root, "data", ...SENTINELA_DATA_REL_PATH.split("/")));
}

export async function buscarJanelaHttp(
  baseUrl: string,
  token: string,
  de: string,
  ate: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<RespostaVendas> {
  let res: Response;
  let texto: string;
  try {
    res = await fetch(urlDaJanela(baseUrl, de, ate), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    texto = await res.text();
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`/hotmart/vendas ${de}..${ate}: sem resposta em ${timeoutMs} ms (timeout)`);
    }
    throw e;
  }
  let body: unknown;
  try {
    body = JSON.parse(texto);
  } catch {
    throw new Error(`/hotmart/vendas ${de}..${ate}: HTTP ${res.status}, corpo não é JSON (${texto.length} caracteres)`);
  }
  if (!res.ok) {
    const erro = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string" ? (body as Record<string, unknown>).error : "?";
    throw new Error(`/hotmart/vendas ${de}..${ate}: HTTP ${res.status} (${erro})`);
  }
  return parseRespostaVendas(body);
}

/**
 * Cria `lockPath` com `wx` (falha se já existe) e devolve a função que o
 * remove. Lock existente com mais de `LOCK_STALE_MS` é tomado, com aviso em
 * `avisar`; lock recente lança.
 */
export function adquirirLock(lockPath: string, nowMs: number = Date.now(), avisar: (msg: string) => void = console.warn): () => void {
  const criar = (): void => {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, `${process.pid} ${new Date(nowMs).toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
  };
  try {
    criar();
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e;
    const idadeMs = nowMs - statSync(lockPath).mtimeMs;
    if (idadeMs <= LOCK_STALE_MS) {
      throw new Error(`lock ${lockPath} ocupado (outra rodada do sync em andamento há ${Math.round(idadeMs / 1000)}s)`);
    }
    avisar(`sync-hotmart-vendas: AVISO: lock ${lockPath} abandonado há ${Math.round(idadeMs / 60_000)} min; tomando.`);
    rmSync(lockPath, { force: true });
    criar();
  }
  return () => rmSync(lockPath, { force: true });
}

/**
 * Resolve o período pedido na linha de comando. Lança (o CLI devolve exit 2)
 * em combinação inválida, data inválida ou período invertido.
 */
export function resolverPeriodoCli(opts: { de?: string; ate?: string; dias?: number; nowMs: number }): { periodo: Periodo; janelas: Periodo[] } {
  const { de, ate, dias, nowMs } = opts;
  if ((de || ate) && dias !== undefined) throw new Error("use --dias OU --de/--ate, não os dois.");
  if (ate && !de) throw new Error("--ate exige --de (sem --de não há início para o backfill).");
  const periodo: Periodo = de ? { de, ate: ate ?? brtDay(nowMs) } : periodoPadrao(nowMs, dias ?? diasPadraoDoSync(nowMs));
  return { periodo, janelas: planejarJanelas(periodo.de, periodo.ate) };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const outArg = getStringArg(argv, "out", { example: "/tmp/vendas.jsonl" });
  const baseUrl = getStringArg(argv, "base-url", { example: DEFAULT_BASE_URL }) ?? process.env.HOTMART_VENDAS_BASE_URL ?? DEFAULT_BASE_URL;

  let periodo: Periodo;
  let janelas: Periodo[];
  try {
    ({ periodo, janelas } = resolverPeriodoCli({
      de: getStringArg(argv, "de", { example: "2026-10-01" }),
      ate: getStringArg(argv, "ate", { example: "2026-10-22" }),
      dias: getIntArg(argv, "dias", { min: 1 }),
      nowMs: Date.now(),
    }));
  } catch (e) {
    console.error(`sync-hotmart-vendas: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CONFIG;
  }

  const token = process.env.HOTMART_VENDAS_TOKEN?.trim();
  if (!token) {
    console.error("sync-hotmart-vendas: HOTMART_VENDAS_TOKEN ausente no ambiente (Doppler/.env).");
    return EXIT_CONFIG;
  }

  // `data/` é a junction do OneDrive. Sem ela montada, gravar criaria um
  // espelho local solto que nunca chega às outras máquinas. A pasta sozinha
  // não prova nada (o runner a cria para o log): checa o sentinela.
  if (!outArg && !dataMontado(ROOT)) {
    console.error(
      `sync-hotmart-vendas: data/${SENTINELA_DATA_REL_PATH} não existe (junction do OneDrive não montada?); ` +
        "abortando sem gravar. Use --out para outro destino.",
    );
    return EXIT_CONFIG;
  }
  const outPath = outArg ? resolve(outArg) : join(ROOT, "data", ...ESPELHO_REL_PATH.split("/"));

  // #10991: go-live do webhook de vendas. Sem ele, nada entra na cobertura
  // (o espelho segue sendo gravado; o ARPU/LTV vê a Hotmart sem dado).
  const vendasDesdeArg = getStringArg(argv, "vendas-desde", { example: "2026-10-21" });
  let vendasDesde: string | null;
  if (vendasDesdeArg !== undefined) {
    vendasDesde = parseVendasDesde({ hotmart: { vendas_desde: vendasDesdeArg } });
    if (vendasDesde === null) {
      console.error(`sync-hotmart-vendas: --vendas-desde inválido "${vendasDesdeArg}" (use AAAA-MM-DD).`);
      return EXIT_CONFIG;
    }
  } else {
    const cfg = loadHotmartVendasDesde(ROOT);
    vendasDesde = cfg.vendasDesde;
    if (vendasDesde === null) {
      console.warn(`sync-hotmart-vendas: AVISO: ${cfg.motivo}; o espelho é gravado, mas nenhum dia entra na cobertura.`);
    }
  }

  let liberar: (() => void) | null = null;
  if (!dryRun) {
    mkdirSync(dirname(outPath), { recursive: true });
    liberar = adquirirLock(`${outPath}.lock`);
  }
  try {
    const textoAtual = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    // #10876/#10881: estado ao lado do espelho (cobertura + chaves inválidas
    // já avisadas). Ilegível lança: zerá-lo reabriria alarmes e apagaria a
    // cobertura que o ARPU/LTV lê.
    const estadoPath = estadoPathDoEspelho(outPath);
    let estado: EstadoSync = parseEstadoSync(existsSync(estadoPath) ? readFileSync(estadoPath, "utf8") : null);
    let linhasGravadas = 0;
    let janelasConcluidas = 0;
    let r: Awaited<ReturnType<typeof sincronizarEspelho>>;
    try {
      r = await sincronizarEspelho({
        janelas,
        buscarJanela: (d, a) => buscarJanelaHttp(baseUrl, token, d, a),
        textoAtual,
        chavesInvalidasConhecidas: new Set(estado.chaves_invalidas_conhecidas),
        // #10876 item 2: grava janela a janela; a falha da janela N não
        // descarta o que as anteriores leram.
        aoConcluirJanela: dryRun
          ? undefined
          : (j) => {
              if (j.acrescentar) {
                appendFileSync(outPath, j.acrescentar, "utf8");
                linhasGravadas += j.novos.length;
              }
              janelasConcluidas++;
              const agora = Date.now();
              estado = registrarJanelaNoEstado(
                estado,
                trechosCobertosDaJanela(j.janela, j, agora, vendasDesde),
                j.chavesIgnoradasNovas,
                new Date(agora).toISOString(),
                // #10991: a perda tira o dia da cobertura já gravada, e nada
                // antes do go-live fica nela (limpa estado anterior ao fix).
                { retirar: diasARetirarDaJanela(j.janela, j), vendasDesde },
              );
              writeFileAtomic(estadoPath, JSON.stringify(estado, null, 2) + "\n");
            },
      });
    } catch (e) {
      if (janelasConcluidas > 0) {
        console.error(
          `sync-hotmart-vendas: falhou depois de ${janelasConcluidas} janela(s) concluída(s); ${linhasGravadas} linha(s) delas ficaram gravadas em ${outPath} ` +
            "(rodar de novo continua de onde parou, a dedup ignora o que já está lá).",
        );
      }
      throw e;
    }

    console.log(
      `sync-hotmart-vendas: ${periodo.de}..${periodo.ate} em ${r.janelas} janela(s): ${r.recebidos} evento(s) lidos, ` +
        `${r.novos.length} novo(s), ${r.jaPresentes} já no espelho` +
        (r.descartados ? `, ${r.descartados} descartado(s) por formato` : "") +
        (r.ignoradosNoKv ? `, ${r.ignoradosNoKv} chave(s) inválida(s) no KV` : ""),
    );
    if (r.invalidasNoEspelho) {
      console.warn(`sync-hotmart-vendas: AVISO: ${r.invalidasNoEspelho} linha(s) inválida(s) no espelho ${outPath} (mantidas como estão).`);
    }
    if (r.duplicadasNoEspelho) {
      console.warn(`sync-hotmart-vendas: AVISO: ${r.duplicadasNoEspelho} linha(s) com chave repetida no espelho ${outPath} (lidas só uma vez).`);
    }

    if (dryRun) {
      console.log(`sync-hotmart-vendas: --dry-run, nada gravado (destino seria ${outPath}).`);
    } else if (r.acrescentar) {
      console.log(`sync-hotmart-vendas: ${r.novos.length} linha(s) acrescentada(s) em ${outPath}.`);
    }

    const invalidasJaConhecidas = r.ignoradosNoKv - r.ignoradosNoKvNovos;
    if (invalidasJaConhecidas > 0) {
      console.warn(
        `sync-hotmart-vendas: AVISO: ${invalidasJaConhecidas} chave(s) inválida(s) no KV já avisada(s) numa rodada anterior ` +
          `(lista em ${estadoPath}); não viram alarme de novo, mas o dia de cada uma segue fora da cobertura ` +
          "(o mês dele sai sem dado da Hotmart no ARPU/LTV, nunca como receita a menos, #10909).",
      );
    }
    if (r.descartados + r.ignoradosNoKvNovos > 0) {
      console.error(
        `sync-hotmart-vendas: ${r.descartados} registro(s) fora do formato na resposta e ${r.ignoradosNoKvNovos} chave(s) ` +
          "inválida(s) NOVA(S) no KV ficaram de fora do espelho; o resto foi gravado. Exit 3 para virar alarme" +
          (dryRun ? "." : " (as chaves novas ficam registradas no estado e não repetem o alarme na próxima rodada)."),
      );
      return EXIT_REGISTROS_INVALIDOS;
    }
    return EXIT_OK;
  } finally {
    liberar?.();
  }
}

if (isMainModule(import.meta.url)) {
  void runCli(main, {
    onError: (e) => console.error(`sync-hotmart-vendas: ${e instanceof Error ? e.message : String(e)}`),
  });
}
