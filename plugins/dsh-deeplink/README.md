# dsh-deeplink

DSH web GUI 的深链支持插件：加载时读取 URL 参数 `?session=<id>`（可选 `?workspace=<id>`），
等会话列表就绪后自动打开对应会话。外部调用方（如 dsh-sessions VS Code 扩展）即可直接
跳到某个会话，而不是落在无会话的空页面。

- 纯客户端行为，host 侧只是一个空行（为了让 client bundle 被发现并服务）。
- 无 tools、无 skills、无设置项。

## 构建与安装

```sh
npm install
npm run build          # 生成 lib/
npm pack               # 生成 dsh-deeplink-0.1.0.tgz
dsh plugin --profile web add ./dsh-deeplink-0.1.0.tgz
```

然后按 DSH 文档重启 web 服务器并刷新页面。

## 用法

```
http://127.0.0.1:3080/?session=<sessionId>
http://127.0.0.1:3080/?workspace=<workspaceId>&session=<sessionId>
```
