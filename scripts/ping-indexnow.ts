#!/usr/bin/env node
/**
 * scripts/ping-indexnow.ts (#4909 item 2)
 *
 * CLI chamado por `.github/workflows/deploy-arquivo.yml` DEPOIS do deploy,
 * só no step gated por "o diff do push tocou
 * `workers/arquivo/src/hubs/*.generated.ts`?" — o próprio workflow decide
 * SE roda este script; este script decide (via `buildIndexNowPayload`,
 * `scripts/lib/indexnow.ts`) SE há algo a pingar dentro da lista recebida
 * (defesa em profundidade: mesmo chamado sem gate, um input sem
 * `.generated.ts` não pinga nada).
 *
 * **NUNCA rodar isto localmente contra produção.** É o mesmo princípio do
 * guard de publishers do overnight/develop (`context/overnight-dispatch-rules.md`
 * regra 1) aplicado aqui: código de ping é ok de editar/testar (com fetch
 * mockado), EXECUTAR contra o endpoint real é ação exclusiva do workflow do
 * GitHub Actions.
 *
 * O Google NÃO participa do IndexNow — quem recebe é o Bing
 * (api.indexnow.org, que replica pros demais motores participantes:
 * Yandex, Seznam), e por tabela alimenta o ChatGPT via parceria de busca da
 * OpenAI com a Microsoft. Não é garantia de citação — é só um aviso "isto
 * mudou, quando puder revisite" (ver `docs/seo-notes.md` Fato 3 pra mesma
 * ressalva já registrada sobre `<lastmod>`).
 *
 * Uso:
 *   npx tsx scripts/ping-indexnow.ts --changed-files-file /caminho/lista.txt --key <chave>
 *   npx tsx scripts/ping-indexnow.ts --changed-file workers/arquivo/src/hubs/x.generated.ts --key <chave>
 *
 * `--key` opcional na CLI — se omitido, cai pra `process.env.INDEXNOW_KEY`
 * (é assim que o workflow passa o secret). Sem chave (nem flag nem env) =
 * gate fechado, exit 0 sem pingar (ver docstring de `buildIndexNowPayload`
 * pro racional de tratar isso como "ainda não provisionado", não erro).
 *
 * Exit: 0 quando o payload foi montado com sucesso e pingado (ou quando o
 * gate fechou — nada a pingar, isso NÃO é falha); 1 em falha de rede/API
 * com payload não-vazio.
 */
import { readFileSync } from "node:fs";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { buildIndexNowPayload, ARQUIVO_HOST, type IndexNowPayload } from "./lib/indexnow.ts";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const LOG_PREFIX = "[ping-indexnow]";

/** Lê a lista de arquivos alterados de `--changed-files-file` (1 path por
 * linha — formato cru de `git diff --name-only`) e/ou de `--changed-file`
 * repetido (útil em teste/uso manual pontual). Concatena as duas fontes se
 * ambas forem passadas. */
export function readChangedFiles(argv: string[]): string[] {
  const files: string[] = [];
  const filePath = getStringArg(argv, "changed-files-file");
  if (filePath) {
    files.push(
      ...readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--changed-file" && argv[i + 1] !== undefined) files.push(argv[i + 1]);
  }
  return files;
}

export interface PingResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** I/O isolado — o único ponto deste módulo que faz uma chamada de rede
 * real. `fetchFn` injetável pra teste (nunca chamado com o `fetch` global
 * em teste — ver `test/ping-indexnow.test.ts`). `payload === null` (gate
 * fechado) é NO-OP, sempre `ok: true`. */
export async function pingIndexNow(
  payload: IndexNowPayload | null,
  fetchFn: typeof fetch = fetch,
): Promise<PingResult> {
  if (!payload) return { ok: true, status: null, error: null };
  try {
    const res = await fetchFn(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, status: res.status, error: body };
    }
    return { ok: true, status: res.status, error: null };
  } catch (e) {
    return { ok: false, status: null, error: (e as Error).message };
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const changedFiles = readChangedFiles(argv);
  const key = getStringArg(argv, "key") ?? process.env.INDEXNOW_KEY ?? "";
  const host = getStringArg(argv, "host") ?? ARQUIVO_HOST;

  const payload = buildIndexNowPayload(changedFiles, key, { host });

  if (!payload) {
    console.log(
      `${LOG_PREFIX} gate fechado (nenhum .generated.ts na lista de ${changedFiles.length} arquivo(s), ou --key/INDEXNOW_KEY ausente) — nada a pingar.`,
    );
    return 0;
  }

  console.log(
    `${LOG_PREFIX} pingando IndexNow (Bing — Google não participa) — ${payload.urlList.length} URL(s): ${payload.urlList.join(", ")}`,
  );
  const result = await pingIndexNow(payload);
  if (!result.ok) {
    console.error(`${LOG_PREFIX} falha: status=${result.status} error=${result.error}`);
    return 1;
  }
  console.log(`${LOG_PREFIX} ok (status=${result.status}).`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`${LOG_PREFIX} erro:`, e);
      process.exitCode = 1;
    });
}
