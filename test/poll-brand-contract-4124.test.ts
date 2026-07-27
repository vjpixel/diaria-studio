/**
 * test/poll-brand-contract-4124.test.ts (#4124)
 *
 * Teste de CONTRATO (não de comportamento): toda rota do worker `poll` que
 * recebe `brand`/`bEnv` do router (`routeRequest`, workers/poll/src/index.ts)
 * precisa ter, em ALGUM lugar da suíte, pelo menos 1 caso de teste que a
 * exercite com um brand de PREFIXO NÃO-VAZIO (`clarice` ou `web` — ver
 * `brandKvPrefix`, lib.ts: `diaria` é `""`, os outros dois são `"{brand}:"`).
 *
 * Decisão do editor (#4124, comentário 260727): escopo ENXUTO — só este
 * teste de contrato entra nesta rodada. Ficam de fora (issue futura se a
 * classe reaparecer): tipos `RawKv`/`BrandedKv` distintos, helper de acesso
 * obrigatório, e lint de literal `correct:`/`eiameta:` solto.
 *
 * O MOTIVO É PRECISO: o prefixo de `diaria` é vazio, então um teste que só
 * exercita esse brand NUNCA distingue leitura/escrita CRUA de BRANDED — as
 * duas resolvem pra EXATAMENTE a mesma chave. Foi assim que #4117 (arquivo
 * retroativo) e #4118 (/stats) escaparam da suíte por meses: a rota TINHA
 * teste, só que só com `diaria`. #4038 (admin/correct) e #3600 (/vote) são a
 * mesma classe, direção oposta. Sozinho, este item já teria pego #4117 e
 * #4118 (issue #4124).
 *
 * Mesmo espírito de `test/lib-boundary.test.ts` (#2747): trava a fronteira
 * via CI em vez de documentá-la em prosa que ninguém relê. Duas metades:
 *
 *   1. `brandAwareHandlers()` — scan ESTÁTICO de `routeRequest` em index.ts:
 *      todo `return handleXxx(...);` cujos argumentos citam `bEnv` OU o
 *      identificador solto `brand` é, por definição, uma rota brand-aware
 *      (mesmo que só cosmético — ex: handleArchiveVotePage/
 *      handleLeaderboardArchive recebem `brand` só pra texto do HTML, KV via
 *      `env` cru — #4117 — mas ainda assim precisam de cobertura com brand
 *      não-default, porque foi EXATAMENTE a ausência dela que escondeu o bug).
 *      Isso é 100% automático — uma rota nova que passe `brand`/`bEnv` pro
 *      handler entra na lista sem precisar editar este arquivo.
 *
 *   2. `ROUTE_COVERAGE` — mapa handler→markers de busca, curado à
 *      mão (o único ponto manual aqui, análogo à lista `DOMAINS` de
 *      lib-boundary.test.ts). Pra cada handler brand-aware detectado em (1):
 *        a. falha se não houver entrada no mapa (handler novo sem marker
 *           registrado — força quem adicionou a rota a também decidir como
 *           ela seria encontrada pelo scan);
 *        b. falha se NENHUM `it()`, em NENHUM arquivo `test/*.test.ts`, tiver
 *           um marker de rota daquele handler (no próprio corpo do `it()` OU
 *           no texto de nível de módulo do MESMO arquivo — cobre o padrão de
 *           helper, ver `hasNonDefaultBrandCoverage` abaixo) JUNTO com um
 *           marker de brand de prefixo não-vazio (`brand=clarice`,
 *           `brand=web`, `"clarice"`, `'clarice'`, `"web"`, `'web'`) DENTRO
 *           do próprio corpo desse `it()`.
 *
 * Revisão pós self-review #2038 (PR #4172): a 1ª versão deste teste usava uma
 * janela de distância em CHARS entre os dois markers em vez de escopo por
 * `it()` — o self-review achou um falso-positivo REAL (não hipotético) com
 * essa versão: `poll-leaderboard-head-3998.test.ts` tem um `it()` testando
 * `/leaderboard/top1` e, ~150-330 chars depois, um `it()` IRMÃO testando
 * `/leaderboard?brand=clarice` — perto o bastante pra qualquer janela
 * generosa o bastante pra não regredir os casos legítimos (que chegam a ~41
 * chars de distância). Escopar por `it()` elimina essa classe de falso-
 * positivo por construção — markers de um `it()` irmão nunca contam pro
 * `it()` sob teste — sem precisar achar o "N mágico" certo pra uma janela.
 *
 * Limites conhecidos (aceitos — mesma classe de trade-off que
 * lib-boundary.test.ts assume pro scan estático de imports, que também não
 * executa os módulos):
 *   - falso-positivo residual: o texto de nível de módulo (helpers, imports)
 *     é compartilhado por TODOS os `it()` do arquivo — um arquivo que
 *     definisse 2 helpers de rotas DIFERENTES ainda poderia creditar a rota
 *     errada se um `it()` de uma tiver brand marker. Não observado na suíte
 *     atual (convenção é 1 arquivo = 1 classe de rota/bug), mas não é
 *     impossível por construção.
 *   - falso-positivo por substring: o marker de brand (`"web"`/`'web'`) pode,
 *     em teoria, coincidir com um uso não relacionado a este contrato DENTRO
 *     do mesmo `it()` que também tem o marker de rota.
 *   - falso-negativo: um teste que exercite a rota só via closure/helper sem
 *     repetir o path/nome do handler como string literal em nenhum lugar do
 *     arquivo (nem no `it()`, nem no nível de módulo) não é detectado.
 *   - granularidade por HANDLER, não por URL exata: `handleLeaderboardByYear`
 *     é despachado tanto por `/leaderboard` (quando `leaderboardPeriod`==
 *     "year") quanto por `/leaderboard/{YYYY}` — cobrir uma URL cobre a
 *     outra pro propósito deste contrato (é literalmente a mesma função).
 *
 * Ao rodar pela 1ª vez (260727), o scan encontrou 3 rotas brand-aware SEM
 * nenhuma cobertura de brand não-default em lugar nenhum da suíte:
 * `/leaderboard/top1` (handleLeaderboardTop1), `/set-name` (handleSetName) e
 * `/leaderboard/{YYYY-MM}.json` (handleLeaderboardByMonthJson) — as 3 só
 * tinham testes com `diaria` (default) em código executável, apesar de
 * lerem/escreverem KV branded (`{brand}:score-by-month:*`, `{brand}:score:*`).
 * Os testes que fecham essa lacuna estão no fim deste arquivo (describe
 * "cobertura adicionada pelo #4124").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker, { hmacSign } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_TS = join(ROOT, "workers", "poll", "src", "index.ts");
const TEST_DIR = join(ROOT, "test");
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Remove comentários (`/* ... *\/` e `// até o fim da linha`) de source TS —
 * heurística por REGEX (não um tokenizer completo), deliberado: uma 1ª
 * tentativa char-by-char "entra em modo string ao ver aspas, sai na aspa de
 * fechamento" quebrou de verdade neste arquivo (achado ao escrever este
 * teste) — um `it()` com `` `${expr.join(", ")}` `` (aspas retas DENTRO de
 * um template literal, dentro de uma interpolação `${}`) desalinha a
 * paridade de aspas do scanner char-by-char, e o desalinhamento se propaga
 * pro resto do arquivo (comentários reais deixam de ser reconhecidos como
 * comentário). Regex evita esse tipo de desalinhamento cumulativo por
 * construção — cada `//`/`/* *\/` é tratado independente, sem estado
 * compartilhado entre matches.
 *
 * Bloco `/* ... *\/` é removido primeiro (`[\s\S]*?` cruza linha, non-greedy).
 * Linha `// ...` só é removida quando o `//` NÃO é imediatamente precedido
 * por `:` — protege `https://`/`http://` (o `:` de "https:" nunca antecede um
 * comentário de verdade neste codebase). Isso significa que um comentário
 * genuíno logo depois de uma URL na MESMA linha (raro neste repo) sobrevive
 * — limite aceito, mesma classe de trade-off documentada no header do
 * arquivo (falso-negativo é seguro aqui; falso-positivo por corromper string
 * de código real não é).
 *
 * Sem isso, o scan também caiu num FALSO-POSITIVO real (achado ao escrever
 * este arquivo): `poll-stats-legacy-cycle-3261.test.ts` menciona
 * `/leaderboard/2026-04.json?brand=clarice` só em COMENTÁRIO (docstring de
 * rationale) — sem stripar comentários, o scan credita
 * `handleLeaderboardByMonthJson` como coberto quando na verdade NENHUM teste
 * executável exercita essa rota com brand não-default (ver describe
 * dedicado no fim deste arquivo, que fecha esse gap de verdade).
 */
function stripComments(src: string): string {
  const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ── Parte 1: scan estático de routeRequest ──────────────────────────────────

/** Extrai o corpo de `routeRequest` (de `async function routeRequest` até o
 * `return json({ error: "not found"` final que fecha o dispatcher). */
function routeRequestBody(src: string): string {
  const start = src.indexOf("async function routeRequest");
  const endMarker = 'return json({ error: "not found"';
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(
      "routeRequest não encontrado em index.ts (ou marcadores de início/fim mudaram) — " +
        "scan de test/poll-brand-contract-4124.test.ts quebrado, revisar os marcadores.",
    );
  }
  return src.slice(start, end);
}

/**
 * Extrai, do corpo de `routeRequest`, cada dispatch `return handleXxx(args);`
 * cujos args referenciam `bEnv` OU o identificador solto `brand` — sinal de
 * que a rota recebe brand namespacing (mesmo que só cosmético). Retorna o
 * conjunto de nomes de handler brand-aware, deduplicado, na ordem de
 * aparição.
 */
function brandAwareHandlers(body: string): string[] {
  const found: string[] = [];
  const re = /return\s+(handle\w+)\((.*)\);/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const [, handlerName, args] = m;
    const hasBrandArg = /\bbEnv\b/.test(args) || /\bbrand\b/.test(args);
    if (hasBrandArg && !found.includes(handlerName)) found.push(handlerName);
  }
  return found;
}

// ── Parte 2: registro de markers de cobertura (único ponto manual) ─────────

interface RouteEntry {
  handler: string;
  /** Regexes — QUALQUER uma bastando pra achar "a rota foi referenciada" num arquivo. */
  routeMarkers: RegExp[];
}

const ROUTE_COVERAGE: RouteEntry[] = [
  { handler: "handleVote", routeMarkers: [/\bhandleVote\b/, /\/vote(\?|["'`])/] },
  { handler: "handleStats", routeMarkers: [/\bhandleStats\b/, /\/stats(\?|["'`])/] },
  { handler: "handleEditions", routeMarkers: [/\bhandleEditions\b/, /\/editions(\?|["'`])/] },
  // "/leaderboard" bare — exclui propositalmente "/leaderboard/..." (top1,
  // arquivo, {YYYY-MM}, {YYYY}) via exigir que logo após venha "?" ou fecha-aspas.
  { handler: "handleLeaderboard", routeMarkers: [/\bhandleLeaderboard\b(?!Top1|ByMonth|ByYear|Archive)/, /\/leaderboard(\?|["'`])/] },
  { handler: "handleLeaderboardByYear", routeMarkers: [/\bhandleLeaderboardByYear\b/, /\/leaderboard\/(19|20)\d{2}(\?|["'`])/] },
  { handler: "handleLeaderboardTop1", routeMarkers: [/\bhandleLeaderboardTop1\b/, /\/leaderboard\/top1(\?|["'`])/] },
  { handler: "handleArchiveVotePage", routeMarkers: [/\bhandleArchiveVotePage\b/, /\/leaderboard\/\d{4}\/arquivo\/\d{6}/] },
  { handler: "handleLeaderboardArchive", routeMarkers: [/\bhandleLeaderboardArchive\b/, /\/leaderboard\/\d{4}\/arquivo(\?|["'`])/] },
  // ".json" — o "." logo após \d{2} garante que NÃO colide com o marker de
  // handleLeaderboardByMonth abaixo (que exige "?"/aspas logo após os dígitos).
  { handler: "handleLeaderboardByMonthJson", routeMarkers: [/\bhandleLeaderboardByMonthJson\b/, /\/leaderboard\/\d{4}-\d{2}\.json/] },
  { handler: "handleLeaderboardByMonth", routeMarkers: [/\bhandleLeaderboardByMonth\b(?!Json)/, /\/leaderboard\/\d{4}-\d{2}(\?|["'`])/] },
  { handler: "handleSetName", routeMarkers: [/\bhandleSetName\b/, /\/set-name(\?|["'`])/] },
  { handler: "handleAdminCorrect", routeMarkers: [/\bhandleAdminCorrect\b/, /\/admin\/correct(\?|["'`])/] },
  { handler: "handleJogarIdentify", routeMarkers: [/\bhandleJogarIdentify\b/, /\/jogar\/identify(\?|["'`])/] },
  { handler: "handleConfirmMerge", routeMarkers: [/\bhandleConfirmMerge\b/, /\/confirm-merge(\?|["'`])/] },
];

/** Marker de brand de PREFIXO NÃO-VAZIO — nunca `diaria` sozinho (prefixo ""). */
const BRAND_MARKER = /brand=clarice|brand=web|["']clarice["']|["']web["']/;

function listTestFiles(): string[] {
  return readdirSync(TEST_DIR, { withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join(TEST_DIR, f));
}

/**
 * Auto-referência: este PRÓPRIO arquivo cita os 14 nomes de handler como
 * STRING em `ROUTE_COVERAGE` (metadado, não teste) — sem tratamento
 * especial, isso faria `hasRoute` bater trivialmente pra TODA rota nesta
 * MESMA linha do arquivo, e como o arquivo também tem `brand=clarice`/`"web"`
 * de verdade (nos describes de cobertura no fim), o par (rota, brand)
 * bateria SEMPRE — um falso-positivo estrutural que tornaria o teste de
 * cobertura um no-op (sempre verde, mesmo pra rota sem cobertura real em
 * lugar nenhum). Remove só o array `ROUTE_COVERAGE` (puro metadado) do texto
 * escaneado deste arquivo; os describes de teste reais (inclusive os que
 * fecham gaps no fim do arquivo) continuam no texto e contam normalmente.
 */
function stripRouteCoverageArrayLiteral(src: string): string {
  const startMarker = "const ROUTE_COVERAGE: RouteEntry[] = [";
  const start = src.indexOf(startMarker);
  if (start === -1) return src; // marcador mudou de nome — fail-open (não filtra, não lança)
  const endMarker = "\n];";
  const end = src.indexOf(endMarker, start);
  if (end === -1) return src;
  return src.slice(0, start) + src.slice(end + endMarker.length);
}

/**
 * Extrai todos os spans top-level de chamadas que casam `calleeRe` (ex:
 * `it(`/`it.only(`/`it.skip(`, ou `describe(`/`describe.only(`/`describe.skip(`)
 * via contagem de parênteses a partir do "(" — ignora chaves (só a paridade
 * de `()` importa pra achar onde a chamada externa fecha; o corpo em `{...}`
 * do callback fica todo DENTRO do span, sem afetar a contagem de parênteses
 * externa). NÃO é string-aware (não pula parênteses dentro de literais) —
 * risco aceito, mesma classe dos outros scans deste arquivo; comentários já
 * foram removidos por `stripComments` antes de chegar aqui.
 */
function extractCallSpans(content: string, calleeRe: RegExp): Array<{ start: number; end: number; text: string }> {
  const flags = calleeRe.flags.includes("g") ? calleeRe.flags : `${calleeRe.flags}g`;
  const re = new RegExp(calleeRe.source, flags);
  const spans: Array<{ start: number; end: number; text: string }> = [];
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const openParenIdx = m.index + m[0].length - 1; // "(" é o último char do match
    let depth = 0;
    let i = openParenIdx;
    for (; i < content.length; i++) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    spans.push({ start: m.index, end: i + 1, text: content.slice(m.index, i + 1) });
  }
  return spans;
}

const DESCRIBE_CALL_RE = /\bdescribe(?:\.only|\.skip)?\(/g;
const IT_CALL_RE = /\bit(?:\.only|\.skip)?\(/g;

/**
 * Texto "nível de módulo" de um arquivo de teste: o conteúdo INTEIRO MENOS
 * todo span `describe(...)` (que, por convenção deste repo, contém todos os
 * `it()` do arquivo). Sobra o que fica FORA de qualquer describe/it — imports,
 * e sobretudo HELPERS de módulo (ex: `function statsUrl(...)`, `async function
 * postAdminCorrect(...)`) que constroem a URL/path da rota testada e são
 * chamados de DENTRO de cada `it()` com o brand como argumento (padrão comum
 * nesta suíte — ver `poll-admin-correct-raw-key-4038.test.ts`,
 * `poll-stats-gabarito-brand-raw-read-4118.test.ts`).
 */
function moduleLevelText(content: string): string {
  const describeSpans = extractCallSpans(content, DESCRIBE_CALL_RE);
  if (describeSpans.length === 0) return content;
  // Mescla spans sobrepostos/aninhados (describe dentro de describe) antes de
  // remover, pra não desalinhar índices removendo em 2 passadas sobre o mesmo texto.
  const sorted = [...describeSpans].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += content.slice(cursor, span.start);
    cursor = span.end;
  }
  out += content.slice(cursor);
  return out;
}

/**
 * Cobertura = existe pelo menos 1 `it()`, em algum arquivo, cujo texto
 * "efetivo" (próprio corpo do `it()` UNIDO ao texto de nível de módulo do
 * MESMO arquivo) contém um marker de rota E um marker de brand não-vazio.
 *
 * Por que não window de distância em char (1ª versão deste teste, revisada
 * após self-review #2038 do PR): um arquivo com VÁRIOS `it()` testando rotas
 * DIFERENTES faz um marker de rota do `it()` A ficar fisicamente perto (em
 * chars) de um marker de brand do `it()` B, sem NENHUM teste de verdade
 * exercitar rota+brand juntos — achado real, não hipotético, em
 * `poll-leaderboard-head-3998.test.ts` (`/leaderboard/top1` num `it()` e
 * `brand=clarice` no `it()` SEGUINTE, ~150-330 chars de distância — dentro de
 * qualquer window generoso o bastante pra não regredir os casos legítimos).
 * Escopar por `it()` elimina essa classe inteira: markers de um `it()`
 * IRMÃO nunca contam pro `it()` sob teste. Unir o texto de nível de módulo
 * preserva o padrão de helper (o marker de ROTA mora no helper, fora de
 * qualquer `it()`; o marker de BRAND é o argumento passado pelo `it()` que
 * CHAMA o helper) sem precisar resolver call-graph por nome de função.
 */
function hasNonDefaultBrandCoverage(entry: RouteEntry, fileContents: Map<string, string>): boolean {
  for (const content of fileContents.values()) {
    const itBlocks = extractCallSpans(content, IT_CALL_RE);
    if (itBlocks.length === 0) continue;
    const moduleText = moduleLevelText(content);
    const moduleHasRoute = entry.routeMarkers.some((re) => re.test(moduleText));
    for (const block of itBlocks) {
      const hasRoute = moduleHasRoute || entry.routeMarkers.some((re) => re.test(block.text));
      if (!hasRoute) continue;
      if (BRAND_MARKER.test(block.text)) return true;
    }
  }
  return false;
}

describe("contrato de brand por rota — /vote, /stats, /leaderboard*, /admin/correct, etc. (#4124)", () => {
  const indexSrc = stripComments(readFileSync(INDEX_TS, "utf8"));
  const body = routeRequestBody(indexSrc);
  const detected = brandAwareHandlers(body);

  it("sanity: o scan de routeRequest não veio vazio (regressão silenciosa se index.ts mudar de forma)", () => {
    assert.ok(detected.length >= 10, `esperado >=10 handlers brand-aware, achou ${detected.length}: ${detected.join(", ")}`);
  });

  it("todo handler brand-aware detectado em routeRequest tem entrada em ROUTE_COVERAGE (registro não ficou desatualizado)", () => {
    const registered = new Set(ROUTE_COVERAGE.map((e) => e.handler));
    const missing = detected.filter((h) => !registered.has(h));
    assert.deepEqual(
      missing,
      [],
      `handler(s) brand-aware sem entrada em ROUTE_COVERAGE — adicione um RouteEntry ` +
        `pra: ${missing.join(", ")} (e um teste de cobertura com brand=clarice/web, ver header do arquivo)`,
    );
  });

  it("todo RouteEntry registrado ainda corresponde a um handler brand-aware real (sem entrada órfã pós-refactor)", () => {
    const detectedSet = new Set(detected);
    const orphaned = ROUTE_COVERAGE.map((e) => e.handler).filter((h) => !detectedSet.has(h));
    assert.deepEqual(
      orphaned,
      [],
      `entrada(s) em ROUTE_COVERAGE sem handler brand-aware correspondente em routeRequest — ` +
        `a rota deixou de ser brand-aware (ou o handler foi renomeado): ${orphaned.join(", ")}`,
    );
  });

  it("toda rota brand-aware tem >=1 caso de teste na suíte com brand=clarice OU brand=web (não só diaria)", () => {
    const files = listTestFiles();
    const fileContents = new Map<string, string>(
      files.map((f) => {
        const raw = readFileSync(f, "utf8");
        const withoutSelfMetadata = f === SELF_PATH ? stripRouteCoverageArrayLiteral(raw) : raw;
        return [f, stripComments(withoutSelfMetadata)];
      }),
    );

    const uncovered = ROUTE_COVERAGE.filter((entry) => !hasNonDefaultBrandCoverage(entry, fileContents));
    assert.deepEqual(
      uncovered.map((e) => e.handler),
      [],
      `rota(s) brand-aware SEM nenhum teste com brand de prefixo não-vazio (clarice/web) na suíte: ` +
        `${uncovered.map((e) => e.handler).join(", ")}. O prefixo de diaria é vazio — um teste só ` +
        `com diaria nunca distingue chave crua de branded (é assim que #4117/#4118 escaparam). ` +
        `Adicione um teste que hit a rota com ?brand=clarice ou ?brand=web.`,
    );
  });
});

// ── Cobertura adicionada pelo #4124 ──────────────────────────────────────────
//
// Os 3 gaps reais encontrados na 1ª rodada do scan acima (260727) — nenhum
// dos três tinha SEQUER 1 teste, em qualquer arquivo, com um brand de
// prefixo não-vazio (o 3º, handleLeaderboardByMonthJson, só apareceu depois
// de blindar o scan contra falso-positivo de COMENTÁRIO — ver
// `stripComments` acima: `poll-stats-legacy-cycle-3261.test.ts` menciona
// `/leaderboard/2026-04.json?brand=clarice` só em docstring de rationale,
// nunca em código executável). Os três passam por `bEnv`/`env` (index.ts,
// routeRequest) e LEEM/ESCREVEM chave KV branded — sem este teste, uma
// futura confusão crua-vs-branded neles (mesma classe de
// #4117/#4118/#4038/#3600) passaria batido, porque brand=diaria nunca teria
// exposto a divergência.

describe("cobertura adicionada pelo #4124: GET /leaderboard/top1 com brand não-default", () => {
  it("brand=clarice: lê score-by-month sob o prefixo clarice: (não a chave crua)", async () => {
    const kv = makeTrackedKv({
      // Chave CRUA (sem prefixo) — NÃO deve ser usada por handleLeaderboardTop1
      // quando brand=clarice; existe só pra provar que o teste distingue as duas.
      "score-by-month:2026-07:leo@x.com": JSON.stringify({ nickname: "Leo Diária", correct: 1, total: 1 }),
      // Chave BRANDED — a que handleLeaderboardTop1 deve efetivamente ler.
      "clarice:score-by-month:2026-07:leo@x.com": JSON.stringify({ nickname: "Leo Clarice", correct: 5, total: 6 }),
    });
    const env = makePollEnv(kv);

    const url = new URL("https://poll.test/leaderboard/top1");
    url.searchParams.set("brand", "clarice");
    url.searchParams.set("period", "2026-07");

    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { top1: Array<{ nickname: string; correct: number; total: number }> };
    assert.equal(body.top1.length, 1);
    assert.equal(body.top1[0].nickname, "Leo Clarice", "deve ler a entry BRANDED (clarice:score-by-month:*), não a crua");
  });

  it("brand=web: mesmo contrato — prefixo web: isolado da chave crua e da clarice:", async () => {
    const kv = makeTrackedKv({
      "score-by-month:2026-07:ana@x.com": JSON.stringify({ nickname: "Ana Diária", correct: 1, total: 1 }),
      "clarice:score-by-month:2026-07:ana@x.com": JSON.stringify({ nickname: "Ana Clarice", correct: 1, total: 1 }),
      "web:score-by-month:2026-07:ana@x.com": JSON.stringify({ nickname: "Ana Web", correct: 4, total: 4 }),
    });
    const env = makePollEnv(kv);

    const url = new URL("https://poll.test/leaderboard/top1");
    url.searchParams.set("brand", "web");
    url.searchParams.set("period", "2026-07");

    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { top1: Array<{ nickname: string; correct: number; total: number }> };
    assert.equal(body.top1.length, 1);
    assert.equal(body.top1[0].nickname, "Ana Web");
  });
});

describe("cobertura adicionada pelo #4124: GET /set-name com brand não-default", () => {
  it("brand=clarice: grava nickname em score:{email} sob o prefixo clarice:, nunca na chave crua", async () => {
    const kv = makeTrackedKv({
      "clarice:score:ana@x.com": JSON.stringify({ total: 3, correct: 2 }),
    });
    const env = makePollEnv(kv);
    const sig = await hmacSign(env.POLL_SECRET, "setname:ana@x.com");

    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", "ana@x.com");
    url.searchParams.set("name", "Ana Clarice");
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");

    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200);

    const updated = JSON.parse((await kv.get("clarice:score:ana@x.com"))!);
    assert.equal(updated.nickname, "Ana Clarice", "nickname deve ser gravado sob a chave BRANDED clarice:score:*");
    assert.equal(await kv.get("score:ana@x.com"), null, "a chave crua score:{email} NUNCA deve ser tocada por brand=clarice");
  });

  it("brand=web: mesmo contrato — dedup de nickname (nickname:{norm}) também isolado por prefixo", async () => {
    const kv = makeTrackedKv({
      "web:score:leo@x.com": JSON.stringify({ total: 1, correct: 1 }),
      // Mesmo nickname normalizado já reivindicado do lado DIARIA (prefixo
      // vazio) — não deve colidir com o dedup do brand web (índices isolados).
      "nickname:leo": "leo-diaria@x.com",
    });
    const env = makePollEnv(kv);
    const sig = await hmacSign(env.POLL_SECRET, "setname:leo@x.com");

    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", "leo@x.com");
    url.searchParams.set("name", "Leo");
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "web");

    const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    assert.equal(res.status, 200, "dedup de nickname do brand diaria não deve vazar pro brand web");

    const updated = JSON.parse((await kv.get("web:score:leo@x.com"))!);
    assert.equal(updated.nickname, "Leo");
  });
});

describe("cobertura adicionada pelo #4124: GET /leaderboard/{YYYY-MM}.json com brand não-default", () => {
  it("brand=clarice: entries vêm do score-by-month sob o prefixo clarice:, não da chave crua", async () => {
    const kv = makeTrackedKv({
      // Chave CRUA — não deve ser usada por handleLeaderboardByMonthJson
      // quando brand=clarice; existe só pra provar que o teste distingue as duas.
      "score-by-month:2026-07:leo@x.com": JSON.stringify({ nickname: "Leo Diária", correct: 1, total: 1 }),
      "clarice:score-by-month:2026-07:leo@x.com": JSON.stringify({ nickname: "Leo Clarice", correct: 5, total: 6 }),
    });
    const env = makePollEnv(kv);

    const res = await worker.fetch(
      new Request("https://poll.test/leaderboard/2026-07.json?brand=clarice"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ nickname: string; correct: number; total: number }> };
    assert.equal(body.entries.length, 1, "deve ver só a entry BRANDED — não a crua nem 0 entries");
    assert.equal(body.entries[0].nickname, "Leo Clarice", "deve ler score-by-month sob o prefixo clarice:, não a chave crua");
  });

  it("brand=web: mesmo contrato — prefixo web: isolado da chave crua e da clarice:", async () => {
    const kv = makeTrackedKv({
      "score-by-month:2026-07:ana@x.com": JSON.stringify({ nickname: "Ana Diária", correct: 1, total: 1 }),
      "clarice:score-by-month:2026-07:ana@x.com": JSON.stringify({ nickname: "Ana Clarice", correct: 1, total: 1 }),
      "web:score-by-month:2026-07:ana@x.com": JSON.stringify({ nickname: "Ana Web", correct: 4, total: 4 }),
    });
    const env = makePollEnv(kv);

    const res = await worker.fetch(
      new Request("https://poll.test/leaderboard/2026-07.json?brand=web"),
      env,
      {} as ExecutionContext,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: Array<{ nickname: string; correct: number; total: number }> };
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].nickname, "Ana Web");
  });
});
