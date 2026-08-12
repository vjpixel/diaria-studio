#!/usr/bin/env tsx
/**
 * reorder-destaques.ts (#1585)
 *
 * Reordena destaques mid-Stage atomicamente. Propaga reorder pra:
 *   - `_internal/01-approved.json` (highlights[])
 *   - `_internal/01-approved-capped.json` (highlights[])
 *   - `02-reviewed.md` (blocos DESTAQUE 1/2/3)
 *   - `_internal/intentional-error.json` (campo `location`, #3222 — não mora
 *     mais no frontmatter de `02-reviewed.md`)
 *   - `_internal/02-d{N}-prompt.md` (rename files)
 *   - `04-d{N}-*.jpg` (rename files — 2x1, 1x1, 4x5, 4x5-nativo, master; #5085
 *     cobriu 4x5-nativo, que o regex antigo excluía por causa do hífen no
 *     sufixo, e adicionou verificação `existsSync` pós-rename — ver
 *     `renameSyncVerified`)
 *   - `03-social.md` (sections `## d{N}` em cada plataforma)
 *
 * Outputs a JSON com lista de arquivos modificados. NÃO re-uploada imagens
 * pro Drive/Cloudflare (editor roda upload-images-public manualmente após
 * checagem visual).
 *
 * Uso:
 *   # D2 vira D1, D1 vira D2, D3 stay:
 *   npx tsx scripts/reorder-destaques.ts --edition 260529 --new-order 2,1,3
 *
 *   # Dry-run:
 *   npx tsx scripts/reorder-destaques.ts --edition 260529 --new-order 2,1,3 --dry-run
 *
 *   # Custom edition-dir (sobrescreve default data/editions/{AAMMDD}):
 *   npx tsx scripts/reorder-destaques.ts --edition 260529 --new-order 3,1,2 --edition-dir /tmp/test
 *
 *   # --editions-dir <path>: override do editions ROOT — só para testes (#3491)
 *
 * Validação:
 *   - --new-order DEVE ser permutação de [1,2,3]
 *   - Idempotente: reorder 1,2,3 = no-op (saída zero-changes)
 *   - Reorder + inverso = identity (#1606 review fix: 2× só identity em 2-cycles
 *     como [2,1,3]; 3-cycles como [3,1,2] precisam 3 aplicações pra fechar).
 *     Editor que quer desfazer reorder anterior deve usar o inverso explícito.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDestaqueCount } from "./lib/invariant-checks/stage-3.ts";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import {
  loadIntentionalErrorJson,
  writeIntentionalErrorJson,
  intentionalErrorJsonPath,
  type IntentionalErrorJson,
} from "./lib/intentional-errors.ts";
import {
  extractTitlesFromMd,
  insertOrUpdateTituloSubtitulo,
} from "./insert-titulo-subtitulo.ts"; // #3980
import { checkDestaqueMaxChars } from "./lib/lint-checks/destaque-chars.ts"; // #3982

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Funções de rename/existsSync injetáveis pra teste (#5085, mesmo padrão de
 * `PlanFileReaders` em `overnight-statusline.ts`).
 */
export interface RenameFileDeps {
  renameSync: typeof renameSync;
  existsSync: typeof existsSync;
}

const defaultRenameFileDeps: RenameFileDeps = { renameSync, existsSync };

/**
 * Rename com verificação pós-rename (#5085 — achado ao vivo edição 260812).
 *
 * `renameSync` retornar sem lançar NÃO garante que o arquivo de destino
 * ainda existe momentos depois: numa pasta sincronizada por um provedor tipo
 * OneDrive (`data/` é uma directory junction), uma sequência de vários
 * renames rápidos em 1-2s pode disparar resolução de conflito do provedor de
 * sync que descarta uma das versões "perdedoras" DEPOIS que a chamada já
 * retornou com sucesso do ponto de vista do Node — não há como detectar isso
 * na própria chamada de `renameSync`.
 *
 * Verificar `existsSync(to)` logo em seguida fecha essa lacuna: se o destino
 * não existe, abortamos com erro claro em vez de prosseguir silenciosamente
 * pro próximo rename da sequência. O bug real: o grupo inteiro de
 * `04-d2-*.jpg` sumiu do disco (e do OneDrive) sem nenhum sinal de erro no
 * pipeline — pior que um placeholder óbvio, porque a publicação teria saído
 * com a imagem de uma edição antiga, não uma imagem ausente.
 */
export function renameSyncVerified(
  from: string,
  to: string,
  deps: RenameFileDeps = defaultRenameFileDeps,
): void {
  deps.renameSync(from, to);
  if (!deps.existsSync(to)) {
    throw new Error(
      `reorder-destaques: rename ${from} → ${to} retornou sem erro mas o arquivo de destino ` +
        `não existe no disco logo depois. Provável conflito de sync (OneDrive) descartando uma ` +
        `versão "perdedora" durante a sequência de renames. Abortando para evitar publicação ` +
        `com imagem ausente/errada — reexecute reorder-destaques.ts depois de confirmar que o ` +
        `sync terminou (ou restaure os arquivos a partir do OneDrive antes de retentar).`,
    );
  }
}

export interface CliArgs {
  edition: string;
  newOrder: number[];
  editionDir: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  // #2834: --dry-run é flag booleana incondicional no parser local original
  // (checada antes da lógica genérica, com `continue` — nunca é tratada como
  // valor de outra flag) → argv.includes preserva isso. O consumo de valor das
  // demais flags é incondicional (argv[i+1] vira valor mesmo que comece com
  // "--") → parseArgsSimple replica; por isso removemos "--dry-run" antes de
  // repassar pro parser genérico, senão ele tentaria consumir o próximo token
  // como se "--dry-run" fosse uma flag de valor.
  const dryRun = argv.includes("--dry-run");
  const args = parseArgsSimple(argv.filter((a) => a !== "--dry-run"));
  if (!args.edition || !args["new-order"]) {
    console.error(
      "Uso: reorder-destaques.ts --edition AAMMDD --new-order 2,1,3 [--edition-dir <path>] [--dry-run]",
    );
    process.exit(2);
  }
  const newOrder = args["new-order"].split(",").map((s) => parseInt(s.trim(), 10));
  // #2352: aceita permutação de [1,2] (2-destaque) OU [1,2,3] (3-destaque).
  // N = length do newOrder; válido se length ∈ {2,3} e é permutação de [1..N].
  const n = newOrder.length;
  const validNs = [2, 3];
  const expected = Array.from({ length: n }, (_, i) => i + 1);
  if (
    !validNs.includes(n) ||
    newOrder.some((x) => !expected.includes(x)) ||
    new Set(newOrder).size !== n
  ) {
    console.error(
      `--new-order inválido: "${args["new-order"]}". Deve ser permutação de 1,2 (2-destaque) ou 1,2,3 (3-destaque).`,
    );
    process.exit(2);
  }
  // #3491: sem --edition-dir (o override "cru" de path COMPLETO, já existente),
  // o default construía `data/editions/{AAMMDD}` à mão (layout FLAT) — mesma
  // classe de bug de #3483/#3484. Este é um comando editor-invocado
  // diretamente (sem caller fixo no orchestrator que sempre passe
  // --edition-dir), então o default É o path realmente exercitado no uso
  // normal. `resolveEditionDir` acha o dir REAL no disco (flat ou nested).
  // `--editions-dir` (plural, raiz) é um segundo override, só de teste (mesmo
  // padrão de close-poll.ts #3031) — distinto de `--edition-dir` (singular,
  // dir completo).
  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir =
    args["edition-dir"] ?? resolveEditionDir(editionsRootDir, args.edition);
  return { edition: args.edition, newOrder, editionDir, dryRun };
}

interface FilesModified {
  rewritten: string[];
  renamed: Array<{ from: string; to: string }>;
}

/**
 * Reordena highlights[] em JSON file (01-approved.json ou 01-approved-capped.json).
 * newOrder[i] é o número canônico (1-based) do destaque que vai pra posição i.
 *
 * Ex: newOrder=[2,1,3] → highlights[0] = original highlights[1] (D2),
 *                       highlights[1] = original highlights[0] (D1),
 *                       highlights[2] = original highlights[2] (D3).
 *
 * #2352: suporta newOrder de comprimento 2 (2-destaque) ou 3 (3-destaque).
 * `h.length < newOrder.length` → return false (não tenta reordenar mais
 * destaques do que existem no JSON). 3-destaque com newOrder de 2 elementos
 * é inválido por definição — CLI valida antes de chegar aqui.
 */
export function reorderHighlightsInJson(
  json: { highlights?: unknown[] },
  newOrder: number[],
): boolean {
  const h = json.highlights;
  if (!Array.isArray(h) || h.length < newOrder.length) return false;
  const reordered = newOrder.map((n) => h[n - 1]);
  // Preserva slots após os N reordenados (ex: runners-up em posição 3+)
  const tail = h.slice(newOrder.length);
  json.highlights = [...reordered, ...tail];
  return true;
}

/**
 * Reordena blocos DESTAQUE N em 02-reviewed.md. Renumera headers no
 * resultado (`DESTAQUE 1 | …` no top, `DESTAQUE 2 | …`, etc).
 *
 * Estratégia:
 *   1. Split MD em pre-destaques + N blocos DESTAQUE + post-destaques
 *   2. Reordenar blocos conforme newOrder
 *   3. Renumerar `DESTAQUE N | …` → posição final
 *   4. Re-join
 *
 * Não toca `_internal/intentional-error.json` (caller cuida do campo `location`
 * via `updateIntentionalErrorLocationJson`, #3222).
 */
export function reorderDestaquesInMd(md: string, newOrder: number[]): string {
  // Match cada bloco: header + content until next `---\n\n**DESTAQUE` OR
  // next non-destaque section (LANÇAMENTOS, RADAR/PESQUISAS/OUTRAS legacy, etc).
  // #1569: 📡 RADAR adicionado como terminator (caso 260529+ teve D3 engolindo
  // RADAR inteiro porque emoji ausente da lista).
  // Review #1606: `\Z` é literal Z em JS — usar `$(?![\s\S])` pra true EOF.
  const blockRe =
    /(\*\*DESTAQUE\s+\d+\s*\|[^\n]*\*\*[\s\S]*?)(?=\n+---\n+\*\*(?:DESTAQUE\s+\d|🚀|🔬|📰|📡|🛠️|VÍDEOS?|🎁|🙋|ERRO\s+INTENCIONAL|ASSINE)|$(?![\s\S]))/g;
  const blocks: string[] = [];
  const positions: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(md)) !== null) {
    blocks.push(m[1]);
    positions.push({ start: m.index, end: m.index + m[1].length });
  }
  // #2352: require at least as many blocks as positions in newOrder (2 or 3).
  if (blocks.length < newOrder.length) return md;

  // Reorder + renumerar
  const reorderedBlocks = newOrder.map((n, i) => {
    const block = blocks[n - 1];
    // Substitui "DESTAQUE N |" pra "DESTAQUE i+1 |" no header
    return block.replace(
      /^\*\*DESTAQUE\s+\d+(\s*\|)/m,
      `**DESTAQUE ${i + 1}$1`,
    );
  });
  // #2352: tail = blocks beyond the N reordered ones (e.g. slot 3 in a 3-block
  // MD when newOrder has 2 elements is intentionally not included here, because
  // a 2-destaque edition has only 2 blocks — tail is empty in the normal case).
  const tail = blocks.slice(newOrder.length);

  // Construir resultado: prefixo (antes do 1º block) + blocos reordenados +
  // sufixo (após o último block original).
  const firstStart = positions[0].start;
  const lastEnd = positions[positions.length - 1].end;
  const prefix = md.slice(0, firstStart);
  const suffix = md.slice(lastEnd);
  // Separator entre blocos: usar `\n\n---\n\n` (canônico do template)
  const blocksSerialized = [...reorderedBlocks, ...tail].join("\n\n---\n\n");
  return prefix + blocksSerialized + suffix;
}

/**
 * Atualiza `location` do record `_internal/intentional-error.json` quando
 * refere a DESTAQUE N. "DESTAQUE 2, paragrafo 2" + newOrder=[2,1,3] →
 * "DESTAQUE 1, paragrafo 2" (porque o que era D2 agora é D1).
 *
 * (#3222) Migrado de regex sobre frontmatter YAML em `02-reviewed.md` pra
 * operar direto no campo `location` do JSON estruturado — `_internal/*`
 * nunca sincroniza com o Drive, então não há mais round-trip de Google Docs
 * a se preocupar aqui.
 *
 * Review #1606 (herdado): só reescreve quando `location` começa literalmente
 * com "DESTAQUE N" — conservador, evita tocar valores que citam destaque
 * fora desse padrão.
 */
export function updateIntentionalErrorLocationJson(
  record: IntentionalErrorJson,
  newOrder: number[],
): { record: IntentionalErrorJson; changed: boolean } {
  if (typeof record.location !== "string") return { record, changed: false };
  const m = record.location.match(/^DESTAQUE\s+(\d)(\s*,.*)?$/);
  if (!m) return { record, changed: false };

  const oldNum = parseInt(m[1], 10);
  if (![1, 2, 3].includes(oldNum)) return { record, changed: false };
  const newIdx = newOrder.indexOf(oldNum);
  if (newIdx < 0) {
    // #2366: DESTAQUE N referenciado na location não existe no newOrder
    // (ex: location='DESTAQUE 3' num reorder 3→2 destaques). Sem este
    // tratamento a location ficaria stale silenciosamente apontando pro
    // destaque eliminado.
    //
    // NÃO limpar pra string vazia: o lint de intentional-error (Stage 5,
    // scripts/lib/lint-checks/intentional-error.ts) trata location vazia
    // como campo faltando → "intentional_error_incomplete: campos faltando
    // — location" → BLOQUEIA publicação. Em vez disso, escrever um sentinel
    // não-vazio que (a) passa a checagem de completude e (b) sinaliza ao
    // editor que precisa redeclarar o erro manualmente.
    console.warn(
      `[updateIntentionalErrorLocationJson] location aponta para DESTAQUE ${oldNum} que não existe em newOrder=[${newOrder.join(",")}] — marcando location como REVISAR (destaque removido no reorder)`,
    );
    return {
      record: { ...record, location: "[REVISAR — destaque removido no reorder]" },
      changed: true,
    };
  }
  const newN = newIdx + 1;
  const rest = m[2] ?? "";
  return { record: { ...record, location: `DESTAQUE ${newN}${rest}` }, changed: true };
}

/**
 * Reordena sections `## d{N}` em 03-social.md. Sintaxe é repetida por
 * plataforma (LinkedIn, Facebook), então re-aplicar pra cada bloco.
 *
 * Header pattern: `^## d(\d)\b` (case-insensitive). Renumerar igual ao MD.
 */
export function reorderSocialMd(md: string, newOrder: number[]): string {
  // Review #1612: dead-code loop de sectionRe removido. O reorder real é
  // o token-replace abaixo (## d{N} → ## TEMP_D{N} → ## d{newN}).
  if (!/^##\s+d\d/im.test(md)) return md;

  // Grupos por d-number. Pode haver múltiplas plataformas com d1/d2/d3.
  // Estratégia: pra cada plataforma block (sequência de d1/d2/d3 consecutiva),
  // reordenar. Por simplicidade, reorder GLOBAL — se há 2 plataformas, cada
  // d1 original vira d{newOrder.indexOf(1)+1}.
  let result = md;
  // Build mapping old N → new N
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  // Replace each `## d{N}` header — usar token temporário pra evitar conflito
  // entre passes (## d1 → ## d2 → ## d1 oscilação).
  let temp = result;
  temp = temp.replace(/^##\s+d(\d)\s*$/gim, (full, oldNStr) => {
    const oldN = parseInt(oldNStr, 10);
    const newN = oldToNew.get(oldN);
    return newN ? `## TEMP_D${newN}` : full;
  });
  result = temp.replace(/^##\s+TEMP_D(\d)\s*$/gim, "## d$1");
  return result;
}

/**
 * Reverte best-effort TODOS os renames de fato aplicados nesta invocação
 * quando a sequência de 2 passos (original→TMP→final) abortar no meio
 * (#5087 self-review finding do #5085 — sem rollback, um
 * `renameSyncVerified` que lança no meio da sequência deixava arquivos
 * `TMP{N}-*` órfãos no disco).
 *
 * HOTFIX (achado do review consolidado da rodada overnight que produziu
 * #5085/#5087): a versão anterior recebia só os pares "original→TMP" AINDA
 * pendentes (removidos da lista assim que promovidos ao nome final no passo
 * 2) e revertia cada TMP de volta pro `originalName` do SEU PRÓPRIO grupo.
 * Isso corrompe dado em qualquer reorder cíclico (todo swap/rotação — o caso
 * mais comum) onde pelo menos uma promoção do passo 2 tem sucesso antes de
 * outra falhar: o `originalName` de uma entrada ainda pendente pode já ter
 * sido REIVINDICADO como `finalName` por uma promoção que teve sucesso —
 * ex: TMP1 (era D1) promove com sucesso pra D2 (seu novo slot); TMP2 (era
 * D2) falha ao promover pra D1; o rollback antigo renomeava TMP2 de volta
 * pra "D2", sobrescrevendo silenciosamente o conteúdo de D1 recém-promovido
 * ali — D1 desaparecia sem chance de recuperação a partir do próprio
 * output da função.
 *
 * Fix: `applied` agora é a lista CRONOLÓGICA de TODOS os renames realmente
 * executados nesta invocação (passo 1 E passo 2, nunca removidos da lista
 * ao promover). O rollback desfaz em ordem REVERSA — cada entrada volta
 * exatamente ao nome (`from`) que tinha imediatamente ANTES daquele rename
 * específico, tratando a sequência como uma pilha de operações atômicas a
 * desfazer uma a uma, em vez de reconstruir "o nome original do grupo".
 * Isso generaliza pra qualquer ciclo (swap de 2, rotação de 3, ...): cada
 * `to` só é revertido se ainda existir com aquele nome exato — se uma
 * operação posterior já moveu o arquivo dali (caso comum quando o mesmo
 * path é reaproveitado por dois renames em sequência), a entrada mais
 * recente desfaz primeiro (ordem reversa), liberando o path na ordem certa
 * pra entrada anterior encontrar o que espera.
 *
 * Best-effort de propósito: usada dentro de um `catch`, então NUNCA lança —
 * se o próprio rollback falhar (ex: o arquivo esperado também já sumiu,
 * mesma classe de conflito de sync que motivou `renameSyncVerified` em
 * primeiro lugar), a falha é engolida em silêncio pra aquela entrada e o
 * loop continua tentando desfazer as demais. O objetivo é reduzir
 * dado-perdido/órfão, não garantir reversão perfeita — o erro original (já
 * capturado pelo caller) é o que de fato chega ao editor.
 */
function rollbackAppliedRenames(
  dir: string,
  applied: Array<{ from: string; to: string }>,
  deps: RenameFileDeps,
): void {
  for (let i = applied.length - 1; i >= 0; i--) {
    const { from, to } = applied[i];
    try {
      const toPath = join(dir, to);
      if (deps.existsSync(toPath)) {
        deps.renameSync(toPath, join(dir, from));
      }
    } catch {
      // best-effort — nunca lançar por cima do erro original do caller;
      // segue tentando desfazer as demais entradas da pilha.
    }
  }
}

/**
 * Renomeia arquivos de imagem 04-d{N}-*.jpg conforme newOrder.
 * Estratégia: usar nomes temporários pra evitar colisão (renomeia
 * 04-d1-* → 04-tmp-d1-*, depois 04-tmp-d1-* → 04-d{newPos}-*).
 *
 * #5085: regex de match do sufixo aceita hífen (`[a-z0-9-]+`, não só
 * `[a-z0-9]+`) — sem isso, `04-d{N}-4x5-nativo.jpg` (arte nativa gerada por
 * `image-generate.ts`) nunca era pego pelo filtro e ficava com o número de
 * destaque ERRADO após um reorder, silenciosamente (nenhum erro, só o
 * arquivo órfão do slot antigo).
 *
 * #5085: cada rename passa por `renameSyncVerified` (existsSync pós-rename),
 * que lança se o destino não existir — ver docstring de `renameSyncVerified`.
 *
 * #5087 (self-review finding do #5085): se `renameSyncVerified` lançar no
 * MEIO da sequência de 2 passos, os renames já aplicados até ali (passo 1 E
 * passo 2 — ver HOTFIX na docstring de `rollbackAppliedRenames`) são
 * revertidos best-effort antes de repropagar o erro — evita órfãos
 * `04-TMP{N}-*` no disco E evita sobrescrever silenciosamente uma promoção
 * anterior que já tinha tido sucesso no mesmo reorder cíclico.
 *
 * Retorna lista de renames aplicados.
 */
export function renameDestaqueImages(
  editionDir: string,
  newOrder: number[],
  dryRun: boolean,
  deps: RenameFileDeps = defaultRenameFileDeps,
): Array<{ from: string; to: string }> {
  const renames: Array<{ from: string; to: string }> = [];
  if (!deps.existsSync(editionDir)) return renames;
  const files = readdirSync(editionDir).filter((f) =>
    /^04-d[123]-[a-z0-9-]+\.(?:jpg|png|jpeg)$/i.test(f),
  );
  // Build oldN → newN map
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  // Rastreia TODOS os renames de fato aplicados nesta invocação, em ordem
  // cronológica — passo 1 (original→TMP) E passo 2 (TMP→final), NUNCA
  // removidos da lista ao promover (ver HOTFIX na docstring de
  // `rollbackAppliedRenames` — remover ao promover foi o que causava o
  // data-loss em reorders cíclicos).
  const appliedRenames: Array<{ from: string; to: string }> = [];
  try {
    // 2-step rename pra evitar colisão
    for (const f of files) {
      const m = f.match(/^04-d([123])-(.+)$/);
      if (!m) continue;
      const oldN = parseInt(m[1], 10);
      const newN = oldToNew.get(oldN);
      if (!newN || newN === oldN) continue;
      const tmpName = f.replace(`04-d${oldN}-`, `04-TMP${oldN}-`);
      if (!dryRun) {
        renameSyncVerified(join(editionDir, f), join(editionDir, tmpName), deps);
        appliedRenames.push({ from: f, to: tmpName });
      }
      renames.push({ from: f, to: tmpName });
    }
    // Step 2: tmp → final
    if (!dryRun) {
      const tmpFiles = readdirSync(editionDir).filter((f) =>
        /^04-TMP[123]-[a-z0-9-]+\.(?:jpg|png|jpeg)$/i.test(f),
      );
      for (const f of tmpFiles) {
        const m = f.match(/^04-TMP([123])-(.+)$/);
        if (!m) continue;
        const oldN = parseInt(m[1], 10);
        const newN = oldToNew.get(oldN)!;
        const finalName = `04-d${newN}-${m[2]}`;
        renameSyncVerified(join(editionDir, f), join(editionDir, finalName), deps);
        appliedRenames.push({ from: f, to: finalName });
        renames.push({ from: f, to: finalName });
      }
    }
  } catch (e) {
    rollbackAppliedRenames(editionDir, appliedRenames, deps);
    throw e;
  }
  return renames;
}

/**
 * (#3980) Re-deriva o bloco TÍTULO/SUBTÍTULO do topo de `02-reviewed.md` a
 * partir dos títulos D1/D2/D3 JÁ REORDENADOS no `md` passado. Pura — delega
 * inteiramente a `insert-titulo-subtitulo.ts` (#916, mesma lógica usada no
 * Stage 2) em vez de duplicar extração/render aqui. Sem isso, um reorder
 * deixava TÍTULO/SUBTÍTULO com os títulos ANTIGOS (pré-reorder), vazando pro
 * assunto/preview do Beehiiv no Stage 5.
 *
 * Retorna `null` quando não há DESTAQUE 1 reconhecível no md (ex: reviewed.md
 * ainda não escrito no formato esperado) — caller trata como no-op, não erro
 * fatal (reorder já reportaria isso via outros caminhos se fosse grave).
 */
export function deriveTituloSubtitulo(
  md: string,
): { md: string; action: "inserted" | "updated" | "no_change" } | null {
  const { d1, d2, d3 } = extractTitlesFromMd(md);
  if (!d1) return null;
  return insertOrUpdateTituloSubtitulo(md, d1, d2 ?? "", d3 ?? "");
}

/**
 * Renomeia arquivos `_internal/02-d{N}-prompt.md` e `_internal/02-d{N}-sd-prompt.json`.
 *
 * #5085: mesma proteção `renameSyncVerified` (existsSync pós-rename) do
 * `renameDestaqueImages` — se um provedor de sync descartar o destino entre
 * o `renameSync` e a próxima operação, aborta em vez de seguir silenciosamente.
 *
 * #5087 (self-review finding do #5085): mesmo rollback best-effort de
 * `renameDestaqueImages` (`rollbackAppliedRenames`) pra órfãos `02-TMP{N}-*`
 * — inclusive o HOTFIX de rastrear passo 1 E passo 2 (ver docstring de
 * `rollbackAppliedRenames`).
 */
export function renameDestaquePrompts(
  internalDir: string,
  newOrder: number[],
  dryRun: boolean,
  deps: RenameFileDeps = defaultRenameFileDeps,
): Array<{ from: string; to: string }> {
  const renames: Array<{ from: string; to: string }> = [];
  if (!deps.existsSync(internalDir)) return renames;
  const files = readdirSync(internalDir).filter((f) =>
    /^02-d[123]-(?:prompt\.md|sd-prompt\.json|draft\.md)$/.test(f),
  );
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  // Ver comentário equivalente em `renameDestaqueImages` — mesma pilha de
  // renames aplicados (passo 1 E passo 2), nunca removida ao promover.
  const appliedRenames: Array<{ from: string; to: string }> = [];
  try {
    // 2-step rename
    for (const f of files) {
      const m = f.match(/^02-d([123])-(.+)$/);
      if (!m) continue;
      const oldN = parseInt(m[1], 10);
      const newN = oldToNew.get(oldN);
      if (!newN || newN === oldN) continue;
      const tmpName = f.replace(`02-d${oldN}-`, `02-TMP${oldN}-`);
      if (!dryRun) {
        renameSyncVerified(join(internalDir, f), join(internalDir, tmpName), deps);
        appliedRenames.push({ from: f, to: tmpName });
      }
      renames.push({ from: f, to: tmpName });
    }
    if (!dryRun) {
      const tmpFiles = readdirSync(internalDir).filter((f) =>
        /^02-TMP[123]-/.test(f),
      );
      for (const f of tmpFiles) {
        const m = f.match(/^02-TMP([123])-(.+)$/);
        if (!m) continue;
        const oldN = parseInt(m[1], 10);
        const newN = oldToNew.get(oldN)!;
        const finalName = `02-d${newN}-${m[2]}`;
        renameSyncVerified(join(internalDir, f), join(internalDir, finalName), deps);
        appliedRenames.push({ from: f, to: finalName });
        renames.push({ from: f, to: finalName });
      }
    }
  } catch (e) {
    rollbackAppliedRenames(internalDir, appliedRenames, deps);
    throw e;
  }
  return renames;
}

function processJsonFile(
  path: string,
  newOrder: number[],
  dryRun: boolean,
): boolean {
  if (!existsSync(path)) return false;
  const data = JSON.parse(readFileSync(path, "utf8"));
  const changed = reorderHighlightsInJson(data, newOrder);
  if (changed && !dryRun) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  return changed;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args.editionDir;
  if (!existsSync(editionDir)) {
    console.error(`Edition dir não encontrado: ${editionDir}`);
    process.exit(1);
  }
  const internalDir = resolve(editionDir, "_internal");

  // #2352: Rejeita quando o comprimento de --new-order não bate com o
  // destaque_count real da edição. Ex: --new-order 2,1 numa edição 3-destaque
  // faria reorderHighlightsInJson emitir [D2,D1,D3] sem aviso — footgun.
  const editionDestaqueCount = readDestaqueCount(editionDir);
  if (args.newOrder.length !== editionDestaqueCount) {
    console.error(
      `Erro: --new-order tem ${args.newOrder.length} posições mas a edição tem ${editionDestaqueCount} destaques. ` +
      `Forneça uma permutação completa de 1..${editionDestaqueCount} (ex: ${Array.from({ length: editionDestaqueCount }, (_, i) => i + 1).join(",")}).`,
    );
    process.exit(2);
  }

  // No-op se ordem é canônica (1,2 ou 1,2,3 dependendo de N).
  const canonical = Array.from({ length: args.newOrder.length }, (_, i) => i + 1).join(",");
  if (args.newOrder.join(",") === canonical) {
    console.log(JSON.stringify({ edition: args.edition, no_op: true }, null, 2));
    return;
  }

  const modified: FilesModified = { rewritten: [], renamed: [] };

  // 1. Image files + 2. Prompts — RENOMEADOS ANTES de qualquer escrita de
  // texto (#5087 self-review finding do #5085 reordena esta seção pra cá,
  // era o passo 4/5 originais, executado DEPOIS dos writes de texto).
  //
  // Motivo: `renameDestaqueImages`/`renameDestaquePrompts` são as únicas
  // operações desta função capazes de abortar no meio de uma sequência
  // (`renameSyncVerified` lança em conflito de sync — ver docstring).
  // Rodando-as primeiro, um abort aqui propaga com o disco AINDA no estado
  // pré-reorder para JSON/md/social — nunca deixa texto já reordenado à
  // frente de imagens só parcialmente reordenadas (estado misto). As
  // funções não dependem de nada computado pelas etapas de texto abaixo
  // (só de `editionDir`/`internalDir`/`args.newOrder`/`args.dryRun`), então
  // a reordenação é puramente de sequenciamento — sem mudança de
  // comportamento em nenhum dos dois lados.
  modified.renamed.push(
    ...renameDestaqueImages(editionDir, args.newOrder, args.dryRun),
  );
  modified.renamed.push(
    ...renameDestaquePrompts(internalDir, args.newOrder, args.dryRun),
  );

  // 3. JSONs canônicos
  for (const f of ["01-approved.json", "01-approved-capped.json"]) {
    const path = resolve(internalDir, f);
    if (processJsonFile(path, args.newOrder, args.dryRun)) {
      modified.rewritten.push(path);
    }
  }

  // 3b. 02-reviewed.md
  const mdPath = resolve(editionDir, "02-reviewed.md");
  // Conteúdo pós-reorder de 02-reviewed.md (em memória, mesmo em --dry-run) —
  // usado pelos passos 2c (#3980) e pela validação max-chars (#3982) abaixo,
  // sem precisar reler o disco (que em dry-run continuaria com o conteúdo
  // ANTIGO, pré-reorder).
  let reorderedReviewedMd: string | null = null;
  if (existsSync(mdPath)) {
    let md = readFileSync(mdPath, "utf8");
    const before = md;
    md = reorderDestaquesInMd(md, args.newOrder);
    if (md !== before) {
      if (!args.dryRun) writeFileSync(mdPath, md, "utf8");
      modified.rewritten.push(mdPath);
    }
    reorderedReviewedMd = md;
  }

  // 3c. _internal/intentional-error.json (#3222 — location não mora mais no
  // frontmatter de 02-reviewed.md).
  const intentionalErrorPath = intentionalErrorJsonPath(editionDir);
  const intentionalErrorRecord = loadIntentionalErrorJson(intentionalErrorPath);
  if (intentionalErrorRecord) {
    const { record: updatedRecord, changed } = updateIntentionalErrorLocationJson(
      intentionalErrorRecord,
      args.newOrder,
    );
    if (changed) {
      if (!args.dryRun) writeIntentionalErrorJson(intentionalErrorPath, updatedRecord);
      modified.rewritten.push(intentionalErrorPath);
    }
  }

  // 3d. TÍTULO/SUBTÍTULO (#3980): re-derivar do D1/D2/D3 JÁ REORDENADOS.
  // Reusa `deriveTituloSubtitulo` (→ insert-titulo-subtitulo.ts, #916) — não
  // duplica a lógica de extração/render. Idempotente: no-op se o bloco já
  // reflete a ordem atual (ex: reorder de um campo que não afeta o header,
  // ou 2ª invocação acidental).
  if (reorderedReviewedMd !== null) {
    const derived = deriveTituloSubtitulo(reorderedReviewedMd);
    if (derived === null) {
      // Self-review finding (#3980): sem DESTAQUE 1 reconhecível, o bloco
      // TÍTULO/SUBTÍTULO não é re-derivado — avisar em vez de pular em
      // silêncio, mesmo padrão do WARN de destaque-max-chars logo abaixo.
      console.warn(
        "WARN: reorder-destaques — TÍTULO/SUBTÍTULO não re-derivado (DESTAQUE 1 não reconhecível em " +
          `${mdPath}). O bloco pode ficar desatualizado em relação à nova ordem D1/D2/D3.`,
      );
    } else if (derived.action !== "no_change") {
      if (!args.dryRun) writeFileSync(mdPath, derived.md, "utf8");
      if (!modified.rewritten.includes(mdPath)) modified.rewritten.push(mdPath);
      reorderedReviewedMd = derived.md;
    }
  }

  // 4. 03-social.md
  const socialPath = resolve(editionDir, "03-social.md");
  if (existsSync(socialPath)) {
    const md = readFileSync(socialPath, "utf8");
    const reordered = reorderSocialMd(md, args.newOrder);
    if (reordered !== md) {
      if (!args.dryRun) writeFileSync(socialPath, reordered, "utf8");
      modified.rewritten.push(socialPath);
    }
  }

  // #3982: validação PÓS-reorder do limite de chars por slot (D1=1200,
  // D2/D3=1000 — scripts/lib/lint-checks/destaque-chars.ts, mesmo rubrico de
  // `lint-newsletter-md.ts --check destaque-max-chars`). WARN-only: um
  // destaque escrito pra D1 (limite maior) pode facilmente estourar o limite
  // menor de D2/D3 ao ser movido — mas trim é call editorial do humano, então
  // reorder NUNCA bloqueia por isso, só avisa.
  const maxCharsWarnings: string[] = [];
  if (reorderedReviewedMd !== null) {
    const maxCharsResult = checkDestaqueMaxChars(reorderedReviewedMd);
    for (const e of maxCharsResult.errors) {
      const msg =
        `D${e.destaque} (${e.category}): ${e.chars} chars — acima do máximo de ${e.max} ` +
        `chars pro slot novo (excesso: ${e.chars - e.max}). Trim manual recomendado.`;
      maxCharsWarnings.push(msg);
      console.error(`⚠️  destaque-max-chars pós-reorder: ${msg}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        edition: args.edition,
        new_order: args.newOrder,
        dry_run: args.dryRun,
        modified,
        max_chars_warnings: maxCharsWarnings,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(2);
  }
}
