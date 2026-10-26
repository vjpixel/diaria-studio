/** Diagnóstico de checkpoint da conta que gerou o token de página (#11036). */
export function facebookCheckpointDiagnostic(body: unknown): string | null {
  let parsed = body;
  if (typeof body === "string") {
    try { parsed = JSON.parse(body); } catch { return null; }
  }
  const error = (parsed as { error?: { code?: unknown; error_data?: { checkpoint_url?: unknown } } } | null)?.error;
  const checkpoint = error?.error_data?.checkpoint_url;
  if (error?.code !== 190 || typeof checkpoint !== "string" || !checkpoint.trim()) return null;
  return "Facebook: checkpoint de segurança na conta que gerou o token da página (Graph API code 190). " +
    "Ação do editor: entrar em https://www.facebook.com com a conta pessoal que gerou o token da página e seguir as instruções do checkpoint. " +
    "Depois, reexecutar o comando que falhou.";
}
