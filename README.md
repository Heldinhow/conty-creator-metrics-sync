# Conty — Sincronização de métricas do criador

Serviço que sincroniza métricas de posts (Instagram, TikTok, YouTube, X) a partir de uma conexão já autorizada, usando um provedor simulado em processo. Sem OAuth real, sem banco, sem rede externa.

## Como rodar

```bash
npm ci
npm test        # 24 testes, sem dormir de verdade
npm run build && npm start   # sobe em :3000 (ou PORT)
```

Demonstração com dados de exemplo (criador `creator-1` já cadastrado):

```bash
curl -X POST localhost:3000/sync \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer fake' \
  -d '{"creatorId":"creator-1","provider":"instagram","windowFrom":"2026-09-01T00:00:00.000Z","windowTo":"2026-10-01T00:00:00.000Z"}'

curl localhost:3000/creators/creator-1/posts -H 'authorization: Bearer fake'
```

## Contrato da API

- `GET /health` → `{status:"ok"}` (sem auth).
- `POST /sync {creatorId, provider, windowFrom, windowTo}` → `200 {synced, deduplicated, retries}`.
  - `provider`: `instagram|tiktok|youtube|x`; janela ISO-8601 semiaberta `[from,to)` em UTC.
  - Sem `Authorization: Bearer <qualquer>` → `401`; criador desconhecido → `404`; janela/provedor inválido → `400` sem chamar o provedor.
  - Teto estourado → `502 {error:"SYNC_EXHAUSTED", retries, retryAfterSeconds}`.
- `GET /creators/:id/posts[?provider=]` → posts com `fetchedAt` (quando a métrica foi buscada).
- Qualquer outra rota → `404`.

O token é fictício: qualquer valor passa, só a presença é registrada (o valor nunca entra em log).

## Como a idempotência funciona

A chave é o par `(provider, postId)`. O sync faz upsert sobre essa chave, nunca soma. Receber o mesmo post de novo — mesmo snapshot, janelas sobrepostas ou duplicata dentro da mesma resposta — conta `deduplicated`, mantém os totais e só atualiza o snapshot e o `fetchedAt` (carimbado após o último retry, com relógio injetável).

## O que acontece no 429

O serviço retenta internamente e o 429 nunca vaza direto. Espera `min(Retry-After do provedor, 30s)`; `Retry-After` ausente, zero, negativo ou inválido vira espera de 1s (como timeout). Timeout também espera 1s. Tudo compartilha um único contador de no máximo 5 chamadas ao provedor por sync (`retries = chamadas - 1`); estourando, responde `502` sem desfazer o que já sincronizou e sem loop infinito. Execução é sequencial; concorrência paralela está fora de escopo.

## Nota sobre IA

Planejamento com IA para alinhar a spec; revisei a spec, quebrei em tickets e revisei os tickets. Implementação com IA; review final com IA (código vs spec) + review manual.
