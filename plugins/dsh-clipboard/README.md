# dsh-clipboard

DSH GUI 嵌入 VS Code webview 时的剪贴板桥接插件。

VS Code 的 webview 会禁止跨源 iframe 访问系统剪贴板（即使配置了
`sandbox`/`allow` 属性也不行，见 microsoft/vscode#182642）。本插件在
DSH 页面内监听 `copy`/`cut`/`paste`，通过 `postMessage` 把内容转发给嵌入
宿主（dsh-sessions 扩展），宿主用 VS Code API `vscode.env.clipboard`
读写系统剪贴板后再回传注入。

只在 GUI 被嵌入（`window.parent` 存在）时激活；普通浏览器打开 DSH 时
无任何行为。

## 构建与安装

```sh
npm install
npm run build          # 生成 lib/
npm pack               # 生成 dsh-clipboard-0.1.0.tgz
dsh plugin --profile web add ./dsh-clipboard-0.1.0.tgz
```

重启 web 服务器后生效。

## 协议

- 页面 → 宿主：`{ source: "dsh-clipboard", type: "write", text }` /
  `{ source: "dsh-clipboard", type: "read" }`
- 宿主 → 页面：`{ source: "dsh-clipboard-host", type: "inject", text }`
