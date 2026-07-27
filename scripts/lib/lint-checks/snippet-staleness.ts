/**
 * lint-checks/snippet-staleness.ts (#4076)
 *
 * `stitch-newsletter.ts` (Stage 2) injeta em `02-reviewed.md` o conteúdo de
 * alguns snippets de `context/snippets/` (boxes de divulgação — slots 1/2/3,
 * config-driven via `platform.config.json > boxes_divulgacao` — + o bloco
 * PARA ENCERRAR, sempre lido de `encerramento-social-apoio.md` — + a caixa
 * de agradecimento a apoiadores, `agradecimento-apoiadores.md`). Se o editor
 * editar um desses arquivos-fonte DEPOIS do stitch (ex: durante a revisão do
 * gate do Stage 4, via Studio), a mudança fica presa no snippet — ela nunca
 * chega em `02-reviewed.md`, que já foi escrito antes — e nada sinalizava a
 * divergência.
 *
 * Caso real (#4076, edição 260727): o editor editou
 * `encerramento-social-apoio.md` no Studio e pediu para atualizar a edição.
 * O orchestrator olhou o bloco PARA ENCERRAR de `02-reviewed.md`, viu texto
 * inalterado, e reportou incorretamente que "a edição não chegou ao disco" —
 * quando o save tinha funcionado, só que no snippet-fonte, que já não é lido
 * nessa altura do pipeline. Mesmo vetor para os 3 slots de `boxes_divulgacao`
 * — trocar `platform.config.json` pós-Stage-2 também não repropaga.
 *
 * WARN-ONLY, NUNCA gate-blocking (decisão explícita da issue): reaplicar
 * automaticamente arriscaria clobberar uma edição legítima que o editor tenha
 * feito direto em `02-reviewed.md` — o mesmo motivo pelo qual o warn-before-save
 * do Studio (#3729, CLAUDE.md) nunca sobrescreve silenciosamente.
 *
 * ─── "Snippets efetivamente usados" (a parte não-trivial) ──────────────────
 *
 * Comparar o mtime de TODOS os arquivos de `context/snippets/` geraria
 * falso-positivo constante — qualquer snippet editado (mesmo um não usado
 * nesta edição específica, ex: um snippet arquivado/histórico ou reservado
 * para outro slot) dispararia aviso, e o editor aprenderia a ignorar o
 * warning (o pior desfecho possível para um guard warn-only). Este módulo
 * deriva o conjunto de candidatos da MESMA lógica que `stitch-newsletter.ts`
 * usa para decidir o que entra na edição, reusando os extratores reais
 * (`extractBoxDivulgacao{1,2,3}` de `newsletter-parse.ts` — o mesmo parser
 * que gera o HTML final) sobre o `02-reviewed.md` JÁ STITCHED, em vez de
 * reimplementar heurística própria:
 *
 *   - `encerramento-social-apoio.md`: SEMPRE candidato. `buildParaEncerrar()`
 *     (stitch-newsletter.ts) lê esse arquivo incondicionalmente em toda
 *     edição — não há gate de config nem de conteúdo (mesmo o fallback
 *     hardcoded, usado quando o snippet está vazio, é substituído por
 *     conteúdo real assim que o editor preenche o arquivo — exatamente o
 *     cenário real do #4076).
 *   - `agradecimento-apoiadores.md`: candidato SOMENTE quando o conteúdo
 *     ATUAL do arquivo (pós strip do comentário HTML) não contém mais o
 *     placeholder `{apoiadores}` — mesmo teste que
 *     `loadAgradecimentoSnippet()` aplica. Se o placeholder ainda está lá,
 *     o box nunca apareceu em `02-reviewed.md` (idêntico antes e depois),
 *     então não há nada a repropagar — incluir mesmo assim só adicionaria
 *     ruído.
 *   - slots 1/2/3 de `boxes_divulgacao`: candidato somente quando (a) o slot
 *     está configurado (não-`null`) E (b) `extractBoxDivulgacao{1,2,3}`
 *     efetivamente encontra um box na posição correspondente do
 *     `02-reviewed.md` atual — cobre o caso de idempotência do stitch (bloco
 *     já colado manualmente pelo editor, então o snippet NUNCA foi lido para
 *     esta edição) e o caso de edição de 2 destaques (sem gap D2/D3, slot2
 *     nunca existe) sem precisar duplicar a lógica de contagem de destaques.
 *
 * `platform.config.json` entra na comparação (pedido explícito da issue)
 * SOMENTE quando pelo menos um dos 3 slots está de fato engajado nesta
 * edição (usa o mesmo `used` acima) — evita falso-positivo de uma mudança
 * em qualquer outra chave do config (ex: lista de publishers) que nada tem a
 * ver com boxes de divulgação.
 *
 * Precisão restante conhecida e aceita (documentada, não corrigida aqui —
 * "prefira errar pro lado de avisar menos"): se o editor trocar
 * `boxes_divulgacao` para apontar um slot vazio (`null`) para um NOVO
 * snippet, e esse slot NUNCA teve box em nenhuma edição anterior (então
 * `extractBoxDivulgacao{1,2,3}` não encontra nada no `02-reviewed.md`
 * atual porque o box realmente não está lá), este guard não dispara —
 * correto, não é staleness (não há nada "preso" no snippet, o conteúdo dele
 * de fato nunca chegou à edição). O cenário real do #4076 ("slots trocados,
 * tiveram que ser aplicados à mão") tinha o slot JÁ preenchido com o box
 * ANTIGO — `extractBoxDivulgacao{1,2,3}` encontra esse box antigo, o slot
 * conta como engajado, e a comparação de mtime do `platform.config.json`
 * dispara normalmente.
 *
 * Duas imprecisões adicionais conhecidas e aceitas (self-review #4140,
 * mesma filosofia acima — não corrigidas aqui):
 *
 *   - Atribuição de arquivo enganosa quando `boxesCfg.slotN` é TROCADO
 *     (aponta pra um snippet diferente) pós-stitch. `resolveUsedSnippets`
 *     usa o valor ATUAL do slot como nome do arquivo candidato, não o
 *     snippet que de fato produziu o box já baked-in em `02-reviewed.md`
 *     (o `extractBoxDivulgacao{1,2,3}` só confirma que HÁ um box na posição
 *     — não de qual arquivo ele veio). Inofensivo no caso comum (config
 *     inalterado) e o cenário real do #4076 é coberto normalmente pelo
 *     check de `platform.config.json` (kind: "config"). Mas se, além da
 *     troca de slot, o arquivo NOVO também tiver mtime recente por
 *     coincidência não-relacionada, o report emitiria um warning
 *     `kind: "snippet"` nomeando um arquivo que NUNCA foi de fato
 *     incorporado nesta edição (o conteúdo baked-in veio do arquivo
 *     ANTIGO). Severidade baixa (dupla coincidência necessária), warn-only.
 *   - `isAgradecimentoSnippetUsed` reflete o estado ATUAL do disco, não o
 *     estado no momento do stitch — pode silenciar uma divergência real no
 *     sentido inverso. Se o editor preencheu `{apoiadores}` com um nome
 *     real (box presente em `02-reviewed.md`) e DEPOIS reverteu pro
 *     placeholder (ex: desfez a edição), a função volta a retornar `false`
 *     e o arquivo sai do conjunto "usado" — mesmo que o box com o nome
 *     antigo ainda esteja fisicamente em `02-reviewed.md` e o arquivo-fonte
 *     tenha mtime mais novo que o MD. O guard fica em silêncio apesar de
 *     haver divergência real (MD tem um nome que o snippet-fonte já não
 *     tem). Diferente do ponto acima, este é um miss real (não só teórico)
 *     — não apenas uma atribuição incorreta de qual arquivo avisar.
 *
 * #4150 (achado do review consolidado, interação com #4143): o guard original
 * comparava só `mtimeMs` bruto do snippet contra o `02-reviewed.md` — uma
 * edição restrita ao CABEÇALHO de comentário (`nome:`/`categoria:`/`alt:`,
 * nunca injetado no corpo pelo stitch, ver `snippet-header.ts`) disparava
 * warning sem nenhuma divergência real de conteúdo. Corrigido comparando
 * `bodyHash` (sha256 do corpo PÓS-cabeçalho, via `snippetBodyHash`) gravado
 * por `stitch-newsletter.ts` no momento do stitch (manifest
 * `_internal/.snippet-body-hashes.json`, mesmo padrão de
 * `.social-source-hash.json`/#1413) contra o hash recomputado agora — mtime
 * mais novo + hash IGUAL = silêncio (só o cabeçalho mudou); hash DIFERENTE =
 * warning (comportamento antigo preservado). Escolhido em vez de comparar o
 * corpo cru diretamente contra o texto embutido em `02-reviewed.md` (approach
 * "a" cogitada na issue) porque o conteúdo baked-in passa por transformação
 * NÃO-literal em pelo menos 2 dos 5 candidatos: `buildParaEncerrar()`
 * (`encerramento-social-apoio.md`, SEMPRE candidato) faz split+reorder dos
 * parágrafos intercalados com blocos fixos, e o `02-reviewed.md` final ainda
 * passa por humanizador + Clarice (Stage 2, Passo 3) ANTES do `cp` final —
 * qualquer um dos dois pode reescrever palavras dentro do bloco, o que faria
 * uma comparação texto-a-texto contra o MD final disparar falso-positivo em
 * quase toda edição (muito pior que o bug original). Hash do corpo-FONTE ao
 * longo do tempo (nunca comparado contra o MD humanizado/corrigido) evita
 * esse problema por construção. Fallback gracioso: manifest ausente (edição
 * anterior ao #4150) ou hash de um snippet específico ausente → volta pro
 * comportamento mtime-puro de sempre, nunca deixa de avisar por falta de
 * dado novo.
 */

import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
} from "../newsletter-parse.ts";
import { snippetBodyHash } from "../shared/snippet-header.ts";

/** Mesmo shape de `BoxesDivulgacaoConfig` (stitch-newsletter.ts) — duplicado
 * aqui (não importado) de propósito: este módulo precisa ler
 * `platform.config.json` de um path PARAMETRIZADO (testável com fixture em
 * diretório temporário, nunca o arquivo real) — o loader de
 * `stitch-newsletter.ts` resolve o ROOT real internamente, sem opção de
 * override. */
export interface BoxesDivulgacaoConfigLike {
  slot1: string | null;
  slot2: string | null;
  slot3: string | null;
}

/** Retorna `mtimeMs` do arquivo, ou `null` se ausente/inacessível. */
function safeMtimeMs(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Lê `platform.config.json` em `configPath` e extrai `boxes_divulgacao`.
 * Mesmo contrato/fallback de `loadBoxesDivulgacaoConfig` (stitch-newsletter.ts):
 * chave ausente → default legado (`livros-divulgacao.md` no slot1, nada nos
 * demais); config ilegível/corrompido → mesmo default (graceful).
 */
export function readBoxesDivulgacaoConfig(configPath: string): BoxesDivulgacaoConfigLike {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (raw.boxes_divulgacao && typeof raw.boxes_divulgacao === "object") {
      return {
        slot1: raw.boxes_divulgacao.slot1 ?? null,
        slot2: raw.boxes_divulgacao.slot2 ?? null,
        slot3: raw.boxes_divulgacao.slot3 ?? null,
      };
    }
  } catch {
    // graceful — config ausente/corrompido cai no default legado abaixo
  }
  return { slot1: "livros-divulgacao.md", slot2: null, slot3: null };
}

/**
 * Lê um snippet cru de `snippetsDir/filename`, removendo o comentário HTML de
 * header (convenção de todos os snippets). `null` se ausente/vazio após o
 * strip. Mesmo contrato de `readSnippetFile` (lib/shared/snippet-loader.ts),
 * parametrizado por diretório (testável).
 */
function readSnippetRaw(snippetsDir: string, filename: string): string | null {
  const p = join(snippetsDir, filename);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  return raw || null;
}

/**
 * True quando `agradecimento-apoiadores.md` tem conteúdo real (placeholder
 * `{apoiadores}` já substituído) — mesmo teste de `loadAgradecimentoSnippet`
 * (stitch-newsletter.ts). Se ainda tem o placeholder, o box nunca aparece em
 * `02-reviewed.md`, então não é candidato a staleness.
 */
export function isAgradecimentoSnippetUsed(snippetsDir: string): boolean {
  const raw = readSnippetRaw(snippetsDir, "agradecimento-apoiadores.md");
  if (raw === null) return false;
  return !raw.includes("{apoiadores}");
}

export type SnippetSlot = "encerramento" | "agradecimento" | "slot1" | "slot2" | "slot3";

export interface UsedSnippetEntry {
  file: string;
  slot: SnippetSlot;
}

/**
 * Pure — determina quais snippets ENTRARAM de fato nesta edição (ver doc do
 * módulo acima para a justificativa de cada regra). Não toca o filesystem —
 * `reviewedMd` é o conteúdo já lido de `02-reviewed.md`, `boxesCfg` já lido
 * de `platform.config.json`, `agradecimentoUsed` já resolvido por
 * `isAgradecimentoSnippetUsed`.
 */
export function resolveUsedSnippets(
  reviewedMd: string,
  boxesCfg: BoxesDivulgacaoConfigLike,
  agradecimentoUsed: boolean,
): UsedSnippetEntry[] {
  const used: UsedSnippetEntry[] = [
    // Sempre candidato — buildParaEncerrar() lê este arquivo incondicionalmente.
    { file: "encerramento-social-apoio.md", slot: "encerramento" },
  ];
  if (agradecimentoUsed) {
    used.push({ file: "agradecimento-apoiadores.md", slot: "agradecimento" });
  }
  if (boxesCfg.slot1 && extractBoxDivulgacao1(reviewedMd) !== null) {
    used.push({ file: boxesCfg.slot1, slot: "slot1" });
  }
  if (boxesCfg.slot2 && extractBoxDivulgacao2(reviewedMd) !== null) {
    used.push({ file: boxesCfg.slot2, slot: "slot2" });
  }
  if (boxesCfg.slot3 && extractBoxDivulgacao3(reviewedMd) !== null) {
    used.push({ file: boxesCfg.slot3, slot: "slot3" });
  }
  return used;
}

export interface SnippetStalenessWarning {
  kind: "snippet" | "config";
  /** Nome do arquivo (relativo a `context/snippets/`) ou `"platform.config.json"`. */
  file: string;
  slot?: SnippetSlot;
  reviewed_mtime: string;
  file_mtime: string;
  lag_minutes: number;
}

export interface SnippetStalenessReport {
  /** `true` quando não há nenhum warning. Informativo — este check NUNCA
   * bloqueia o gate, mesmo com `ok: false` (WARN-only, decisão da issue). */
  ok: boolean;
  warnings: SnippetStalenessWarning[];
}

// Mesma tolerância de `check-staleness.ts` — diferenças <1s são ruído
// (clock skew, chamadas paralelas), não edição real pós-stitch.
const DEFAULT_TOLERANCE_MS = 1000;

/**
 * Pure — compara mtimes já resolvidos (nenhum acesso a filesystem). Usado
 * tanto pelos testes (mtimes fabricados) quanto por `runSnippetStalenessCheck`
 * (mtimes reais lidos do disco).
 *
 * #4150: `recordedBodyHash`/`currentBodyHash` (ambos opcionais, back-compat
 * com chamadas/testes pré-#4150 que só passam mtime) permitem distinguir
 * edição de METADADO (linhas `nome:`/`categoria:`/`alt:` do cabeçalho de
 * comentário, nunca injetadas no corpo pelo stitch — ver `snippetBodyHash`)
 * de edição de CONTEÚDO real. Quando ambos os hashes estão presentes E
 * batem, o mtime mais novo é ignorado (silêncio) — só o cabeçalho mudou, o
 * corpo que o stitch de fato consumiu é idêntico ao gravado no momento do
 * stitch. Ausência de qualquer um dos dois (edição sem o manifest de hash,
 * ex: anterior ao #4150, ou arquivo que sumiu) preserva o comportamento
 * ANTIGO (mtime puro) — nunca deixa de avisar por falta de dado novo.
 */
export function evaluateSnippetStaleness(
  reviewedMtimeMs: number,
  usedSnippets: Array<{
    file: string;
    slot: SnippetSlot;
    mtimeMs: number | null;
    recordedBodyHash?: string | null;
    currentBodyHash?: string | null;
  }>,
  boxesConfig: { engaged: boolean; mtimeMs: number | null },
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): SnippetStalenessReport {
  const warnings: SnippetStalenessWarning[] = [];
  for (const s of usedSnippets) {
    if (s.mtimeMs === null) continue; // arquivo ausente — nada a comparar (graceful)
    if (s.mtimeMs - reviewedMtimeMs > toleranceMs) {
      // #4150: mtime mais novo, mas o CORPO pós-cabeçalho é idêntico ao
      // gravado no momento do stitch — mudança restrita ao cabeçalho de
      // comentário (nome/categoria/alt), que nunca chega no MD. Silêncio.
      if (
        s.recordedBodyHash != null &&
        s.currentBodyHash != null &&
        s.recordedBodyHash === s.currentBodyHash
      ) {
        continue;
      }
      warnings.push({
        kind: "snippet",
        file: s.file,
        slot: s.slot,
        reviewed_mtime: new Date(reviewedMtimeMs).toISOString(),
        file_mtime: new Date(s.mtimeMs).toISOString(),
        lag_minutes: Math.round((s.mtimeMs - reviewedMtimeMs) / 60000),
      });
    }
  }
  if (
    boxesConfig.engaged &&
    boxesConfig.mtimeMs !== null &&
    boxesConfig.mtimeMs - reviewedMtimeMs > toleranceMs
  ) {
    warnings.push({
      kind: "config",
      file: "platform.config.json",
      reviewed_mtime: new Date(reviewedMtimeMs).toISOString(),
      file_mtime: new Date(boxesConfig.mtimeMs).toISOString(),
      lag_minutes: Math.round((boxesConfig.mtimeMs - reviewedMtimeMs) / 60000),
    });
  }
  return { ok: warnings.length === 0, warnings };
}

export interface RunSnippetStalenessOptions {
  /** Override de teste — diretório de `context/snippets/`. Default: real. */
  snippetsDir?: string;
  /** Override de teste — path de `platform.config.json`. Default: real. */
  configPath?: string;
}

// #4150: manifest de hash do CORPO pós-cabeçalho de cada snippet usado, no
// momento do stitch (Stage 2) — irmão de `_internal/.social-source-hash.json`
// (#1413, mesmo padrão: hash gravado na produção, comparado depois). Vive
// dentro de `_internal/` da própria edição (ao lado de `02-draft.md`), não em
// `snippetsDir`/`configPath` (que podem ser overrides de teste apontando pra
// um diretório de fixture sem relação com a edição).
const SNIPPET_BODY_HASH_MANIFEST_RELPATH = join("_internal", ".snippet-body-hashes.json");

interface SnippetBodyHashManifest {
  hashes?: Record<string, string>;
  generated_at?: string;
}

/**
 * Lê o manifest de hashes gravado por `buildSnippetBodyHashManifest` +
 * `writeSnippetBodyHashManifest` (chamado por `stitch-newsletter.ts` logo
 * após escrever `02-draft.md`). `null` se ausente/corrompido/formato
 * inesperado — graceful, o caller cai de volta pro comportamento mtime-puro
 * (edição anterior ao #4150, ou qualquer falha ao gravar o manifest).
 */
export function readSnippetBodyHashManifest(editionDir: string): Record<string, string> | null {
  const p = join(editionDir, SNIPPET_BODY_HASH_MANIFEST_RELPATH);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as SnippetBodyHashManifest;
    if (raw.hashes && typeof raw.hashes === "object") return raw.hashes;
    return null;
  } catch {
    return null;
  }
}

/**
 * Monta `{ file: bodyHash }` para os snippets efetivamente USADOS nesta
 * edição — chamado por `stitch-newsletter.ts` (main()) logo após montar
 * `02-draft.md`, com o `used` já resolvido via `resolveUsedSnippets` sobre o
 * MD recém-montado. Arquivo ausente/ilegível para um dado snippet é pulado
 * (graceful — mesma postura de `safeMtimeMs`); esse snippet simplesmente não
 * entra no manifest e o guard cai pro fallback mtime-puro pra ele.
 */
export function buildSnippetBodyHashManifest(
  usedSnippets: UsedSnippetEntry[],
  snippetsDir: string,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const u of usedSnippets) {
    try {
      const raw = readFileSync(join(snippetsDir, u.file), "utf8");
      hashes[u.file] = snippetBodyHash(raw);
    } catch {
      // arquivo sumiu entre resolveUsedSnippets e aqui, ou é ilegível —
      // graceful, sem esse snippet no manifest.
    }
  }
  return hashes;
}

/**
 * Grava o manifest em `{editionDir}/_internal/.snippet-body-hashes.json`.
 * Pode lançar (I/O) — caller (`stitch-newsletter.ts`) envolve em try/catch
 * fail-soft, mesmo padrão de `merge-social-md.ts` gravando
 * `.social-source-hash.json` (#1413): a escrita do manifest NUNCA deve
 * derrubar o stitch em si, só degradar o guard de volta pro mtime-puro.
 */
export function writeSnippetBodyHashManifest(
  editionDir: string,
  hashes: Record<string, string>,
): void {
  const p = join(editionDir, SNIPPET_BODY_HASH_MANIFEST_RELPATH);
  writeFileSync(
    p,
    JSON.stringify({ hashes, generated_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Impuro — monta o report real a partir do disco. `mdPath` é sempre real
 * (o `02-reviewed.md` da edição em curso); `snippetsDir`/`configPath` são
 * overrides SÓ para teste (fixtures em diretório temporário — nunca aponta
 * para `context/snippets/`/`platform.config.json` reais em teste, por regra
 * desta rodada).
 */
export function runSnippetStalenessCheck(
  mdPath: string,
  root: string,
  opts: RunSnippetStalenessOptions = {},
): SnippetStalenessReport {
  const reviewedMtime = safeMtimeMs(mdPath);
  if (reviewedMtime === null) {
    // 02-reviewed.md ausente — nada a comparar (skip gracioso, mesma postura
    // de check-staleness.ts quando o downstream não existe).
    return { ok: true, warnings: [] };
  }
  const reviewedMd = readFileSync(mdPath, "utf8");
  const snippetsDir = opts.snippetsDir ?? join(root, "context", "snippets");
  const configPath = opts.configPath ?? join(root, "platform.config.json");

  const boxesCfg = readBoxesDivulgacaoConfig(configPath);
  const agradecimentoUsed = isAgradecimentoSnippetUsed(snippetsDir);
  const used = resolveUsedSnippets(reviewedMd, boxesCfg, agradecimentoUsed);

  // #4150: editionDir = diretório de 02-reviewed.md (onde `_internal/` mora)
  // — sempre real, nunca os overrides de teste de snippetsDir/configPath.
  const editionDir = join(mdPath, "..");
  const bodyHashManifest = readSnippetBodyHashManifest(editionDir);

  const usedWithMtimes = used.map((u) => {
    const filePath = join(snippetsDir, u.file);
    const mtimeMs = safeMtimeMs(filePath);
    let currentBodyHash: string | null = null;
    if (bodyHashManifest && bodyHashManifest[u.file] !== undefined) {
      try {
        currentBodyHash = snippetBodyHash(readFileSync(filePath, "utf8"));
      } catch {
        currentBodyHash = null;
      }
    }
    return {
      file: u.file,
      slot: u.slot,
      mtimeMs,
      recordedBodyHash: bodyHashManifest ? bodyHashManifest[u.file] ?? null : null,
      currentBodyHash,
    };
  });
  const boxesEngaged = used.some(
    (u) => u.slot === "slot1" || u.slot === "slot2" || u.slot === "slot3",
  );

  return evaluateSnippetStaleness(reviewedMtime, usedWithMtimes, {
    engaged: boxesEngaged,
    mtimeMs: safeMtimeMs(configPath),
  });
}
