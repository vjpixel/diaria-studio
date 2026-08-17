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
 *     sufixo; #5564 trocou o mecanismo de rename-em-2-passos por staging
 *     local + escrita direta no destino — ver `stageAndWriteVerified`)
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
  copyFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
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
 * Funções de fs injetáveis pra teste (#5085, mesmo padrão de
 * `PlanFileReaders` em `overnight-statusline.ts`).
 */
export interface RenameFileDeps {
  renameSync: typeof renameSync;
  existsSync: typeof existsSync;
  copyFileSync: typeof copyFileSync;
  readFileSync: typeof readFileSync;
}

const defaultRenameFileDeps: RenameFileDeps = {
  renameSync,
  existsSync,
  copyFileSync,
  readFileSync,
};

/**
 * Rename com verificação pós-rename (#5085 — achado ao vivo edição 260812).
 * MANTIDA como utilitário standalone (usada só em teste hoje) — mas
 * `renameDestaqueImages`/`renameDestaquePrompts` não a usam mais desde #5564
 * (ver `stageAndWriteVerified` abaixo): `renameSync` em sequência DENTRO do
 * diretório sincronizado é exatamente o padrão que causava a "reversão
 * pós-hoc" que este guard não conseguia pegar (a checagem `existsSync`
 * acontece um instante depois do rename, mas o provedor de sync pode
 * reverter o arquivo minutos depois — janela menor, não eliminada).
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

/**
 * Uma reordenação de arquivo pendente: nome original → nome final, ambos
 * relativos ao diretório-alvo (editionDir ou internalDir).
 */
interface PendingFileRename {
  originalName: string;
  finalName: string;
}

/**
 * Aplica um conjunto de renomeações de arquivo (#5564 — substitui a dança de
 * rename-em-2-passos original→TMP→final que rodava inteiramente DENTRO do
 * diretório sincronizado pelo OneDrive).
 *
 * Causa raiz do #5564: mesmo com `renameSyncVerified` (#5085), um reorder
 * real perdeu conteúdo — a issue documentou uma "reversão pós-hoc":
 * `existsSync` passava um instante depois do rename, mas o provedor de sync
 * revertia o arquivo (voltava pra versão antiga) minutos depois, sem
 * qualquer sinal de erro visível ao script. A causa é estrutural: uma
 * sequência de 6+ renames rápidos (create+delete pairs, já que rename =
 * delete-antigo + create-novo do ponto de vista do provedor de sync) dentro
 * da pasta sincronizada dá ao OneDrive múltiplas oportunidades de resolução
 * de conflito, cada uma podendo descartar a versão "perdedora" de forma
 * assíncrona — nenhum delay de verificação pós-rename elimina essa janela,
 * só encolhe.
 *
 * Fix estrutural (não só detecção): a reordenação em si roda FORA do
 * diretório sincronizado.
 *   1. Cada arquivo que muda de nome é COPIADO (não movido) pro um diretório
 *      de staging local via `mkdtempSync(os.tmpdir())` — genuinamente fora
 *      da junction do OneDrive, nunca sincronizado.
 *   2. Só depois de TODOS os arquivos afetados terem sido capturados com
 *      sucesso no staging, cada um é escrito (via `copyFileSync`, não
 *      `renameSync`) DIRETO no path final dentro do diretório sincronizado —
 *      zero nomes `TMP{N}` aparecem na pasta sincronizada, então não há
 *      dança de rename pro provedor de sync confundir.
 *   3. Verificação em 2 camadas: (a) checagem imediata pós-escrita
 *      (`existsSync`, mesmo padrão do #5085), e (b) uma PASSADA FINAL, depois
 *      que TODAS as escritas terminaram, relendo cada arquivo final e
 *      comparando byte-a-byte contra o conteúdo staged — pega justamente a
 *      classe "reversão pós-hoc" do #5564, que só se manifesta um pouco
 *      DEPOIS da escrita individual reportar sucesso.
 *   4. Se qualquer etapa falhar, rollback: para CADA arquivo afetado
 *      (independente de sua escrita ter chegado a rodar), regrava o
 *      conteúdo staged de volta no path ORIGINAL. Como o conteúdo original
 *      já está capturado no staging desde o passo 1, isso é robusto a
 *      qualquer ordem de falha — não depende de reconstruir uma pilha de
 *      operações cronológicas como o rollback antigo (`rollbackAppliedRenames`,
 *      #5087) precisava.
 *
 * Residual: o processo ainda não pode detectar uma reversão que aconteça
 * DEPOIS que ele já terminou e saiu — mas a superfície de risco caiu de "N
 * renames intercalados na pasta sincronizada, ao longo de toda a execução"
 * pra "1 escrita por arquivo final, todas verificadas antes do processo
 * retornar sucesso".
 */
function stageAndWriteVerified(
  dir: string,
  pending: PendingFileRename[],
  deps: RenameFileDeps,
): Array<{ from: string; to: string }> {
  if (pending.length === 0) return [];

  const stagingDir = mkdtempSync(join(tmpdir(), "reorder-destaques-staging-"));
  const staged: Array<PendingFileRename & { stagingPath: string }> = [];
  try {
    // Passo 1: captura o conteúdo ATUAL de cada arquivo afetado no staging
    // local — nunca toca o diretório sincronizado nesta etapa.
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const stagingPath = join(stagingDir, `staged-${i}-${basename(p.originalName)}`);
      deps.copyFileSync(join(dir, p.originalName), stagingPath);
      staged.push({ ...p, stagingPath });
    }

    try {
      // Passo 2: escreve cada arquivo final DIRETO no destino — sem nome
      // temporário dentro do diretório sincronizado.
      for (const s of staged) {
        const finalPath = join(dir, s.finalName);
        deps.copyFileSync(s.stagingPath, finalPath);
        if (!deps.existsSync(finalPath)) {
          throw new Error(
            `reorder-destaques: escrita de ${s.finalName} retornou sem erro mas o arquivo não ` +
              `existe no disco logo depois. Provável conflito de sync (OneDrive) descartando a ` +
              `escrita. Abortando (#5564).`,
          );
        }
      }
      // Passo 3: passada FINAL de verificação, depois que TODAS as escritas
      // já terminaram — pega a "reversão pós-hoc" (#5564): um arquivo que
      // passou na checagem imediata do passo 2 mas foi revertido pelo
      // provedor de sync enquanto os DEMAIS arquivos da sequência ainda
      // estavam sendo escritos.
      for (const s of staged) {
        const finalPath = join(dir, s.finalName);
        const expected = deps.readFileSync(s.stagingPath);
        const actual = deps.existsSync(finalPath) ? deps.readFileSync(finalPath) : null;
        if (actual === null || !actual.equals(expected)) {
          throw new Error(
            `reorder-destaques: ${s.finalName} não bate com o conteúdo esperado na verificação ` +
              `final pós-reorder (#5564 — "reversão pós-hoc": o arquivo foi revertido pelo ` +
              `provedor de sync depois de a escrita individual ter reportado sucesso). Abortando ` +
              `para evitar publicação com imagem/prompt errado — reexecute reorder-destaques.ts ` +
              `depois de confirmar que o sync do OneDrive terminou.`,
          );
        }
      }
    } catch (e) {
      // Rollback best-effort: restaura o conteúdo ORIGINAL em cada path
      // ORIGINAL a partir do staging — independe de quais escritas do passo
      // 2 chegaram a rodar, então não precisa de pilha cronológica.
      for (const s of staged) {
        try {
          deps.copyFileSync(s.stagingPath, join(dir, s.originalName));
        } catch {
          // best-effort — nunca lançar por cima do erro original.
        }
      }
      throw e;
    }

    return staged.map((s) => ({ from: s.originalName, to: s.finalName }));
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — staging é local, não business-sensitive.
    }
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
 * Renomeia arquivos de imagem 04-d{N}-*.jpg conforme newOrder — via
 * `stageAndWriteVerified` (#5564, ver docstring lá pra causa raiz + fix
 * estrutural completo). Nunca cria nome `TMP{N}` dentro do diretório
 * sincronizado; toda a reordenação roda num staging local primeiro.
 *
 * #5085: regex de match do sufixo aceita hífen (`[a-z0-9-]+`, não só
 * `[a-z0-9]+`) — sem isso, `04-d{N}-4x5-nativo.jpg` (arte nativa gerada por
 * `image-generate.ts`) nunca era pego pelo filtro e ficava com o número de
 * destaque ERRADO após um reorder, silenciosamente (nenhum erro, só o
 * arquivo órfão do slot antigo).
 *
 * Retorna lista de renames aplicados (ou que seriam aplicados, em dry-run).
 */
export function renameDestaqueImages(
  editionDir: string,
  newOrder: number[],
  dryRun: boolean,
  deps: RenameFileDeps = defaultRenameFileDeps,
): Array<{ from: string; to: string }> {
  if (!deps.existsSync(editionDir)) return [];
  const files = readdirSync(editionDir).filter((f) =>
    /^04-d[123]-[a-z0-9-]+\.(?:jpg|png|jpeg)$/i.test(f),
  );
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  const pending: PendingFileRename[] = [];
  for (const f of files) {
    const m = f.match(/^04-d([123])-(.+)$/);
    if (!m) continue;
    const oldN = parseInt(m[1], 10);
    const newN = oldToNew.get(oldN);
    if (!newN || newN === oldN) continue;
    pending.push({ originalName: f, finalName: `04-d${newN}-${m[2]}` });
  }
  if (dryRun) {
    return pending.map((p) => ({ from: p.originalName, to: p.finalName }));
  }
  return stageAndWriteVerified(editionDir, pending, deps);
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
 * Renomeia arquivos `_internal/02-d{N}-prompt.md` e `_internal/02-d{N}-sd-prompt.json`
 * — via `stageAndWriteVerified` (#5564), mesmo padrão de `renameDestaqueImages`.
 */
export function renameDestaquePrompts(
  internalDir: string,
  newOrder: number[],
  dryRun: boolean,
  deps: RenameFileDeps = defaultRenameFileDeps,
): Array<{ from: string; to: string }> {
  if (!deps.existsSync(internalDir)) return [];
  const files = readdirSync(internalDir).filter((f) =>
    /^02-d[123]-(?:prompt\.md|sd-prompt\.json|draft\.md)$/.test(f),
  );
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  const pending: PendingFileRename[] = [];
  for (const f of files) {
    const m = f.match(/^02-d([123])-(.+)$/);
    if (!m) continue;
    const oldN = parseInt(m[1], 10);
    const newN = oldToNew.get(oldN);
    if (!newN || newN === oldN) continue;
    pending.push({ originalName: f, finalName: `02-d${newN}-${m[2]}` });
  }
  if (dryRun) {
    return pending.map((p) => ({ from: p.originalName, to: p.finalName }));
  }
  return stageAndWriteVerified(internalDir, pending, deps);
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
