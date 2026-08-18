# Connect Toolbox

VSCode 插件：SSH / MySQL / Redis 连接管理工具箱。

## 功能

- **连接管理**：MySQL / Redis / SSH 连接配置的增删改，分组展示，密码存系统密钥链（SecretStorage）
- **SSH 远程终端**：双击 SSH 连接即可打开远程终端（Pseudoterminal）
- **SSH 隧道**：MySQL / Redis 支持通过 SSH 隧道连接（本地端口转发）
- **MySQL 客户端**：查询与表数据编辑（M2）
- **Redis 客户端**：键值浏览与编辑（M3）

## 开发

```bash
npm install
npm run build     # esbuild 打包到 dist/extension.js
npm run watch     # 监听模式
npm run typecheck # 类型检查
npm run package   # 打包 .vsix
```

F5 启动扩展开发宿主调试。

## 安全说明

- 密码/私钥口令仅存于 VSCode `SecretStorage`（系统密钥链），配置 JSON 只存引用
- 私钥文件不复制，仅记录路径（支持 `~` 展开）
