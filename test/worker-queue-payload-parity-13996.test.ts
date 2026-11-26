/**
 * worker-queue-payload-parity-13996.test.ts (#13996)
 *
 * O payload do `POST /queue` do Worker `linkedin-cron` é tipado duas vezes, à
 * mão: `WorkerQueuePayload` (cliente, `scripts/lib/worker-queue-client.ts`) e
 * `QueueEntry` (Worker, `workers/linkedin-cron/src/index.ts`). O Worker não
 * importa de `scripts/` por desenho (bundle do Cloudflare, deploy com `paths`
 * restrito), então a trava é este teste de paridade, não um módulo
 * compartilhado.
 *
 * Um campo novo do cliente pode sumir em silêncio em três pontos do Worker:
 *   1. não existir em `QueueEntry` (o tipo nem conhece o campo);
 *   2. existir no tipo mas não ser copiado do body para a entry em
 *      `handleEnqueue` (`const entry: QueueEntry = { ... }`): o enqueue aceita
 *      o POST e grava a entry sem o campo;
 *   3. ficar fora de `IDEMPOTENT_CONTENT_FIELDS`: o retry idempotente com esse
 *      campo mudado é lido como `duplicate` e a entry velha fica.
 * O teste cobre os três pelo fonte (o Worker não exporta a lista nem a função
 * de enqueue) e confere também os valores: um literal novo numa união do
 * cliente (`channel`, `action`, `ig_account`...) tem que existir no tipo do
 * Worker.
 *
 * Campos legitimamente só de um lado vão nas listas explícitas abaixo; mudar
 * qualquer uma exige decidir o caso, não só fazer o teste passar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Sem `import type { QueueEntry }`: o tipo do Worker arrasta os globais do
// Cloudflare (`DurableObjectStorage`, `ScheduledEvent`...) que o
// `tsconfig.test.json` não declara, e o Typecheck ratchet reprova. A
// compatibilidade de valor (uniões de literais) vai pelo parse do fonte abaixo.

// ── Listas explícitas ───────────────────────────────────────────────────────

/**
 * Campos só do Worker: estado gravado pelo próprio Worker, nunca mandados pelo
 * cliente.
 */
const WORKER_ONLY_FIELDS = [
  "created_at", // carimbo do enqueue
  "retry_count", // #880 — contador de falhas do disparo
  "reels_container", // #10922 — container de Reels retomado entre voltas; nunca aceito no POST
  "cancelled", // #2230 — tombstone do DELETE /queue
  "last_error", // #7626 — motivo gravado só ao mover pra DLQ
] as const;

/** Campos só do cliente: nenhum hoje. */
const CLIENT_ONLY_FIELDS = [] as const;

/**
 * Campos do cliente que ficam fora de `IDEMPOTENT_CONTENT_FIELDS` de
 * propósito: não definem o que é publicado.
 */
const CLIENT_FIELDS_NOT_CONTENT = [
  "idempotency_key", // #10906 — é a própria chave (deriva a key da fila), não conteúdo
] as const;

// ── Parse do fonte ──────────────────────────────────────────────────────────

const CLIENT_SRC = readFileSync(new URL("../scripts/lib/worker-queue-client.ts", import.meta.url), "utf8");
const WORKER_SRC = readFileSync(new URL("../workers/linkedin-cron/src/index.ts", import.meta.url), "utf8");

/** Remove comentários `//` de linha inteira e blocos `/* ... *\/`. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Corpo entre a chave que abre em `startIdx` e a que fecha no mesmo nível. */
function balancedBody(src: string, startIdx: number, what: string): string {
  const open = src.indexOf("{", startIdx);
  assert.ok(open >= 0, `não achei "{" de ${what}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`chave de ${what} não fecha`);
}

/** Campos de topo de uma `interface X { ... }`: chave → texto do tipo. */
function interfaceFields(src: string, name: string): Map<string, string> {
  const idx = src.search(new RegExp(`export interface ${name}\\s*\\{`));
  assert.ok(idx >= 0, `interface ${name} não encontrada`);
  const body = stripComments(balancedBody(src, idx, `interface ${name}`));
  // Só o nível de topo: descarta o conteúdo de chaves aninhadas antes de casar.
  let flat = "";
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") depth++;
    if (depth === 0) flat += ch;
    if (ch === "}") depth--;
  }
  const fields = new Map<string, string>();
  for (const m of flat.matchAll(/^\s*([A-Za-z_]\w*)\??\s*:\s*([^;]+);/gm)) fields.set(m[1], m[2].trim());
  assert.ok(fields.size > 0, `interface ${name} sem chaves (parse falhou)`);
  return fields;
}

/** Literais de string de um tipo, resolvendo um alias `type X = "a" | "b"` do mesmo fonte. */
function stringLiterals(typeText: string, src: string): string[] {
  const alias = typeText.match(/^([A-Z]\w*)$/);
  if (alias) {
    const def = src.match(new RegExp(`(?:export )?type ${alias[1]} = ([^;]+);`));
    if (def) return stringLiterals(def[1].trim(), src);
  }
  return [...typeText.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function idempotentContentFields(src: string): string[] {
  const m = src.match(/const IDEMPOTENT_CONTENT_FIELDS = \[([\s\S]*?)\]\s*as const/);
  assert.ok(m, "IDEMPOTENT_CONTENT_FIELDS não encontrada no Worker");
  const fields = [...stripComments(m[1]).matchAll(/"([A-Za-z_]\w*)"/g)].map((x) => x[1]);
  assert.ok(fields.length > 0, "IDEMPOTENT_CONTENT_FIELDS vazia (parse falhou)");
  return fields;
}

/** Chaves gravadas na entry montada por `handleEnqueue`. */
function enqueueEntryKeys(src: string): string[] {
  const fnIdx = src.indexOf("async function handleEnqueue(");
  assert.ok(fnIdx >= 0, "handleEnqueue não encontrada no Worker");
  const litIdx = src.indexOf("const entry: QueueEntry = {", fnIdx);
  assert.ok(litIdx >= 0, "literal `const entry: QueueEntry = {` não encontrado em handleEnqueue");
  const body = stripComments(balancedBody(src, litIdx, "entry do handleEnqueue"));
  const keys = [...body.matchAll(/(?:^|[{,\s])([A-Za-z_]\w*)\s*:(?!:)/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "entry do handleEnqueue sem chaves (parse falhou)");
  return [...new Set(keys)];
}

const clientFields = interfaceFields(CLIENT_SRC, "WorkerQueuePayload");
const workerFields = interfaceFields(WORKER_SRC, "QueueEntry");
const clientKeys = [...clientFields.keys()];
const workerKeys = [...workerFields.keys()];
const contentFields = idempotentContentFields(WORKER_SRC);
const entryKeys = enqueueEntryKeys(WORKER_SRC);

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("WorkerQueuePayload x QueueEntry — paridade de campos (#13996)", () => {
  it("o parse acha os campos conhecidos (sanidade do regex)", () => {
    for (const k of ["text", "image_url", "scheduled_at", "destaque", "channel", "idempotency_key"]) {
      assert.ok(clientKeys.includes(k), `cliente sem ${k}: parse quebrado`);
      assert.ok(workerKeys.includes(k), `Worker sem ${k}: parse quebrado`);
    }
    assert.ok(contentFields.includes("text") && contentFields.includes("document_title"));
    assert.ok(entryKeys.includes("text") && entryKeys.includes("created_at"));
  });

  it("todo campo de WorkerQueuePayload existe em QueueEntry (fora a lista CLIENT_ONLY_FIELDS)", () => {
    const missing = clientKeys.filter((k) => !workerKeys.includes(k));
    assert.deepEqual(
      sorted(missing),
      sorted(CLIENT_ONLY_FIELDS),
      `campo do cliente sem contrapartida em QueueEntry: o Worker ignora em silêncio. ` +
        `Adicione em workers/linkedin-cron/src/index.ts (QueueEntry + handleEnqueue + IDEMPOTENT_CONTENT_FIELDS) ` +
        `ou, se for legitimamente só do cliente, em CLIENT_ONLY_FIELDS deste teste.`,
    );
  });

  it("os campos só do Worker são exatamente WORKER_ONLY_FIELDS (estado, nunca mandado pelo cliente)", () => {
    const workerOnly = workerKeys.filter((k) => !clientKeys.includes(k));
    assert.deepEqual(
      sorted(workerOnly),
      sorted(WORKER_ONLY_FIELDS),
      `QueueEntry ganhou ou perdeu campo sem contrapartida no cliente. Se o cliente deve mandar, ` +
        `adicione em WorkerQueuePayload; se é estado do Worker, atualize WORKER_ONLY_FIELDS.`,
    );
  });

  it("todo literal das uniões do cliente existe no tipo do Worker (channel, action, ig_account...)", () => {
    const unionKeys: string[] = [];
    const unknown: string[] = [];
    for (const [k, clientType] of clientFields) {
      const workerType = workerFields.get(k);
      if (workerType === undefined) continue; // coberto pelo teste de chaves acima
      const clientLits = stringLiterals(clientType, CLIENT_SRC);
      if (clientLits.length === 0) continue;
      unionKeys.push(k);
      if (workerType === "string") continue; // o Worker aceita qualquer string
      const workerLits = stringLiterals(workerType, WORKER_SRC);
      for (const lit of clientLits) if (!workerLits.includes(lit)) unknown.push(`${k}="${lit}"`);
    }
    // Sanidade: as uniões conhecidas foram lidas (o regex não pulou nenhuma).
    for (const k of ["channel", "action", "webhook_target", "ig_account", "media_type"]) {
      assert.ok(unionKeys.includes(k), `união ${k} não lida do cliente: parse quebrado`);
    }
    assert.deepEqual(unknown, [], `valor do cliente que o tipo do Worker não conhece: ${unknown.join(", ")}`);
  });

  it("handleEnqueue copia para a entry todo campo que o cliente manda", () => {
    const dropped = clientKeys.filter((k) => !CLIENT_ONLY_FIELDS.includes(k as never) && !entryKeys.includes(k));
    assert.deepEqual(
      dropped,
      [],
      `handleEnqueue aceita o POST mas não grava estes campos na entry (somem em silêncio): ${dropped.join(", ")}`,
    );
  });

  it("todo campo de conteúdo do cliente está em IDEMPOTENT_CONTENT_FIELDS (fora CLIENT_FIELDS_NOT_CONTENT)", () => {
    const outside = clientKeys.filter(
      (k) =>
        !CLIENT_ONLY_FIELDS.includes(k as never) &&
        !CLIENT_FIELDS_NOT_CONTENT.includes(k as never) &&
        !contentFields.includes(k),
    );
    assert.deepEqual(
      outside,
      [],
      `campo fora de IDEMPOTENT_CONTENT_FIELDS: um retry idempotente com ele mudado vira "duplicate" ` +
        `e a entry velha fica. Adicione na lista ou, se não define o que é publicado, em CLIENT_FIELDS_NOT_CONTENT.`,
    );
  });

  it("IDEMPOTENT_CONTENT_FIELDS só tem campos que o cliente manda (nenhum estado do Worker)", () => {
    const stray = contentFields.filter((f) => !clientKeys.includes(f));
    assert.deepEqual(stray, [], `IDEMPOTENT_CONTENT_FIELDS com campo que o cliente não manda: ${stray.join(", ")}`);
  });

  it("as listas explícitas não se contradizem", () => {
    for (const k of CLIENT_FIELDS_NOT_CONTENT) {
      assert.ok(clientKeys.includes(k), `${k} em CLIENT_FIELDS_NOT_CONTENT mas não está no cliente`);
      assert.ok(!contentFields.includes(k), `${k} em CLIENT_FIELDS_NOT_CONTENT mas está em IDEMPOTENT_CONTENT_FIELDS`);
    }
    for (const k of WORKER_ONLY_FIELDS) {
      assert.ok(!contentFields.includes(k), `${k} é estado do Worker e não pode definir conteúdo idempotente`);
    }
  });
});
