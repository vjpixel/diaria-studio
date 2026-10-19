# Crawlers de IA ficam liberados nas nossas superfícies

Movido do `CLAUDE.md` (#6935 PR 2 — curadoria do teto de bytes). Enforcement
real é a config de zona da Cloudflare + os `robots.txt` servidos pelos
Workers de curadoria, auditados diariamente por `Diaria-Robots-Txt-Drift-Check`
(arme: `docs/robots-txt-drift-check-setup.md`) — mover este texto não muda
nenhuma config, só onde a decisão é documentada.

## A decisão (260803)

GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider e afins podem ler o
conteúdo público do projeto — ser citado por assistente é canal de
descoberta, e as páginas de curadoria são curadoria e link, não texto
autoral das edições.

## Estado atual, confirmado ao vivo em 12/08/2026 (#5120)

Nenhum Worker de curadoria (`arquivo.diar.ia.br`, `livros.diar.ia.br` e
demais) serve mais o bloco gerenciado da Cloudflare — o `robots.txt` de
cada um hoje é só `Content-Signal: search=yes,ai-train=yes,use=reference`
+ `Allow: /` no grupo `*`, com **`Amazonbot` e
`CloudflareBrowserRenderingCrawler` bloqueados** (`Disallow: /`) e
`Sitemap:` declarado.

**O apex `diar.ia.br` é caso à parte** (medido ao vivo em 19/08/2026,
#5641): não é um Worker, é servido pela Beehiiv, e o que sai é o
`robots.txt` DEFAULT dela — sem `Content-Signal`, sem `Allow: /`
explícito, com `Amazonbot` e `Nutch` em `Disallow: /` e
`AhrefsBot`/`adsbot-google` restritos a `/login`.

Nenhum dos dois formatos bloqueia os 9 crawlers de assistente/treino
(GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider, meta-externalagent,
Applebot-Extended e os 2 de busca/citação) — a decisão desta seção está no
ar nos dois hosts, só o arquivo servido difere.

## Não reabrir via Worker se reaparecer

Um `robots.txt` custom no Worker não basta — o bloco gerenciado da
Cloudflare (quando ligado) é ANEXADO depois e vence por especificidade RFC
9309, então a correção é sempre no dashboard da zona (desligar o bloco
gerenciado), não no arquivo servido pelo Worker (histórico detalhado do
incidente: issues #4910 e #5120 no GitHub).

Ao subir Worker novo, `curl https://{host}/robots.txt` pra confirmar que o
bloco gerenciado não reapareceu — é o que `Diaria-Robots-Txt-Drift-Check`
audita diariamente (registro completo da task: `docs/scheduled-tasks-registry.md`).

## O texto certo não basta: 403 na borda (#10508)

Em outubro/2026 a zona devolvia **403 na borda** a GPTBot, ClaudeBot, CCBot,
Bytespider e meta-externalagent nos 6 hosts onde esses bots aparecem (apex,
`cursos.`, `livros.`, `arquivo.`, `especial.`, `eia.`), com o `robots.txt`
servido correto o tempo todo — a regra gerenciada "Block AI bots" / AI Crawl
Control isenta o próprio `/robots.txt`, então o drift check textual nunca
acusou nada. Correção é no painel da zona (liberar os crawlers, **mantendo
Amazonbot bloqueado**), não em código.

Desde então `Diaria-Robots-Txt-Drift-Check` (`scripts/robots-txt-drift-check.ts`,
miolo em `scripts/lib/ai-crawler-access-check.ts`) também:

1. **sonda** `GET https://{host}/` com UA de GPTBot e ClaudeBot nos 6 hosts —
   403 vira issue de alarme por host (`ai-crawler-probe:{host}`). Outro erro
   (5xx, rede) é só log: alcançabilidade já é coberta pela checagem do
   `robots.txt`. Ressalva: a sonda sai do nosso IP, então é bot NÃO
   verificado com UA de bot verificado — por isso existe o sinal 2;
2. **soma os 403 reais** das últimas 24h com `verifiedBotCategory = "AI
   Crawler"` (GraphQL `httpRequestsAdaptiveGroups`, `CLOUDFLARE_API_TOKEN`,
   zona por `CLOUDFLARE_ZONE_ID` ou o id fixo de `scripts/lib/apex-cutover.ts`),
   **excluindo Amazonbot**. Total > 0 vira a issue agregada
   `ai-crawler-403-zona` (fingerprint fixo; mudança do conjunto host × bot
   comenta na issue aberta em vez de abrir outra). Token ausente ou erro de
   API/autorização é log, nunca alarme.

Os dois achados são da família `estado`: fecham sozinhos depois de 2
execuções limpas, como os de `robots.txt`.
