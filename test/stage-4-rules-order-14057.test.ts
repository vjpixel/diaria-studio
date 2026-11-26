/**
 * #14057: `scripts/lib/invariant-checks/stage-4.ts` virou índice e as funções
 * foram para `scripts/lib/invariant-checks/stage-4/`, um arquivo por família.
 * Este teste trava o que a divisão não pode mudar: a ORDEM do registro
 * `STAGE_4_RULES` (id + source_issue, regra a regra, capturada antes da
 * divisão) e o conjunto de nomes que o índice exporta (os ~110 importadores
 * seguem importando de `stage-4.ts`). Regra nova entra aqui na posição em que
 * foi registrada; regra removida sai daqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as stage4 from "../scripts/lib/invariant-checks/stage-4.ts";

const EXPECTED_RULES: Array<[id: string, sourceIssue: string]> = [
  ["edition-sync-conflicts", "#13545"],
  ["newsletter-html-not-behind-reviewed", "#10245"],
  ["public-images-populated", "#999"],
  ["public-images-md5-matches-local", "#11252"],
  ["social-hash-fresh", "#1413"],
  ["social-not-behind-reviewed", "#9820"],
  ["social-humanizer-seal-fresh", "#9820"],
  ["social-clarice-pending", "#13848"],
  ["image-content-fresh", "#1730"],
  ["eia-credit-synced", "#3825"],
  ["intro-count-consistent", "#1578"],
  ["max-content-items", "#9785"],
  ["titulo-subtitulo-not-provisional", "#9601"],
  ["reviewed-no-pending-placeholder", "#12259"],
  ["reviewed-onedrive-conflict-copy", "#12259"],
  ["source-not-read", "#12258"],
  ["use-melhor-sentinel", "#2464"],
  ["use-melhor-tempo", "#2372"],
  ["use-melhor-tempo-title-heuristic-share", "#7668"],
  ["use-melhor-tempo-item-sem-medicao", "#10765"],
  ["narrative-not-generic-placeholder", "#2377"],
  ["intentional-error-present-in-final", "#7243"],
  ["intentional-error-not-recent-repeat-final", "#9101"],
  ["truncated-secondary-item-summary", "#2596"],
  ["title-publisher-suffix", "#2664"],
  ["title-trailing-period", "#2672"],
  ["no-trailing-ellipsis", "#2881"],
  ["title-mentions-ia", "#4825"],
  ["title-ia-as-agent", "#12106"],
  ["title-shorts-front-load", "#12464"],
  ["newsletter-intake", "#12188"],
  ["capture-failed-submission-count", "#2878"],
  ["top3-merit-warning", "#10792"],
  ["has-negative-impact-highlight", "#3916"],
  ["fact-recurrence", "#11083"],
  ["intra-edition-fact-recurrence", "#11173"],
  ["lancamento-sem-fabricante", "#12595"],
  ["story-twice-in-edition", "#11496"],
  ["theme-cross-source-repeat", "#11496"],
  ["secondary-theme-possible-repeat", "#13143"],
  ["study-source-recurrence", "#11763"],
  ["story-continuation", "#11897"],
  ["stale-highlight-repeat", "#13313"],
  ["highlight-date-unverified", "#13313"],
  ["highlight-source-stale-date", "#13313"],
  ["no-duplicate-urls-vs-past-editions", "#8993"],
  ["dedup-recurrence", "#13923"],
  ["destaque-repeated-past-edition", "#13883"],
  ["editor-destaque-request", "#12193"],
  ["image-crop-warn", "#3951"],
  ["image-starry-night-detected", "#10312"],
  ["box-divulgacao-alt-missing", "#4086"],
  ["box-selection-config-drift", "#9253"],
  ["social-invite-drift", "#10835"],
  ["box-divulgacao-expiry", "#10174"],
  ["card-4x5-upload-missing", "#4090"],
  ["carousel-cards-missing", "#6740"],
  ["carousel-cards-stale", "#6064"],
  ["carousel-upload-incomplete", "#6064"],
  ["carousel-upload-stale", "#6068"],
  ["carousel-text-overflow", "#6078"],
  ["curto-x-weight", "#11124"],
  ["use-melhor-social-source", "#13927"],
  ["use-melhor-post-item-rendered", "#9592"],
  ["use-melhor-carousel-stale", "#10879"],
  ["use-melhor-image-key-without-file", "#9795"],
  ["instagram-comment-delivery-promise", "#8681"],
  ["box-divulgacao-runtime-excluded", "#4504"],
  ["box-divulgacao-raw-html", "#12202"],
  ["reviewed-unknown-template-marker", "#13252"],
  ["reviewed-duplicate-closing-block", "#13252"],
  ["render-warnings-consumed", "#4673"],
  ["newsletter-html-size", "#5232"],
  ["kit-html-too-large", "#6506"],
  ["kit-fixture-audit", "#6336"],
  ["sponsored-source-marker", "#10169"],
  ["use-melhor-um-isca", "#11667"],
  ["approved-item-removed", "#8121"],
  ["clarice-pending", "#12257"],
  ["clarice-pending-footer-credit", "#13711"],
];

const EXPECTED_RUNTIME_EXPORTS = [
  "BOX_EXPIRY_INVARIANT_WARN_DAYS", "CROP_REVIEW_IMAGE_VARIANTS", "EDITION_REQUIRED_FILES",
  "KIT_HTML_SIZE_ERROR_BYTES", "NEWSLETTER_HTML_SIZE_WARN_BYTES", "STAGE_4_RULES",
  "STORY_TWICE_PAST_WINDOW", "THEME_CROSS_SOURCE_CUT_MIN_JACCARD", "checkApprovedItemRemoval",
  "checkBoxDivulgacaoAltMissing", "checkBoxDivulgacaoExpiry", "checkBoxDivulgacaoRawHtml",
  "checkBoxDivulgacaoRuntimeExcluded", "checkBoxSelectionConfigDrift",
  "checkCaptureFailedSubmissionCount", "checkCard4x5UploadMismatch", "checkCarouselCardsMissing",
  "checkCarouselCardsStale", "checkCarouselTextOverflow", "checkCarouselUploadIncomplete",
  "checkCarouselUploadStale", "checkClaricePending", "checkClaricePendingFooterCredit",
  "checkCropReviewWarnings", "checkCurtoXWeightInvariant", "checkDedupRecurrence",
  "checkDestaqueRepeatedPastEdition", "checkEditionSyncConflicts", "checkEditorDestaqueRequests",
  "checkEiaCreditSynced", "checkFactRecurrence", "checkHighlightDateUnverified",
  "checkHighlightSourceStaleDate", "checkImageContentFresh",
  "checkInstagramCommentDeliveryPromise", "checkIntentionalErrorPresentInFinal",
  "checkIntraEditionFactRecurrence", "checkIntroCountConsistent", "checkKitFixtureAudit",
  "checkKitHtmlSize", "checkLancamentoSemFabricante", "checkMaxContentItems",
  "checkNarrativeNotGenericPlaceholder", "checkNewsletterHtmlNotBehindReviewed",
  "checkNewsletterHtmlSize", "checkNewsletterIntake", "checkNoDuplicateUrlsAgainstPastEditions",
  "checkNoTrailingEllipsisInvariant", "checkPublicImagesPopulated", "checkRenderWarnings",
  "checkReviewedDuplicateClosingBlock", "checkReviewedUnknownTemplateMarkers",
  "checkSecondaryThemePossibleRepeat", "checkSocialClaricePending", "checkSocialHashFresh",
  "checkSocialHumanizerSealFresh", "checkSocialInviteDrift", "checkSocialNotBehindReviewed",
  "checkSponsoredSourceMarkers", "checkStaleHighlightRepeat", "checkStarryNightDetected",
  "checkStoryContinuation", "checkStoryTwiceInEdition", "checkStudySourceRecurrence",
  "checkThemeCrossSourceRepeat", "checkTitleIaAsAgentInvariant", "checkTitleMentionsIaInvariant",
  "checkTitlePublisherSuffixInvariant", "checkTitleShortsFrontLoadInvariant",
  "checkTitleTrailingPeriodInvariant", "checkTituloSubtituloNotProvisional",
  "checkTruncatedSecondaryItemSummary", "checkUseMelhorCarouselStaleAtGate", "checkUseMelhorIsca",
  "checkUseMelhorPostItemRendered", "checkUseMelhorPublicImageKeysHaveFiles",
  "checkUseMelhorSocialSource", "checkUseMelhorTempoItemSemMedicao",
  "checkUseMelhorTempoTitleHeuristicShare", "cropReviewImageSuffix",
  "findDuplicateUrlsAgainstPastEditions", "findImageContentMismatches",
  "formatRepeatedDestaqueMessage", "isCropReviewEntryStale", "isCropReviewImageVariant",
  "isSilencedCropWarn", "readExpiredSlotOutcome", "readIntraEditionItems", "readPastStoryItems",
  "replantCommand",
];

const FAMILY_DIR = join(import.meta.dirname, "..", "scripts", "lib", "invariant-checks", "stage-4");

describe("stage-4 dividido por família (#14057)", () => {
  it("STAGE_4_RULES mantém ids, source_issue e ordem de antes da divisão", () => {
    const actual = stage4.STAGE_4_RULES.map((r) => [r.id, r.source_issue]);
    assert.deepEqual(actual, EXPECTED_RULES);
  });

  it("toda regra de STAGE_4_RULES é stage 4 e tem run", () => {
    for (const r of stage4.STAGE_4_RULES) {
      assert.equal(r.stage, 4, r.id);
      assert.equal(typeof r.run, "function", r.id);
    }
  });

  it("o índice exporta exatamente os mesmos nomes de runtime de antes", () => {
    assert.deepEqual(Object.keys(stage4).sort(), [...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  it("nenhum arquivo de família importa o índice (sem ciclo índice <-> família)", () => {
    for (const f of readdirSync(FAMILY_DIR).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(FAMILY_DIR, f), "utf8");
      assert.doesNotMatch(src, /from\s+["']\.\.\/stage-4\.ts["']/, f);
    }
  });
});
