/**
 * scripts/lib/safe-rename-in-data.ts (#8058)
 *
 * Helper para mover/renomear um arquivo dentro de `data/` (directory
 * junction sincronizada pelo OneDrive) sem usar `fs.renameSync`/`mv` puro.
 *
 * Origem: achado ao vivo na edição 260914 (Stage 4, gate de revisão). O
 * editor reordenou destaques manualmente (D1 removido, D2→D1, D3→D2) e
 * precisou remapear as imagens (`04-d{N}-*.jpg`) e o prompt
 * (`_internal/02-d{N}-prompt.md`) correspondentes usando o padrão de
 * ROTAÇÃO VIA NOMES TEMPORÁRIOS (`a→tmp→b`), já documentado como arriscado
 * em memória do projeto (`onedrive-renomear-em-rodizio.md`):
 *
 *   mv 04-d2-*.jpg  04-tmpA-*.jpg
 *   mv 04-d3-*.jpg  04-tmpB-*.jpg
 *   mv 04-tmpA-*.jpg 04-d1-*.jpg
 *   mv 04-tmpB-*.jpg 04-d2-*.jpg
 *
 * O primeiro rodízio reportou sucesso na hora. Minutos depois, ao tentar um
 * SEGUNDO rodízio, os arquivos de D1 (recém-renomeados) simplesmente não
 * existiam mais em disco — sinal de que o OneDrive estava ativamente
 * sincronizando/mexendo no diretório e um dos renames foi revertido/perdido
 * de forma assíncrona, sem nenhum erro visível na hora da chamada original.
 * Mesma classe de "reversão pós-hoc" já documentada em
 * `reorder-destaques.ts` (#5564/#5581/#5583) para o caso PROGRAMÁTICO de
 * reorder de destaques — este módulo generaliza o mesmo princípio (copy +
 * verify + delete-do-original, nunca rename puro nem rodízio reusando nomes
 * recém-liberados) para qualquer caller que precise mover 1 arquivo dentro
 * de `data/`, dentro OU fora do pipeline.
 *
 * Por que `renameSync` é arriscado aqui: `rename` é, do ponto de vista de um
 * provedor de sync como o OneDrive, um delete-do-antigo + create-do-novo —
 * cada rename dá ao provedor uma nova oportunidade de resolução de conflito
 * que pode descartar a versão "perdedora" de forma ASSÍNCRONA, depois que a
 * chamada de `renameSync` já retornou sucesso do ponto de vista do Node.
 * Isso é pior num RODÍZIO (reusar um nome que acabou de ser liberado por
 * outro rename da mesma sequência) porque multiplica as janelas de conflito
 * na mesma pasta, na mesma janela de tempo curta.
 *
 * Mecanismo (copy + verify + delete, nunca rename):
 *   1. `copyFileSync(from, to)` — cria o destino sem apagar o original.
 *   2. Verifica que o destino existe e que o tamanho bate com o original
 *      (`statSync(...).size`); opcionalmente compara hash SHA-256 completo
 *      quando `verifyHash: true` (mais caro, mas detecta corrupção de
 *      conteúdo que uma simples comparação de tamanho não pega).
 *   3. Só DEPOIS da verificação passar, apaga o original (`unlinkSync`).
 *      Se a verificação falhar em qualquer ponto, o original NUNCA é
 *      apagado — a função lança um erro explícito e para.
 *
 * Não é a mesma sofisticação de `stageAndWriteVerified` em
 * `reorder-destaques.ts` (que faz staging de LOTE inteiro num diretório
 * temporário fora da árvore sincronizada, com rollback de lote e passada
 * final com delay) — este helper é a primitiva de UM ARQUIVO POR VEZ,
 * pensada para uso ad-hoc/scriptado simples. Um caller que precise mover
 * vários arquivos como um LOTE atômico (ex: reorder de destaques) deve
 * seguir usando/estendendo o padrão de staging de `reorder-destaques.ts`,
 * não este helper — ver o docblock de `stageAndWriteVerified` para a
 * análise completa de por que staging em lote é necessário nesse caso
 * (permutações fechadas, arquivos órfãos, etc).
 *
 * Residual conhecido (mesmo aceito em `reorder-destaques.ts`): uma
 * verificação síncrona não detecta uma reversão que o provedor de sync
 * aplique DEPOIS que esta função já retornou sucesso. A superfície de risco
 * cai de "várias trocas de nome em sequência rápida" para "1 cópia + 1
 * verificação + 1 delete", que é a mitigação prática disponível sem
 * introduzir um delay artificial em toda chamada.
 */
import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

/** Funções de fs/crypto injetáveis para teste. */
export interface SafeRenameDeps {
  copyFileSync: typeof copyFileSync;
  existsSync: typeof existsSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  readFileSync: typeof readFileSync;
}

const defaultSafeRenameDeps: SafeRenameDeps = {
  copyFileSync,
  existsSync,
  statSync,
  unlinkSync,
  readFileSync,
};

export interface SafeRenameOptions {
  /**
   * Compara hash SHA-256 completo do conteúdo além do tamanho (default:
   * false — comparação de tamanho já pega o caso comum de cópia truncada/
   * ausente; hash é mais caro e serve para paranoia extra em arquivos
   * pequenos/críticos).
   */
  verifyHash?: boolean;
  deps?: SafeRenameDeps;
}

function sha256(readFile: typeof readFileSync, path: string): string {
  return createHash("sha256").update(readFile(path)).digest("hex");
}

/**
 * Move `from` → `to` via copy + verify (existência + tamanho, opcionalmente
 * hash) + delete-do-original. Nunca usa `renameSync`. Lança erro claro e
 * NUNCA apaga o original se a verificação falhar em qualquer etapa.
 *
 * `from` e `to` devem ser caminhos absolutos (ou relativos ao cwd do
 * caller) já resolvidos — este helper não impõe que estejam dentro de
 * `data/`; quem chama decide o escopo (a issue de origem é sobre `data/`,
 * mas o mecanismo copy+verify+delete é seguro para qualquer pasta
 * sincronizada por um provedor de terceiro).
 */
export function safeRenameInData(
  from: string,
  to: string,
  options: SafeRenameOptions = {},
): void {
  const deps = options.deps ?? defaultSafeRenameDeps;

  if (!deps.existsSync(from)) {
    throw new Error(`safeRenameInData: origem não existe: ${from}`);
  }

  const originalSize = deps.statSync(from).size;

  // Passo 1: copia (não move) — o original continua intacto até a
  // verificação passar.
  deps.copyFileSync(from, to);

  // Passo 2: verifica existência + tamanho do destino.
  if (!deps.existsSync(to)) {
    throw new Error(
      `safeRenameInData: cópia de ${from} → ${to} retornou sem erro mas o destino não existe ` +
        `no disco logo depois. Provável conflito de sync (OneDrive) descartando a escrita. ` +
        `Original preservado — abortando sem apagar ${from}.`,
    );
  }

  const copiedSize = deps.statSync(to).size;
  if (copiedSize !== originalSize) {
    throw new Error(
      `safeRenameInData: tamanho de ${to} (${copiedSize} bytes) não bate com o original ` +
        `${from} (${originalSize} bytes) após a cópia. Original preservado — abortando sem ` +
        `apagar ${from}.`,
    );
  }

  // Passo 2b (opcional): verificação por hash SHA-256 completo.
  if (options.verifyHash) {
    const originalHash = sha256(deps.readFileSync, from);
    const copiedHash = sha256(deps.readFileSync, to);
    if (originalHash !== copiedHash) {
      throw new Error(
        `safeRenameInData: hash de ${to} não bate com o original ${from} após a cópia ` +
          `(tamanho batia, conteúdo não). Original preservado — abortando sem apagar ${from}.`,
      );
    }
  }

  // Passo 3: só agora, com a cópia verificada, apaga o original.
  deps.unlinkSync(from);
}
