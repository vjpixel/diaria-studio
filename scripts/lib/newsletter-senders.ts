import { readFileSync } from "node:fs";

export interface SenderDecision {
  status: "aprovado" | "rejeitado";
  reason: string;
  decided_at: string;
}
export interface SenderRegistry { version: number; senders: Record<string, SenderDecision> }
export function senderKey(sender: string): string {
  return (sender.match(/<([^>]+)>/)?.[1] ?? sender).trim().toLowerCase();
}
export function loadSenderRegistry(path: string): SenderRegistry {
  const registry = JSON.parse(readFileSync(path, "utf8")) as SenderRegistry;
  if (registry.version !== 1 || !registry.senders) throw new Error("Registro de remetentes inválido");
  for (const [sender, decision] of Object.entries(registry.senders)) {
    if (senderKey(sender) !== sender || !sender.includes("@") ||
        !["aprovado", "rejeitado"].includes(decision.status) || !decision.reason?.trim() ||
        !Number.isFinite(Date.parse(decision.decided_at))) throw new Error(`Decisão inválida: ${sender}`);
  }
  return registry;
}
export function classifySender(sender: string, registry: SenderRegistry) {
  const decision: SenderDecision | undefined = Object.hasOwn(registry.senders, senderKey(sender)) ? registry.senders[senderKey(sender)] : undefined;
  return {
    classificacao: decision?.status === "aprovado" ? "IA" : decision ? "não-IA" : "incerta",
    remetente_status: decision?.status ?? "novo-pendente",
    classificacao_motivo: decision?.reason ?? "Remetente sem decisão durável; decidir em lote no gate 4",
  } as const;
}
