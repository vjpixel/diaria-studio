/**
 * scripts/lib/shared/social-networks.ts (#13320, #13321)
 *
 * Fonte única das redes da diar.ia.br, na ordem em que aparecem para o
 * leitor: o convite "Siga a diar.ia.br:" da edição (`SOCIAL_INVITE`,
 * `encerramento-snippet.ts`) e o rodapé social do site (`site-social.ts`)
 * leem esta mesma lista, então as duas superfícies não divergem.
 *
 * Módulo folha de propósito: só importa `canonical-urls.ts` (sem `node:fs`),
 * porque o rodapé do site também roda dentro de Worker (`workers/arquivo`,
 * guard `test/worker-bundle-node-only-imports.test.ts`), e o
 * `encerramento-snippet.ts` lê arquivo do disco.
 */
import {
  DIARIA_YOUTUBE_SUBSCRIBE_URL,
  DIARIA_TIKTOK_URL,
  DIARIA_INSTAGRAM_URL,
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_THREADS_URL,
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_X_URL,
} from "../canonical-urls.ts";

/** Chave do ícone (nome do arquivo em `assets/social-icons/` e em
 * `workers/site/public/icons/social/`), na ordem do convite. #13557 (pedido
 * do editor, edição 261118): YouTube, Instagram, LinkedIn, TikTok, Threads, X,
 * Facebook. A ordem anterior (#13320, TikTok logo depois do YouTube) ficou em
 * `SOCIAL_INVITE_TIKTOK_SECOND_LEGACY` (`encerramento-snippet.ts`). */
export const SOCIAL_INVITE_ICON_KEYS = ["youtube", "instagram", "linkedin", "tiktok", "threads", "x", "facebook"] as const;
export type SocialInviteIconKey = (typeof SOCIAL_INVITE_ICON_KEYS)[number];

export interface DiariaSocialNetwork {
  key: SocialInviteIconKey;
  /** Nome da rede como o leitor vê (rótulo do link no markdown, `alt`/`aria-label`). */
  label: string;
  /** Perfil da diar.ia.br. YouTube é o link de inscrição (#12069). */
  url: string;
}

const NETWORK_BY_KEY: Record<SocialInviteIconKey, Omit<DiariaSocialNetwork, "key">> = {
  youtube: { label: "YouTube", url: DIARIA_YOUTUBE_SUBSCRIBE_URL },
  tiktok: { label: "TikTok", url: DIARIA_TIKTOK_URL },
  instagram: { label: "Instagram", url: DIARIA_INSTAGRAM_URL },
  linkedin: { label: "LinkedIn", url: DIARIA_LINKEDIN_PAGE_URL },
  threads: { label: "Threads", url: DIARIA_THREADS_URL },
  facebook: { label: "Facebook", url: DIARIA_FACEBOOK_PAGE_URL },
  x: { label: "X", url: DIARIA_X_URL },
};

/** As redes na ordem de `SOCIAL_INVITE_ICON_KEYS`. */
export const DIARIA_SOCIAL_NETWORKS: readonly DiariaSocialNetwork[] = SOCIAL_INVITE_ICON_KEYS.map((key) => ({
  key,
  ...NETWORK_BY_KEY[key],
}));
