# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Relevance Gateway Lab — 一个将 Relevance AI Agent 暴露为 OpenAI 兼容接口（`/v1/models`、`/v1/chat/completions`）的单端口网关。同时提供 `/admin` 管理后台。基于 Node.js 20 + Express + SQLite（better-sqlite3），前端为 React + Vite + Tailwind CSS。

## Common Commands

### 本地开发（后端）

```bash
# 安装依赖
npm install

# 启动（需先导出环境变量，项目不含 dotenv）
set -a && source .env.example && set +a
node src/server.js        # 或 npm start

# watch 模式
npm run dev               # node --watch src/server.js
```

### 前端开发

```bash
npm --prefix frontend install
npm --prefix frontend run dev       # Vite dev server（代理 /admin-api 到 :8080）
npm --prefix frontend run build     # 构建到 static/admin/
```

### Docker 一键启动

```bash
cp .env.example .env
docker compose up --build -d
# 管理后台 http://127.0.0.1:18080/admin
# API      http://127.0.0.1:18080
```

### 自测脚本

```bash
SELF_TEST_UPSTREAM_PROJECT=... \
SELF_TEST_UPSTREAM_REGION=... \
SELF_TEST_UPSTREAM_API_KEY=... \
python3 scripts/self_test.py
```

## Architecture

### 后端（`src/`，ESM，`"type": "module"`）

- **server.js** — Express 入口，定义所有路由：管理后台 API（`/admin-api/*`）、OpenAI 兼容接口（`/v1/*`）、SSE 流式输出逻辑。此文件是请求处理与 SSE 分帧的核心。
- **config.js** — 从环境变量读取所有配置（`settings` 对象）。不使用 dotenv，环境变量需外部注入。
- **db.js** — 使用 better-sqlite3 初始化数据库，管理 schema 版本（`SCHEMA_VERSION = "node-sdk-v1"`），包含自动迁移与重建逻辑。导出 `openDatabase()` 和工具函数。
- **services.js** — 核心业务逻辑层：upstream key / deployment / gateway key / model catalog / request log 的 CRUD，消息标准化（`normalizeMessages`），prompt 编译（`buildPrompt`），deployment 选择（最近最少使用策略）。
- **runtime.js** — Agent 任务执行引擎。通过 `@relevanceai/sdk`（`Agent.get` → `agent.sendMessage`）触发上游 Agent，监听 SSE 事件（message/update/error）并实时回调 `onThinking`/`onText`。内含 **view 轮询兜底机制**：SSE 静默超阈值后自动切到 `getTaskView` 轮询，平滑输出 fallback 内容（分块、排序 thinking→text）。
- **relevance-rest.js** — 封装 Relevance AI REST API 的轻量客户端（`RelevanceRestClient`），含 agent 管理、model catalog、conversation result、task metadata/view 等接口。
- **security.js** — admin session（HMAC 签名 cookie）、gateway key 生成（`sk-gw-*`）、bearer token 解析。
- **error-utils.js** — 错误序列化与分类（network/timeout/abort/http/unknown）。

### 前端（`frontend/`，React 18 + TypeScript + Vite + Tailwind）

- 构建输出到 `static/admin/`，由后端静态托管
- `vite.config.ts` 中 `base: '/static/admin/'`，开发时代理 `/admin-api` 到 `:8080`
- 页面：Dashboard、UpstreamKeys、GatewayKeys、RequestLogsPage、ActivityLogs
- UI 组件在 `frontend/src/components/ui/`

### 关键运行机制

1. 用户通过 Gateway API Key 请求 `/v1/chat/completions`
2. `selectDeploymentForModel` 按最近最少使用策略选取 active deployment
3. `buildPrompt` 将 OpenAI messages 编译为 `<Transcript>` 格式
4. `runAgentTask`（runtime.js）使用 SDK 触发上游 Agent
5. 流式：优先 SDK SSE → 静默超时后切 view 轮询兜底 → 平滑分块输出 → 收尾补齐最终内容
6. 所有请求落 request_logs 表，记录 usage/cost/transport/latency

### 数据库表

- `upstream_keys` — 上游 Relevance AI 凭证
- `model_deployments` — 模型部署（关联 upstream_key，包含上游 agent_id）
- `gateway_api_keys` — 网关对外 API Key
- `model_catalog_cache` — 上游模型目录缓存
- `request_logs` — 请求日志
- `app_meta` — schema 版本等元数据

## Extended API Support

### Anthropic `/v1/messages` 端点
- 支持完整 Anthropic Messages API 格式（`system`、`tools`、多类型 content blocks）
- 流式：`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`
- 适配 Claude Code 直连（将网关 URL 配置为 `api_url`，模型名对应 deployment 的 `public_model_name`）

### Tool use（工具调用）
- OpenAI 格式：请求携带 `tools` 数组时，工具定义注入 prompt；响应自动检测 JSON 工具调用并转为 `finish_reason: "tool_calls"` 格式
- Anthropic 格式：同上，响应为 `stop_reason: "tool_use"` 及 `tool_use` content block
- 实现位于 `src/tools.js`：`buildToolsSection` / `detectToolCall` / `generateToolUseId`
- 流式时有工具：切换为缓冲模式（收完全文再判断是否工具调用），无工具则保持原有逐 delta 流式

### 图片支持（multimodal）
- OpenAI 格式：`{"type":"image_url","image_url":{"url":"..."}}`，支持 HTTP URL 和 `data:image/...;base64,...`
- Anthropic 格式：`{"type":"image","source":{"type":"base64",...}}` 或 `{"type":"url",...}`
- base64 图片自动上传至 Relevance AI 临时存储，URL 直接作为 attachment 传给 agent
- 实现位于 `src/multimodal.js`，`src/runtime.js` 的 `runAgentTask` 新增 `attachments` 参数

## Key Conventions

- 后端纯 ESM（`import`/`export`），无 TypeScript 编译
- 数据库操作全部同步（better-sqlite3），无 ORM
- 环境变量不自动加载，本地运行需手动 `source .env.example`
- API Key 以 `sk-gw-` 前缀标识
- Deployment 创建时会在上游自动创建对应的 Agent（`upsertAgent`），删除时同步清理
