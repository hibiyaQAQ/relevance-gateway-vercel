# Repository Guidelines

## 项目结构与模块组织

- `src/`：Node.js ESM 后端。`server.js` 是 HTTP 入口，`services.js` 负责业务逻辑，`runtime.js` 处理上游 Agent 调用，`db.js` 管理 SQLite。
- `frontend/src/`：React + TypeScript 管理后台。页面放在 `pages/`，布局在 `layouts/`，通用组件在 `components/ui/`。
- `static/admin/`：前端构建产物，由后端静态托管，不要直接手改。
- `data/`：本地数据库目录，默认文件为 `data/gateway.db`。
- `scripts/`：集成验证与自测脚本，例如 `self_test.py`、`test_fetch_tool.mjs`。

## 构建、测试与开发命令

- `npm install`：安装后端依赖。
- `npm run dev`：以 `node --watch src/server.js` 启动后端开发模式。
- `npm start`：启动后端服务。
- `npm --prefix frontend install`：安装前端依赖。
- `npm --prefix frontend run dev`：启动 Vite 开发服务器，并将 `/admin-api`、`/v1` 代理到 `http://127.0.0.1:8080`。
- `npm --prefix frontend run build`：将后台构建到 `static/admin/`。
- `docker compose up --build -d`：启动完整环境，默认地址为 `http://127.0.0.1:18080`。
- `python scripts/self_test.py`：运行端到端自测，需先设置 `SELF_TEST_UPSTREAM_*` 环境变量。

## 编码风格与命名约定

- 统一使用 2 空格缩进，保持现有文件风格，避免无关格式化。
- 后端使用原生 ESM `import`/`export`；模块名采用语义化小写文件名，如 `error-utils.js`、`relevance-rest.js`。
- 前端组件、页面、布局使用 `PascalCase`，工具函数与变量使用 `camelCase`。
- 当前未配置独立 `eslint` 或 `prettier`；前端以 TypeScript `strict` 编译为主要约束，提交前至少执行一次 `npm --prefix frontend run build`。

## 测试指南

- 当前测试以仓库脚本为主，不依赖单一测试框架。
- 新增 Python 检查脚本时使用 `test_*.py` 或 `self_test.py` 命名；Node 脚本参考 `test_*.mjs`。
- 涉及接口、流式输出、工具调用或管理后台交互的改动，应补充对应脚本或手工验证步骤，并在变更说明中写明命令。

## 提交与 Pull Request 规范

- 现有历史较少，但已使用 `chore: init open source release` 这类前缀；后续提交建议统一为 `<type>: <summary>`，例如 `fix: handle stalled stream fallback`。
- Pull Request 需说明目的、影响范围和验证命令；涉及 UI 的改动附截图；涉及接口、环境变量或部署行为时同步更新 `README.md`。

## 安全与协作约定

- 不要提交 `.env`、`data/*.db`、真实网关密钥或 `static/admin/` 构建产物。
- 项目不会自动加载 `dotenv`，本地运行前请显式导出环境变量。
- 仓库内沟通、文档和新增代码注释统一使用中文。
