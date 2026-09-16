/**
 * scripts/lib/kit-inactive-reativacao.ts (#8192)
 *
 * Seleção PURA do pool "inactive do Kit que já recebeu o e-mail de
 * confirmação (DOI) há mais de 72h" — compartilhada entre
 * `scripts/verify-kit-inactive-emails-mv.ts` (verifica no MillionVerifier) e
 * `scripts/sync-kit-inactive-to-brevo.ts` (ingere na lista Brevo diária), pra
 * que os dois scripts operem sobre EXATAMENTE o mesmo conjunto. Se cada um
 * filtrasse por conta própria, a cobertura de MV medida pelo sync poderia
 * divergir do que o verify processou.
 *
 * ## Por que `created_at` é o proxy de "e-mail de confirmação enviado"
 *
 * A API v4 do Kit não expõe quando o incentive email (DOI) saiu. Nos 3
 * workers de cadastro (`poll`/`cursos`/`reativar`, #7723) o assinante nasce
 * `inactive` e é vinculado ao designer form no MESMO request — é esse
 * vínculo que dispara o e-mail. Então `created_at` ≈ momento do envio.
 *
 * Ressalva conhecida: o worker `reativar` faz DELETE+CREATE, então quem
 * clica de novo no botão ganha `created_at` novo e volta a esperar 72h
 * antes de ser elegível. Isso só afeta quem ainda não está no store — quem
 * já foi ingerido segue na lista Brevo (dedup é pelo store, por e-mail).
 */

import { matchFixtureEmail } from "./kit-fixture-patterns.ts";
import type { KitSubscriberSummary } from "./kit-subscribers.ts";

/** Janela entre o envio do DOI e a entrada no canal Brevo (decisão do editor, #8192). */
export const KIT_DOI_WAIT_HOURS = 72;

export interface KitInactiveSelection {
  /** Passaram do corte (created_at ≤ now − 72h), não são fixture. */
  eligible: KitSubscriberSummary[];
  /** Criados há menos de 72h — ainda dentro da janela do DOI. */
  tooRecent: number;
  /** `created_at` ausente/não parseável — excluídos (fail-safe: sem data
   *  não dá pra afirmar que o DOI já teve 72h). */
  invalidCreatedAt: number;
  /** Endereços de sonda/teste (`kit-fixture-patterns.ts`). */
  fixtures: number;
}

/**
 * Pura — aplica o corte de 72h e exclui fixtures. Borda: exatamente 72h
 * completas conta como elegível (`<=`).
 */
export function selectKitInactivePastDoiWindow(
  subs: readonly KitSubscriberSummary[],
  nowMs: number,
  waitHours: number = KIT_DOI_WAIT_HOURS,
): KitInactiveSelection {
  const cutoffMs = nowMs - waitHours * 3600 * 1000;
  const eligible: KitSubscriberSummary[] = [];
  let tooRecent = 0;
  let invalidCreatedAt = 0;
  let fixtures = 0;
  for (const s of subs) {
    if (matchFixtureEmail(s.email_address) !== null) {
      fixtures++;
      continue;
    }
    const createdMs = Date.parse(s.created_at ?? "");
    if (!Number.isFinite(createdMs)) {
      invalidCreatedAt++;
      continue;
    }
    if (createdMs > cutoffMs) {
      tooRecent++;
      continue;
    }
    eligible.push(s);
  }
  return { eligible, tooRecent, invalidCreatedAt, fixtures };
}

export function formatKitInactiveSelection(sel: KitInactiveSelection, waitHours = KIT_DOI_WAIT_HOURS): string {
  // Total derivado das 4 partes — nunca um argumento separado que possa divergir.
  const total = sel.eligible.length + sel.tooRecent + sel.fixtures + sel.invalidCreatedAt;
  return (
    `${total} inactive no Kit → ${sel.eligible.length} elegível(is) (DOI há ≥${waitHours}h); ` +
    `fora: ${sel.tooRecent} dentro da janela, ${sel.fixtures} fixture(s), ${sel.invalidCreatedAt} sem created_at válido.`
  );
}
