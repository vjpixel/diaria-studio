/**
 * clarice-studio-campaign-cache.ts (#6720 Fatia A)
 *
 * O painel Clarice do Studio, no caminho `?fresh=1` (`renderClariceDashboardLiveUncached`
 * em `scripts/studio-ui/dashboard-clarice.ts`), chama `fetchRecentCampaigns` com
 * `skipKvCache=true` — mecanismo do #4186 pra NUNCA ler/escrever no KV
 * COMPARTILHADO de produção a partir de uma sessão local. Isso funciona (protege
 * o KV real), mas tem um custo que o #4186 não tinha como evitar sem esta peça:
 * `skipKvCache=true` desliga o cache-aside INTEIRO — inclusive a leitura de
 * campanhas imutáveis (>7 dias, `isImmutableCampaign` em brevo-api.ts) que nunca
 * vão mudar de novo. Resultado: todo reload do painel Studio refaz até
 * `CAMPAIGNS_FETCH_LIMIT` (100) × ~2 GETs na Brevo — inclusive pra campanhas de
 * meses atrás.
 *
 * Este módulo dá ao Studio um cache PRÓPRIO, local, sem tocar o KV de produção:
 * um `KVNamespace`-like (mesmo formato mínimo `get`/`put`/`delete` que
 * `MemoryKv` em dashboard-clarice.ts já implementa) que persiste em ARQUIVO —
 * um por chave, no padrão já usado por `data/beehiiv-cache/posts/{id}.json`
 * (`scripts/beehiiv-sync.ts`) — em vez de em memória de processo. Passado como
 * `env.STATS_CACHE` SÓ para as 3 chamadas que hoje usam `skipKvCache=true`
 * (`fetchRecentCampaigns`/`fetchScheduledCampaigns`/`fetchPlanCredits`), com
 * `skipKvCache=false` — o código de cache-aside de brevo-api.ts passa a rodar
 * de verdade, só que contra ESTE KV local em vez do namespace de produção.
 *
 * NÃO usa SQLite/WAL: `data/` é uma junction do OneDrive sincronizada entre
 * máquinas — WAL + sync em background + múltiplas máquinas escrevendo é risco
 * de corrupção (decisão explícita da issue #6720). Arquivo-por-chave, escrito
 * uma única vez e nunca reescrito, é imune a esse cenário — ou o arquivo
 * chegou inteiro pelo sync, ou ainda não chegou; nunca meio-escrito.
 *
 * Decisão de o que vai a disco: reusa a distinção que brevo-api.ts JÁ faz —
 * `put(key, value, { expirationTtl })` com TTL = dado recente/mutável (nunca
 * persistido, só cacheado em memória pela vida do processo); `put(key, value)`
 * sem TTL = dado imutável (`isImmutableCampaign`, >7 dias) → vai a disco. Não
 * precisamos reimplementar "é imutável?" aqui — o caller (fetchRecentCampaigns)
 * já decidiu isso ao escolher se passa `expirationTtl` ou não.
 *
 * Versionamento de shape (#6720 item 3): a chave de arquivo embute
 * `CAMPAIGN_CACHE_SCHEMA_VERSION` (`{chave}.v{N}.json`). Um bump de versão não
 * tenta migrar nem invalidar em leitura — simplesmente aponta pra um arquivo
 * novo, que começa vazio (cache miss → refetch ao vivo → nova escrita na nova
 * versão). Arquivos da versão antiga ficam órfãos no diretório (inofensivo,
 * nunca mais lidos) — mais simples e mais seguro que comparar/migrar um shape
 * em disco que pode ter sido escrito por um binário mais antigo.
 *
 * Fail-soft por construção (mesmo padrão de `MemoryKv`/`buildContactsSummaryLocal`
 * em dashboard-clarice.ts): qualquer erro de FS (data/ ausente — sessão cloud
 * sem o junction OneDrive, disco cheio, permissão) degrada silenciosamente —
 * o valor fica só em memória para aquele processo, nunca lança, nunca derruba
 * o render.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// import.meta.dirname pode vir undefined em alguns loaders — fallback pra cwd
// (mesmo racional de clarice-db.ts). Scripts do projeto rodam a partir da raiz.
const ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..", "..") : process.cwd();

export const DEFAULT_CAMPAIGN_CACHE_DIR = resolve(ROOT, "data/clarice-studio-cache/campaigns");

/** Bump ao mudar o shape de `BrevoCampaign`/`BrevoList`/plan-credits que este
 * cache persiste — ver docstring do módulo, "Versionamento de shape". */
export const CAMPAIGN_CACHE_SCHEMA_VERSION = 1;

/** Interface mínima usada pelas 3 chamadas de brevo-api.ts que este módulo
 * substitui (`env.STATS_CACHE`) — mesmo shape de `MemoryKv` em
 * dashboard-clarice.ts, só que backed por arquivo em vez de `Map` em memória. */
export interface LocalFileKv {
  get(key: string, type?: "json" | "text"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Sanitiza uma chave KV (`stats:12345`, `list:99`, `brevo:plan-credits`) para
 * um nome de arquivo seguro em qualquer FS (Windows incluído — `:` não é
 * permitido em nome de arquivo no NTFS). */
function sanitizeKeyForFilename(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function filePathFor(dir: string, key: string, version: number): string {
  return resolve(dir, `${sanitizeKeyForFilename(key)}.v${version}.json`);
}

/** Write atômico (tmp + rename) — mesmo padrão de `atomicWrite` em
 * scripts/beehiiv-sync.ts. Evita arquivo meio-escrito se o processo morrer
 * no meio do write (sync do OneDrive rodando em paralelo, por exemplo). */
function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Cria o adapter local. `dir`/`version` só existem pra teste (isolar cada
 * caso num diretório temporário e/ou forçar um bump de versão sem depender
 * da constante do módulo).
 */
export function createLocalFileCampaignCache(
  opts: { dir?: string; version?: number } = {},
): LocalFileKv {
  const dir = opts.dir ?? DEFAULT_CAMPAIGN_CACHE_DIR;
  const version = opts.version ?? CAMPAIGN_CACHE_SCHEMA_VERSION;

  // Cobre 2 papéis: (a) hit-rápido dentro do mesmo processo pra chaves que
  // acabaram de ser lidas/escritas do disco, e (b) ÚNICO lugar onde valores
  // com TTL (recentes/mutáveis) ficam — nunca vão a disco, de propósito.
  const memory = new Map<string, string>();
  let dirReady = false;

  function ensureDir(): boolean {
    if (dirReady) return true;
    try {
      mkdirSync(dir, { recursive: true });
      dirReady = true;
      return true;
    } catch {
      return false; // data/ ausente, sem permissão, disco cheio — degrada pra memória
    }
  }

  return {
    async get(key, type) {
      const cached = memory.get(key);
      if (cached !== undefined) {
        return type === "text" ? cached : safeJsonParse(cached);
      }
      const path = filePathFor(dir, key, version);
      try {
        if (!existsSync(path)) return null;
        const raw = readFileSync(path, "utf8");
        memory.set(key, raw); // aquece o hit-rápido em memória pro resto do processo
        return type === "text" ? raw : safeJsonParse(raw);
      } catch {
        return null; // arquivo corrompido/inacessível — trata como miss, nunca lança
      }
    },

    async put(key, value, putOpts) {
      memory.set(key, value); // hit imediato dentro deste processo, sempre
      // TTL presente = dado recente/mutável (ver docstring do módulo) — nunca
      // persistido em disco; expira sozinho quando este processo reiniciar.
      if (putOpts?.expirationTtl) return;
      if (!ensureDir()) return;
      const path = filePathFor(dir, key, version);
      try {
        // Escrita única — dado imutável nunca muda, então uma 2ª escrita nunca
        // teria conteúdo diferente; pular também evita I/O redundante em cada
        // reload do painel depois do cache já ter aquecido.
        if (existsSync(path)) return;
        atomicWriteFile(path, value);
      } catch {
        // fail-soft — já está em memória, suficiente para este processo
      }
    },

    async delete(key) {
      memory.delete(key);
      try {
        const path = filePathFor(dir, key, version);
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // fail-soft
      }
    },
  };
}
