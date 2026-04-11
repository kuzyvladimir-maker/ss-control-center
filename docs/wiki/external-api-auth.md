# 🔐 External API Auth

## Суть
REST API для внешних потребителей (Claude-агент Jackie, n8n, Telegram бот). Защищён Bearer token.

## Auth
```
Authorization: Bearer <SSCC_API_TOKEN>
```
Middleware: `src/middleware.ts`

## Endpoints
`src/app/api/external/` — API для внешних клиентов.

## MCP Server (Phase 2)
`GET /api/mcp/sse` — Model Context Protocol server для Claude-агентов.

## Безопасность
- API ключи ТОЛЬКО в `.env`
- `.env` в `.gitignore`
- API routes проксируют запросы к внешним сервисам
- SP-API credentials per-store

## 🔗 Связи
- **Используется в:** [Архитектура проекта](project-architecture.md)
- **Связан с:** [Amazon SP-API](amazon-sp-api.md) (per-store auth), [Veeqo API](veeqo-api.md)

## История
- 2026-04-10: Wiki-статья создана при полной индексации проекта
