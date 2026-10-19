/**
 * use-melhor-refresh-plan.ts (#10469)
 *
 * Miolo PURO do `refresh-use-melhor-post.ts`: dado o estado antes/depois da
 * re-seleção contra o `02-reviewed.md` e o status do 4º post, decide o que
 * precisa ser refeito e devolve os passos (comandos exatos + contrato de
 * dispatch dos agents). Idempotente: sem defasagem, `steps` vem vazio.
 *
 * O número de slides do carrossel NUNCA é presumido (capa + p1..pN + CTA,
 * variável por item) — vem do carimbo (`carouselSlots`) quando existe.
 */

import { USE_MELHOR_POST_ID, type UseMelhorPostStatusInput } from "./use-melhor-post.ts";

export interface UseMelhorRefreshInput {
  /** URL do item gravado ANTES da re-seleção (null = nada gravado). */
  previousUrl: string | null;
  /** URL cujo `## um` ficou pendente numa rodada anterior (marcador até `--done`). */
  pendingUrl?: string | null;
  /** Status gathered DEPOIS da re-seleção. */
  status: UseMelhorPostStatusInput;
}

export interface UseMelhorRefreshPlan {
  enabled: boolean;
  /** Por que o plano está vazio / o que está defasado. */
  reasons: string[];
  rewrite_text: boolean;
  regenerate_carousel: boolean;
  carousel_slides: number | null;
  steps: string[];
}

export function buildUseMelhorRefreshPlan(
  input: UseMelhorRefreshInput,
  editionDir: string,
): UseMelhorRefreshPlan {
  const { status } = input;
  const item = status.state?.item ?? null;
  const plan: UseMelhorRefreshPlan = {
    enabled: status.config.enabled,
    reasons: [],
    rewrite_text: false,
    regenerate_carousel: false,
    carousel_slides: status.carouselSlots?.length ?? null,
    steps: [],
  };
  if (!status.config.enabled) {
    plan.reasons.push("4º post desligado (use_melhor_time não definido)");
    return plan;
  }
  if (!item) {
    plan.reasons.push("sem item elegível no USE MELHOR final — 4º post será pulado, nada a refazer");
    return plan;
  }

  if (input.previousUrl !== null && input.previousUrl !== item.url) {
    plan.reasons.push(`item trocado: ${input.previousUrl} → ${item.url}`);
    plan.rewrite_text = true;
  }
  if (input.pendingUrl && input.pendingUrl === item.url && !plan.rewrite_text) {
    plan.reasons.push("reescrita do '## um' pendente de rodada anterior (rode com --done ao terminar)");
    plan.rewrite_text = true;
  }
  if (!status.hasSocialSection) {
    plan.reasons.push(`'## ${USE_MELHOR_POST_ID}' ausente em '# Social'`);
    plan.rewrite_text = true;
  }
  if (!status.hasCurtoSection) {
    plan.reasons.push(`'## ${USE_MELHOR_POST_ID}' ausente em '# Curto'`);
    plan.rewrite_text = true;
  }
  if (status.socialUmMentionsBrand) {
    plan.reasons.push(`'## ${USE_MELHOR_POST_ID}' cita a marca/URL diar.ia (#9628)`);
    plan.rewrite_text = true;
  }
  if (status.carouselSlots === null) {
    plan.reasons.push("carrossel não gerado");
    plan.regenerate_carousel = true;
  } else if (status.carouselStale) {
    plan.reasons.push(`carrossel (${status.carouselSlots.length} slides) defasado`);
    plan.regenerate_carousel = true;
  } else if (status.coverTitleDrift) {
    plan.reasons.push("título da capa diverge do item atual");
    plan.regenerate_carousel = true;
  }
  // Texto novo ⇒ a arte antiga sempre fica defasada.
  if (plan.rewrite_text) plan.regenerate_carousel = true;

  if (plan.reasons.length === 0) {
    plan.reasons.push("4º post em dia — nada a refazer");
    return plan;
  }

  const dir = editionDir.replace(/\/+$/, "");
  const srcPath = item.source_text_path ? `${dir}/${item.source_text_path}` : null;
  let n = 1;
  if (plan.rewrite_text) {
    plan.steps.push(
      `${n++}. Dispatchar social-writer e social-curto SÓ pro '## ${USE_MELHOR_POST_ID}' com ` +
        `use_melhor_post_path=${dir}/_internal/use-melhor-post.json` +
        (srcPath ? ` e source_text_paths={"${USE_MELHOR_POST_ID}":"${srcPath}"}` : " (sem source_text_path: fetch da fonte falhou, omitir a chave)") +
        `; o prompt manda ler context/editorial-rules.md ANTES de escrever.`,
      `${n++}. Integrar cirurgicamente (#495) o '## ${USE_MELHOR_POST_ID}' novo em '# Social' e '# Curto' de ${dir}/03-social.md.`,
      `${n++}. Re-humanizar SCOPED (changed_sections=main_${USE_MELHOR_POST_ID}) e regravar o selo (check-humanizer-social.ts --write).`,
    );
  }
  if (plan.regenerate_carousel) {
    plan.steps.push(`${n++}. npx tsx scripts/gen-carousel-cards.ts --edition-dir ${dir}/ --force`);
  }
  plan.steps.push(
    `${n++}. Re-render/re-servir o social preview e conferir: npx tsx scripts/select-use-melhor-post.ts --edition-dir ${dir}/ --status`,
    `${n++}. Ao terminar: npx tsx scripts/refresh-use-melhor-post.ts --edition-dir ${dir}/ --done`,
  );
  return plan;
}
