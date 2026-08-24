# dsh-vscode-bridge

DSH GUI 嵌入 VS Code webview 时的页面桥接插件，提供：

- 页面内 CSS `zoom` 清晰缩放，并与扩展握手；插件未加载时扩展自动保留 `transform: scale()` 回退。
- 跨源 iframe 的复制、粘贴、剪切、全选和图片粘贴桥接。

只在 GUI 被嵌入（`window.parent` 存在）时激活；普通浏览器打开 DSH 时无任何行为。

## 构建与安装

```sh
npm install
npm run build
npm pack
dsh plugin --profile web add ./dsh-vscode-bridge-0.1.0.tgz
```

安装后需要重启 `dsh web`。

## 协议

- 页面 → 宿主：`{ source: "dsh-vscode-bridge", type: "ready" | "clearZoomApplied" | "write" | "read", ... }`
- 宿主 → 页面：`{ source: "dsh-vscode-bridge-host", type: "setClearZoom" | "inject" | "injectImage", ... }`
