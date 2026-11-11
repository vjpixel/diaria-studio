/** #12748: reserva o vertical ANTES da Parte B, sem depender do store. Puro. */
import { gridFromShortsPublished, type ScheduledSlot } from "../social-slot-planner.ts";
import { listShortDestinations, loadShortsConfig, loadShortScheduleConfig, resolveShortTime, LINKEDIN_REPOST_MIN_DELAY_MINUTES } from "./short-video.ts";

export function configuredVerticalGrid(config: unknown, edition: string): ScheduledSlot[] {
  // Configs sintéticos (anual/artigo especial) não têm vertical diário.
  if (!(config as { publishing?: { shorts?: unknown } })?.publishing?.shorts) return [];
  const cfg = loadShortsConfig(config);
  const sched = loadShortScheduleConfig(config);
  const date = `20${edition.slice(0, 2)}-${edition.slice(2, 4)}-${edition.slice(4, 6)}`;
  const at = (id: string) => `${date}T${resolveShortTime(sched, edition, id).hhmm}:00-03:00`;
  const scheduledAt = (id: string) => id === "linkedin_page_repost"
    ? new Date(Math.max(Date.parse(at(id)), Date.parse(at("linkedin_profile")) + LINKEDIN_REPOST_MIN_DELAY_MINUTES * 60_000)).toISOString()
    : at(id);
  return gridFromShortsPublished({ entries: listShortDestinations(cfg).map(({ id }) => ({
    destination: id,
    scheduled_at: scheduledAt(id),
  })) }, cfg.instagramAuthorPage ?? "diaria", cfg.instagramCollaborators);
}
