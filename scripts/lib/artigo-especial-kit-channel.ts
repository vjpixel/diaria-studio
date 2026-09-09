/**
 * scripts/lib/artigo-especial-kit-channel.ts (#7659)
 *
 * Canal de E-MAIL do Artigo Especial — o 5º canal de `/diaria-artigo-especial`
 * (ao lado de `apoiase`, `linkedin_pagina`, `linkedin_perfil` e `box`), e o
 * que fechava o buraco da issue: a recompensa de R$10+/mês é vendida como
 * "entrega por e-mail" e nunca existiu e-mail nenhum. Este módulo é a parte
 * PURA (config, audiência, render); o I/O vive em
 * `scripts/sync-apoio-especial-tag-kit.ts` e
 * `scripts/publish-artigo-especial-kit.ts`.
 *
 * ## O e-mail é CHAMADA + link, não o artigo inteiro — e isso é mecânico
 *
 * A pergunta 1 da #7659 ("íntegra ou chamada + link?") tem resposta forçada
 * pelo artefato, não por preferência editorial: os Artigos Especiais são
 * documentos web de 43–52 KB de HTML com `<style>` próprio, CSS grid,
 * infográficos em `div`, barra de progresso de leitura e sumário com âncoras
 * (`workers/artigos/articles-src/*.html`). Nada disso sobrevive a um cliente
 * de e-mail, e o Gmail corta a mensagem acima de ~102 KB — cortando
 * justamente o fim, onde fica o pixel de abertura (memória do projeto,
 * estreia do Kit em 27/08). Mandar a íntegra seria entregar um artigo
 * quebrado E perder a medição dele.
 *
 * Então o e-mail leva o MESMO texto de chamada que a skill já gera pro
 * apoia.se (`data/artigo-especial/{ano}-{slug}/email.md`) e um botão pro
 * artigo. Se o editor quiser reabrir isso, o caminho não é mudar este render
 * — é decidir se vale manter uma 2ª versão do artigo, escrita pra e-mail.
 *
 * ## A audiência é R$10+, e vem do MESMO lugar que o gate da web
 *
 * `ARTIGOS_ESPECIAIS_APOIO_THRESHOLD` (`workers/artigos/src/apoio-gate-config.ts`)
 * é a fonte única do limiar desde o #7030 — é ele que decide quem passa no
 * gate de `especial.diar.ia.br`. Importar de lá, em vez de repetir
 * `["apoiador", "mantenedor", "patrono"]` aqui, é o que impede o e-mail e a
 * web de discordarem em silêncio sobre quem tem direito ao artigo (foi
 * exatamente esse tipo de divergência que a #7658 teve de corrigir do outro
 * lado, na Retrospectiva do Mês).
 */

import { ARTIGOS_ESPECIAIS_APOIO_THRESHOLD } from "../../workers/artigos/src/apoio-gate-config.ts";
import type { ApoioNivel } from "./shared/apoio-nivel-types.ts";
import { resolveAudienceTagName, type TagNameResolution } from "./shared/kit-apoio-tag.ts";

/**
 * Níveis que recebem o e-mail do Artigo Especial — R$10+/mês, ou seja todos
 * menos `amigo`. NÃO redeclarado: é o mesmo array que o gate da web usa.
 */
export const ARTIGO_ESPECIAL_EMAIL_NIVEIS: readonly ApoioNivel[] = ARTIGOS_ESPECIAIS_APOIO_THRESHOLD;

/** Config de `platform.config.json` → `kit_artigo_especial`. */
export interface KitArtigoEspecialChannelConfig {
  /** Nome da tag de audiência no Kit. Resolvida por NOME em runtime (o id é
   *  por-conta, nunca hardcoded — mesma disciplina de `kit_apoiadores`). */
  audience_tag?: string;
}

/** Comando que cria/popula a tag — entra nas mensagens de erro dos guards,
 *  que só são acionáveis se disserem o que rodar. */
export const ARTIGO_ESPECIAL_TAG_SYNC_COMMAND = "npx tsx scripts/sync-apoio-especial-tag-kit.ts --push";

export function resolveArtigoEspecialTagName(
  config: KitArtigoEspecialChannelConfig | undefined | null,
): TagNameResolution {
  return resolveAudienceTagName(config?.audience_tag, "kit_artigo_especial.audience_tag");
}
