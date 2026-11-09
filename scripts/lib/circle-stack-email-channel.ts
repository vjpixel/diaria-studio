/**
 * scripts/lib/circle-stack-email-channel.ts (#12538)
 *
 * Canal e-mail do post semanal da Stack: o mesmo post do Radar de Notícias
 * Stack (`publish-circle-stack.ts`) enviado pelo Kit a quem apoia no nível
 * Núcleo (id interno `patrono`, `shared/apoio-nivel-label.ts`).
 *
 * Audiência é uma TAG projetada de `apoio_nivel` (`platform.config.json` →
 * `kit_stack.audience_tag`), nunca segmento — racional completo em
 * `shared/kit-apoio-tag.ts`. Tag SEPARADA das demais tags de apoio de
 * propósito: o conjunto (só Núcleo) é diferente do da Retrospectiva e da
 * votação (Conselho + Núcleo) e do Artigo Especial (Clube+), e muda por motivo
 * diferente.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAudienceTagName, type TagNameResolution } from "./shared/kit-apoio-tag.ts";
import type { ApoioNivel } from "./shared/apoio-nivel-types.ts";

/** Quem recebe: só Núcleo (pedido do editor, 09/11/2026). */
export const STACK_EMAIL_NIVEIS: readonly ApoioNivel[] = ["patrono"];

/** Comando que cria/popula a tag — entra nas mensagens de erro dos guards. */
export const STACK_EMAIL_TAG_SYNC_COMMAND = "npx tsx scripts/sync-apoio-stack-tag-kit.ts --push";

export interface KitStackChannelConfig {
  audience_tag?: string;
}

export interface PlatformConfigSlice {
  kit_stack?: KitStackChannelConfig;
}

export class StackEmailGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackEmailGuardError";
  }
}

/**
 * Um broadcast PODE existir no Kit (criado sem confirmação, cancelamento sem
 * confirmação, registro não gravado). Nunca se reexecuta às cegas: a mensagem
 * diz o que conferir. `cancelled` = o cancelamento automático foi CONFERIDO
 * (nada saiu, pode rodar de novo depois de corrigir a causa).
 */
export class StackEmailIncidentError extends Error {
  constructor(
    message: string,
    readonly broadcastId?: number,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = "StackEmailIncidentError";
  }
}

export function readPlatformConfig(rootDir: string): PlatformConfigSlice {
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) throw new StackEmailGuardError(`${path} ausente.`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlatformConfigSlice;
  } catch (e) {
    throw new StackEmailGuardError(`${path} não é JSON válido: ${(e as Error).message}`);
  }
}

export function resolveStackEmailTagName(config: KitStackChannelConfig | undefined | null): TagNameResolution {
  return resolveAudienceTagName(config?.audience_tag, "kit_stack.audience_tag");
}
