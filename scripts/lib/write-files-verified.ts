/**
 * scripts/lib/write-files-verified.ts (#9173)
 *
 * Escrita VERIFICADA de um lote de arquivos de CONTEÚDO (JSON/MD) dentro de
 * `data/` — pasta sincronizada pelo OneDrive. Irmão, para conteúdo, do
 * `stageAndWriteVerified` de `reorder-destaques.ts` (#5564/#8679), que cobre
 * o caso de RENOMEAR arquivos existentes (imagens, prompts). Mesmos
 * princípios, aplicados a "gravar este texto neste path":
 *
 *   1. Snapshot do conteúdo ATUAL de cada destino (ou "ausente") em memória,
 *      antes de qualquer escrita — base do rollback.
 *   2. Escrita DIRETA no destino (sem nome temporário + rename dentro da
 *      pasta sincronizada: rename é delete+create para o sync client e abre
 *      janela de resolução de conflito) + checagem imediata de existência.
 *   3. Passada FINAL de verificação depois de TODAS as escritas — relê cada
 *      arquivo e compara byte a byte com o esperado. Pega a "reversão
 *      pós-hoc" (#5564): um arquivo que passou na checagem imediata mas foi
 *      revertido pelo provedor enquanto os demais eram gravados.
 *   4. Falha em qualquer ponto → rollback best-effort do lote inteiro para o
 *      snapshot do passo 1 (arquivo que não existia antes é removido) e o
 *      erro original é relançado — nunca deixa o lote meio-gravado em
 *      silêncio (ex: `01-approved.json` com o destaque novo e `02-reviewed.md`
 *      ainda com o antigo).
 *
 * Residual (o mesmo aceito em `reorder-destaques.ts`): uma reversão que o
 * provedor aplique DEPOIS que o processo retornou não é detectável aqui.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface VerifiedWrite {
  /** Caminho final do arquivo. */
  path: string;
  /** Conteúdo completo a gravar (utf8). */
  content: string;
}

/** Funções de fs injetáveis para teste. */
export interface WriteFilesVerifiedDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => Buffer;
  writeFileSync: (path: string, data: Buffer) => void;
  unlinkSync: (path: string) => void;
}

const defaultDeps: WriteFilesVerifiedDeps = {
  existsSync,
  readFileSync: (p) => readFileSync(p),
  writeFileSync: (p, d) => writeFileSync(p, d),
  unlinkSync,
};

/**
 * Grava `writes` com verificação pós-escrita e rollback do lote em falha.
 * `label` prefixa as mensagens de erro (nome do script chamador).
 *
 * @throws Error quando alguma escrita some/diverge; o lote é revertido antes.
 */
export function writeFilesVerified(
  writes: VerifiedWrite[],
  label: string,
  deps: WriteFilesVerifiedDeps = defaultDeps,
): void {
  if (writes.length === 0) return;

  // Passo 1: snapshot.
  const entries = writes.map((w) => ({
    path: w.path,
    expected: Buffer.from(w.content, "utf8"),
    original: deps.existsSync(w.path) ? deps.readFileSync(w.path) : null,
  }));

  try {
    // Passo 2: escrita direta + checagem imediata.
    for (const e of entries) {
      deps.writeFileSync(e.path, e.expected);
      if (!deps.existsSync(e.path)) {
        throw new Error(
          `${label}: escrita de ${basename(e.path)} retornou sem erro mas o arquivo não existe ` +
            `no disco logo depois. Provável conflito de sync (OneDrive) descartando a escrita (#9173).`,
        );
      }
    }
    // Passo 3: verificação final do lote inteiro.
    for (const e of entries) {
      const actual = deps.existsSync(e.path) ? deps.readFileSync(e.path) : null;
      if (actual === null || !actual.equals(e.expected)) {
        throw new Error(
          `${label}: ${basename(e.path)} não bate com o conteúdo esperado na verificação final ` +
            `(reversão pós-hoc do sync, #5564/#9173). Lote revertido — reexecute depois de ` +
            `confirmar que o sync do OneDrive terminou.`,
        );
      }
    }
  } catch (err) {
    // Passo 4: rollback best-effort para o snapshot.
    for (const e of entries) {
      try {
        if (e.original === null) {
          if (deps.existsSync(e.path)) deps.unlinkSync(e.path);
        } else {
          deps.writeFileSync(e.path, e.original);
        }
      } catch {
        // best-effort — nunca lançar por cima do erro original.
      }
    }
    throw err;
  }
}
