/**
 * Invariantes do Stage 4 — social (hash, atraso em relação ao reviewed, humanizador, Clarice, X, Instagram, convite) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { detectSocialInviteDrift } from "../../shared/encerramento-snippet.ts"; // #10835
import type { InvariantViolation } from "../types.ts";
import { hashFromApprovedFile } from "../../social-source-hash.ts";
import { checkCurtoXWeight } from "../../lint-checks/curto-x-weight.ts"; // #11124
import {
  readInstagramTestOverride,
  instagramTestOverridePath,
  type InstagramTestOverride,
} from "../../instagram-test-override.ts"; // #8681
import {
  detectCommentDeliveryPromise,
  commentDeliveryPromiseMessage,
} from "../../comment-delivery-promise.ts"; // #8681
import { evaluateStaleness, findSocialContentMismatches } from "../../../check-staleness.ts"; // #9820
import { checkSentinel as checkSocialHumanizerSentinel } from "../../../check-humanizer-social.ts"; // #9820
import { claricePendingFor, describeProvenance, readRunRecord } from "../../humanizer-run-record.ts"; // #13848
import { computeSectionHashes as computeSocialSectionHashes } from "../../social-lint-rules.ts"; // #13848

/**
 * #1413 (second attempt — hash marker em vez de URL match revert em #1431):
 * compara o hash dos highlights atuais (01-approved.json) contra o hash
 * cached em `_internal/.social-source-hash.json` (escrito por
 * merge-social-md.ts quando social.md foi gerado).
 *
 * Mismatch = highlights mudaram após social.md ser gerado — social ficou
 * stale e precisa re-dispatch do agent `social-writer` (#3991, reverte
 * #3486 — colapsou social-linkedin/social-facebook/social-instagram num
 * único agent) + re-run de merge-social-md.ts. Caso 260520: D1 trocou de
 * Karpathy pra Google I/O pós-Stage 2; social manteve hook Karpathy →
 * contradição cross-channel.
 *
 * Hash ausente = social.md gerado antes desse fix existir, ou merge-social-md
 * não rodou. Warning, não error — pipeline continua mas editor deve verificar.
 */
export function checkSocialHashFresh(editionDir: string): InvariantViolation[] {
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const socialPath = resolve(editionDir, "03-social.md");
  const hashPath = resolve(editionDir, "_internal", ".social-source-hash.json");

  if (!existsSync(approvedPath) || !existsSync(socialPath)) return [];

  if (!existsSync(hashPath)) {
    return [
      {
        rule: "social-hash-fresh",
        message:
          `_internal/.social-source-hash.json ausente — social.md gerado antes do #1413 ` +
          `OU merge-social-md.ts não rodou. Stale detection desabilitada pra essa edição.`,
        source_issue: "#1413",
        severity: "warning",
        file: hashPath,
      },
    ];
  }

  let cachedHash: string;
  try {
    const data = JSON.parse(readFileSync(hashPath, "utf8")) as { hash?: string };
    if (typeof data.hash !== "string") {
      return [
        {
          rule: "social-hash-fresh-parseable",
          message: `social-source-hash sem campo hash string`,
          source_issue: "#1413",
          severity: "error",
          file: hashPath,
        },
      ];
    }
    cachedHash = data.hash;
  } catch (e) {
    return [
      {
        rule: "social-hash-fresh-parseable",
        message: `social-source-hash não parseável: ${(e as Error).message}`,
        source_issue: "#1413",
        severity: "error",
        file: hashPath,
      },
    ];
  }

  let currentHash: string;
  try {
    currentHash = hashFromApprovedFile(approvedPath);
  } catch (e) {
    return [
      {
        rule: "social-hash-fresh",
        message: `falha calculando hash atual: ${(e as Error).message}`,
        source_issue: "#1413",
        severity: "error",
        file: approvedPath,
      },
    ];
  }

  if (cachedHash !== currentHash) {
    return [
      {
        rule: "social-hash-fresh",
        message:
          `Highlights mudaram após social.md ser gerado (hash: ${cachedHash} → ${currentHash}). ` +
          `Editor reestruturou destaques pós-Stage 2. Re-dispatch o agent ` +
          `social-writer (#3991) + re-run merge-social-md.ts E re-push pro Drive ` +
          `(drive-sync --mode push --files 03-social.md) antes de publicar — senão o Drive fica stale (#1828). ` +
          `Se o 03-social.md JÁ foi corrigido, basta recarimbar: ` +
          `npx tsx scripts/refresh-social-hash.ts --edition-dir <dir> (#8596).`,
        source_issue: "#1413",
        severity: "error",
        file: socialPath,
      },
    ];
  }

  return [];
}

/**
 * #9820 — `03-social.md` atrás de `02-reviewed.md`. Edição 261007: o D3 foi
 * reescrito no gate do Stage 4 (lead/ângulo novo, mesmo título — §4d.1 passo 3
 * dizia "corpo sem mudar título não cascateia"), o `03-social.md` e o `# Curto`
 * ficaram com o ângulo antigo e o `.step-4-done` foi gravado 1 min depois. Só o
 * `check-staleness.ts --stage 6` do Stage 5 pegou. Este invariante roda dentro
 * do Stage 4 a comparação de conteúdo `findSocialContentMismatches` (#4832/#9114)
 * — e por estar em `STAGE_4_RULES` com severity `error`, `pipeline-sentinel.ts
 * write --step 4` (#6009) recusa o sentinel enquanto ele não passar. Desde o
 * #9829 a comparação de conteúdo decide SOZINHA quando roda: qualquer `## dN`
 * divergente é `error` mesmo com o social mais novo que o reviewed (cascata de
 * outro destaque, reorder, autofix e save do Studio regravam o arquivo
 * inteiro). Edição cosmética fora dos destaques (box, intro) não acusa: o
 * conteúdo dos `## dN` ainda bate. Quando a comparação não consegue rodar
 * (`findSocialContentMismatches` → `undefined`), só sobra o mtime e a violação
 * sai como `warning` — não bloqueia.
 *
 * `mtimes` (opcional): override pra teste — evita depender de `utimes` no fs.
 */
export function checkSocialNotBehindReviewed(
  editionDir: string,
  mtimes?: (relPath: string) => number | null,
): InvariantViolation[] {
  const getMtime =
    mtimes ??
    ((relPath: string): number | null => {
      const full = resolve(editionDir, relPath);
      return existsSync(full) ? statSync(full).mtimeMs : null;
    });
  const mismatches = findSocialContentMismatches(editionDir);
  const fix =
    ` — o post social sairia com o ângulo antigo. Rodar a cascata §4d.1a com --pieces social,carousel ` +
    `pra cada destaque afetado (social-writer + social-curto pro # Curto, re-humanizar scoped, ` +
    `gen-carousel-cards.ts + upload-images-public.ts) antes do sentinel. Falso-positivo conhecido ` +
    `(social já correto): pipeline-sentinel.ts write --bypass-reason "<motivo>".`;

  // #9829: a comparação de conteúdo é o sinal autoritativo — quando ela RODA,
  // decide sozinha, independente do mtime. Antes o mismatch só era consultado
  // se o mtime já dissesse que o social estava atrás: uma cascata de OUTRO
  // destaque (troca de título do D1 → regera só `## d1`, mas regrava o
  // 03-social.md inteiro), `reorder-destaques.ts`, o autofix do fact-check no
  // social ou um save do Studio deixavam o social mais novo que o reviewed e o
  // `## d3` reescrito no gate passava calado. Medido nas 25 edições de
  // 2609/2610: zero falso positivo da comparação de conteúdo.
  if (mismatches !== undefined) {
    if (mismatches.length === 0) return [];
    return [
      {
        rule: "social-not-behind-reviewed",
        message:
          `o texto social de ${mismatches.join(", ")} em 03-social.md não bate mais com o destaque ` +
          `correspondente de 02-reviewed.md (reescrito depois do social)` +
          fix,
        source_issue: "#9820",
        severity: "error",
        file: resolve(editionDir, "03-social.md"),
      },
    ];
  }

  // Fallback: comparação de conteúdo não rodou (sem `# Social`, layout legado,
  // parse sem destaques) — só sobra o mtime. Warning: o mtime de
  // 02-reviewed.md costuma avançar sozinho (fact-check autofix,
  // sync-intro-count, save do Studio) e o write --step 4 viraria
  // falso-positivo só contornável com --bypass-reason.
  const stale = evaluateStaleness(
    [{ downstream: "03-social.md", upstreams: ["02-reviewed.md"] }],
    getMtime,
    1000,
  );
  if (stale.length === 0) return [];
  const s = stale[0];
  return [
    {
      rule: "social-not-behind-reviewed",
      message:
        `03-social.md (${s.downstream_mtime}) é anterior a 02-reviewed.md (${s.upstream_mtime}, +${s.lag_minutes} min)` +
        ` e não deu pra comparar o conteúdo dos destaques (só mtime)` +
        fix,
      source_issue: "#9820",
      severity: "warning",
      file: resolve(editionDir, "03-social.md"),
    },
  ];
}

/**
 * #9820 — selo do humanizador (`_internal/.humanizer-social-done.json`) atrás
 * do `03-social.md` atual. No Stage 2 isso já é invariante (`social-humanizer-
 * sentinel-written`, #6305); no Stage 4 era só o `check-humanizer-social.ts
 * --check` em prosa (§4c.2b, §4d.1 passo 6.8) — uma cascata do social que
 * reescreve o `## dN` sem re-humanizar passava pelo sentinel. Selo ausente vira
 * warning (edição anterior ao #6305, nada a comparar); hash divergente é error.
 */
export function checkSocialHumanizerSealFresh(editionDir: string): InvariantViolation[] {
  if (!existsSync(resolve(editionDir, "03-social.md"))) return [];
  const result = checkSocialHumanizerSentinel(editionDir);
  if (result.ok) return [];
  const missing = result.reason === "sentinel_missing";
  return [
    {
      rule: "social-humanizer-seal-fresh",
      message: missing
        ? `_internal/.humanizer-social-done.json ausente — não dá pra afirmar que o 03-social.md atual passou pelo humanizador.`
        : `03-social.md mudou depois do selo do humanizador (stored=${result.stored.slice(0, 12)}… ` +
          `current=${result.current.slice(0, 12)}…) — re-humanizar e passar a Clarice nas seções alteradas (§4d.1 passo 6), ` +
          `registrar cada passo com --record-run (#11534) e gravar: ` +
          `npx tsx scripts/check-humanizer-social.ts --write --bypass-reason "<ajuste>" --edition-dir ${editionDir}/`,
      source_issue: "#9820",
      severity: missing ? "warning" : "error",
      file: resolve(editionDir, "03-social.md"),
    },
  ];
}

/**
 * #13848 — seção do social selada com a Clarice PENDENTE (`check-humanizer-social.ts
 * --record-clarice-pending`): humanizada, mas a Clarice não rodou porque a API
 * estava fora do ar. Warning, uma linha por seção, para o resumo do gate trazer a
 * pendência junto da `clarice-pending` da newsletter. Some quando a Clarice roda
 * na seção e o passo é registrado com `--record-run --step clarice`.
 */
export function checkSocialClaricePending(editionDir: string): InvariantViolation[] {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return [];
  const socialMd = readFileSync(socialPath, "utf8");
  const record = readRunRecord(editionDir);
  const hashes = computeSocialSectionHashes(socialMd);
  return describeProvenance(socialMd, record)
    .filter((row) => row.clarice_pending)
    .map((row) => {
      const entry = claricePendingFor(hashes[row.section], record);
      const why = entry ? `${entry.reason}${entry.detail ? `: ${entry.detail}` : ""}` : "motivo não registrado";
      return {
        rule: "social-clarice-pending",
        message:
          `⚠️ ${row.section}: Clarice não rodou no social (${why}); humanizador ok. ` +
          "O editor decide entre aprovar sem a Clarice ou esperar a API; com a Clarice de volta, rodá-la na seção e " +
          `registrar com npx tsx scripts/check-humanizer-social.ts --record-run --step clarice --edition-dir ${editionDir}/`,
        source_issue: "#13848",
        severity: "warning" as const,
        file: socialPath,
      };
    });
}

/**
 * (#11124) Cada post do `# Curto` de `03-social.md` cabe nos 280 do X, pelo
 * MESMO peso do Stage 5 (`checkCurtoXWeight` → `computeTwitterWeightedLength`,
 * URL e `{edition_url}` = 23). O lint `curto-x-weight` (#10180) já roda em
 * §4c.2b, ANTES do gate; uma reescrita feita DENTRO do gate (loop `ajustar`,
 * edição puxada do doc, fast-path do painel do Studio) ficava fora dele. Caso
 * real 261026: o D1 foi reescrito no gate, o `# Curto` do X ficou com 287 e só
 * o `prep-twitter-posts.ts` do Stage 5 acusou, com o gate já aprovado. Como
 * invariante, roda no `check-invariants --stage 4` e no
 * `pipeline-sentinel.ts write --step 4`, que recusa o sentinel com o post
 * estourado, qualquer que tenha sido o caminho da edição.
 */
export function checkCurtoXWeightInvariant(editionDir: string): InvariantViolation[] {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return [];
  const report = checkCurtoXWeight(readFileSync(socialPath, "utf8"));
  return report.errors.map((e) => ({
    rule: "curto-x-weight",
    message:
      `${e.message} Encurtar só esse post em 03-social.md (edição cirúrgica, #495) e regravar o ` +
      `selo do humanizador (check-humanizer-social.ts --write) antes de aprovar.`,
    source_issue: "#11124",
    severity: "error",
    file: socialPath,
  }));
}

/**
 * (#8681) Guard contra a "promessa" — decisão do editor: o repo não tem
 * nenhum mecanismo que responda a comentários do Instagram, então um
 * override de teste (`_internal/instagram-test.json`) que promete entregar
 * link/edição/material a quem comentar fica sem cumprimento. Checa
 * `caption` e `cta_slide.title`/`cta_slide.kicker` do override — nunca o
 * texto normal do `03-social.md` (ele não passa por este mecanismo de
 * override, e a legenda de produção não tem histórico desse padrão).
 *
 * Severity: "warning" (rebaixado de "error" no #8848, decisão do editor
 * 260926) — `detectCommentDeliveryPromise` é heurística de regex com falsos
 * positivos e negativos conhecidos (ver #8848), então o gate SURFACES o
 * achado no resumo do Stage 4 mas quem decide se a legenda de fato promete
 * entrega por comentário é o editor, não o regex. `publish-instagram.ts`
 * também não bloqueia mais nesse caso (só loga aviso) — ver
 * `scripts/publish-instagram.ts`.
 *
 * Blind spot conhecido (code-review do #8681): se `03-social.md` estiver
 * ausente/malformado NA MESMA edição em que `instagram-test.json` também
 * está malformado, nem este check nem `carousel-text-overflow` reportam o
 * JSON quebrado no Stage 4 (os dois saem cedo por causa do
 * `03-social.md`) — mas `publish-instagram.ts` ainda lança na hora de
 * publicar, então não é risco de publicação silenciosa, só um buraco no
 * gate nesse cenário combinado.
 */
export function checkInstagramCommentDeliveryPromise(editionDir: string): InvariantViolation[] {
  const path = instagramTestOverridePath(editionDir);
  if (!existsSync(path)) return [];

  let override: InstagramTestOverride | null;
  try {
    override = readInstagramTestOverride(editionDir);
  } catch {
    return []; // JSON malformado já é reportado por carousel-text-overflow
  }
  if (!override) return [];

  const violations: InvariantViolation[] = [];
  const candidates: Array<{ label: string; text: string | undefined }> = [
    { label: "caption", text: override.caption },
    { label: "cta_slide.title", text: override.cta_slide?.title },
    { label: "cta_slide.kicker", text: override.cta_slide?.kicker },
  ];

  for (const { label, text } of candidates) {
    const result = detectCommentDeliveryPromise(text);
    if (!result.promise) continue;
    violations.push({
      rule: "instagram-comment-delivery-promise",
      message: commentDeliveryPromiseMessage(`_internal/instagram-test.json (${label})`, result.match) + " (heurística de regex — o editor decide se a legenda promete entrega por comentário, #8848)",
      source_issue: "#8681",
      severity: "warning",
      file: path,
    });
  }
  return violations;
}

/**
 * #10835: convite social ("Para acompanhar… siga a diar.ia.br no…") do
 * `02-reviewed.md` divergente do `SOCIAL_INVITE` atual. Duas situações, ambas
 * warning (o editor decide; a edição sai do mesmo jeito):
 * - `unrecognized`: o parágrafo parece o convite mas o renderer não o
 *   reconhece (`isSocialInviteParagraph`) — sai SEM a borda de box, em
 *   silêncio (caso da 261022 antes do #10781).
 * - `outdated`: ganha a caixa, mas o texto difere da constante atual (ex.:
 *   costurado antes do YouTube entrar, #10761) — o leitor vê a lista velha.
 * Lógica pura em `detectSocialInviteDrift` (`shared/encerramento-snippet.ts`).
 */
export function checkSocialInviteDrift(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const drift = detectSocialInviteDrift(readFileSync(path, "utf8"));
  if (!drift) return [];
  const preview = drift.paragraph.length > 120 ? `${drift.paragraph.slice(0, 120)}…` : drift.paragraph;
  const message = drift.kind === "unrecognized"
    ? `Convite social do PARA ENCERRAR não foi reconhecido pelo renderer e vai sair SEM a borda de box: "${preview}". Restaurar o início "Siga a **diar.ia.br**:" (ou colar o SOCIAL_INVITE atual de scripts/lib/shared/encerramento-snippet.ts).`
    : `Convite social do PARA ENCERRAR difere do SOCIAL_INVITE atual (ex.: lista de redes desatualizada): "${preview}". Sai com a caixa, mas com o texto antigo; colar o SOCIAL_INVITE atual de scripts/lib/shared/encerramento-snippet.ts se a diferença não for intencional.`;
  return [{ rule: "social-invite-drift", message, source_issue: "#10835", severity: "warning", file: path }];
}
