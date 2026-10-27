#!/usr/bin/env npx tsx
/**
 * lint-test-email.ts (#603)
 *
 * Roda lints determinísticos sobre o email de teste renderizado da Beehiiv:
 *   - Check 8: version-consistency intra-destaque (V\d+, GPT-X, etc.)
 *   - Check 9: semantic-drift email vs 02-reviewed.md (números, datas)
 *
 * Cada detecção é cross-referenciada com `data/intentional-errors.jsonl` —
 * matches viram `info` (erro intencional do concurso mensal); sem match viram
 * `blocker`.
 *
 * Substitui as instruções textuais que o agent `review-test-email` (Haiku)
 * recebia. Determinístico = não depende de modelo seguir prompt (#588, #602).
 *
 * Uso:
 *   npx tsx scripts/lint-test-email.ts \
 *     --email-file data/editions/260506/_internal/test-email-260506.txt \
 *     --source-md data/editions/260506/02-reviewed.md \
 *     --edition 260506 \
 *     [--intentional-errors data/intentional-errors.jsonl] \
 *     [--out data/editions/260506/_internal/lint-result-260506.json]
 *
 * Output (JSON em stdout ou no arquivo --out):
 *   {
 *     "issues": [
 *       { "type": "blocker", "category": "version_inconsistency",
 *         "destaque": "DESTAQUE 2", "detail": "...", "source_md_value": "..." },
 *       { "type": "info", "category": "intentional_error_confirmed",
 *         "destaque": "DESTAQUE 2", "detail": "..." }
 *     ]
 *   }
 *
 * Exit codes:
 *   0 — sem blockers (warns/infos OK)
 *   1 — pelo menos 1 blocker (caller pode bloquear publicação)
 *   2 — erro de uso (args inválidos, paths não existem)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  extractVersionMentions,
  detectInconsistencies,
} from "./lib/version-consistency.ts";
import { detectDrift } from "./lib/semantic-drift.ts";
import {
  loadIntentionalErrors,
  isIntentionalError,
  intentionalErrorsForEdition,
  type IntentionalError,
} from "./lib/intentional-errors.ts";
import { decodeKitClickUrl } from "./lib/kit-click-url.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type IssueType = "blocker" | "warning" | "info";
export type IssueCategory =
  | "version_inconsistency"
  | "semantic_drift"
  | "intentional_error_confirmed"
  | "subject_mismatch"
  | "vote_merge_tag_unresolved";

export interface LintIssue {
  type: IssueType;
  category: IssueCategory;
  destaque: string;
  detail: string;
  source_md_value?: string;
}

export interface LintResult {
  issues: LintIssue[];
  summary: {
    blockers: number;
    warnings: number;
    infos: number;
  };
}

/**
 * Prefixos de test email, case-insensitive: `[TEST] ` (Beehiiv) e `[teste] `
 * (Kit, fallback `publish-newsletter-kit.ts --send-test` — #11403, achado na
 * revisão da 261028, onde o prefixo do Kit virava `subject_mismatch` falso).
 */
const TEST_SUBJECT_PREFIX_RE = /^\[(?:TEST|TESTE)\]\s*/i;

/**
 * #1645: normaliza o subject de um email de teste pra comparação. Remove o
 * prefixo de teste — `[TEST] ` que o Beehiiv auto-adiciona (pode até repetir —
 * `[TEST] [TEST] `, ver #1215) ou `[teste] ` do Kit (#11403) — e apara espaços.
 */
export function normalizeSubject(s: string): string {
  let out = s.trim();
  while (TEST_SUBJECT_PREFIX_RE.test(out)) out = out.replace(TEST_SUBJECT_PREFIX_RE, "");
  return out.trim();
}

/**
 * #11403: confirma que a merge tag de identidade do voto do É IA? foi
 * expandida no e-mail ENTREGUE pelo Kit. O Kit embrulha todo link no click
 * tracking (`*.click.kit-mail3.com/.../{destino em base64url}`), então a URL
 * `.../vote/{AAMMDD}/{A|B}?email=...` não aparece em claro — decodificamos o
 * destino (`decodeKitClickUrl`) e checamos os parâmetros.
 *
 * Só olha links embrulhados pelo Kit: na Beehiiv a tag pode sair literal por
 * limitação conhecida do modo de envio genérico (#6011/#6608), coberta pelo
 * `lint-test-email-link-tracking.ts`. Sem nenhum voto embrulhado pelo Kit,
 * retorna null (nada a confirmar — a ausência do É IA? é do lint de estrutura).
 *
 * Blocker quando algum voto traz `{{...}}` literal (cru ou percent-encoded) ou
 * um `email=` vazio/que não parece endereço (K3 do `review-test-email`: tag
 * crua no e-mail entregue é falha real).
 */
export function checkKitVoteMergeTag(emailText: string): LintIssue | null {
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  const problems: string[] = [];
  let votes = 0;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(emailText)) !== null) {
    const raw = m[1].replace(/&amp;/g, "&");
    const dest = decodeKitClickUrl(raw);
    if (!dest) continue;
    let u: URL;
    try {
      u = new URL(dest);
    } catch {
      continue;
    }
    if (!/\/vote\/\d{6}\/[A-Za-z]\b/.test(u.pathname)) continue;
    votes++;
    // searchParams já decodifica `%7B%7B` → `{{`; checar também o destino cru.
    const literalTag = /\{\{|%7B%7B/i.test(dest) || [...u.searchParams.values()].some((v) => v.includes("{{"));
    const email = u.searchParams.get("email");
    if (literalTag) {
      problems.push(`${u.pathname}: merge tag literal (${u.search})`);
    } else if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push(`${u.pathname}: email='${email}' não é um endereço`);
    }
  }
  if (votes === 0 || problems.length === 0) return null;
  return {
    type: "blocker",
    category: "vote_merge_tag_unresolved",
    destaque: "É IA?",
    detail: `Merge tag do voto do É IA? não expandiu no e-mail entregue pelo Kit: ${problems.join("; ")}`,
  };
}

/**
 * #1645: valida o subject do test email recebido contra o título esperado.
 * Pega 3 falhas que o lint de corpo não pegava (260601 / 260505):
 *   - placeholder `New post` (título nunca persistiu na Beehiiv — autosave #1198),
 *   - subject == título da edição anterior (título atual não foi setado),
 *   - divergência genérica do título esperado.
 * Retorna uma LintIssue blocker, ou null se ok. O prefixo `[TEST] ` é ignorado.
 */
export function checkSubject(
  received: string,
  expected: string,
  prevTitle?: string,
): LintIssue | null {
  const r = normalizeSubject(received);
  const norm = (x: string) => x.trim().toLowerCase();

  if (r === "" || norm(r) === "new post") {
    return {
      type: "blocker",
      category: "subject_mismatch",
      destaque: "(subject)",
      detail: `Subject do test email é placeholder '${received}' — título não persistiu na Beehiiv (autosave #1198). Re-setar via teclado real + confirmar via get_post antes do envio.`,
    };
  }
  if (prevTitle && norm(r) === norm(prevTitle)) {
    return {
      type: "blocker",
      category: "subject_mismatch",
      destaque: "(subject)",
      detail: `Subject do test email '${r}' == título da edição anterior — título da edição atual não foi setado.`,
      source_md_value: prevTitle,
    };
  }
  if (expected && norm(r) !== norm(expected)) {
    return {
      type: "blocker",
      category: "subject_mismatch",
      destaque: "(subject)",
      detail: `Subject do test email '${r}' diverge do título esperado '${expected}'.`,
      source_md_value: expected,
    };
  }
  return null;
}

/**
 * Pure: roda os lints sobre email + source e retorna issues classificadas.
 * Cross-referenciada com intentional errors da edição.
 *
 * #1645: `subject` (opcional) ativa a verificação do subject do email recebido
 * contra o título esperado — divergência vira blocker `subject_mismatch`.
 */
export function runLints(
  emailText: string,
  sourceMd: string,
  edition: string,
  intentionalErrors: IntentionalError[],
  subject?: { received: string; expected: string; prevTitle?: string },
): LintResult {
  const issues: LintIssue[] = [];

  // #2016: se editor declarou `intentional_error: none`, não procurar erros no
  // corpo — não há erro intencional pra confirmar, e false-positives não têm
  // safety net. Subject check ainda roda (título correto é independente do erro).
  //
  // #2048 item 6: o bypass exige `source` preenchido (gravado por sync-intentional-error).
  // Entry corrompida sem `source` (ex: criada manualmente sem o script) não ativa o bypass —
  // previne que `{ edition: "X", no_error: true }` injected à mão silencia o lint indefinidamente.
  const editionEntries = intentionalErrorsForEdition(intentionalErrors, edition);
  const editionHasNoError = editionEntries.some((e) => e.no_error === true && !!e.source);

  // Check 0 (#1645): subject do email recebido vs título esperado.
  if (subject) {
    const subjectIssue = checkSubject(
      subject.received,
      subject.expected,
      subject.prevTitle,
    );
    if (subjectIssue) issues.push(subjectIssue);
  }

  // Check 0b (#11403): merge tag do voto do É IA? expandida no e-mail do Kit.
  const voteIssue = checkKitVoteMergeTag(emailText);
  if (voteIssue) issues.push(voteIssue);

  // Check 8: version consistency intra-destaque (no email).
  // Detectamos no email — divergência V4 vs V5 dentro do mesmo destaque é o caso.
  // #2043: Checks 8/9 SEMPRE rodam — não têm relação com o erro intencional.
  // O bypass de `intentional_error: none` (#2016) suprime apenas o critério de
  // confirmação do erro intencional (abaixo), nunca os checks estruturais.
  const emailMentions = extractVersionMentions(emailText);
  const inconsistencies = detectInconsistencies(emailMentions);

  for (const group of inconsistencies) {
    const versions = [...new Set(group.mentions.map((m) => m.version))].sort();
    const detail = `Versões inconsistentes em ${group.destaque}: ${versions.join(" / ")}`;
    // #2043: se editor declarou `intentional_error: none`, não há erro intencional
    // pra confirmar — tratar qualquer inconsistência como blocker real.
    const isIntentional = !editionHasNoError && isIntentionalError(
      { error_type: "version_inconsistency", destaque: group.destaque },
      edition,
      intentionalErrors,
    );
    if (isIntentional) {
      issues.push({
        type: "info",
        category: "intentional_error_confirmed",
        destaque: group.destaque,
        detail: `${detail} — feature do concurso mensal (catalogado em intentional-errors.jsonl)`,
      });
    } else {
      // Source value: extrai versão dominante do source MD pra mesmo destaque
      const sourceMentions = extractVersionMentions(sourceMd).filter(
        (m) => m.destaque === group.destaque,
      );
      const sourceVersions = [...new Set(sourceMentions.map((m) => m.version))];
      issues.push({
        type: "blocker",
        category: "version_inconsistency",
        destaque: group.destaque,
        detail,
        source_md_value: sourceVersions.length > 0 ? sourceVersions.join(" / ") : "(nenhuma menção V\\d+ no source)",
      });
    }
  }

  // Check 9: semantic drift (email vs source).
  // Detecções cross-referenciadas com `numeric` / `factual` intentional errors.
  // #2043: também sempre roda — independente de `intentional_error: none`.
  const drifts = detectDrift(emailText, sourceMd);
  // Agrupa drifts por destaque pra gerar 1 issue por destaque (em vez de 1 por valor).
  const driftsByDestaque = new Map<string, typeof drifts>();
  for (const d of drifts) {
    const arr = driftsByDestaque.get(d.destaque) ?? [];
    arr.push(d);
    driftsByDestaque.set(d.destaque, arr);
  }

  for (const [destaque, group] of driftsByDestaque) {
    const onlyEmail = group.filter((d) => d.side === "email");
    const onlySource = group.filter((d) => d.side === "source");
    if (onlyEmail.length === 0 && onlySource.length === 0) continue;

    const parts: string[] = [];
    if (onlyEmail.length > 0) {
      parts.push(`email-only: ${onlyEmail.map((d) => `${d.kind}=${d.value}`).slice(0, 5).join(", ")}`);
    }
    if (onlySource.length > 0) {
      parts.push(`source-only: ${onlySource.map((d) => `${d.kind}=${d.value}`).slice(0, 5).join(", ")}`);
    }
    const detail = `Drift em ${destaque}: ${parts.join(" / ")}`;

    // Cross-ref: numeric intentional ou factual coberto?
    // #2043: se editor declarou `intentional_error: none`, drift nunca é intencional.
    const isIntentional = !editionHasNoError && (
      isIntentionalError(
        { error_type: "numeric", destaque },
        edition,
        intentionalErrors,
      ) ||
      isIntentionalError(
        { error_type: "factual", destaque },
        edition,
        intentionalErrors,
      )
    );

    if (isIntentional) {
      issues.push({
        type: "info",
        category: "intentional_error_confirmed",
        destaque,
        detail: `${detail} — feature do concurso mensal (catalogado em intentional-errors.jsonl)`,
      });
    } else {
      // Drift é warning, não blocker — números novos podem ser legítimos
      // (editor adicionou contexto). Caller decide se bloqueia.
      issues.push({
        type: "warning",
        category: "semantic_drift",
        destaque,
        detail,
      });
    }
  }

  const summary = {
    blockers: issues.filter((i) => i.type === "blocker").length,
    warnings: issues.filter((i) => i.type === "warning").length,
    infos: issues.filter((i) => i.type === "info").length,
  };

  return { issues, summary };
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const emailFile = values["email-file"];
  const sourceMdPath = values["source-md"];
  const edition = values["edition"];
  const intentionalPath = values["intentional-errors"] ?? "data/intentional-errors.jsonl";
  const outPath = values["out"];
  // #1645: subject check (opcional). O agent passa o subject recebido (header
  // Gmail) + o título esperado (05-published.json > title) + o título da edição
  // anterior pra detectar 'New post' / título stale.
  const subjectReceived = values["subject-received"];
  const subjectExpected = values["subject-expected"];
  const prevTitle = values["prev-title"];

  if (!emailFile || !sourceMdPath || !edition) {
    console.error(
      "Uso: lint-test-email.ts --email-file <path> --source-md <path> --edition <AAMMDD> [--intentional-errors <path>] [--out <path>] [--subject-received <s> --subject-expected <s> [--prev-title <s>]]",
    );
    process.exit(2);
  }

  const emailAbs = resolve(ROOT, emailFile);
  const sourceAbs = resolve(ROOT, sourceMdPath);
  const intentionalAbs = resolve(ROOT, intentionalPath);

  if (!existsSync(emailAbs)) {
    console.error(`ERRO: email-file não existe: ${emailAbs}`);
    process.exit(2);
  }
  if (!existsSync(sourceAbs)) {
    console.error(`ERRO: source-md não existe: ${sourceAbs}`);
    process.exit(2);
  }

  const emailText = readFileSync(emailAbs, "utf8");
  const sourceMd = readFileSync(sourceAbs, "utf8");
  const intentionalErrors = loadIntentionalErrors(intentionalAbs);

  const subject =
    typeof subjectReceived === "string" && typeof subjectExpected === "string"
      ? {
          received: subjectReceived,
          expected: subjectExpected,
          prevTitle: typeof prevTitle === "string" ? prevTitle : undefined,
        }
      : undefined;

  const result = runLints(emailText, sourceMd, edition, intentionalErrors, subject);
  const json = JSON.stringify(result, null, 2);

  if (outPath) {
    writeFileSync(resolve(ROOT, outPath), json + "\n", "utf8");
  } else {
    console.log(json);
  }

  if (result.summary.blockers > 0) process.exit(1);
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  main();
}
