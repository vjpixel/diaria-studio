# Smoke-test do `robots.txt` SERVIDO pelos Workers de curadoria

Issue: [#4910](https://github.com/vjpixel/diaria-studio/issues/4910), item 3.

`scripts/lib/shared/robots-txt.ts` produz um `robots.txt` PRÓPRIO por Worker de curadoria (`renderCuradoriaRobotsTxt`), e guards existentes (`test/curadoria-sitemap-robots.test.ts`, `test/worker-robots-txt-guard-4777.test.ts`) confirmam que esse texto está correto — mas ambos são inteiramente **test-time**, contra a função pura, nunca contra o que o Worker de fato serve em produção. Todo Worker num domínio proxiado pela Cloudflare nasce com um robots.txt gerenciado DEFAULT que a plataforma **anexa** antes do bloco próprio do Worker (nunca substituído por servir um arquivo próprio) — como um grupo `User-agent:` nomeado vence o curinga `*` por especificidade (RFC 9309), os 7 crawlers de assistente/treino que o [#4546](https://github.com/vjpixel/diaria-studio/issues/4546) quis liberar continuam bloqueados pelo bloco da Cloudflare independente do que o código do Worker declara. Confirmado ao vivo em 10/08/2026 nos 6 Workers de host público: 11 `Disallow: /` no arquivo servido, 9 do bloco gerenciado (primeiro) + 2 do bloco do Worker (depois). Nenhum guard existente olhava o que está de fato SERVIDO — este smoke-test fecha esse gap.

## O que ele checa

Para cada host descoberto via `discoverWorkerPublicHosts` (`scripts/lib/worker-public-hosts.ts`, varre `workers/*/wrangler.toml` — sem lista hardcoded, um Worker novo com `custom_domain = true` entra na checagem sozinho):

1. **GET runtime** (`checkRobotsTxt`, `scripts/robots-txt-drift-check.ts`) — bate `GET https://{host}/robots.txt` com UA identificável (`DiariaBot/1.0`) e timeout de 15s.
2. **Análise do corpo** (`analyzeRobotsTxt`, `scripts/lib/robots-txt-drift-check.ts`, lógica pura/testável) — 3 sinais de drift:
   - `hasCloudflareManagedBlock`: o delimitador `# BEGIN Cloudflare Managed content` aparece no arquivo.
   - `unexpectedBlockedBots`: um bot NOMEADO fora de `CURADORIA_BLOCKED_BOTS` (Amazonbot, CloudflareBrowserRenderingCrawler) tem `Disallow: /` geral (não um path específico, ex: `/vote`).
   - `blockedRecoveryBots`: um bot de RECUPERAÇÃO/citação (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot, Bingbot) tem `Disallow: /` geral — o caso mais grave, porque destravaria o objetivo de citação do #4546/#4558 se algum dia acontecer.
3. **Decisão de drift** (`evaluateRobotsDrift`):
   - HTTP 200 + nenhum dos 3 sinais → `ok`.
   - HTTP 200 + pelo menos 1 sinal → `drift`.
   - HTTP != 200, ou a chamada de rede falhou → `error` (tratado como pendência igual a `drift` — mesmo racional de `hub-drift-check.ts`: um erro de rede NUM host específico já é sinal suficiente de "não deu pra confirmar que está limpo").

Se houver pelo menos 1 host `drift`/`error`, chega **1 e-mail** ao editor nomeando o(s) host(s) e o(s) motivo(s) exato(s).

## Por que `diar.ia.br` (Beehiiv) nunca entra na checagem

`discoverWorkerPublicHosts` varre `workers/*/wrangler.toml` — Beehiiv não é um Worker deste repo, então nunca aparece, sem precisar de exclusão explícita no código. O `robots.txt` dele é de outro fabricante inteiro (abre com `# beehiiv default robots.txt`) e não tem o bloco gerenciado da Cloudflare — fora de escopo por natureza.

## O que NÃO faz

Não substitui `test/curadoria-sitemap-robots.test.ts`/`test/worker-robots-txt-guard-4777.test.ts`. As camadas respondem perguntas diferentes: os testes perguntam "o código de `renderCuradoriaRobotsTxt` está correto?"; este smoke-test pergunta "o que está no ar concorda com isso, depois de qualquer injeção da plataforma?".

## Idempotência

Fingerprint do conjunto de hosts pendentes (`data/robots-txt-drift-check/state.json`, mesmo padrão de `hub-drift-check.ts`/`worker-drift-check.ts`/`apoios-diff-alarm.ts`) — inclui host + status + motivo(s) de cada host problemático:

- o **mesmo** drift persistindo entre execuções (a cada 6h) não gera um novo e-mail a cada rodada.
- um **host adicional** com drift, ou um **motivo novo** no mesmo host, muda o fingerprint — alarma de novo.
- o drift sendo **resolvido** (a plataforma reverte a injeção, ou o desligamento do robots.txt gerenciado do item 4 da #4910 acontece) tira esse host do conjunto pendente — o cursor "re-arma".
- o **mesmo host voltando a ter drift** depois gera um fingerprint novo — alarma de novo mesmo partindo de um cursor já re-armado.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando algum host está com drift.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o cursor:
  ```powershell
  npx tsx scripts/robots-txt-drift-check.ts --dry-run
  ```
- **Log da task agendada**: `data/robots-txt-drift-check/.drift-check.log` (append-only, uma seção por execução).

## O que fazer quando o alarme dispara

1. Confira se o bloco gerenciado da Cloudflare mudou de shape (a plataforma pode reintroduzir um bot que hoje não bloqueia). Consulte `scripts/lib/shared/robots-txt.ts` pro comportamento completo do módulo próprio deste repo (que continua correto — o drift é sempre de PLATAFORMA, não deste código).
2. Se um bot de RECUPERAÇÃO estiver bloqueado (`blockedRecoveryBots` não-vazio), é o caso mais grave — o objetivo de citação do #4546/#4558 está comprometido. Escalar imediatamente, não esperar o próximo ciclo.
3. Depois de confirmado que a plataforma reverteu (ou que o desligamento do robots.txt gerenciado do item 4 da #4910 foi feito), a próxima execução da task (até 6h depois) já reconhece o host como `ok` — não é preciso limpar estado manualmente. Pra confirmar antes, rode `npx tsx scripts/robots-txt-drift-check.ts --dry-run`.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Windows + Task Scheduler + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme quando há drift; a checagem HTTP em si é um `GET` público, sem credencial nenhuma. **Não** requer o junction `data/` para descobrir hosts (lê `workers/*/wrangler.toml`, local ao checkout) — só precisa dele para persistir `data/robots-txt-drift-check/state.json` (idempotência).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-robots-txt-drift-check-schedule.ps1
```

Linux/systemd (molde da épica #4798): `npx tsx scripts/setup-systemd-timers.ts --task Diaria-Robots-Txt-Drift-Check` seguido de `systemctl --user daemon-reload && systemctl --user enable --now diaria-robots-txt-drift-check.timer`.

Isso registra a task `Diaria-Robots-Txt-Drift-Check` (a cada 6h). Idempotente — re-executar atualiza a task. Remover (Windows): mesmo comando com `-Unregister`.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem acesso ao Task Scheduler real nem a `data/.credentials.json` reais, e nenhum host de produção foi batido em teste por decisão explícita do dispatch) — validado só via testes da lógica pura + fetch mockado (`test/robots-txt-drift-check.test.ts`, `test/robots-txt-drift-check-script.test.ts`), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750.

## Item 4 da #4910 (desligar o robots.txt gerenciado na zona Cloudflare)

Fora de escopo desta unidade — ação de dashboard do editor, não código. A issue ordena explicitamente "3 antes de 4": este smoke-test precisa existir (e, idealmente, já ter rodado por um tempo confirmando o baseline de drift atual) antes do desligamento, senão não há como confirmar que a mudança pegou nem detectar se a plataforma reintroduzir o bloco depois.
