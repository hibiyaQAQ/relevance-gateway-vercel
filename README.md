# Relevance Gateway Lab

## ⚠️ 免责声明

> 本项目仅供学习、研究和测试使用，请勿用于任何违法违规、滥用上游服务或违反第三方服务条款的用途。  
> 使用本项目所涉及的上游账号、API Key、计费、风控、封禁、内容合规、数据安全及相关责任，均由实际使用者自行承担。  
> 本项目与任何第三方服务提供商不存在官方关联，作者及贡献者不对因使用、部署或二次开发本项目所造成的任何直接或间接损失承担责任。

一个把 Relevance AI Agent 暴露成 OpenAI 兼容接口的单端口网关项目。

它同时提供：

- 管理后台：`/admin`
- OpenAI 兼容 API：`/v1/models`、`/v1/chat/completions`

适合用来做：

- 给 Cherry Studio、Open WebUI、AnythingLLM 一类客户端接入 Relevance AI
- 用一个统一入口管理上游 Project / Region / API Key
- 通过后台快速部署、同步和调试可用模型

## 项目简介

`relevance-gateway-lab` 是一个基于 Node.js + Express + SQLite 的 Relevance AI 网关实验项目。

它的核心目标是：把 Relevance AI 上游 Agent 包装成 OpenAI 风格的 API，同时提供一个轻量的后台，用来管理上游密钥、模型目录、部署记录、网关密钥和请求日志。

当前运行时采用官方 `@relevanceai/sdk`，并对流式输出做了增强：

- 优先走 SDK / SSE 真流式
- 断流或长时间静默时自动切到 `view` 轮询兜底
- 收尾阶段补齐最终内容，尽量避免客户端看到半截回复

## 功能特性

- 单端口服务，同时承载后台和 API
- OpenAI 兼容接口，可直接对接支持 `chat/completions` 的客户端
- 后台管理上游 Relevance Key、模型目录、部署和网关 Key
- 按模型维度管理 deployment，支持同步和批量部署
- 请求日志落 SQLite，便于排查流式、成本、tokens 和失败原因
- 官方 SDK 流式优先，`view` 轮询自动兜底
- fallback 支持 `thinking` 与正文顺序控制，避免交错输出
- Docker Compose 一键启动，本地调试成本低

## 快速开始

推荐直接使用 Docker Compose。

### 1. 准备环境变量

```bash
cp .env.example .env
```

如果只是本地试跑，默认值通常已经够用。至少建议改掉：

- `APP_SECRET_KEY`
- `APP_ENCRYPTION_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

### 2. 启动服务

```bash
docker compose up --build -d
```

默认访问地址：

- 管理后台：`http://127.0.0.1:18080/admin`
- API 根地址：`http://127.0.0.1:18080`

### 3. 登录后台

默认账号密码来自环境变量：

- 用户名：`ADMIN_USERNAME`
- 密码：`ADMIN_PASSWORD`

如果你直接使用 `.env.example`，默认是：

- 用户名：`admin`
- 密码：`admin`

### 4. 在后台完成初始化

建议按下面顺序操作：

1. 添加一个上游 Relevance Key
2. 刷新模型目录
3. 为目标模型创建 deployment
4. 创建一个 Gateway API Key
5. 用这个 Gateway API Key 请求 `/v1/models` 和 `/v1/chat/completions`

## 安装

### 运行要求

- Node.js 20+
- npm
- Docker / Docker Compose（推荐）
- Python 3（仅自测脚本需要）

### 本地运行

如果你不想用 Docker，也可以直接本地运行：

```bash
npm install
npm --prefix frontend install
npm --prefix frontend run build
node src/server.js
```

默认本地地址：

```bash
http://127.0.0.1:8080
```

注意：

- 项目本身没有内置 `dotenv` 加载逻辑
- 如果你本地直跑，需要自己导出环境变量

例如：

```bash
set -a
source .env.example
set +a
node src/server.js
```

## 使用方法

### 管理后台

后台相关接口和页面主要用于：

- 登录和退出
- 管理上游 Relevance Key
- 查看模型目录缓存
- 创建、更新、删除 deployment
- 创建、删除网关 API Key
- 查看请求日志

管理后台入口：

```bash
/admin
```

后台 API 前缀：

```bash
/admin-api/*
```

### OpenAI 兼容 API

#### 查询模型

```bash
curl http://127.0.0.1:18080/v1/models \
  -H "Authorization: Bearer <YOUR_GATEWAY_KEY>"
```

#### 发起非流式对话

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

#### 发起流式对话

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

### 运行机制说明

当前网关的执行路径大致如下：

1. 接收 OpenAI 风格 `messages[]`
2. 将整段对话编译成上游 transcript prompt
3. 使用官方 `@relevanceai/sdk` 调用目标 Agent
4. 优先消费 SDK / SSE 流式输出
5. 如果上游长时间静默，则切到 `view` 轮询兜底
6. 最终补齐 usage / cost / 最终文本并收尾

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

适合用来验证：

- 上游凭证是否可用
- 模型触发是否成功
- 网关基础链路是否正常

## 项目结构

```bash
.
├── src/                # Express 服务端、运行时、数据层
├── frontend/           # 后台前端（React + Vite）
├── static/             # 构建后的静态资源
├── scripts/            # 自测和辅助脚本
├── data/               # SQLite 数据库与运行数据
├── docker-compose.yml  # Docker 启动配置
└── README.md
```
