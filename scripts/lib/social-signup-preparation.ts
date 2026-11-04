/** #12038: artefato de revisão local; nenhum publicador consome este arquivo. */
import { extractSection, extractDestaqueBlock, assertNoScaffolding } from "./extract-section.ts";
import { FACEBOOK_CTA_LINE, buildFacebookCtaUrl, injectChannelLine, splitBodyAndTags, type SocialChannel } from "./social-cta-lines.ts";
import { toSocialPostText } from "./social-post-text.ts";
import { SOCIAL_SIGNUP_TEST_UTM } from "./shared/utm-registry.ts";

/** Data civil explícita, sem inferir início pela execução ou pela edição mais recente. */
export function civilDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Data inválida: ${value}; use AAAA-MM-DD.`);
  }
  return date;
}

export function signupTestWindow(start: string) {
  const end = civilDate(start);
  end.setUTCDate(end.getUTCDate() + 28);
  return { start, endExclusive: end.toISOString().slice(0, 10), weeks: 4 };
}

export function signupTestUrl(channel: SocialChannel): string {
  const url = new URL("https://diar.ia.br/");
  url.searchParams.set("utm_source", channel);
  url.searchParams.set("utm_medium", SOCIAL_SIGNUP_TEST_UTM.medium);
  url.searchParams.set("utm_campaign", SOCIAL_SIGNUP_TEST_UTM.campaign);
  return url.toString();
}

/** Reusa a copy aprovada que já existe em FACEBOOK_CTA_LINE (#3991). */
export function signupTestLine(channel: SocialChannel): string {
  return FACEBOOK_CTA_LINE.replace(buildFacebookCtaUrl(), signupTestUrl(channel));
}

export function prepareSocialSignup(socialMd: string, editionDate: string, start: string) {
  civilDate(editionDate);
  const window = signupTestWindow(start);
  if (editionDate < start || editionDate >= window.endExclusive) {
    throw new Error("Edição fora da janela de quatro semanas do teste.");
  }
  const section = extractSection(socialMd, "Social");
  if (!section) throw new Error("Seção # Social ausente.");
  const posts = (["d1", "d2", "d3"] as const).map((id) => {
    const raw = extractDestaqueBlock(section, id)?.trim();
    if (!raw) throw new Error(`Post ${id} ausente: teste exige três posts diários.`);
    assertNoScaffolding(raw, id);
    const { body, tags } = splitBodyAndTags(raw);
    if (body.split(/\n\s*\n/).length !== 3) throw new Error(`${id}: esperados exatamente três parágrafos editoriais.`);
    const texts = Object.fromEntries((["linkedin", "facebook", "instagram"] as const).map((channel) => {
      // D1 termina com a assinatura, após as tags; D2/D3 seguem a preparação atual.
      const text = id === "d1" && channel !== "instagram"
        ? [body, tags, signupTestLine(channel)].filter(Boolean).join("\n\n")
        : injectChannelLine(raw, channel);
      return [channel, toSocialPostText(text)];
    }));
    return { id, texts };
  });
  return {
    issue: 12038,
    preparationOnly: true,
    editionDate,
    window,
    tracking: { ...SOCIAL_SIGNUP_TEST_UTM, sources: ["linkedin", "facebook", "instagram"] },
    posts,
    instagram: {
      post: "d1",
      firstComment: signupTestLine("instagram"),
      pinRequired: true,
      bioUrl: signupTestUrl("instagram"),
      manualActions: "Revisar o primeiro comentário, fixá-lo e atualizar o link da bio somente ao ativar o teste. A API não fixa comentários.",
    },
  };
}
