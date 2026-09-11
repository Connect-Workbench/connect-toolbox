# Changelog

本项目的所有重要变更都记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.5] - 2026-09-11

### 变更

- 侧边栏（活动栏）图标更新为品牌「节点 C」风格单色设计，与扩展市场图标统一

## [0.3.4] - 2026-09-11

### 变更

- MCP SDK 升级至 v2：`@modelcontextprotocol/sdk@1.30` → `@modelcontextprotocol/server@2.0.0`（含 core 2.0.0），zod 改为显式依赖 `^4.2.0`
- MCP server 运行要求提升至 Node.js >= 20（node 探测与构建目标同步调整）

### 修复

- MCP server 进程生命周期加固：修复宿主异常退出后的孤儿残留与 CPU 忙循环（PPID 轮询兜底、stdio 断开即退出、强制退出超时）
- 扩展激活时自动刷新 MCP server 软链，修复扩展升级后软链断链问题

## [0.3.0] - 2026-09-03

### 新增

- MCP server 支持无 `--config` 启动：未指定时自动读取固定用户目录下的 `~/.connect-toolbox/mcp-config.json`
- 生成 MCP 配置时自动创建 server 软链 `~/.connect-toolbox/mcp-server.js`，缩短 mcpServers 片段路径
- 生成 MCP 配置时自动探测合适的 node：默认 node >= 18 时使用 `node`，否则取 nvm 中 >= 18 的最高版本绝对路径
- 设置面板展示 node 探测结果

### 变更

- MCP 配置文件从 VS Code globalStorage 迁移至 `~/.connect-toolbox/mcp-config.json`（与宿主无关，VS Code / CodeBuddy / Cursor 可共用）
- 移除 MCP status 心跳写盘机制：不再每 5 秒 / 每次 SQL 执行同步写状态文件
- 移除「查看 MCP 状态」命令及其本地化文案
- MCP server 内部版本号同步至 0.3.0

### 修复

- 修复 MCP 进程在 stdout 管道断开（EPIPE）后不退出、持续空转写心跳导致的 CPU 高占用问题

## [0.2.0] - 2026-08-27

### 新增

- MCP server 动态工具化：每个 MySQL 直连连接注册一个 `execute_{name}` 工具，接入 `@connect_workbench/mcp-core`
- 设置面板与 MCP 配置生成

## [0.1.2] - 2026-08-24

### 新增

- Connect Workbench 品牌标识

## [0.1.1] - 2026-08-20

### 变更

- 发布准备

## [0.1.0] - 2026-08-20

### 新增

- connect-toolbox VS Code 插件初始版本：SSH / MySQL / Redis 连接管理工具箱
- 远程终端、数据查询与表格编辑、i18n（中/英）
- GitHub Actions CI
