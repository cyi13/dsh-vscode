# DSH Sessions

在 VS Code 里管理 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的会话：只显示**当前工作区**的会话，点开会话直接进入 DSH 对话界面（像 Codex 一样停在右侧），并支持重命名 / 分叉 / 归档 / 复制粘贴。

## 功能

- **当前工作区会话列表**：左侧 DSH Sessions 树 + 右侧 DSH 面板列表，按最近活跃排序；运行中的会话带**转圈动画**（每 5 秒自动刷新状态）。
- **一键进入会话**：点会话 → 右侧副边栏内嵌 DSH 网页，直接定位到该会话（深链 `?session=`）。
- **会话操作**：重命名、分叉会话、归档会话（左右两处右键菜单均可）。
- **剪贴板桥接**：在 DSH 面板里复制 / 粘贴（文本秒级；图片粘贴走 macOS 系统剪贴板，可进附件栏）、Cmd+A 全选、Cmd+X 剪切。
- **面板控制**：缩放（60%–140%）、刷新、返回列表。
- 路径匹配做 `realpath` 规范化；未注册的工作区文件夹会自动注册。

## 依赖

- 本机运行着 **DSH web**（`dsh web`，默认 `http://127.0.0.1:3080`）。
- 需要两个 DSH 插件（源码在仓库 `plugins/`，构建安装见 [PLUGINS.md](PLUGINS.md)）：
  - `dsh-deeplink`：会话深链（`?session=`）
  - `dsh-clipboard`：剪贴板桥接

```sh
# 构建并安装（详见 PLUGINS.md）
cd plugins/dsh-deeplink && npm install && npm run build && npm pack
dsh plugin --profile web add ./dsh-deeplink-0.1.0.tgz
# 同理安装 dsh-clipboard
```
安装后重启 dsh web 并刷新页面。

## 安装

### VS Code Marketplace（发布后）

在 Extensions 里搜索 **DSH Sessions** 安装。

### 本地 / VSIX

```sh
npm run package     # 生成 dsh-sessions-0.1.0.vsix
code --install-extension dsh-sessions-0.1.0.vsix
```

## 配置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `dshSessions.baseUrl` | `http://127.0.0.1:3080` | DSH web 服务地址 |
| `dshSessions.autoRegister` | `true` | 打开未注册的文件夹时自动注册为 DSH workspace |

## 使用

- 左侧 **DSH Sessions** 树：当前工作区的会话；点击进入，右键有操作菜单。
- 右侧 **DSH** 面板：默认会话列表；点会话进入 DSH 界面，`←` 返回，`−`/`+` 缩放。
- 在 DSH 输入框内可复制 / 粘贴 / 剪切 / 全选。

## 开发

```sh
npm install
npm run compile     # 构建到 dist/
code .              # F5 启动 Extension Development Host 调试
```

## 限制

- 图片粘贴依赖 macOS 系统剪贴板（osascript），仅 macOS 可用。
- 归档会话后 DSH 网页当前没有"取消归档"界面（会话数据与日志保留，不删除）。
- 需要 DSH 0.1.0-rc.6 及以上的 web 版本。

## License

[MIT](LICENSE)
