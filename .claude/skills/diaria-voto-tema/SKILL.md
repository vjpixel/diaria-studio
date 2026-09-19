---
name: diaria-voto-tema
description: Votação do tema do próximo Artigo Especial pelos apoiadores Mantenedor/Patrono (R$25+, #8371) — 1 clique, link único por pessoa, resultado parcial visível. Substitui o voto manual por e-mail (BCC + resposta), que media 1-2 votos em 5-10 destinatários. Uso — `/diaria-voto-tema abrir|enviar|placar|lembrete|fechar --ciclo AAMM [--dry-run|--push] [...]`.
---

# /diaria-voto-tema

Fecha a recompensa "voto no tema do próximo Artigo Especial" já vendida no
tier Mantenedor (`scripts/lib/site-apoiar-page.ts:131`) e nunca implementada
antes da #8371 — até aqui o editor coletava votos por e-mail (BCC +
resposta), com 1-2 votos em 5-10 destinatários nas duas rodadas que
existiram.

**Requer a máquina com credenciais Cloudflare (`CLOUDFLARE_ACCOUNT_ID`/
`CLOUDFLARE_WORKERS_TOKEN`) e Kit (`KIT_API_KEY`)** — nenhum passo usa
navegador. Roda tanto no `300` (overnight/develop) quanto na máquina do
editor.

## Decisões já tomadas (editor, 18/09/2026 — não reabrir, issue #8371)

| Pergunta | Decisão |
|---|---|
| Eleitorado | Mantenedor + Patrono (R$25+), tag Kit `apoio-voto-tema` (`platform.config.json` → `kit_votacao.audience_tag`) |
| Mecanismo | 1 clique, link único por pessoa (token opaco, mesmo formato do "É IA?") |
| Cédula | O editor propõe os N candidatos (sem rodada prévia de coleta) — `data/artigo-especial/votacao/{aamm}/ballot.json` |
| Destino do clique | Página de resultado parcial — vota e já vê o placar |
| Troca de voto | Permitida — último clique vence |
| Visibilidade do placar | Contagem pública, nunca quem votou |
| Empate | NÃO resolvido automaticamente — `voto-tema-close.ts` recusa declarar vencedor e sai com exit 3; decisão editorial via `--forcar-vencedor N` |
| Ciclo | `AAMM` (mês de publicação do artigo) — formato de 4 dígitos, nunca `AAMMDD` (diária) nem `YYMM-MM` (mensal) |

Arquitetura completa (KV, rotas do worker, diagrama): corpo da issue #8371 e
docstrings de `workers/artigos/src/voto-tema-core.ts`/`voto-tema.ts`.

## Comandos

### `abrir --ciclo AAMM`

Escreve `data/artigo-especial/votacao/{aamm}/ballot.json` (título + opções)
**antes** de rodar — é o editor quem escreve a cédula, a skill só valida.
Roda `voto-tema-open.ts`: resolve o eleitorado (tag Kit), calcula 1 token
por pessoa, grava a tabela reversa `polltoken:{token} -> email` no KV,
patcha o custom field `voto_token` no Kit, e grava
`tema:ballot:{aamm}` (com `eleitores[]` como hash, nunca e-mail cru).

```
npx tsx scripts/sync-apoio-nivel-kit.ts --push          # se a base de apoio mudou desde o último sync
npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push   # projeta apoio_nivel → tag apoio-voto-tema
npx tsx scripts/voto-tema-open.ts --ciclo AAMM --dry-run
npx tsx scripts/voto-tema-open.ts --ciclo AAMM --push
```

**Antes do 1º uso real, rodar o teste decisivo da merge tag** (corpo da
#8371 — a #8371 não confirmou isto ao vivo, é o único desconhecido de
plataforma do plano): criar o custom field `voto_token` no Kit (se ainda
não existir), popular o do próprio editor, mandar um broadcast de teste
escopado à tag `diaria-test-email` com o link montado, e ler o e-mail
recebido (Gmail MCP) pra confirmar que `{{ subscriber.voto_token }}`
substituiu. Se NÃO substituir, o transporte precisa trocar pra Brevo
transacional (`sendTransactionalEmail`) — mudança de 1 script só
(`publish-voto-tema-kit.ts`), o resto do desenho (worker, cédula, apuração)
não muda.

### `enviar --ciclo AAMM [--audience eleitorado|pendentes]`

Roda `publish-voto-tema-kit.ts`: cria o broadcast **sempre como rascunho**
(`send_at: null`, `public: false`). **Gate humano obrigatório antes de
qualquer disparo real** (`AskUserQuestion` — irreversível para terceiros,
critério 1 de "Perguntar é exceção" no `CLAUDE.md`): test-send pra
`diaria-test-email`, conferência visual + clique real de teste, e só então
o editor dispara manualmente no painel do Kit.

```
npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --dry-run
npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --push
```

### `placar --ciclo AAMM`

Só leitura — `voto-tema-stats.ts`, sem gate. `--json` para consumo
programático.

```
npx tsx scripts/voto-tema-stats.ts --ciclo AAMM
```

### `lembrete --ciclo AAMM`

Marca quem ainda não votou com a tag `voto-tema-pendente`
(`voto-tema-lembrete.ts`), depois `enviar --audience pendentes` pra criar o
rascunho do 2º broadcast (mesmo gate humano do `enviar` acima antes de
disparar).

```
npx tsx scripts/voto-tema-lembrete.ts --ciclo AAMM --push
npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --audience pendentes --push
```

### `fechar --ciclo AAMM [--forcar-vencedor N]`

Apura o resultado final e grava `tema:result:{aamm}` (congela o placar; o
worker passa a recusar novos votos). Empate → exit 3, sem gravar nada;
rodar de novo com `--forcar-vencedor N` depois da decisão editorial.

```
npx tsx scripts/voto-tema-close.ts --ciclo AAMM --dry-run
npx tsx scripts/voto-tema-close.ts --ciclo AAMM --push
```

## Guard de publicação

Nenhum destes scripts dispara e-mail sozinho — `publish-voto-tema-kit.ts`
só cria RASCUNHO. Disparar (`send_at`, ou apertar "Send" no painel do Kit)
é sempre ação humana, fora desta skill.
