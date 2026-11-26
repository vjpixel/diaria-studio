/**
 * Invariantes do Stage 4 — pasta da edição (É IA?, pendência Clarice, cópias de conflito do sync) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { findConflictCopies } from "../../conflict-copy-triage.ts"; // #13545
import type { InvariantViolation } from "../types.ts";
import {
  CLARICE_PENDING_REL,
  lastResumeAttemptNote,
  readClaricePending,
  resumeCommandFor,
} from "../../diaria/clarice-pending.ts"; // #12257, #12693
import { hasClariceReviewCredit } from "../../diaria/clarice-review-credit.ts"; // #13711
import { extractEiaMirrorBlock, parseEiaMirrorBlock, parseEIA, fallbackEIA } from "../../newsletter-parse.ts";

/**
 * #3825: o bloco `**É IA?**` em `02-reviewed.md` é só espelho/preview pro
 * editor — `extractContent` (newsletter-parse.ts) SEMPRE lê o crédito real
 * (legenda + "Resultado da última edição") de `01-eia.md`, nunca do mirror.
 * Nada garantia que os dois ficassem sincronizados: o editor corrige a
 * legenda em `02-reviewed.md` (fluxo natural — é a aba que o Studio abre),
 * `01-eia.md` nunca é tocado, e o HTML publicado sai com o crédito ANTIGO
 * sem nenhum aviso (incidente real 260722, erro intencional da legenda da
 * ave corrigido só em 02-reviewed.md — reproduzido em
 * `test/stage-4-eia-credit-synced.test.ts`).
 *
 * Reusa `parseEIA`/`fallbackEIA` (mesmos parsers de `extractContent`) dos
 * dois lados via `parseEiaMirrorBlock`/`extractEiaMirrorBlock` — garante que
 * qualquer divergência reportada é de CONTEÚDO, não de regra de parsing
 * diferente entre os dois lados.
 *
 * Sem bloco mirror em `02-reviewed.md` (edição legada, ou stitch ainda não
 * rodou) → `[]`, nada a comparar.
 *
 * **Severity "warning", não "error" (decisão conservadora, self-review
 * #3825).** A issue original pedia GATE-BLOCKING "ou pelo menos warn-loud —
 * nunca silencioso", deixando a escolha em aberto. `warning` ainda aparece
 * no `{violations_block}` do gate humano do Stage 4 (nunca silencioso —
 * `orchestrator-stage-4-gate.md` §4d, regra `{violations_block}`, lista ⚠️ junto com ❌), mas não falha
 * o exit code. Motivo: o mirror em `02-reviewed.md` é inserido verbatim de
 * `01-eia.md` no stitch (Stage 2, `stitch-newsletter.ts::readEiaBlock`), mas
 * DEPOIS passa pelo humanizador + Clarice — ambos operam sobre o
 * `02-normalized.md`/`02-humanized.md` INTEIRO, sem exclusão de seção (ver
 * `orchestrator-stage-2-fallback.md` §2b/§2c) — enquanto `01-eia.md` nunca é
 * re-processado por nenhum dos dois. Já existe precedente no repo pra esse
 * risco: `verify-clarice-url-stability` (#873) trata "Clarice alterou texto"
 * como WARNING, não ERROR, porque é comportamento esperado do pipeline, não
 * necessariamente erro editorial. Uma correção de pontuação/grafia do
 * humanizador ou da Clarice na legenda (texto curto, não narrativo — mais
 * provável de sofrer edição mínima que os destaques em si) bastaria pra
 * disparar `error` TODA edição, mesmo sem nenhuma ação do editor — "crying
 * wolf" que treina o editor a ignorar o gate. `error` fica como follow-up se
 * a observação em produção mostrar que o mirror sai idêntico ao 01-eia.md
 * na prática (sem essa erosão), ou com um comparador tolerante a reescrita
 * leve.
 */
/**
 * #13886: a mensagem antiga só dizia "01-eia.md é o real", e quem a seguia
 * rodava `sync-eia-block.ts` esperando espelhar 01→02 — mas o default do
 * script é o sentido OPOSTO (02→01) e apagava a legenda real com o
 * placeholder do mirror. Cita os dois sentidos com o comando exato.
 */
function eiaSyncHint(editionDir: string): string {
  return (
    `Se 01-eia.md está certo e só o espelho está defasado, espelhar 01 → 02 com ` +
    `\`npx tsx scripts/sync-eia-block.ts --edition-dir ${editionDir} --from 01\`. ` +
    `Sem \`--from 01\` o script vai no sentido 02 → 01 (propaga ao real a correção feita no espelho).`
  );
}

export function checkEiaCreditSynced(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");
  if (!existsSync(reviewedPath)) return [];

  const mirrorBlock = extractEiaMirrorBlock(readFileSync(reviewedPath, "utf8"));
  if (!mirrorBlock) return [];

  const real = existsSync(eiaPath)
    ? parseEIA(readFileSync(eiaPath, "utf8"), editionDir)
    : fallbackEIA(editionDir);
  const mirror = parseEiaMirrorBlock(mirrorBlock, editionDir);

  /**
   * #8992: falso-positivo recorrente (TODA edição) achado ao vivo na 260929 —
   * a única diferença entre `real.credit`/`mirror.credit` era pontuação de
   * separador (vírgula em `01-eia.md` virando travessão em `02-reviewed.md`,
   * ou vice-versa), nunca o texto do crédito em si. Causa provável: o mirror
   * block de `02-reviewed.md` passa pelo humanizador + Clarice DEPOIS do
   * stitch (ver docstring acima — "erosão" já era o risco documentado desde
   * o #3825), e a normalização de "travessão excessivo" do humanizador (um
   * dos ~27 padrões da skill `humanizador`) troca `—` por `,` nesse tipo de
   * legenda curta. Normalizar vírgula/travessão-em/travessão-en pra um único
   * separador canônico ANTES de comparar reduz esse ruído cosmético sem
   * mascarar divergência real de conteúdo (a comparação de palavras segue
   * exata — só o CARACTERE separador é elástico).
   */
  const normalizeSeparators = (s: string) => s.replace(/\s*[,—–]\s*/g, " § ");
  const normalize = (s: string) => normalizeSeparators(s.trim().replace(/\s+/g, " "));
  const normalizeLine = (s?: string) => (s ? normalize(s) : "");

  const violations: InvariantViolation[] = [];

  if (normalize(real.credit) !== normalize(mirror.credit)) {
    violations.push({
      rule: "eia-credit-synced",
      message:
        `Bloco **É IA?** de 02-reviewed.md diverge do crédito real em 01-eia.md ` +
        `(fonte que extractContent/render-newsletter-html.ts de fato usa — o bloco em ` +
        `02-reviewed.md é só um espelho pro editor, editá-lo NÃO afeta o email publicado). ` +
        `02-reviewed.md (cosmético): "${mirror.credit}". ` +
        `01-eia.md (real, vai pro email): "${real.credit}". ` +
        `Fix: editar 01-eia.md com a legenda correta — editar só 02-reviewed.md não tem ` +
        `efeito no email enviado (incidente 260722, #3825). ` +
        `${eiaSyncHint(editionDir)}`,
      source_issue: "#3825",
      severity: "warning",
      file: eiaPath,
    });
  }

  if (normalizeLine(real.prevResultLine) !== normalizeLine(mirror.prevResultLine)) {
    violations.push({
      rule: "eia-prev-result-line-synced",
      message:
        `Linha "Resultado da última edição" do bloco **É IA?** em 02-reviewed.md diverge ` +
        `de 01-eia.md (mesma fonte real do render, ver eia-credit-synced acima). ` +
        `02-reviewed.md: "${mirror.prevResultLine ?? "(ausente)"}". ` +
        `01-eia.md: "${real.prevResultLine ?? "(ausente)"}". ` +
        `Fix: editar 01-eia.md — editar só 02-reviewed.md não tem efeito no email enviado (#3825). ` +
        `${eiaSyncHint(editionDir)}`,
      source_issue: "#3825",
      severity: "warning",
      file: eiaPath,
    });
  }

  return violations;
}

/**
 * #12257: o Stage 2 seguiu sem a Clarice (`clarice-correct.ts` exit 6,
 * `clarice_unavailable`) e gravou `02-reviewed.md` a partir do texto
 * humanizado via `clarice-pending.ts skip`. O marcador só sai quando a
 * revisão é retomada com sucesso (`clarice-pending.ts resume`). Warning, não
 * error: publicar sem a Clarice é decisão do editor no gate, e a mensagem traz
 * o comando de retomada.
 */
export function checkClaricePending(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, CLARICE_PENDING_REL);
  if (!existsSync(path)) return [];
  const marker = readClaricePending(editionDir);
  const reason = marker?.reason ?? "motivo ilegível no marcador";
  const resume = resumeCommandFor(editionDir, marker?.edition);
  return [
    {
      rule: "clarice-pending",
      message:
        `clarice não rodou (${reason}): 02-reviewed.md saiu do texto humanizado, sem a revisão da Clarice. ` +
        lastResumeAttemptNote(marker) +
        `Retomar antes de aprovar: ${resume}`,
      source_issue: "#12257",
      severity: "warning",
      file: path,
    },
  ];
}

/**
 * #13711: com a Clarice pendente, o rodapé PARA ENCERRAR de `02-reviewed.md`
 * ainda afirma "A revisão foi feita pelo MCP da Clarice (...)". O render
 * (`extractContent`) já omite essa oração enquanto o marcador existir; o aviso
 * diz isso ao editor no gate, para ele saber por que o preview difere do
 * markdown e decidir se quer outra redação. Warning, nunca bloqueia.
 */
export function checkClaricePendingFooterCredit(editionDir: string): InvariantViolation[] {
  if (!existsSync(resolve(editionDir, CLARICE_PENDING_REL))) return [];
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  if (!hasClariceReviewCredit(readFileSync(path, "utf8"))) return [];
  return [
    {
      rule: "clarice-pending-footer-credit",
      message:
        "o rodapé PARA ENCERRAR de 02-reviewed.md afirma que a revisão foi feita pela Clarice, mas ela não rodou nesta edição. " +
        "O render omite essa oração (com o link de afiliado) enquanto _internal/02-clarice-pending.json existir; " +
        "se a Clarice for retomada com sucesso, a frase volta. Para outra redação, editar o rodapé à mão.",
      source_issue: "#13711",
      severity: "warning",
      file: path,
    },
  ];
}

/** Arquivos sem os quais o Stage 4 não tem o que revisar nem publicar (#13545). */
export const EDITION_REQUIRED_FILES = ["02-reviewed.md", "_internal/01-approved.json", "06-public-images.json"] as const;

/**
 * #13545: o sync de `data/` (rclone bisync) renomeou para `.conflictN` e fez
 * sumir arquivos da edição em curso (02-reviewed, 01-approved, 06-public-images).
 * Acusa cópia `.conflictN` dentro da edição (fora de `_conflitos-*`) e arquivo
 * obrigatório ausente. Restaurar: `docs/sync-conflict-restore.md`.
 */
export function checkEditionSyncConflicts(editionDir: string): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const base = { rule: "edition-sync-conflicts", source_issue: "#13545", severity: "error" as const };
  for (const copy of findConflictCopies(editionDir)) {
    const rel = relative(editionDir, copy).split(sep).join("/");
    out.push({
      ...base,
      file: rel,
      message: `cópia de conflito do sync em ${rel}. NÃO copie por cima nem apague: compare com o original e restaure como em docs/sync-conflict-restore.md (npx tsx scripts/triage-conflict-copies.ts).`,
    });
  }
  for (const rel of EDITION_REQUIRED_FILES) {
    if (existsSync(resolve(editionDir, rel))) continue;
    out.push({
      ...base,
      file: rel,
      message: `${rel} ausente na edição. Se há ${rel}.conflictN ao lado, o sync renomeou o original: restaure como em docs/sync-conflict-restore.md.`,
    });
  }
  return out;
}
