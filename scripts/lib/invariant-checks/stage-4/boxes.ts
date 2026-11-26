/**
 * Invariantes do Stage 4 — boxes de divulgação (alt, runtime, HTML cru, drift, validade) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { detectBoxSelectionConfigDrift, formatBoxSelectionDrift } from "../../box-selection-drift.ts"; // #9253
import { aammddToIsoDate, readSnippetExpiry } from "../../shared/snippet-header.ts"; // #10174
import { readSnippetFileRaw } from "../../shared/snippet-loader.ts"; // #10174
import { findRawHtmlTag } from "../../shared/non-box-snippets.ts"; // #12202
import type { InvariantViolation } from "../types.ts";
import {
  extractBoxDivulgacao0,
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
  readBoxDivulgacao0Image,
  readBoxDivulgacao1Image,
  readBoxDivulgacao2Image,
  readBoxDivulgacao3Image,
  readBoxDivulgacaoAltForSlot,
  readBoxDivulgacaoAltForFile, // #5457
  readBoxDivulgacaoRuntimeExcludedForSlot, // #4504
  readBoxSelectionFileForSlot, // #5457/#8756/#9172 — MESMA leitura do render (antes duplicada aqui)
  BOX_SLOT_EMPTIED, // #9172
} from "../../newsletter-parse.ts";
import { ROOT } from "./_shared.ts";

/**
 * #4086 item 2: warn-only guard — quando um slot de box de divulgação
 * (0/1/2/3 — slot 0 desde #4274) tem imagem (explícita via
 * `box_slot{N}_image`, ou `livros_promo` quando o
 * box é de livros — mesmo contrato de `readBoxDivulgacao{N}Image`), mas o
 * snippet atualmente atribuído àquele slot (`boxes_divulgacao.slot{N}` em
 * `platform.config.json`) não declara `alt:` no header, o alt renderizado cai
 * no anchor text do 1º link do box (`renderMidCallout`, #2067) — um rótulo de
 * ação genérico ("Ler o artigo", "Quero apoiar") que não descreve a imagem.
 * Quem usa leitor de tela, ou tem imagens bloqueadas no cliente de e-mail
 * (Outlook desktop bloqueia por padrão), perde a informação que a imagem
 * carrega (caso real 260727: header com o TÍTULO do artigo rasterizado saiu
 * com alt="Ler o artigo" — o título não aparecia em lugar nenhum do e-mail).
 *
 * Warning, não error (decisão explícita da issue): alt fraco (anchor text)
 * não deve bloquear a publicação — deve só ficar visível no gate.
 *
 * **#5457: slot 1/2/3 preferem `_internal/box-selection.json` sobre o config
 * estático.** Desde #4626, o snippet que de fato aparece nos slots de
 * rotação (1/2/3) pode ser escolhido automaticamente por
 * `select-boxes-by-clicks.ts` (`resolveBoxesForEdition`) e diverge de
 * `boxes_divulgacao.slot{N}` no `platform.config.json` — o registro do que
 * foi USADO de fato fica em `box-selection.json`, gravado por
 * `stitch-newsletter.ts` a cada stitch (`SlotSelectionRecord[]`, `file` por
 * slot já é o valor EFETIVO independente do modo — pinado, automático, ou
 * fallback pro config, os três casos já resolvidos por
 * `resolveBoxesForEdition`). Ler esse arquivo evita o gap achado ao vivo na
 * edição 260817: o check apontava pro snippet estático (que sequer usa
 * imagem) enquanto o snippet REALMENTE renderizado em `02-reviewed.md`
 * (fonte de `boxText`/`imageUrl` logo abaixo, já sempre a edição real) era
 * outro, com `alt:` correto. Sem o arquivo (edição pré-#4626, ou falha de
 * escrita fail-soft do stitch), cai pro config estático — comportamento
 * idêntico ao pré-#5457. Slot 0 nunca entra na rotação automática (fora do
 * escopo de `resolveBoxesForEdition`, ver docstring do módulo) — sempre lido
 * do config estático.
 *
 * `rootDir` (default: raiz do repo real, via `readBoxDivulgacaoAltForSlot`/
 * `readBoxDivulgacaoAltForFile`) existe só pra permitir fixture de teste
 * isolada — o call site real (STAGE_4_RULES) nunca passa override.
 */
export function checkBoxDivulgacaoAltMissing(
  editionDir: string,
  rootDir?: string,
): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");

  const slots: Array<{
    n: 0 | 1 | 2 | 3;
    extract: (text: string) => string | null;
    readImage: (editionDir: string, boxText?: string | null) => string | null;
  }> = [
    { n: 0, extract: extractBoxDivulgacao0, readImage: readBoxDivulgacao0Image }, // #4274
    { n: 1, extract: extractBoxDivulgacao1, readImage: readBoxDivulgacao1Image },
    { n: 2, extract: extractBoxDivulgacao2, readImage: readBoxDivulgacao2Image },
    { n: 3, extract: extractBoxDivulgacao3, readImage: readBoxDivulgacao3Image },
  ];

  const violations: InvariantViolation[] = [];
  for (const { n, extract, readImage } of slots) {
    const boxText = extract(md);
    if (!boxText) continue; // slot vazio nesta edição — nada a checar
    const imageUrl = readImage(editionDir, boxText);
    if (!imageUrl) continue; // sem imagem — anchor text é o alt de sempre, sem gap

    // #5457: slot 0 nunca tem entry em box-selection.json (fora da rotação
    // automática) — só 1/2/3 consultam o arquivo antes do fallback estático.
    const selectedFile = n === 0 ? undefined : readBoxSelectionFileForSlot(editionDir, n, boxText, rootDir);
    let alt: string | null;
    let sourceNote: string;
    let fixNote: string;
    const snippetFix =
      `Fix: adicionar \`alt: {descrição do CONTEÚDO da imagem}\` ao header do snippet ` +
      `(ver context/snippets/README.md).`;
    if (selectedFile === BOX_SLOT_EMPTIED) {
      // #9172: slot esvaziado pela seleção (fallback recusado, #9155) — o box
      // presente foi colado à mão e não tem snippet associado. NÃO cair no
      // config: ele aponta justamente pro arquivo recusado.
      alt = null;
      sourceNote =
        `o box foi colado à mão num slot que a seleção deixou vazio (fallback recusado, ver ` +
        `_internal/box-selection.json) e não corresponde a nenhum snippet, então não há \`alt:\` a ler`;
      fixNote =
        `Fix: usar no slot um snippet de data/snippets/ que declare \`alt:\`, ou aceitar o anchor text como alt.`;
    } else if (selectedFile) {
      alt = rootDir !== undefined
        ? readBoxDivulgacaoAltForFile(selectedFile, rootDir)
        : readBoxDivulgacaoAltForFile(selectedFile);
      sourceNote =
        `o snippet \`${selectedFile}\` (efetivamente usado neste slot nesta edição, via ` +
        `_internal/box-selection.json) não declara \`alt:\` no header`;
      fixNote = snippetFix;
    } else {
      alt = rootDir !== undefined
        ? readBoxDivulgacaoAltForSlot(n, rootDir)
        : readBoxDivulgacaoAltForSlot(n);
      // nome do arquivo desconhecido aqui sem reler o config — mensagem cita o slot
      sourceNote =
        `o snippet atribuído em boxes_divulgacao.slot${n} (platform.config.json) não declara \`alt:\` no header`;
      fixNote = snippetFix;
    }
    if (alt) continue;
    violations.push({
      rule: "box-divulgacao-alt-missing",
      message:
        `Slot ${n} de box de divulgação tem imagem, mas ${sourceNote}. ` +
        `O alt renderizado cai no anchor text do 1º link do box (rótulo de ação genérico, ` +
        `ex: "Ler o artigo") — não descreve a imagem pra leitor de tela ou cliente com imagens ` +
        `bloqueadas (Outlook desktop). ${fixNote}`,
      source_issue: "#4086",
      severity: "warning",
      file: path,
    });
  }
  return violations;
}

/**
 * #4504: mirror de `checkBoxDivulgacaoAltMissing`, pro gap identificado no
 * fleet review do #4502 — valida que NENHUM slot de `boxes_divulgacao`
 * (0-3, `platform.config.json`) aponta pra um snippet com `runtime: false`
 * no header (`readBoxDivulgacaoRuntimeExcludedForSlot`, que usa
 * `isRuntimeExcluded` de `shared/snippet-header.ts` — movida de
 * `studio-ui/studio-boxes.ts` nesta mesma issue, item 2, porque este check
 * roda no pipeline core e não pode importar da camada UI).
 *
 * `saveBoxSlots` (Studio UI) já bloqueia essa atribuição no PUT (#4500/
 * #4502), mas config editado manualmente ou não migrado passa por fora
 * dessa checagem — este invariant é a defesa em profundidade no PRÓPRIO
 * pipeline de render, rodando antes do gate humano do Stage 4,
 * independente da via de edição do config.
 *
 * Diferente de `checkBoxDivulgacaoAltMissing` (warning — alt ausente só
 * degrada acessibilidade), esta regra é **error**: o conteúdo ERRADO seria
 * injetado verbatim na newsletter — o mesmo cenário que causou o incidente
 * original do #4500 (`intro-campeoes-sorteio.md` configurado num slot).
 *
 * `rootDir` (default: raiz do repo real, via
 * `readBoxDivulgacaoRuntimeExcludedForSlot`) existe só pra fixture de teste
 * isolada — o call site real (STAGE_4_RULES) nunca passa override.
 * `editionDir` não é lido pelo corpo desta função (a config não é
 * por-edição), mas é mantido na assinatura pra bater o contrato comum de
 * `InvariantRule.run`.
 */
export function checkBoxDivulgacaoRuntimeExcluded(
  editionDir: string,
  rootDir?: string,
): InvariantViolation[] {
  void editionDir; // não lido — checagem é sobre platform.config.json, não sobre a edição
  const violations: InvariantViolation[] = [];
  const slots: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
  for (const n of slots) {
    const excluded = rootDir !== undefined
      ? readBoxDivulgacaoRuntimeExcludedForSlot(n, rootDir)
      : readBoxDivulgacaoRuntimeExcludedForSlot(n);
    if (!excluded) continue;
    violations.push({
      rule: "box-divulgacao-runtime-excluded",
      message:
        `boxes_divulgacao.slot${n} (platform.config.json) aponta pra um snippet com ` +
        `\`runtime: false\` no header — esse conteúdo é documentação/referência, não ` +
        `deveria aparecer na newsletter, mas seria injetado verbatim (mesmo incidente ` +
        `do #4500). Fix: apontar o slot pra outro snippet, ou remover \`runtime: false\` ` +
        `do header se o conteúdo passou a ser real.`,
      source_issue: "#4504",
      severity: "error",
      file: "platform.config.json",
    });
  }
  return violations;
}

/**
 * #12202: box de divulgação (slot 0-3) no `02-reviewed.md` com tag HTML crua
 * (`<p>`, `<a ` etc.). O render trata o corpo do box como markdown e escapa o
 * HTML, então o leitor vê as tags como texto. Incidente da 261105:
 * `onboarding-2.md` (e-mail de boas-vindas em HTML) foi escolhido pela seleção
 * por cliques pro slot 1. A seleção agora recusa esses arquivos
 * (`isNonBoxSnippet`); este check é a defesa no conteúdo, pra qualquer via
 * (pin, colagem à mão, snippet novo com HTML). Error, gate-blocking.
 */
export function checkBoxDivulgacaoRawHtml(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const slots: Array<{ n: 0 | 1 | 2 | 3; extract: (text: string) => string | null }> = [
    { n: 0, extract: extractBoxDivulgacao0 },
    { n: 1, extract: extractBoxDivulgacao1 },
    { n: 2, extract: extractBoxDivulgacao2 },
    { n: 3, extract: extractBoxDivulgacao3 },
  ];
  const violations: InvariantViolation[] = [];
  for (const { n, extract } of slots) {
    const boxText = extract(md);
    if (!boxText) continue;
    const tag = findRawHtmlTag(boxText);
    if (!tag) continue;
    violations.push({
      rule: "box-divulgacao-raw-html",
      message:
        `Box de divulgação do slot ${n} tem HTML cru (\`${tag}\`) — o render escapa e o leitor ` +
        `vê as tags como texto. Fix: ` +
        (n === 1 || n === 2
          ? `trocar a caixa (\`npx tsx scripts/apply-box-slot.ts --edition ${basename(editionDir)} --slot ${n} --file X.md\`) ou `
          : "") +
        `reescrever o box em markdown no 02-reviewed.md.`,
      source_issue: "#12202",
      severity: "error",
      file: path,
    });
  }
  return violations;
}

/**
 * #9253: `boxes_divulgacao.slotN` trocado no config DEPOIS do stitch não tem
 * efeito — `_internal/box-selection.json` congelou o snippet antigo e o
 * render lê título/alt/categoria dele. Warning (não bloqueia: a troca pode
 * ser pra próxima edição) que nomeia o slot e o comando de correção
 * (`apply-box-slot.ts`). Lógica pura em `../box-selection-drift.ts`.
 * `rootDir` só pra fixture de teste.
 */
export function checkBoxSelectionConfigDrift(
  editionDir: string,
  rootDir: string = ROOT,
): InvariantViolation[] {
  const selPath = resolve(editionDir, "_internal", "box-selection.json");
  if (!existsSync(selPath)) return [];
  let selection: unknown;
  let cfg: { slot1?: string | null; slot2?: string | null } = {};
  try {
    selection = JSON.parse(readFileSync(selPath, "utf8"));
    const raw = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8"));
    cfg = raw?.boxes_divulgacao ?? {};
  } catch {
    return []; // arquivo malformado/config ilegível — outros checks cobrem
  }
  const edition = basename(editionDir).match(/^\d{6}$/) ? basename(editionDir) : null;
  return detectBoxSelectionConfigDrift(selection, cfg).map((d) => ({
    rule: "box-selection-config-drift",
    message: formatBoxSelectionDrift(d, edition),
    source_issue: "#9253",
    severity: "warning" as const,
    file: selPath,
  }));
}

/** #10174: a partir de quantos dias antes do `expires:` o invariante avisa
 * "expira em N dias" (mesmo limiar do painel Caixas, `BOX_EXPIRY_WARN_DAYS`
 * em `studio-ui/studio-boxes.ts` — não importado de lá: camada UI). */
export const BOX_EXPIRY_INVARIANT_WARN_DAYS = 3;

/**
 * #12107: o que o stitch fez com o slot `slot` cuja caixa configurada
 * (`expiredFile`) venceu, lido de `_internal/box-selection.json`:
 * - `filled`: o slot recebeu outro arquivo (seleção automática);
 * - `empty`: o registro do slot não tem arquivo;
 * - `null`: sem registro legível, ou o registro ainda aponta pra própria
 *   caixa vencida (seleção anterior à checagem de validade) — o chamador
 *   cai na frase genérica, sem afirmar nada.
 */
export function readExpiredSlotOutcome(
  editionDir: string,
  slot: 1 | 2,
  expiredFile: string,
): { kind: "filled"; file: string } | { kind: "empty" } | null {
  const path = resolve(editionDir, "_internal", "box-selection.json");
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const entry = data.find(
    (r): r is { file?: unknown } => !!r && typeof r === "object" && (r as { slot?: unknown }).slot === slot,
  );
  if (!entry) return null;
  if (typeof entry.file === "string" && entry.file) {
    return entry.file === expiredFile ? null : { kind: "filled", file: entry.file };
  }
  if (entry.file === null) return { kind: "empty" };
  return null;
}

/**
 * #10174: caixa de divulgação configurada num slot (`boxes_divulgacao.slot0/1/2`
 * do `platform.config.json`) com `expires:` VENCIDO, perto de vencer
 * (≤ `BOX_EXPIRY_INVARIANT_WARN_DAYS` dias) ou malformado, julgado contra a
 * data da EDIÇÃO (basename `AAMMDD` do `editionDir`). Caso que motivou: a
 * caixa do evento de 17/10 pinada no slot 1 anunciaria, a partir da edição
 * de 18/10, um evento que já aconteceu — sem nada acusar.
 *
 * O stitch (`resolveBoxesForEdition`) já PULA a caixa vencida; este check é a
 * visibilidade no gate (Stage 2 e Stage 4): o editor vê que o slot pinado
 * caducou e que o config precisa ser atualizado. Warning, nunca error — a
 * edição sai correta sem a caixa. Slot 2 entra mesmo em edição de 2
 * destaques (o config vale pras próximas). Snippet ausente → pulado (o
 * stitch já falha alto nesse caso). `rootDir` só pra fixture de teste.
 *
 * #10214: além do config, lê a caixa EFETIVAMENTE presente na edição — o box
 * dos slots 1/2 no `02-reviewed.md` (ou `_internal/02-draft.md` antes dele
 * existir), resolvido pra snippet pela mesma leitura do render
 * (`readBoxSelectionFileForSlot`, casando pelo conteúdo). Caixa vencida
 * PRESENTE (aplicada pós-stitch por `apply-box-slot.ts --allow-expired`, ou
 * colada à mão) gera o aviso de que ela VAI chegar ao leitor — e substitui o
 * aviso do config pro mesmo slot, que diria (falsamente) que o stitch a pulou.
 *
 * #12107: o efeito descrito no aviso do config (slot 1/2) sai do
 * `box-selection.json` da edição (`readExpiredSlotOutcome`) — "recebeu X pela
 * seleção automática" ou "saiu vazio" — e só cai na frase genérica quando a
 * seleção não existe ou não é legível.
 */
export function checkBoxDivulgacaoExpiry(
  editionDir: string,
  rootDir: string = ROOT,
): InvariantViolation[] {
  const aammdd = basename(editionDir);
  const editionIso = aammddToIsoDate(aammdd);
  if (!editionIso) return [];
  const violations: InvariantViolation[] = [];

  // #10214: caixa presente no markdown da edição.
  const presentExpired = new Set<string>();
  const mdPath = [resolve(editionDir, "02-reviewed.md"), resolve(editionDir, "_internal", "02-draft.md")].find((p) =>
    existsSync(p),
  );
  if (mdPath) {
    let md = "";
    try {
      md = readFileSync(mdPath, "utf8");
    } catch {
      md = "";
    }
    for (const slot of [1, 2] as const) {
      const boxText = slot === 1 ? extractBoxDivulgacao1(md) : extractBoxDivulgacao2(md);
      if (!boxText) continue;
      const file = readBoxSelectionFileForSlot(editionDir, slot, boxText, rootDir);
      if (typeof file !== "string" || !file) continue;
      const content = readSnippetFileRaw(file, rootDir);
      if (content === null) continue;
      const exp = readSnippetExpiry(content, editionIso);
      if (exp.status !== "expired") continue;
      presentExpired.add(file);
      violations.push({
        rule: "box-divulgacao-expiry",
        message:
          `Caixa \`${file}\` está NA EDIÇÃO (box do slot ${slot} em ${basename(mdPath)}) e expirou: ` +
          `expires: ${exp.expires}, edição ${editionIso} — vai chegar ao leitor anunciando algo vencido. ` +
          `Fix: trocar a caixa (\`npx tsx scripts/apply-box-slot.ts --edition ${aammdd} --slot ${slot} --file X.md\`) ` +
          `ou remover o box do 02-reviewed.md.`,
        source_issue: "#10214",
        severity: "warning",
        file: basename(mdPath),
      });
    }
  }

  let cfg: Record<string, unknown> = {};
  let pinned: unknown[] = [];
  let autoEnabled = false;
  try {
    const raw = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8"));
    cfg = raw?.boxes_divulgacao ?? {};
    autoEnabled = raw?.boxes_divulgacao_auto?.enabled === true;
    pinned = Array.isArray(raw?.boxes_divulgacao_auto?.pinned_slots) ? raw.boxes_divulgacao_auto.pinned_slots : [];
  } catch {
    return violations; // config ilegível — outros checks cobrem
  }
  for (const n of [0, 1, 2] as const) {
    const file = cfg[`slot${n}`];
    if (typeof file !== "string" || !file) continue;
    // #10214: a mesma caixa já foi acusada como PRESENTE na edição — o aviso
    // do config ("o stitch não publica caixa vencida") seria falso aqui.
    if (presentExpired.has(file)) continue;
    const content = readSnippetFileRaw(file, rootDir);
    if (content === null) continue;
    const exp = readSnippetExpiry(content, editionIso);
    const isPinned = n !== 0 && autoEnabled && pinned.includes(n);
    const where = `boxes_divulgacao.slot${n}${isPinned ? " (pinado)" : ""}`;
    let message: string | null = null;
    if (exp.status === "expired") {
      // #12107: o efeito vem do que o stitch de fato decidiu
      // (`_internal/box-selection.json`), nunca de suposição. Antes a frase do
      // slot pinado afirmava "sem candidato, sai vazio" incondicionalmente —
      // na 261104 o slot 1 tinha recebido `youtube-comentario-destaque.md` pela
      // seleção automática e o aviso fez parecer que o espaço estava perdido.
      const outcome = n === 0 ? null : readExpiredSlotOutcome(editionDir, n, file);
      const effect =
        outcome?.kind === "filled"
          ? `nesta edição o slot ${n} recebeu \`${outcome.file}\` pela seleção automática`
          : outcome?.kind === "empty"
            ? `nesta edição o slot ${n} saiu vazio (sem candidato automático)`
            : isPinned
              ? "nesta edição o slot vai pra seleção automática (sem candidato, sai vazio)"
              : "a caixa é pulada nesta edição (o slot sai vazio ou recebe a seleção automática)";
      message =
        `Caixa \`${file}\` (${where}) expirada: expires: ${exp.expires}, edição ${editionIso}. ` +
        `O stitch não publica caixa vencida — ${effect}. Fix: trocar o slot em platform.config.json ` +
        `(ou pelo painel Caixas) e arquivar a caixa.`;
    } else if (exp.status === "valid" && exp.daysLeft <= BOX_EXPIRY_INVARIANT_WARN_DAYS) {
      const when = exp.daysLeft === 0 ? "expira hoje (última edição)" : `expira em ${exp.daysLeft} dia${exp.daysLeft === 1 ? "" : "s"}`;
      message =
        `Caixa \`${file}\` (${where}) ${when} — expires: ${exp.expires}. ` +
        `Depois disso o slot sai vazio ou vai pra seleção automática; planeje a troca no config.`;
    } else if (exp.status === "invalid") {
      message =
        `Caixa \`${file}\` (${where}) declara expires: "${exp.raw}", que não é uma data AAAA-MM-DD — ` +
        `a validade é IGNORADA e a caixa segue saindo. Fix: corrigir o header do snippet.`;
    }
    if (message) {
      violations.push({
        rule: "box-divulgacao-expiry",
        message,
        source_issue: "#10174",
        severity: "warning",
        file: "platform.config.json",
      });
    }
  }
  return violations;
}
