# Relevance Gateway Lab

## ⚠️ 免责声明

> 本项目仅供学习、研究和测试使用，请勿用于任何违法违规、滥用上游服务或违反第三方服务条款的用途。  
> 使用本项目所涉及的上游账号、API Key、计费、风控、封禁、内容合规、数据安全及相关责任，均由实际使用者自行承担。  
> 本项目与任何第三方服务提供商不存在官方关联，作者及贡献者不对因使用、部署或二次开发本项目所造成的任何直接或间接损失承担责任。

一个把 Relevance AI Agent 暴露成兼容接口的单端口网关项目。

同时提供：

- 管理后台：`/admin`
- **OpenAI 兼容 API**：`/v1/models`、`/v1/chat/completions`
- **Anthropic 兼容 API**：`/v1/messages`

适合用来做：

- 给 Cherry Studio、Open WebUI、AnythingLLM 一类客户端接入 Relevance AI
- 给 **Claude Code** 提供 Anthropic 格式接入（支持工具调用）
- 用一个统一入口管理上游 Project / Region / API Key
- 通过后台快速部署、同步和调试可用模型

## 项目简介

`relevance-gateway-lab` 是一个基于 Node.js + Express + SQLite 的 Relevance AI 网关实验项目。

核心目标：把 Relevance AI 上游 Agent 包装成 OpenAI / Anthropic 风格的 API，同时提供一个轻量后台，用来管理上游密钥、模型目录、部署记录、网关密钥和请求日志。

运行时采用官方 `@relevanceai/sdk`，并做了以下增强：

- 优先走 SDK / SSE 真流式
- 断流或长时间静默时自动切到 `view` 轮询兜底
- 收尾阶段补齐最终内容，尽量避免客户端看到半截回复

## 功能特性

- 单端口服务，同时承载后台和 API
- **OpenAI 兼容**：`/v1/models`、`/v1/chat/completions`（流式 / 非流式）
- **Anthropic 兼容**：`/v1/messages`（流式 / 非流式），适配 Claude Code
- **工具调用（Tool Use）**：OpenAI `tools` / Anthropic `tools` 均支持，自动识别模型的工具调用意图并转换为标准格式
- **图片输入（Multimodal）**：支持 HTTP URL 图片和 base64 内嵌图片，自动上传至 Relevance AI 临时存储
- 后台管理上游 Relevance Key、模型目录、部署和网关 Key
- 按模型维度管理 deployment，支持同步和批量部署
- 请求日志落 SQLite，便于排查流式、成本、tokens 和失败原因
- Docker Compose 一键启动，本地调试成本低

## 快速开始

推荐直接使用 Docker Compose。

### 1. 准备环境变量

```bash
cp .env.example .env
```

至少建议改掉：

- `APP_SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

### 2. 启动服务

```bash
docker compose up --build -d
```

默认访问地址：

- 管理后台：`http://127.0.0.1:18080/admin`
- API 根地址：`http://127.0.0.1:18080`

### 3. 在后台完成初始化

建议按下面顺序操作：

1. 添加一个上游 Relevance Key
2. 刷新模型目录
3. 为目标模型创建 deployment（`public_model_name` 就是客户端请求时用的模型名）
4. 创建一个 Gateway API Key

## 安装

### 运行要求

- Node.js 20+
- npm
- Docker / Docker Compose（推荐）
- Python 3（仅自测脚本需要）

### 本地运行

```bash
npm install
npm --prefix frontend install
npm --prefix frontend run build
node src/server.js
```

默认本地地址：`http://127.0.0.1:8080`

项目没有内置 `dotenv`，本地直跑需先导出环境变量：

```bash
set -a
source .env.example
set +a
node src/server.js
```

## 使用方法

### 管理后台

入口：`/admin`，后台 API 前缀：`/admin-api/*`

功能包括：登录/退出、管理上游 Relevance Key、查看模型目录缓存、管理 deployment、管理网关 API Key、查看请求日志。

### OpenAI 兼容 API

#### 查询模型

```bash
curl http://127.0.0.1:18080/v1/models \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>"
```

#### 对话（非流式）

```bash
curl http://127.0.0.1:18080/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "stream": false,
    "messages": [
      { "role": "user", "content": "你好，介绍一下你自己。" }
    ]
  }'
```

#### 对话（流式）

```bash
curl -N http://127.0.0.1:18080/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "stream": true,
    "messages": [
      { "role": "user", "content": "请用中文写两段介绍 Node.js。" }
    ]
  }'
```

#### 工具调用

请求中携带 `tools` 字段，网关会将工具定义注入上游 prompt，并在响应中自动识别模型的工具调用意图：

```bash
curl http://127.0.0.1:18080/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "messages": [{ "role": "user", "content": "查一下北京今天天气" }],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询城市天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          },
          "required": ["city"]
        }
      }
    }]
  }'
```

#### 图片输入

`image_url` 支持 HTTP URL 或 base64 data URL：

```bash
curl http://127.0.0.1:18080/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "这张图里有什么？" },
        { "type": "image_url", "image_url": { "url": "https://example.com/image.jpg" } }
      ]
    }]
  }'
```

### Anthropic 兼容 API

网关同时暴露 `/v1/messages` 端点，格式与 Anthropic API 完全兼容。

#### 对话（非流式）

```bash
curl http://127.0.0.1:18080/v1/messages \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "你好！" }
    ]
  }'
```

#### 对话（流式）

```bash
curl -N http://127.0.0.1:18080/v1/messages \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      { "role": "user", "content": "请用中文写两段介绍 Node.js。" }
    ]
  }'
```

#### 工具调用

```bash
curl http://127.0.0.1:18080/v1/messages \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "anthropic-claude-opus-4-6",
    "max_tokens": 1024,
    "tools": [{
      "name": "get_weather",
      "description": "查询城市天气",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": { "type": "string" }
        },
        "required": ["city"]
      }
    }],
    "messages": [{ "role": "user", "content": "查一下北京今天天气" }]
  }'
```

### 接入 Claude Code

Claude Code 使用 Anthropic API 格式，可以直接将本网关作为后端。

在 Claude Code 的配置中设置：

```json
{
  "apiUrl": "http://your-gateway-host:18080",
  "apiKey": "sk-gw-xxxxxx",
  "model": "你在网关部署的 public_model_name"
}
```

或通过环境变量：

```bash
export ANTHROPIC_BASE_URL=http://your-gateway-host:18080
export ANTHROPIC_API_KEY=sk-gw-xxxxxx
claude --model anthropic-claude-opus-4-6
```

`model` 字段填写你在网关后台创建 deployment 时设置的 `public_model_name`。

Claude Code 的所有工具调用（文件读写、bash 执行等）都会经由 Relevance AI Agent 完整处理。

### 运行机制说明

```
客户端请求
  │
  ├─ 解析消息（文本 / 图片 / tool_use / tool_result）
  ├─ 图片 base64 → 上传至 Relevance AI 临时存储
  ├─ 按最近最少使用策略选取 active deployment
  ├─ 构建 transcript prompt（含工具定义、对话历史）
  │
  └─ runAgentTask（@relevanceai/sdk）
       │
       ├─ 优先 SSE 流式 ──────────────────────────────→ 逐 delta 输出
       │   （无工具时直接转发，有工具时缓冲）
       │
       ├─ SSE 静默超阈值 → 切 view 轮询兜底 ──────────→ 平滑分块输出
       │
       └─ 任务结束 → waitForConversationResult
            ├─ 检测工具调用 JSON → 返回 tool_use/tool_calls 响应
            └─ 普通文本 → 补齐 usage / cost 后返回
```

## 配置说明

### 核心配置

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_NAME` | `Relevance Gateway` | 服务名称 |
| `APP_SECRET_KEY` | `change-me-super-secret` | 后台会话签名密钥 |
| `ADMIN_USERNAME` | `admin` | 后台登录用户名 |
| `ADMIN_PASSWORD` | `admin` | 后台登录密码 |
| `PORT` | `8080` | 本地直跑监听端口 |
| `DATABASE_URL` | `sqlite:////app/data/gateway.db` | SQLite 数据库路径 |

### 流式与 fallback 配置

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_POLL_TIMEOUT_SECONDS` | `300` | 单次上游请求总超时 |
| `STREAM_HEARTBEAT_INTERVAL_SECONDS` | `8` | 下游 SSE 心跳间隔 |
| `TASK_METADATA_POLL_INTERVAL_SECONDS` | `1` | metadata 轮询间隔 |
| `TASK_VIEW_POLL_INTERVAL_SECONDS` | `1` | `view` 轮询间隔 |
| `STREAM_FALLBACK_INITIAL_SILENCE_SECONDS` | `10` | 首字前静默多久触发 fallback |
| `STREAM_FALLBACK_SILENCE_SECONDS` | `5` | 首字后静默多久触发 fallback |
| `STREAM_FALLBACK_SMOOTH_CHUNK_CHARS` | `24` | fallback 平滑输出的单块字符数上限 |
| `STREAM_FALLBACK_SMOOTH_CHUNK_DELAY_MS` | `25` | fallback 平滑输出的块间隔 |

### 调试配置

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `DEBUG_RUNTIME` | `false` | 是否开启运行时调试日志 |
| `DEBUG_STREAM_PAYLOADS` | `false` | 是否打印流式内容预览 |
| `DEBUG_STREAM_PAYLOAD_PREVIEW_CHARS` | `160` | 内容预览长度 |
| `DEBUG_STREAM_STALL_WARNING_SECONDS` | `15` | 流式卡顿告警阈值 |
| `DEBUG_STREAM_WATCHDOG_INTERVAL_SECONDS` | `5` | watchdog 检查间隔 |

## 自测

仓库内自带一个简单的 Python 自测脚本：

```bash
SELF_TEST_UPSTREAM_PROJECT=... \
SELF_TEST_UPSTREAM_REGION=... \
SELF_TEST_UPSTREAM_API_KEY=... \
python3 scripts/self_test.py
```

适合用来验证上游凭证是否可用、模型触发是否成功、网关基础链路是否正常。

## 项目结构

```
.
├── src/
│   ├── server.js           # Express 入口，所有路由（OpenAI + Anthropic + admin）
│   ├── services.js         # 业务逻辑：CRUD、消息规范化、prompt 构建、deployment 选择
│   ├── runtime.js          # Agent 任务执行引擎（SDK SSE + view 轮询兜底）
│   ├── anthropic-format.js # Anthropic API 格式解析与响应构造
│   ├── tools.js            # 工具调用：prompt 注入、响应检测
│   ├── multimodal.js       # 图片处理：格式解析、base64 上传
│   ├── relevance-rest.js   # Relevance AI REST API 轻量客户端
│   ├── config.js           # 环境变量配置
│   ├── db.js               # SQLite 初始化与 schema 管理
│   ├── security.js         # admin session、gateway key 生成
│   └── error-utils.js      # 错误序列化与分类
├── frontend/               # 后台前端（React + Vite + Tailwind）
├── static/                 # 构建后的静态资源
├── scripts/                # 自测和辅助脚本
├── data/                   # SQLite 数据库与运行数据
├── docker-compose.yml
└── README.md
```

## 致谢

本项目在 [LINUX DO](https://linux.do/) 社区推广，感谢 LINUX DO 社区对开源项目的支持与认可。
