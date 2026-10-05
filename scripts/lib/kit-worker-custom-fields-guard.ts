/**
 * scripts/lib/kit-worker-custom-fields-guard.ts (#9663)
 *
 * Guard: todo `KIT_*_FIELD = "{key}"` declarado em `workers/{w}/wrangler.toml`
 * precisa existir como custom field na conta Kit.
 *
 * ## Por que existe
 *
 * O Kit v4 DESCARTA EM SILÊNCIO as chaves de `fields` que não existem como
 * custom field: o POST do worker responde 2xx e o valor some (mesma classe de
 * "2xx não é prova" do #6582). Foi assim que o worker `reativar` passou de
 * 28/09 a 05/10/2026 gravando `confirmou_via = "brevo-reativar"` (#8438) num
 * field que nunca existiu — `self_confirmed_kit_botao` nunca apareceu e todo
 * clique no botão da Brevo caiu como `self_confirmed_kit` genérico (#9663).
 * Nenhum log do worker acusava nada, porque do lado dele não havia erro.
 *
 * O guard cobre a CLASSE (todos os workers, todas as vars `KIT_*_FIELD`), não
 * só `KIT_CONFIRMOU_VIA_FIELD`: o mesmo modo de falha apagou a atribuição UTM
 * de 25/08 a 26/08 (#6318) por um motivo vizinho (var ausente).
 *
 * ## Fronteira
 *
 * Parse e comparação são puros (testáveis sem rede). O I/O fica isolado em
 * `fetchKitCustomFieldKeys` (recebe o `fetch` do Kit por injeção) e no CLI
 * `scripts/check-kit-worker-custom-fields.ts`, que também é chamado pelo
 * `check-brevo-diaria-guardrail.ts` (task agendada de 4 em 4h) — é isso que
 * arma o guard (#7137 item 27: guard construído tem que ser armado).
 *
 * Limite conhecido: só enxerga vars declaradas no `wrangler.toml`. Um
 * `KIT_*_FIELD` setado como SECRET (`wrangler secret put`) não aparece aqui —
 * hoje nenhum é (todos são `[vars]`, nome de field não é sensível).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Uma var `KIT_*_FIELD` declarada num worker. */
export interface WorkerKitFieldVar {
  worker: string;
  varName: string;
  /** Valor da var = `key` do custom field no Kit. */
  fieldKey: string;
}

const KIT_FIELD_VAR_RE = /^\s*(KIT_[A-Z0-9_]*_FIELD)\s*=\s*"([^"]*)"\s*(?:#.*)?$/;

/**
 * Puro — extrai as vars `KIT_*_FIELD = "..."` de um `wrangler.toml`. Linhas
 * comentadas (`# KIT_X_FIELD = ...`) não casam (o regex exige a var no início
 * da linha, depois de espaço opcional). Valor vazio é ignorado — var vazia é
 * o "gate desligado" dos workers (`env.KIT_X_FIELD` falsy ⇒ nada é gravado),
 * não um field a conferir.
 */
export function parseWorkerKitFieldVars(worker: string, tomlText: string): WorkerKitFieldVar[] {
  const out: WorkerKitFieldVar[] = [];
  for (const line of tomlText.split(/\r?\n/)) {
    const m = KIT_FIELD_VAR_RE.exec(line);
    if (!m) continue;
    const fieldKey = m[2].trim();
    if (!fieldKey) continue;
    out.push({ worker, varName: m[1], fieldKey });
  }
  return out;
}

/** I/O (leitura local) — varre `workers/*\/wrangler.toml`. */
export function collectWorkerKitFieldVars(workersDir: string): WorkerKitFieldVar[] {
  if (!existsSync(workersDir)) return [];
  const out: WorkerKitFieldVar[] = [];
  for (const name of readdirSync(workersDir).sort()) {
    const toml = join(workersDir, name, "wrangler.toml");
    if (!existsSync(toml)) continue;
    out.push(...parseWorkerKitFieldVars(name, readFileSync(toml, "utf8")));
  }
  return out;
}

/**
 * Puro — vars cujo `fieldKey` não está entre as `key`s de custom field do
 * Kit. Comparação exata (o Kit usa a `key` como chave de `fields` no POST,
 * e ela é case-sensitive).
 */
export function findMissingKitCustomFields(
  configured: WorkerKitFieldVar[],
  existingKeys: Iterable<string>,
): WorkerKitFieldVar[] {
  const existing = new Set(existingKeys);
  return configured.filter((v) => !existing.has(v.fieldKey));
}

/** Puro — fingerprint estável (independe da ordem) pro dedup do alarme. */
export function missingFieldsFingerprint(missing: WorkerKitFieldVar[]): string {
  return [...new Set(missing.map((m) => `${m.worker}:${m.varName}=${m.fieldKey}`))].sort().join(",");
}

/** Puro — linhas legíveis pro log/corpo do alarme. */
export function describeMissingKitCustomFields(missing: WorkerKitFieldVar[]): string[] {
  return missing.map(
    (m) =>
      `workers/${m.worker}/wrangler.toml: ${m.varName} = "${m.fieldKey}" — custom field "${m.fieldKey}" NÃO existe no Kit ` +
      "(o Kit descarta a chave em silêncio e responde 2xx; nada do que o worker grava nesse field fica registrado)",
  );
}

interface RawCustomField {
  id?: unknown;
  key?: unknown;
  label?: unknown;
}
interface RawCustomFieldsPage {
  custom_fields?: unknown;
  pagination?: { has_next_page?: unknown; end_cursor?: unknown } | null;
}

/**
 * I/O — todas as `key`s de custom field do Kit (`GET /v4/custom_fields`,
 * paginado por cursor). `kitGet` recebe o path relativo à base v4.
 *
 * Fail-closed de propósito: resposta sem `custom_fields` como array LANÇA em
 * vez de virar `[]`. `?? []` aqui faria "não consegui ler" virar "nenhum field
 * existe" e todo worker apareceria quebrado — alarme falso que treina o editor
 * a ignorar o alarme real (mesma regra de `fetchSuspendedCampaigns`, #6146).
 */
export async function fetchKitCustomFieldKeys(
  kitGet: (path: string) => Promise<unknown>,
  maxPages = 20,
): Promise<string[]> {
  const keys: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ per_page: "500" });
    if (after) qs.set("after", after);
    const body = (await kitGet(`/custom_fields?${qs.toString()}`)) as RawCustomFieldsPage | undefined;
    const fields = body?.custom_fields;
    if (!Array.isArray(fields)) {
      throw new Error(
        `GET /custom_fields não devolveu \`custom_fields\` como array (recebido: ${JSON.stringify(fields)}) — ` +
          "lista de custom fields do Kit ilegível.",
      );
    }
    for (const f of fields as RawCustomField[]) {
      if (typeof f?.key === "string" && f.key) keys.push(f.key);
    }
    const p = body?.pagination;
    if (!p || p.has_next_page !== true || typeof p.end_cursor !== "string" || !p.end_cursor) {
      return keys;
    }
    after = p.end_cursor;
  }
  throw new Error(`GET /custom_fields: paginação não terminou em ${maxPages} páginas — resposta inesperada do Kit.`);
}

export interface KitWorkerFieldsCheckResult {
  configured: WorkerKitFieldVar[];
  missing: WorkerKitFieldVar[];
  existingKeys: string[];
}

/** Orquestra coleta + leitura + comparação. Lança se a leitura do Kit falhar. */
export async function checkKitWorkerCustomFields(deps: {
  workersDir: string;
  kitGet: (path: string) => Promise<unknown>;
}): Promise<KitWorkerFieldsCheckResult> {
  const configured = collectWorkerKitFieldVars(deps.workersDir);
  const existingKeys = await fetchKitCustomFieldKeys(deps.kitGet);
  return { configured, missing: findMissingKitCustomFields(configured, existingKeys), existingKeys };
}

export interface KitWorkerFieldsAlarmDeps {
  check: () => Promise<KitWorkerFieldsCheckResult>;
  alarm: (missing: WorkerKitFieldVar[]) => Promise<void>;
  isDryRun: boolean;
  log: (msg: string) => void;
}

/**
 * Roda o guard e alarma se houver field ausente. Retorna o número de fields
 * ausentes, ou `null` se a checagem não pôde rodar (leitura do Kit falhou —
 * logado como AVISO, nunca como "tudo ok").
 *
 * Nunca lança: chamado de dentro do `check-brevo-diaria-guardrail.ts`, cujos
 * outros alarmes (conta suspensa, seed) não podem ser derrubados por uma falha
 * na leitura do Kit.
 */
export async function runKitWorkerFieldsGuard(deps: KitWorkerFieldsAlarmDeps): Promise<number | null> {
  let result: KitWorkerFieldsCheckResult;
  try {
    result = await deps.check();
  } catch (e) {
    deps.log(`AVISO: guard de custom fields do Kit (#9663) NÃO rodou — ${(e as Error).message}`);
    return null;
  }
  if (result.missing.length === 0) {
    deps.log(
      `custom fields do Kit OK (#9663): ${result.configured.length} var(s) KIT_*_FIELD dos workers, todas existem no Kit.`,
    );
    return 0;
  }
  deps.log(`ERRO: ${result.missing.length} var(s) KIT_*_FIELD apontam pra custom field inexistente no Kit (#9663):`);
  for (const line of describeMissingKitCustomFields(result.missing)) deps.log(`  - ${line}`);
  if (deps.isDryRun) {
    deps.log("--dry-run: NÃO registra alarme.");
    return result.missing.length;
  }
  try {
    await deps.alarm(result.missing);
  } catch (e) {
    deps.log(`AVISO: falha ao registrar alarme de custom field ausente no Kit: ${(e as Error).message}`);
  }
  return result.missing.length;
}

/** Puro — corpo do alarme. */
export function buildMissingKitFieldsAlarmBody(missing: WorkerKitFieldVar[], nowIso: string): string {
  const keys = [...new Set(missing.map((m) => m.fieldKey))];
  return [
    "Worker(s) configurado(s) pra gravar em custom field(s) que NÃO existe(m) no Kit:",
    "",
    ...describeMissingKitCustomFields(missing).map((l) => `- ${l}`),
    "",
    "O Kit v4 descarta em silêncio as chaves de `fields` desconhecidas e responde 2xx —",
    "nenhum log do worker acusa a perda. Foi assim que `confirmou_via` ficou sem medir",
    "nada de 28/09 a 05/10/2026 (#9663).",
    "",
    "Correção: criar o(s) field(s) no Kit e conferir que a `key` resultante bate com o valor da var:",
    "",
    ...keys.map((k) => `  POST /v4/custom_fields {"label":"${k}"}`),
    "",
    "(ou, se a var não deveria mais gravar nada, removê-la do wrangler.toml e redeployar o worker)",
    "",
    `(alarme automático — checagem rodou em ${nowIso})`,
  ].join("\n");
}
