/**
 * Invariants de Stage 4 — Publicação (#1007 Fase 1).
 *
 * Última barreira antes de invocar publishers. Falha aqui = catastrófica
 * (publicação corrompida, broadcast vazio). Checks aqui devem ser strict.
 *
 * #14057: este arquivo é o ÍNDICE — as funções moram em `./stage-4/`, um
 * arquivo por família de invariante. Aqui ficam o registro `STAGE_4_RULES`
 * (a ordem é travada por `test/stage-4-rules-order-14057.test.ts`) e o
 * reexport público; os importadores continuam importando deste caminho.
 */

import type { InvariantRule } from "./types.ts";
import { checkIntentionalErrorNotRecentRepeat } from "../intentional-error-repeat.ts"; // #9101
import {
  CROP_REVIEW_IMAGE_VARIANTS,
  type CropReviewImageVariant,
  isCropReviewImageVariant,
  cropReviewImageSuffix,
  isCropReviewEntryStale,
  isSilencedCropWarn,
} from "../crop-review-entry.ts"; // #13997
import { checkTituloSubtituloNotProvisional } from "../titulo-provisional.ts"; // #9601 review PR #9666
import {
  checkReviewedNoPendingPlaceholder,
  checkReviewedOnedriveConflictCopy,
} from "../diaria/reviewed-integrity.ts"; // #12259
import { checkSourceNotRead } from "../diaria/source-readability.ts"; // #12258
import { checkHasNegativeImpactHighlight, checkTop3Merit } from "./stage-1.ts"; // #3916, #3918
import { checkPublicImagesMd5MatchesLocal } from "../public-images-md5-check.ts"; // #11252
import {
  checkBoxDivulgacaoAltMissing,
  checkBoxDivulgacaoExpiry,
  checkBoxDivulgacaoRawHtml,
  checkBoxDivulgacaoRuntimeExcluded,
  checkBoxSelectionConfigDrift,
} from "./stage-4/boxes.ts";
import {
  checkCarouselCardsMissing,
  checkCarouselCardsStale,
  checkCarouselTextOverflow,
  checkCarouselUploadIncomplete,
  checkCarouselUploadStale,
} from "./stage-4/carrossel.ts";
import {
  checkCaptureFailedSubmissionCount,
  checkIntroCountConsistent,
  checkLancamentoSemFabricante,
  checkMaxContentItems,
  checkNewsletterIntake,
  checkNoTrailingEllipsisInvariant,
  checkReviewedDuplicateClosingBlock,
  checkReviewedUnknownTemplateMarkers,
  checkTitleIaAsAgentInvariant,
  checkTitleMentionsIaInvariant,
  checkTitlePublisherSuffixInvariant,
  checkTitleShortsFrontLoadInvariant,
  checkTitleTrailingPeriodInvariant,
  checkTruncatedSecondaryItemSummary,
} from "./stage-4/conteudo.ts";
import {
  checkClaricePending,
  checkClaricePendingFooterCredit,
  checkEditionSyncConflicts,
  checkEiaCreditSynced,
} from "./stage-4/edicao.ts";
import {
  checkIntentionalErrorPresentInFinal,
  checkNarrativeNotGenericPlaceholder,
} from "./stage-4/erro-intencional.ts";
import {
  KIT_HTML_SIZE_ERROR_BYTES,
  NEWSLETTER_HTML_SIZE_WARN_BYTES,
  checkKitFixtureAudit,
  checkKitHtmlSize,
  checkNewsletterHtmlNotBehindReviewed,
  checkNewsletterHtmlSize,
  checkRenderWarnings,
} from "./stage-4/html.ts";
import {
  checkCard4x5UploadMismatch,
  checkCropReviewWarnings,
  checkImageContentFresh,
  checkPublicImagesPopulated,
  checkStarryNightDetected,
} from "./stage-4/imagens.ts";
import {
  checkApprovedItemRemoval,
  checkDedupRecurrence,
  checkDestaqueRepeatedPastEdition,
  checkEditorDestaqueRequests,
  checkFactRecurrence,
  checkHighlightDateUnverified,
  checkHighlightSourceStaleDate,
  checkIntraEditionFactRecurrence,
  checkNoDuplicateUrlsAgainstPastEditions,
  checkSecondaryThemePossibleRepeat,
  checkSponsoredSourceMarkers,
  checkStaleHighlightRepeat,
  checkStoryContinuation,
  checkStoryTwiceInEdition,
  checkStudySourceRecurrence,
  checkThemeCrossSourceRepeat,
} from "./stage-4/repeticao.ts";
import {
  checkCurtoXWeightInvariant,
  checkInstagramCommentDeliveryPromise,
  checkSocialClaricePending,
  checkSocialHashFresh,
  checkSocialHumanizerSealFresh,
  checkSocialInviteDrift,
  checkSocialNotBehindReviewed,
} from "./stage-4/social.ts";
import {
  checkUseMelhorCarouselStaleAtGate,
  checkUseMelhorIsca,
  checkUseMelhorPostItemRendered,
  checkUseMelhorPublicImageKeysHaveFiles,
  checkUseMelhorSentinel,
  checkUseMelhorSocialSource,
  checkUseMelhorTempoConsistent,
  checkUseMelhorTempoItemSemMedicao,
  checkUseMelhorTempoTitleHeuristicShare,
} from "./stage-4/use-melhor.ts";

export {
  type ImageContentMismatch,
  findImageContentMismatches,
} from "./stage-4/imagens.ts";
export {
  checkSocialNotBehindReviewed,
  checkSocialHumanizerSealFresh,
  checkSocialClaricePending,
  checkSocialInviteDrift,
} from "./stage-4/social.ts";
export {
  checkUseMelhorIsca,
  checkUseMelhorTempoItemSemMedicao,
  checkUseMelhorSocialSource,
} from "./stage-4/use-melhor.ts";
export {
  replantCommand,
} from "./stage-4/erro-intencional.ts";
export {
  checkMaxContentItems,
  checkTitleShortsFrontLoadInvariant,
  checkNewsletterIntake,
  checkLancamentoSemFabricante,
  checkReviewedUnknownTemplateMarkers,
  checkReviewedDuplicateClosingBlock,
} from "./stage-4/conteudo.ts";
export {
  checkSponsoredSourceMarkers,
  checkFactRecurrence,
  readIntraEditionItems,
  checkIntraEditionFactRecurrence,
  STORY_TWICE_PAST_WINDOW,
  readPastStoryItems,
  checkStoryTwiceInEdition,
  THEME_CROSS_SOURCE_CUT_MIN_JACCARD,
  checkThemeCrossSourceRepeat,
  checkSecondaryThemePossibleRepeat,
  checkStudySourceRecurrence,
  checkStoryContinuation,
  checkStaleHighlightRepeat,
  checkHighlightDateUnverified,
  checkHighlightSourceStaleDate,
  type DuplicateUrlMatch,
  findDuplicateUrlsAgainstPastEditions,
  formatRepeatedDestaqueMessage,
  checkDestaqueRepeatedPastEdition,
  checkDedupRecurrence,
} from "./stage-4/repeticao.ts";
export {
  checkBoxDivulgacaoRawHtml,
  checkBoxSelectionConfigDrift,
  BOX_EXPIRY_INVARIANT_WARN_DAYS,
  readExpiredSlotOutcome,
  checkBoxDivulgacaoExpiry,
} from "./stage-4/boxes.ts";
export {
  NEWSLETTER_HTML_SIZE_WARN_BYTES,
  checkNewsletterHtmlSize,
  KIT_HTML_SIZE_ERROR_BYTES,
  checkKitHtmlSize,
  checkNewsletterHtmlNotBehindReviewed,
} from "./stage-4/html.ts";
export {
  EDITION_REQUIRED_FILES,
  checkEditionSyncConflicts,
} from "./stage-4/edicao.ts";

// #13997: helpers do veredito de crop moram em lib/crop-review-entry.ts
// (módulo-folha), para que run-image-crop-reviewer.ts não puxe este arquivo
// e, por ele, o corretor Clarice de lib/diaria/ (fronteira #13998).
export {
  CROP_REVIEW_IMAGE_VARIANTS,
  type CropReviewImageVariant,
  isCropReviewImageVariant,
  cropReviewImageSuffix,
  isCropReviewEntryStale,
  isSilencedCropWarn,
};

export const STAGE_4_RULES: InvariantRule[] = [
  {
    id: "edition-sync-conflicts",
    description: "pasta da edição sem cópia .conflictN do sync e com os arquivos obrigatórios presentes (#13545)",
    source_issue: "#13545",
    stage: 4,
    run: checkEditionSyncConflicts,
  },
  {
    id: "newsletter-html-not-behind-reviewed",
    description: "newsletter-final.html não ficou atrás de 02-reviewed.md — replant/edição no gate sem re-render (#10245; error desde #10258 — bloqueia o sentinel do Stage 4; reviewed só tocado, com sha256 igual ao carimbo do render, não acusa)",
    source_issue: "#10245",
    stage: 4,
    run: (editionDir) => checkNewsletterHtmlNotBehindReviewed(editionDir),
  },
  {
    id: "public-images-populated",
    description: "06-public-images.json com URLs d1/d2/d3 (#999)",
    source_issue: "#999",
    stage: 4,
    run: checkPublicImagesPopulated,
  },
  {
    id: "public-images-md5-matches-local",
    description: "hero 2:1 do e-mail (cover/d1_play/d2_2x1/d3_2x1) em 06-public-images.json tem o md5 do arquivo local — troca de destaque não deixa imagem antiga no e-mail (#11252)",
    source_issue: "#11252",
    stage: 4,
    run: checkPublicImagesMd5MatchesLocal,
  },
  {
    id: "social-hash-fresh",
    description: "social.md hash bate com approved.json highlights (#1413)",
    source_issue: "#1413",
    stage: 4,
    run: checkSocialHashFresh,
  },
  {
    id: "social-not-behind-reviewed",
    description: "03-social.md não ficou atrás de 02-reviewed.md — destaque reescrito no gate sem cascata do social (#9820)",
    source_issue: "#9820",
    stage: 4,
    run: (editionDir) => checkSocialNotBehindReviewed(editionDir),
  },
  {
    id: "social-humanizer-seal-fresh",
    description: "selo do humanizador bate com o 03-social.md atual — social reescrito no Stage 4 foi re-humanizado (#9820)",
    source_issue: "#9820",
    stage: 4,
    run: checkSocialHumanizerSealFresh,
  },
  {
    id: "social-clarice-pending",
    description: "seção do social selada com a Clarice pendente (API fora do ar) aparece no gate (#13848)",
    source_issue: "#13848",
    stage: 4,
    run: checkSocialClaricePending,
  },
  {
    id: "image-content-fresh",
    description: "imagem de destaque bate com highlight D{N} atual (#1730)",
    source_issue: "#1730",
    stage: 4,
    run: checkImageContentFresh,
  },
  {
    id: "eia-credit-synced",
    description: "crédito do bloco É IA? em 02-reviewed.md bate com 01-eia.md, a fonte real do render (#3825)",
    source_issue: "#3825",
    stage: 4,
    run: checkEiaCreditSynced,
  },
  {
    id: "intro-count-consistent",
    description: "intro line Z = contagem real de items visíveis (#1578)",
    source_issue: "#1578",
    stage: 4,
    run: checkIntroCountConsistent,
  },
  {
    id: "max-content-items",
    description: "rascunho do Gate 4 com no máximo 13 conteúdos (destaques + seções secundárias) (#9785)",
    source_issue: "#9785",
    stage: 4,
    run: checkMaxContentItems,
  },
  {
    id: "titulo-subtitulo-not-provisional",
    description:
      "TÍTULO/SUBTÍTULO não carrega o título provisório (da fonte) deixado pelo swap-destaque depois que o D{N} ganhou título final (#9601)",
    source_issue: "#9601",
    stage: 4,
    run: checkTituloSubtituloNotProvisional,
  },
  {
    id: "reviewed-no-pending-placeholder",
    description:
      "02-reviewed.md sem placeholder de destaque não integrado ([RASCUNHO PENDENTE …]/[TEXTO PENDENTE …] do swap/promote) (#12259)",
    source_issue: "#12259",
    stage: 4,
    run: checkReviewedNoPendingPlaceholder,
  },
  {
    id: "reviewed-onedrive-conflict-copy",
    description:
      "avisa quando o OneDrive deixou cópia de conflito (*-safeBackup-*.md) de 02-reviewed.md/03-social.md — o principal pode ter perdido uma edição (#12259)",
    source_issue: "#12259",
    stage: 4,
    run: checkReviewedOnedriveConflictCopy,
  },
  {
    id: "source-not-read",
    description:
      "lista no gate os itens da edição cuja fonte não foi lida (403, vídeo, resumo curto); error para item de pool sem texto lido nem aceite do editor (#12258, #13884)",
    source_issue: "#12258",
    stage: 4,
    run: checkSourceNotRead,
  },
  {
    id: "use-melhor-sentinel",
    description: "itens USE MELHOR sem descrição real (sentinel [DESCRIÇÃO PENDENTE] presente, #2464)",
    source_issue: "#2464",
    stage: 4,
    run: checkUseMelhorSentinel,
  },
  {
    id: "use-melhor-tempo",
    description: "cada item USE MELHOR tem estimativa de tempo na descrição (#2372)",
    source_issue: "#2372",
    stage: 4,
    run: checkUseMelhorTempoConsistent,
  },
  {
    id: "use-melhor-tempo-title-heuristic-share",
    description: "itens USE MELHOR cuja estimativa veio de title-heuristic (body não cacheado) — sinal de qualidade, warning-only (#7668)",
    source_issue: "#7668",
    stage: 4,
    run: checkUseMelhorTempoTitleHeuristicShare,
  },
  {
    id: "use-melhor-tempo-item-sem-medicao",
    description: "warning individual por item USE MELHOR com tempo estimado por título ou sem fonte de medição (#10765)",
    source_issue: "#10765",
    stage: 4,
    run: checkUseMelhorTempoItemSemMedicao,
  },
  {
    id: "narrative-not-generic-placeholder",
    description: "narrative ERRO INTENCIONAL é declaração real de primeira pessoa (#2377)",
    source_issue: "#2377",
    stage: 4,
    run: checkNarrativeNotGenericPlaceholder,
  },
  {
    id: "intentional-error-present-in-final",
    description:
      "item que carrega o erro intencional (wrong_value) ainda está em 02-reviewed.md — detecta poda silenciosa no gate (#7243)",
    source_issue: "#7243",
    stage: 4,
    run: checkIntentionalErrorPresentInFinal,
  },
  {
    id: "intentional-error-not-recent-repeat-final",
    description:
      "erro intencional declarado até o pré-gate (inclusive o do proposer) não reusa wrong_value/correct_value de edição dos últimos 30 dias (#9101)",
    source_issue: "#9101",
    stage: 4,
    run: (editionDir) =>
      checkIntentionalErrorNotRecentRepeat(editionDir, { ruleId: "intentional-error-not-recent-repeat-final" }),
  },
  {
    id: "truncated-secondary-item-summary",
    description: "descrição de item secundário não termina em reticências de truncamento (#2596)",
    source_issue: "#2596",
    stage: 4,
    run: checkTruncatedSecondaryItemSummary,
  },
  {
    id: "title-publisher-suffix",
    description: "título sem sufixo residual de veículo (' | Veículo' / ' - Veículo', #2664)",
    source_issue: "#2664",
    stage: 4,
    run: checkTitlePublisherSuffixInvariant,
  },
  {
    id: "title-trailing-period",
    description: "título de destaque/item sem ponto final único (#2672)",
    source_issue: "#2672",
    stage: 4,
    run: checkTitleTrailingPeriodInvariant,
  },
  {
    id: "no-trailing-ellipsis",
    description: "descrição de item secundário não termina em reticências herdadas da fonte (#2881)",
    source_issue: "#2881",
    stage: 4,
    run: checkNoTrailingEllipsisInvariant,
  },
  {
    id: "title-mentions-ia",
    description: "título de destaque sem menção a 'IA'/'AI'/'inteligência artificial' quando evitável (#4825, warning-only)",
    source_issue: "#4825",
    stage: 4,
    run: checkTitleMentionsIaInvariant,
  },
  {
    id: "title-ia-as-agent",
    description: "título de destaque não põe 'IA' como sujeito quando o corpo descreve ator humano (#12106, warning-only)",
    source_issue: "#12106",
    stage: 4,
    run: checkTitleIaAsAgentInvariant,
  },
  {
    id: "title-shorts-front-load",
    description: "título do D1 se lê sozinho nos ~40 caracteres que o feed de Shorts mostra (#12464, warning-only)",
    source_issue: "#12464",
    stage: 4,
    run: checkTitleShortsFrontLoadInvariant,
  },
  {
    id: "newsletter-intake", description: "intake completo e scores de todos os links IA (#12188)",
    source_issue: "#12188", stage: 4, run: checkNewsletterIntake,
  },
  {
    id: "capture-failed-submission-count",
    description: "captura de newsletters (0b-bis) falhou — coverage line não pode afirmar '0 submissões' (#2878)",
    source_issue: "#2878",
    stage: 4,
    run: checkCaptureFailedSubmissionCount,
  },
  {
    id: "top3-merit-warning",
    description: "item fora do top-3 com score ≥ maior do trio (warning-only)",
    source_issue: "#10792", stage: 4, run: checkTop3Merit,
  },
  {
    id: "has-negative-impact-highlight",
    description: "≥1 destaque tagueado negative_impact:true — repetido no gate consolidado (#3916, #3918, warning-only)",
    source_issue: "#3916",
    stage: 4,
    run: checkHasNegativeImpactHighlight,
  },
  {
    id: "fact-recurrence", description: "Possível mesmo fato em todas as seções (heurístico, warning-only)",
    source_issue: "#11083", stage: 4, run: checkFactRecurrence,
  },
  {
    id: "intra-edition-fact-recurrence", description: "Item do pool com a mesma história de um destaque ou de outro item da edição (heurístico, warning-only)",
    source_issue: "#11173", stage: 4, run: checkIntraEditionFactRecurrence,
  },
  {
    id: "lancamento-sem-fabricante",
    description: "Item de LANÇAMENTOS cita o fabricante (empresa ou produto da URL) no título ou na descrição (heurístico, warning-only)",
    source_issue: "#12595", stage: 4, run: checkLancamentoSemFabricante,
  },
  {
    id: "story-twice-in-edition",
    description: "Mesma história duas vezes na edição final (destaque × destaque, pool × destaque) ou repetindo item publicado nas últimas 3 edições por produto+versão (heurístico, warning-only)",
    source_issue: "#11496", stage: 4, run: (dir: string) => checkStoryTwiceInEdition(dir),
  },
  {
    id: "theme-cross-source-repeat",
    description: "Candidato a destaque com aviso cross-source do passe de tema do Stage 1 (repete tema de destaque recente) que segue no 02-reviewed.md final (warning-only)",
    source_issue: "#11496", stage: 4, run: checkThemeCrossSourceRepeat,
  },
  {
    id: "secondary-theme-possible-repeat",
    description: "Item do pool que o passe secundário do Stage 1 marcou como possível repetição de tema (entidade + termo de conteúdo em comum com item publicado nas últimas edições) e segue no 02-reviewed.md final (warning-only)",
    source_issue: "#13143", stage: 4, run: checkSecondaryThemePossibleRepeat,
  },
  {
    id: "study-source-recurrence",
    description: "Item que é cobertura secundária de estudo/relatório já publicado nos últimos 30 dias (mesmo publicador + documento + número-chave; heurístico, warning-only)",
    source_issue: "#11763", stage: 4, run: (dir: string) => checkStudySourceRecurrence(dir),
  },
  {
    id: "story-continuation",
    description: "Destaque que continua história publicada nos últimos 30 dias (produto+versão no lead ou URL que continua a anterior; informativo, warning-only)",
    source_issue: "#11897", stage: 4, run: (dir: string) => checkStoryContinuation(dir),
  },
  {
    id: "stale-highlight-repeat",
    description: "Destaque que é notícia velha: URL publicada há 31-84 dias ou mesmo incidente contado de novo depois de 30 dias (heurístico, warning-only)",
    source_issue: "#13313", stage: 4, run: (dir: string) => checkStaleHighlightRepeat(dir),
  },
  {
    id: "highlight-date-unverified",
    description: "Destaque final com date_unverified: true em 01-approved.json — a data do pipeline pode não ser a do anúncio (warning-only)",
    source_issue: "#13313", stage: 4, run: checkHighlightDateUnverified,
  },
  {
    id: "highlight-source-stale-date",
    description: "Texto da fonte do destaque declara atualização/publicação mais de 30 dias antes da edição (warning-only)",
    source_issue: "#13313", stage: 4, run: checkHighlightSourceStaleDate,
  },
  {
    id: "no-duplicate-urls-vs-past-editions",
    description:
      "URL editorial de 02-reviewed.md repetida contra os últimos ~30 dias de edições (past-editions.md, #9955) — dedup do Stage 1 não vê itens inseridos/promovidos no gate (#8993, warning-only)",
    source_issue: "#8993",
    stage: 4,
    run: checkNoDuplicateUrlsAgainstPastEditions,
  },
  {
    id: "dedup-recurrence",
    description: "Item isento antigo ou tema entidade + evento de destaque nos últimos 10 dias (#13923, warning-only)",
    source_issue: "#13923", stage: 4, run: (dir: string) => checkDedupRecurrence(dir),
  },
  {
    id: "destaque-repeated-past-edition",
    description:
      "destaque aprovado cuja URL já saiu nos últimos ~30 dias, com edição e seção de origem: ⚠️ upgrade do #12193 (pede fato novo) ou 🚨 repetição sem o marcador do dedup (#13883, warning-only)",
    source_issue: "#13883",
    stage: 4,
    run: (dir: string) => checkDestaqueRepeatedPastEdition(dir),
  },
  {
    id: "editor-destaque-request",
    description:
      "link enviado pelo editor com pedido explícito de destaque (inbox) que ficou fora dos destaques ou em outra posição, com o motivo (#12193, warning-only)",
    source_issue: "#12193",
    stage: 4,
    run: checkEditorDestaqueRequests,
  },
  {
    id: "image-crop-warn",
    description:
      "revisor de crop (Stage 3) sinaliza sujeito cortado/composição sem sentido no card 4:5 (#3951, warning-only; o 1:1 não chega ao leitor e não avisa, #12226)",
    source_issue: "#3951",
    stage: 4,
    run: checkCropReviewWarnings,
  },
  {
    id: "image-starry-night-detected",
    description:
      "revisor de imagem (Stage 3) acusou Noite Estrelada na imagem ATUAL do destaque — regra invariável, error; Stage 3 regenera sozinho antes (#10312)",
    source_issue: "#10312",
    stage: 4,
    run: checkStarryNightDetected,
  },
  {
    id: "box-divulgacao-alt-missing",
    description: "slot de box de divulgação com imagem mas sem alt: descritivo no snippet (#4086, warning-only)",
    source_issue: "#4086",
    stage: 4,
    run: checkBoxDivulgacaoAltMissing,
  },
  {
    id: "box-selection-config-drift",
    description: "boxes_divulgacao.slotN trocado no config depois do stitch, sem efeito no render (#9253, warning-only)",
    source_issue: "#9253",
    stage: 4,
    run: (editionDir: string) => checkBoxSelectionConfigDrift(editionDir),
  },
  {
    id: "social-invite-drift",
    description: "convite social do PARA ENCERRAR diverge do SOCIAL_INVITE atual — não reconhecido (sai sem a borda de box) ou com texto desatualizado (#10835, warning-only)",
    source_issue: "#10835",
    stage: 4,
    run: checkSocialInviteDrift,
  },
  {
    id: "box-divulgacao-expiry",
    description: "caixa de boxes_divulgacao (slot 0/1/2) com expires: vencido, perto de vencer (≤3 dias) ou malformado, pela data da edição; e caixa vencida PRESENTE no box do slot 1/2 do 02-reviewed.md (#10174, #10214, warning-only)",
    source_issue: "#10174",
    stage: 4,
    run: (editionDir: string) => checkBoxDivulgacaoExpiry(editionDir),
  },
  {
    id: "card-4x5-upload-missing",
    description: "card 4:5 existe no disco mas 06-public-images.json não tem a entry d{N}_4x5 (#4090, warning-only)",
    source_issue: "#4090",
    stage: 4,
    run: checkCard4x5UploadMismatch,
  },
  {
    id: "carousel-cards-missing",
    description: "ausência TOTAL dos slides do carrossel diário (0 dos N×4) pra edição com texto de destaque — gen-carousel-cards.ts provavelmente nunca rodou (#6740)",
    source_issue: "#6740",
    stage: 4,
    run: checkCarouselCardsMissing,
  },
  {
    id: "carousel-cards-stale",
    description: "slides do carrossel diário rasterizados com texto anterior à edição do 03-social.md (#6064; warning com arte mantida pelo editor em carousel-keep-art.json, #11210)",
    source_issue: "#6064",
    stage: 4,
    run: checkCarouselCardsStale,
  },
  {
    id: "carousel-upload-incomplete",
    description: "slides do carrossel existem no disco mas 06-public-images.json não tem todas as 5 chaves (#6064, warning-only)",
    source_issue: "#6064",
    stage: 4,
    run: checkCarouselUploadIncomplete,
  },
  {
    id: "carousel-upload-stale",
    description: "arte do carrossel no KV está atrás do arquivo local (md5 divergente) — post sairia com a arte velha (#6068)",
    source_issue: "#6068",
    stage: 4,
    run: checkCarouselUploadStale,
  },
  {
    id: "carousel-text-overflow",
    description: "parágrafo do social não cabe no card do carrossel em tamanho fixo — precisa ser reescrito (#6078; warning com arte mantida pelo editor em carousel-keep-art.json, #11210); `## d{N}-cards` sem exatamente 3 parágrafos também (#14019)",
    source_issue: "#6078",
    stage: 4,
    run: (editionDir) => checkCarouselTextOverflow(editionDir),
  },
  {
    id: "curto-x-weight",
    description: "post do # Curto passa de 280 no peso do X (URL = 23) — o Stage 5 pularia o post no X (#11124, mesmo cálculo do lint #10180)",
    source_issue: "#11124",
    stage: 4,
    run: checkCurtoXWeightInvariant,
  },
  {
    id: "use-melhor-social-source",
    description: "Link do ## um corresponde à fonte selecionada (#13927)",
    source_issue: "#13927",
    stage: 4,
    run: checkUseMelhorSocialSource,
  },
  {
    id: "use-melhor-post-item-rendered",
    description: "item do 4º post (USE MELHOR) gravado em _internal/use-melhor-post.json saiu do USE MELHOR final — bloqueia o gate até realinhar seleção e ## um (#12898)",
    source_issue: "#9592",
    stage: 4,
    run: (editionDir) => checkUseMelhorPostItemRendered(editionDir),
  },
  {
    id: "use-melhor-carousel-stale",
    description: "carrossel do 4º post (USE MELHOR) defasado em relação ao '## um' no gate — a regeração do pré-render falhou (ex.: Georgia ausente) e o Stage 5 pularia o 4º post (#10879, warning-only)",
    source_issue: "#10879",
    stage: 4,
    run: (editionDir) => checkUseMelhorCarouselStaleAtGate(editionDir),
  },
  {
    id: "use-melhor-image-key-without-file",
    description: "06-public-images.json com chave um_carousel_* de slide que não existe mais no disco — sobra de carrossel do 4º post com mais slides (#9795, warning-only)",
    source_issue: "#9795",
    stage: 4,
    run: checkUseMelhorPublicImageKeysHaveFiles,
  },
  {
    id: "instagram-comment-delivery-promise",
    description: "override de teste do Instagram (_internal/instagram-test.json) promete entregar link/edição/material a quem comentar — o repo não responde comentários (#8681, warning-only desde #8848: heurística de regex, editor decide)",
    source_issue: "#8681",
    stage: 4,
    run: checkInstagramCommentDeliveryPromise,
  },
  {
    id: "box-divulgacao-runtime-excluded",
    description: "slot de boxes_divulgacao aponta pra snippet runtime:false — injetaria conteúdo de doc/referência verbatim (#4504)",
    source_issue: "#4504",
    stage: 4,
    run: checkBoxDivulgacaoRuntimeExcluded,
  },
  {
    id: "box-divulgacao-raw-html",
    description: "box de divulgação (slot 0-3) do 02-reviewed.md com tag HTML crua (<p>, <a …) — o render escapa e o leitor vê as tags como texto (#12202)",
    source_issue: "#12202",
    stage: 4,
    run: checkBoxDivulgacaoRawHtml,
  },
  {
    id: "reviewed-unknown-template-marker",
    description: "02-reviewed.md com {{...}} que não é merge tag conhecida do ESP (ex.: {{OPENING}} do snippet de encerramento) — o leitor veria o marcador cru (#13252)",
    source_issue: "#13252",
    stage: 4,
    run: checkReviewedUnknownTemplateMarkers,
  },
  {
    id: "reviewed-duplicate-closing-block",
    description: "02-reviewed.md com o parágrafo \"Nesta edição da diar.ia.br, usei...\" mais de uma vez — bloco Para encerrar duplicado (#13252)",
    source_issue: "#13252",
    stage: 4,
    run: checkReviewedDuplicateClosingBlock,
  },
  {
    id: "render-warnings-consumed",
    description: "eventos estruturados de render-newsletter-html.ts (divulgacao_box_dropped_no_gap / whatsapp_share_no_d1 / whatsapp_share_d1_mismatch / convite_amigo_snippet_missing) surfaced no gate (#4673, warning-only)",
    source_issue: "#4673",
    stage: 4,
    run: checkRenderWarnings,
  },
  {
    id: "newsletter-html-size",
    description: `_internal/newsletter-final.html acima de ${NEWSLETTER_HTML_SIZE_WARN_BYTES} bytes — sinal de crescimento perto do limite de clipping do Gmail (#5232, warning-only)`,
    source_issue: "#5232",
    stage: 4,
    run: checkNewsletterHtmlSize,
  },
  {
    id: "kit-html-too-large",
    description: `_internal/newsletter-final-kit.html acima de ${KIT_HTML_SIZE_ERROR_BYTES} bytes (102 KB) — limite de clipping do Gmail, pixel de abertura do Kit ficaria abaixo do corte (#6506)`,
    source_issue: "#6506",
    stage: 4,
    run: checkKitHtmlSize,
  },
  {
    id: "kit-fixture-audit",
    description: "assinante de fixture de teste (ex: ana@example.com) ATIVO na base Kit de produção (#6336)",
    source_issue: "#6336",
    stage: 4,
    run: checkKitFixtureAudit,
  },
  {
    id: "sponsored-source-marker",
    description: "página-fonte de item com marcador de publieditorial (/publicidade/, conteúdo de marca, patrocinado, Pré-MBA) — warning-only, decisão fica no gate (#10169)",
    source_issue: "#10169",
    stage: 4,
    run: checkSponsoredSourceMarkers,
  },
  {
    id: "use-melhor-um-isca",
    description: "4º post (## um, USE MELHOR) fora do padrão de isca — diz quantos itens faltam, promete a lista inteira, chamada sem data ou fora do fim do 3º parágrafo, ou item com marcador de publieditorial sem confirmação no gate — warning-only (#11667)",
    source_issue: "#11667",
    stage: 4,
    run: checkUseMelhorIsca,
  },
  {
    id: "approved-item-removed",
    description: "item removido de 01-approved.json no Stage 4 (comparado ao snapshot pós-Stage 1) em vez de só desreferenciado — corrompe o sinal de analyze-bucket-overrides.ts (#8121, warning-only)",
    source_issue: "#8121",
    stage: 4,
    run: checkApprovedItemRemoval,
  },
  {
    id: "clarice-pending",
    description: "revisão da Clarice pendente: o Stage 2 gravou 02-reviewed.md sem a Clarice (API indisponível) e o marcador _internal/02-clarice-pending.json continua (#12257, warning-only)",
    source_issue: "#12257",
    stage: 4,
    run: checkClaricePending,
  },
  {
    id: "clarice-pending-footer-credit",
    description: "rodapé PARA ENCERRAR afirma a revisão da Clarice com o marcador _internal/02-clarice-pending.json ativo; o render omite a oração (#13711, warning-only)",
    source_issue: "#13711",
    stage: 4,
    run: checkClaricePendingFooterCredit,
  },
  // #1694 finding 8: publication env-var checks movidas pra STAGE_5_RULES.
  // Facebook/LinkedIn tokens só são necessários no Stage 5 (Publicação) — não devem
  // bloquear a Revisão (Stage 4) quando tokens expirados ou não configurados.
];

// #2154: checkFbPageIdSet, checkFbTokenSet, checkLinkedinWorkerUrlSet,
// checkCloudflareTokenSet foram movidas para stage-5.ts — pertencem
// logicamente ao Stage 5 (Publicação).
// #2154 pass-2: checkConsentBinding removida deste arquivo — definição canônica
// está em stage-5.ts (onde os dados que ela verifica, 05-published.json e
// 06-social-published.json, são de fato escritos). A cópia aqui era órfã:
// não estava em STAGE_4_RULES, e o teste importava desta cópia em vez da viva.
export {
  checkPublicImagesPopulated,
  checkSocialHashFresh,
  checkImageContentFresh,
  checkEiaCreditSynced,
  checkIntroCountConsistent,
  checkTituloSubtituloNotProvisional,
  checkNarrativeNotGenericPlaceholder,
  checkIntentionalErrorPresentInFinal,
  checkTruncatedSecondaryItemSummary,
  checkTitlePublisherSuffixInvariant,
  checkTitleTrailingPeriodInvariant,
  checkNoTrailingEllipsisInvariant,
  checkTitleMentionsIaInvariant,
  checkTitleIaAsAgentInvariant,
  checkCaptureFailedSubmissionCount,
  checkNoDuplicateUrlsAgainstPastEditions,
  checkEditorDestaqueRequests,
  checkCropReviewWarnings,
  checkStarryNightDetected,
  checkBoxDivulgacaoAltMissing,
  checkCard4x5UploadMismatch,
  checkCarouselCardsMissing,
  checkCarouselCardsStale,
  checkCarouselUploadIncomplete,
  checkCarouselUploadStale,
  checkCarouselTextOverflow,
  checkCurtoXWeightInvariant,
  checkUseMelhorPostItemRendered,
  checkUseMelhorPublicImageKeysHaveFiles,
  checkUseMelhorCarouselStaleAtGate,
  checkInstagramCommentDeliveryPromise,
  checkBoxDivulgacaoRuntimeExcluded,
  checkRenderWarnings,
  checkKitFixtureAudit,
  checkUseMelhorTempoTitleHeuristicShare,
  checkApprovedItemRemoval,
  checkClaricePending,
  checkClaricePendingFooterCredit,
};
