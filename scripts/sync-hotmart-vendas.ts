/**
 * sync-hotmart-vendas.ts (#10734, item 4c)
 *
 * Traz as vendas da Hotmart do KV `CURSOS_SUBSCRIBERS` (gravadas pelo Worker
 * `site`, TTL de 400 dias) para o espelho append-only `data/hotmart/vendas.jsonl`,
 * antes que a retenção do KV as apague. Lê pela rota autenticada
 * `GET {base}/hotmart/vendas?de=&ate=` (token `HOTMART_VENDAS_TOKEN`), nunca
 * pela API do KV: a rota já valida e deduplica os registros, e o token dela só
 * dá leitura das vendas, não do namespace inteiro.
 *
 * Idempotente por transação + evento (`scripts/lib/hotmart-vendas-espelho.ts`):
 * rodar de novo não acrescenta nada; linha já espelhada nunca é reescrita. Só
 * acrescenta ao arquivo (`appendFileSync`), nunca o reescreve.
 *
 * Uso:
 *   npx tsx scripts/sync-hotmart-vendas.ts                       # últimos 35 dias
 *   npx tsx scripts/sync-hotmart-vendas.ts --dias 90
 *   npx tsx scripts/sync-hotmart-vendas.ts --de 2026-10-01 --ate 2026-10-22   # backfill (janelas de 93 dias)
 *   npx tsx scripts/sync-hotmart-vendas.ts --dry-run             # lê e conta, não grava
 *   npx tsx scripts/sync-hotmart-vendas.ts --out /tmp/vendas.jsonl
 *
 * Env:
 *   HOTMART_VENDAS_TOKEN      obrigatório (Doppler/.env; o mesmo secret do Worker)
 *   HOTMART_VENDAS_BASE_URL   opcional (default https://diar.ia.br; ou --base-url)
 *
 * Saída: 0 = ok (com ou sem novidade); 1 = falha de leitura/escrita;
 * 2 = configuração ausente (token, ou `data/` não montado sem `--out`).
 *
 * Agendado: task `Diaria-Hotmart-Vendas-Sync` (semanal), ver
 * `scripts/lib/scheduled-tasks.ts` e `docs/scheduled-tasks-registry.md`.
 */
import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { HOTMART_VENDAS_PATH } from "./lib/shared/hotmart-vendas.ts";
import {
  ESPELHO_REL_PATH,
  SYNC_DIAS_PADRAO,
  parseRespostaVendas,
  periodoPadrao,
  planejarJanelas,
  sincronizarEspelho,
  type RespostaVendas,
} from "./lib/hotmart-vendas-espelho.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "https://diar.ia.br";
/** Sem User-Agent a Cloudflare às vezes responde com challenge em vez da rota. */
const USER_AGENT = "diaria-studio-sync-hotmart-vendas/1.0 (+https://diar.ia.br)";

export function urlDaJanela(baseUrl: string, de: string, ate: string): string {
  const u = new URL(HOTMART_VENDAS_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  u.searchParams.set("de", de);
  u.searchParams.set("ate", ate);
  return u.toString();
}

async function buscarJanelaHttp(baseUrl: string, token: string, de: string, ate: string): Promise<RespostaVendas> {
  const res = await fetch(urlDaJanela(baseUrl, de, ate), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
  });
  const texto = await res.text();
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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const de = getStringArg(argv, "de", { example: "2026-10-01" });
  const ate = getStringArg(argv, "ate", { example: "2026-10-22" });
  const dias = getIntArg(argv, "dias", { min: 1 });
  const outArg = getStringArg(argv, "out", { example: "/tmp/vendas.jsonl" });
  const baseUrl = getStringArg(argv, "base-url", { example: DEFAULT_BASE_URL }) ?? process.env.HOTMART_VENDAS_BASE_URL ?? DEFAULT_BASE_URL;

  if ((de || ate) && dias !== undefined) {
    console.error("sync-hotmart-vendas: use --dias OU --de/--ate, não os dois.");
    return 2;
  }
  const token = process.env.HOTMART_VENDAS_TOKEN?.trim();
  if (!token) {
    console.error("sync-hotmart-vendas: HOTMART_VENDAS_TOKEN ausente no ambiente (Doppler/.env).");
    return 2;
  }

  // `data/` é a junction do OneDrive. Sem ela montada, gravar criaria um
  // espelho local solto que nunca chega às outras máquinas.
  if (!outArg && !existsSync(join(ROOT, "data"))) {
    console.error("sync-hotmart-vendas: data/ não existe (junction do OneDrive não montada?); abortando sem gravar. Use --out para outro destino.");
    return 2;
  }
  const outPath = outArg ? resolve(outArg) : join(ROOT, "data", ...ESPELHO_REL_PATH.split("/"));

  const periodo = de || ate ? { de: de ?? ate!, ate: ate ?? de! } : periodoPadrao(Date.now(), dias ?? SYNC_DIAS_PADRAO);
  const janelas = planejarJanelas(periodo.de, periodo.ate);
  const textoAtual = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";

  const r = await sincronizarEspelho({
    janelas,
    buscarJanela: (d, a) => buscarJanelaHttp(baseUrl, token, d, a),
    textoAtual,
  });

  console.log(
    `sync-hotmart-vendas: ${periodo.de}..${periodo.ate} em ${r.janelas} janela(s): ${r.recebidos} evento(s) lidos, ` +
      `${r.novos.length} novo(s), ${r.jaPresentes} já no espelho` +
      (r.descartados ? `, ${r.descartados} descartado(s) por formato` : "") +
      (r.ignoradosNoKv ? `, ${r.ignoradosNoKv} chave(s) inválida(s) no KV` : ""),
  );
  if (dryRun) {
    console.log(`sync-hotmart-vendas: --dry-run, nada gravado (destino seria ${outPath}).`);
    return 0;
  }
  if (r.acrescentar) {
    mkdirSync(dirname(outPath), { recursive: true });
    appendFileSync(outPath, r.acrescentar, "utf8");
    console.log(`sync-hotmart-vendas: ${r.novos.length} linha(s) acrescentada(s) em ${outPath}.`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, {
    onError: (e) => console.error(`sync-hotmart-vendas: ${e instanceof Error ? e.message : String(e)}`),
  });
}
