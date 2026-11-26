/**
 * Invariantes do Stage 4 — erro intencional (narrativa e presença no final) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { InvariantViolation } from "../types.ts";
import {
  pickErroIntencionalReveal, // #6734 — MESMA função que o renderer/check-stage2-invariants usam
} from "../../newsletter-parse.ts";
import {
  extractCurrentDeclarationFromMd,
  extractRevealFromFrontmatter,
  narrativeIsGenericPlaceholder,
  narrativeIsCatalogShaped,
  SECTION_HEADER,
} from "../../../render-erro-intencional.ts";
import {
  loadIntentionalErrorJson,
  intentionalErrorJsonPath,
  scanWrongValueAdoption, // #7324
} from "../../intentional-errors.ts";

/**
 * #2377/#2411/#2419/#6734 (rewrite): detecta quando a fonte do reveal para a PRÓXIMA
 * edição seria inválida — genérica, catalog-shaped (label interno "DESTAQUE N"), sem
 * o prefixo temporal correto, ou agramatical.
 *
 * Casos detectados:
 *   1. Narrativa "Nessa edição, …" no corpo é placeholder genérico (incidente #2377).
 *   2. (#2419 bug #2 fix) Narrativa no corpo ou no record (`_internal/intentional-error.json`,
 *      #3222) é catalog-shaped ("DESTAQUE N lista o Spotify…") — passa verde hoje, publica
 *      label interno.
 *   3. (#6734) `record.reveal` não é catálogo/genérico mas não começa com "Na última
 *      edição" nem contém palavra-gancho temporal reconhecida pelo renderer — caso real
 *      260828: "Nessa edição, escrevi ChatGTP…" (editor descrevendo a edição ATUAL, não
 *      fraseando pra edição SEGUINTE revelar). `check-stage2-invariants.ts` já bloqueia
 *      isso no dia da declaração (#6139); este é o backstop no Stage 4 pra qualquer edição
 *      manual do JSON feita depois daquele check já ter passado.
 *   4. (#2419) Sem campo `reveal` dedicado E sem fonte válida de narrative →
 *      reveal da próxima edição seria o fallback genérico seguro.
 *
 * severity: "warning" (lints permanecem warning — re-block para error é follow-up).
 *
 * Remediação: preencher `reveal` em `_internal/intentional-error.json` com prosa first-person.
 */
export function checkNarrativeNotGenericPlaceholder(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  // (#3222) campos estruturados migraram de frontmatter YAML pra
  // `_internal/intentional-error.json` — não sincroniza mais com o Drive.
  const record = loadIntentionalErrorJson(intentionalErrorJsonPath(editionDir));

  const REMEDIATION =
    `Preencha o campo \`reveal\` em _internal/intentional-error.json com prosa ` +
    `first-person completa para o reveal público da próxima edição. ` +
    `Ex: "Na última edição, escrevi 1990 onde o correto é 1998."`;

  // 1. Verificação via extractCurrentDeclarationFromMd (#3494: SÓ corpo, nunca
  //    `record` — `record.reveal` descreve o erro desta edição fraseado para a
  //    PRÓXIMA edição revelar, não a declaração desta edição sobre si mesma;
  //    misturar os dois mascarava prosa genérica/placeholder no corpo sempre
  //    que `record.reveal` estivesse preenchido, produzindo inclusive a
  //    mensagem corrompida "Nessa edição, Na última edição, …").
  const extracted = extractCurrentDeclarationFromMd(md);
  if (extracted?.narrative) {
    // (self-review #3494) Ambos os checks abaixo (genérico + catalog-shaped)
    // são estruturalmente redundantes agora — extractCurrentDeclarationFromMd
    // já filtra as duas classes antes de retornar não-null, então
    // `extracted.narrative` nunca deveria bater aqui. Mantidos como
    // defense-in-depth intencional (mesma classe de guard que #2438/#633
    // já pratica no resto desta função) em vez de removidos — barato e
    // protege contra o filtro de extractCurrentDeclarationFromMd divergir
    // no futuro sem este check acompanhar.
    if (narrativeIsGenericPlaceholder(extracted.narrative)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: a narrativa "Nessa edição, ${extracted.narrative}." ` +
            `é um placeholder genérico (contém frases do bloco de convite ao sorteio: ` +
            `"há um erro proposital", "responda este e-mail", "concorrer ao sorteio"). ` +
            `O reveal da PRÓXIMA edição vai publicar esse texto genérico — incidente #2377. ` +
            REMEDIATION,
          source_issue: "#2377",
          severity: "warning",
          file: path,
        },
      ];
    }
    if (narrativeIsCatalogShaped(extracted.narrative)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: a narrativa "${extracted.narrative}" parece texto catálogo ` +
            `de terceira pessoa (label interno "DESTAQUE N"). ` +
            `O reveal da PRÓXIMA edição vai publicar o fallback seguro genérico em vez do erro real. ` +
            REMEDIATION,
          source_issue: "#2419",
          severity: "warning",
          file: path,
        },
      ];
    }
  }

  // 2. Quando extractCurrentDeclarationFromMd retorna null (filtrou texto
  //    genérico/catalog, ou não achou nenhuma linha "Nessa edição, …"),
  //    verificar diretamente o corpo do bloco ERRO INTENCIONAL. Isso cobre:
  //    editor escreveu só o convite genérico OU catalog-shaped no corpo —
  //    INDEPENDENTE de `record.reveal` estar preenchido (#3494): o corpo é
  //    lido pelos assinantes DESTA edição, `record.reveal` é usado pela
  //    PRÓXIMA — um não substitui o outro.
  if (!extracted) {
    const narrativeRe = /Nessa\s+edi[çc][ãa]o,\s+([^\n]+?)\.\s*(?:\n|$)/i;
    let block = md;
    const headerIdx = md.indexOf(SECTION_HEADER);
    if (headerIdx !== -1) {
      const afterHeader = md.slice(headerIdx);
      const nextSepRe = /\n---\s*\n|\n\*\*[🎁🙋📰🚀🔬🇧🇷🛠️📦📈💡🎭⚖️📊💬🏭🔐]/;
      const nextSepMatch = afterHeader.match(nextSepRe);
      block = nextSepMatch !== null && nextSepMatch.index !== undefined
        ? afterHeader.slice(0, nextSepMatch.index)
        : afterHeader;
    }
    const nm = block.match(narrativeRe);
    if (nm) {
      const bodyNarrative = nm[1].trim();
      if (!/^\{PREENCHER/i.test(bodyNarrative)) {
        if (narrativeIsGenericPlaceholder(bodyNarrative)) {
          return [
            {
              rule: "narrative-not-generic-placeholder",
              message:
                `ERRO INTENCIONAL: a linha do corpo "Nessa edição, ${bodyNarrative}." ` +
                `é um placeholder genérico. O reveal da PRÓXIMA edição não terá fonte válida. ` +
                REMEDIATION,
              source_issue: "#2411",
              severity: "warning",
              file: path,
            },
          ];
        }
        // (#2419 bug #2 fix) catalog-shaped no corpo → emitir warning
        if (narrativeIsCatalogShaped(bodyNarrative)) {
          return [
            {
              rule: "narrative-not-generic-placeholder",
              message:
                `ERRO INTENCIONAL: a linha do corpo "Nessa edição, ${bodyNarrative}." ` +
                `é texto catálogo de terceira pessoa (label interno "DESTAQUE N"). ` +
                `O reveal da PRÓXIMA edição usará o fallback seguro genérico. ` +
                REMEDIATION,
              source_issue: "#2419",
              severity: "warning",
              file: path,
            },
          ];
        }
      }
    }
  }

  // F3 (#633): verifica o campo `reveal` do frontmatter quanto a conteúdo catalog-shaped.
  // Se o editor copiar `description` (catálogo, ex: 'DESTAQUE 2 lista...') para dentro de
  // `reveal`, o Stage 4 ficaria silencioso sem esta checagem.
  // severity: warning (decisão editorial 260619 — lints ficam warning).
  //
  // (#3494) `extracted` (corpo) e `reveal` (record) são fontes ORTOGONAIS desde
  // o split de extractCurrentDeclarationFromMd/extractPreviousRevealFromRecord
  // — `extracted` nunca carrega mais um campo `.reveal` derivado do record, então
  // este check roda SEMPRE, independente do corpo já ter (ou não) uma declaração
  // válida. Isso é o que corrige o cegamento original: `record.reveal` catalog/
  // genérico agora é sinalizado mesmo quando o corpo também está com problema
  // (que já terá sido sinalizado antes, no passo 1/2 acima).
  const reveal = extractRevealFromFrontmatter(record);
  if (reveal) {
    if (narrativeIsCatalogShaped(reveal)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: o campo \`intentional_error.reveal\` contém texto catálogo ` +
            `de terceira pessoa (label interno "DESTAQUE N" ou similar): "${reveal.slice(0, 80)}". ` +
            `O reveal da PRÓXIMA edição usará o fallback seguro genérico em vez do erro real. ` +
            REMEDIATION,
          source_issue: "#2419",
          severity: "warning",
          file: path,
        },
      ];
    }
    if (narrativeIsGenericPlaceholder(reveal)) {
      return [
        {
          rule: "narrative-not-generic-placeholder",
          message:
            `ERRO INTENCIONAL: o campo \`intentional_error.reveal\` contém texto genérico ` +
            `(placeholder do convite ao sorteio): "${reveal.slice(0, 80)}". ` +
            `O reveal da PRÓXIMA edição usará o fallback seguro genérico em vez do erro real. ` +
            REMEDIATION,
          source_issue: "#2419",
          severity: "warning",
          file: path,
        },
      ];
    }
  }

  // #6734: `reveal` pode passar limpo pelas 2 checagens acima (não é catálogo,
  // não é o placeholder genérico do convite ao sorteio) e AINDA assim não
  // começar com o prefixo temporal correto — caso real 260828:
  // "Nessa edição, escrevi ChatGTP..." (editor pensando na edição ATUAL,
  // não escrevendo pra edição SEGUINTE revelar). `check-stage2-invariants.ts`
  // já valida isso no Stage 2 (mesmo dia da declaração, #6139) — este é o
  // BACKSTOP no Stage 4 (mesma reincidência de #2419/#3494: `record.reveal`
  // pode ser editado depois do Stage 2 já ter passado, sem re-rodar aquele
  // check), pra pegar antes do publish, não só quando a edição SEGUINTE
  // tentar renderizar e o box de reveal sumir silenciosamente.
  if (reveal && pickErroIntencionalReveal(reveal) === null) {
    return [
      {
        rule: "reveal-temporal-prefix",
        message:
          `ERRO INTENCIONAL: o campo \`intentional_error.reveal\` não começa com ` +
          `"Na última edição" nem contém palavra-gancho temporal reconhecida pelo ` +
          `renderer (último/anterior/passado/ontem/edições): "${reveal.slice(0, 80)}". ` +
          `A edição SEGUINTE copia este texto verbatim e o box de reveal do ERRO ` +
          `INTENCIONAL não será renderizado, silenciosamente (#6139/#6734). ` +
          `Reescreva \`reveal\` em _internal/intentional-error.json começando com ` +
          `"Na última edição, ...".`,
        source_issue: "#6734",
        severity: "warning",
        file: path,
      },
    ];
  }

  // (#2438 Item 2 — caso 3) Sem campo `reveal` dedicado E sem fonte válida de narrative
  // (extracted=null) → o reveal da PRÓXIMA edição cairia no fallback seguro genérico.
  // Emitir warning NÃO-BLOCKING quando o MD declara um bloco ERRO INTENCIONAL (o
  // editor está usando o recurso) mas não preencheu nenhuma fonte válida de reveal.
  // severity: warning — nunca blocking (decisão editorial, fora de escopo #2438).
  if (!extracted && !reveal && md.includes(SECTION_HEADER)) {
    return [
      {
        rule: "narrative-not-generic-placeholder",
        message:
          `ERRO INTENCIONAL: sem campo \`reveal\` dedicado E sem fonte válida de narrative ` +
          `no corpo ou frontmatter. O reveal da PRÓXIMA edição usará o fallback seguro genérico ` +
          `("Na última edição, escondemos um erro proposital...") em vez de descrever o erro real. ` +
          REMEDIATION,
        source_issue: "#2438",
        severity: "warning",
        file: path,
      },
    ];
  }

  return [];
}

/**
 * (#11553) Comando de replantio sugerido na mensagem do
 * `intentional-error-present-in-final` — o `--edition-dir` sai do diretório
 * real checado, então dá pra colar direto.
 */
export function replantCommand(editionDir: string): string {
  const dir = editionDir.replace(/[\\/]+$/, "");
  return `npx tsx scripts/replant-intentional-error.ts --edition-dir ${dir}/`;
}

/**
 * #7243: detecta o item PORTADOR do erro intencional sumindo do texto final —
 * incidente real: edição 260902, item de RADAR com "Anthropik" (erro declarado
 * em `_internal/intentional-error.json`) foi removido pelo editor numa poda
 * NORMAL do RADAR (7 → 3 itens) dentro do gate do Stage 4. Nada acusou —
 * `checkNarrativeNotGenericPlaceholder` acima valida só a PROSA do reveal
 * (`Nessa edição, …`/`reveal`), nunca cruza contra o texto publicado. O reveal
 * da edição SEGUINTE ia afirmar pros assinantes que um erro existia quando não
 * existia mais — desinformação publicada, concurso "ache o erro" quebrado em
 * silêncio, alocação de número de sorteio contaminada (ver corpo da #7243).
 *
 * O que TORNA isso verificável mecanicamente: `wrong_value` (#7243, irmão de
 * `correct_value`) — a grafia/valor ERRADO efetivamente plantado, não o valor
 * corrigido. Buscar por `correct_value` não serve: é justamente o texto que o
 * item CORRIGIDO teria (guard ingênuo que procurasse `correct_value` no MD
 * passaria sempre, como o corpo da issue observa).
 *
 * Duas saídas quando o guard acusa (mensagem de erro nomeia as duas, #7243
 * item 3 — "mensagem acionável"): (a) replantar o erro em outro item do texto
 * atual, ou (b) declarar a edição sem erro (`{"no_error": true}`, suporte já
 * existente desde #2016/#2037 — ver `loadIntentionalErrorJson`).
 *
 * Roda DEPOIS de qualquer edição do editor no gate — é o único ponto onde a
 * verificação vale (a janela entre "erro plantado no Stage 2" e "editor podou
 * o RADAR no Stage 4" não tinha guarda nenhuma). O call site que fecha essa
 * janela de fato — reinvocar só esta regra imediatamente antes de escrever o
 * sentinel de Stage 4, cobrindo o fast-path do painel Studio (#6444) que pula
 * o loop `sim/ajustar` inteiro — vive em `orchestrator-stage-4-gate.md` §4e, não
 * aqui (esta função é só o pure check; o card mecânico completo, incluindo
 * QUANDO ele roda, é responsabilidade do playbook).
 *
 * Severidade dupla, por design:
 *   - `error` (GATE-BLOCKING) quando `wrong_value` está declarado e NÃO
 *     aparece mais em `02-reviewed.md` — o caso real do incidente.
 *   - `warning` quando há erro declarado (não `no_error`) mas `wrong_value`
 *     está ausente/placeholder — não dá pra verificar mecanicamente, mas
 *     bloquear TODA edição anterior ao #7243 (campo novo, opcional por
 *     decisão de escopo — ver PR #7243) seria travar o pipeline por uma
 *     mudança de schema que o editor ainda não adotou o hábito de preencher.
 *
 * Match verbatim (substring simples, case-sensitive, sem trim de acentuação):
 * a essência de um erro ortográfico/factual É a grafia exata plantada —
 * normalizar case ou acentos esconderia justamente o tipo de erro mais comum
 * (ortográfico) que o incidente real envolveu ("Anthropik" ⊄ "anthropik").
 *
 * Falso-negativo conhecido, registrado e não corrigido aqui (#7243 review):
 * `md.includes(wrongValue)` sem escopo pode achar `wrongValue` em outro lugar
 * do texto que não o item declarado — plausível quando `wrong_value` é CURTO
 * ou GENÉRICO o bastante pra ocorrer por acaso (categorias `numeric`,
 * `version_inconsistency`, `data`: ex. `wrong_value: "5"` batendo num número
 * qualquer de outro destaque). O caso concreto do incidente (`"Anthropik"`,
 * categoria `ortografico`) não sofre disso — é específico o bastante pra só
 * bater no item certo. Escopar o match ao item/seção declarada em `location`
 * fecharia o gap, mas exigiria parsear `location` de volta pra uma região do
 * MD (formato livre, "DESTAQUE 2, parágrafo 1") — fora de escopo desta PR.
 */
export function checkIntentionalErrorPresentInFinal(
  editionDir: string,
  // #7324: injetável em teste — produção nunca passa (default = pai de
  // editionDir, tipicamente `data/editions/`); testes injetam um diretório
  // isolado pra não contar edições vizinhas de outros testes/processos
  // rodando concorrentemente no mesmo tmpdir do OS.
  editionsRootDir?: string,
): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];

  const jsonPath = intentionalErrorJsonPath(editionDir);
  const record = loadIntentionalErrorJson(jsonPath);
  if (!record) return []; // nada declarado ainda — check-stage2-invariants.ts é dono desse gap

  // #2016/#2037: edição sem erro intencional é um estado legítimo — nada a verificar.
  if (record.no_error === true) return [];

  const md = readFileSync(path, "utf8");
  // Só relevante quando a edição de fato declara um erro no corpo publicado.
  // NÃO é a mesma condição do último branch de checkNarrativeNotGenericPlaceholder
  // (linha ~843 acima, que é `!extracted && !reveal && md.includes(SECTION_HEADER)`
  // — um AND de 3 termos usado pra detectar "sem NENHUMA fonte válida de reveal").
  // Aqui o objetivo é mais amplo — "existe declaração de erro pra verificar,
  // seja qual for a forma" —, então é um OR de 2: presença do header da seção
  // (cobre a edição que zerou a narrativa mas manteve o bloco) OU uma
  // declaração válida extraída do corpo (`extractCurrentDeclarationFromMd`
  // já filtra placeholder/catalog-shaped, então != null implica declaração real).
  const hasDeclaredError = md.includes(SECTION_HEADER) || extractCurrentDeclarationFromMd(md) !== null;
  if (!hasDeclaredError) return [];

  const wrongValue = (record.wrong_value ?? "").trim();
  if (!wrongValue || /^\{PREENCHER/i.test(wrongValue)) {
    // #7324: conta quantas edições (histórico completo em editionsRootDir)
    // declaram erro sem `wrong_value` — a decisão de tornar o campo
    // obrigatório é do editor (fica aberta), mas essa contagem tira o "opcional
    // vira permanente por inércia" da lista de riscos silenciosos: com o
    // número exposto aqui, toda vez que o warning dispara, dá pra ler a
    // adoção sem precisar de auditoria manual.
    const rootDir = editionsRootDir ?? dirname(resolve(editionDir));
    const { totalDeclared, missingWrongValue } = scanWrongValueAdoption(rootDir);
    const adoptionNote =
      totalDeclared > 0
        ? ` [instrumentação #7324: ${missingWrongValue}/${totalDeclared} edição(ões) com erro ` +
          `declarado ainda sem \`wrong_value\` — inclui esta.]`
        : "";
    return [
      {
        rule: "intentional-error-present-in-final",
        message:
          `ERRO INTENCIONAL: campo \`wrong_value\` ausente/placeholder em ${jsonPath} — não é ` +
          `possível verificar mecanicamente se o item que carrega o erro plantado ainda está ` +
          `presente em 02-reviewed.md (uma poda de RADAR no gate pode removê-lo sem nenhum ` +
          `aviso — incidente real: edição 260902, #7243). Preencha \`wrong_value\` com a ` +
          `grafia/valor efetivamente ERRADO plantado no texto (ex: "Anthropik", não "Anthropic" ` +
          `— esse é o \`correct_value\`).${adoptionNote}`,
        source_issue: "#7243",
        severity: "warning",
        file: jsonPath,
      },
    ];
  }

  if (!md.includes(wrongValue)) {
    return [
      {
        rule: "intentional-error-present-in-final",
        message:
          `ERRO INTENCIONAL: o valor plantado "${wrongValue}" (declarado em ${jsonPath}) NÃO ` +
          `aparece mais em 02-reviewed.md. Causa provável: o item que continha o erro foi removido ` +
          `(ou reescrito) depois da declaração, numa poda do gate ou na retirada de um item ` +
          `duplicado (incidentes reais: edição 260902, RADAR podado levou junto "Anthropik" — ` +
          `#7243; edição 261029, item duplicado de LANÇAMENTOS levou junto "DeepMinde" — #11553). ` +
          `Publicar assim faz o reveal da PRÓXIMA edição afirmar um erro que não existe mais — ` +
          `desinformação publicada, concurso "ache o erro" quebrado em silêncio. Fix: (a) replantar ` +
          `com \`${replantCommand(editionDir)}\` — atualiza de uma vez 02-reviewed.md, ` +
          `${jsonPath}, data/intentional-errors.jsonl e a frase "Nessa edição, …", rechecando a ` +
          `regra dos últimos 30 dias (\`--entity <marca>\` escolhe a grafia/item, \`--dry-run\` ` +
          `só mostra o candidato), OU (b) declarar a edição sem erro — gravar {"no_error": true} ` +
          `em ${jsonPath} (sobrescreve os demais campos). Repetir esta checagem até exit 0 antes ` +
          `de aprovar o gate.`,
        source_issue: "#7243",
        severity: "error",
        file: path,
      },
    ];
  }

  return [];
}
