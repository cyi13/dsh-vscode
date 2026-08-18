# DSH 依赖插件

dsh-sessions 扩展依赖两个 DSH 插件（安装到 `dsh web` profile），本仓库已包含源码：

| 插件 | 目录 | 作用 | 是否必需 |
| --- | --- | --- | --- |
| `dsh-deeplink` | `plugins/dsh-deeplink` | DSH web GUI 深链：URL `?session=<id>` 直达会话 | 必需（点会话跳转） |
| `dsh-clipboard` | `plugins/dsh-clipboard` | 剪贴板桥：VS Code webview 内复制/粘贴/剪切 | 必需（复制粘贴） |

> 两者职责不同：deeplink 解决"定位会话"，clipboard 解决"webview 剪贴板被禁"。缺一个，扩展的部分功能即不可用。

## 构建与安装

每个插件都是独立的 pnpm/npm 包，构建方式一致：

```sh
cd plugins/dsh-deeplink
npm install
npm run build          # 生成 lib/
npm pack               # 生成 dsh-deeplink-0.1.0.tgz

# 安装进 dsh web profile
dsh plugin --profile web add ./dsh-deeplink-0.1.0.tgz
```

```sh
cd plugins/dsh-clipboard
npm install
npm run build          # 生成 lib/
npm pack               # 生成 dsh-clipboard-0.1.0.tgz

dsh plugin --profile web add ./dsh-clipboard-0.1.0.tgz
```

> 注意：`npm pack` 生成的 tarball 与 `node_modules`、`lib/` 一样，已被插件自身的 `.gitignore` 忽略，不会提交进仓库。

## 安装后重启

按 DSH 文档，安装插件后需要**重启 web 服务器**（`kill -TERM <pid>` 优雅退出，再 `dsh web`），然后刷新页面。

## 验证

- 深链：浏览器打开 `http://127.0.0.1:3080/?session=<某个会话id>` 应直达该会话。
- 剪贴板：在 VS Code 的 DSH 面板里 Cmd+V / Cmd+C / Cmd+X 应正常。

## 开发

两个插件共用相同的工程结构（host 空行 + client bundle，esbuild 打包）：
- `src/index.ts`：host 插件（空行，让 client-modules 发现 bundle）
- `src/client.ts`：浏览器端逻辑（deeplink 读 URL / clipboard 桥接）
- `cordis.patch.yml`：把插件挂进 profile 的 bundle 层
