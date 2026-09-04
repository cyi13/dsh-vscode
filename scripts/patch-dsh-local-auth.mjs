#!/usr/bin/env node

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dshRoot =
  process.env.DSH_INSTALL_ROOT ??
  join(homedir(), ".local/lib/node_modules/@deepseek-ai/dsh");
const connectionRoot = join(
  dshRoot,
  "node_modules/@deepseek-ai/dsh-client-connection",
);
const packagePath = join(connectionRoot, "package.json");
const targetPath = join(connectionRoot, "lib/index.js");
const marker = "dsh-vscode-local-no-auth";

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
let source = await readFile(targetPath, "utf8");
if (source.includes(`const LOCAL_NO_AUTH_SENTINEL = \"${marker}\"`)) {
  console.log(`[dsh-vscode] local-only auth patch already applied (${packageJson.version})`);
  process.exit(0);
}

const constantsBefore = `const CHANNEL_PATTERN = /^\\/[A-Za-z0-9._~-]+$/;\nconst ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;`;
const constantsAfter = `const CHANNEL_PATTERN = /^\\/[A-Za-z0-9._~-]+$/;\nconst ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;\nconst LOCAL_NO_AUTH_SENTINEL = "${marker}";\nfunction allowsLocalNoAuth(trustedHosts, headers) {\n\tif (!trustedHosts.includes(LOCAL_NO_AUTH_SENTINEL)) return false;\n\tconst authority = requestAuthority(headers);\n\tif (authority === void 0) return false;\n\ttry {\n\t\tconst hostname = new URL(\`http://\${authority}\`).hostname;\n\t\treturn hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";\n\t} catch {\n\t\treturn false;\n\t}\n}\nfunction isLoopbackUrl(value) {\n\ttry {\n\t\tconst hostname = new URL(value).hostname;\n\t\treturn hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";\n\t} catch {\n\t\treturn false;\n\t}\n}`;

const methodsBefore = `\trequestRejection(request) {\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n\t}\n\t/** Authenticate an index request through the process-token exchange or cookie. */\n\tauthorizeIndex(request, response) {\n\t\treturn this.browserAuth.authorizeIndex(request, response);\n\t}\n\t/** Add this process's launch token to the clean application URL. */\n\tauthenticatedUrl(baseUrl) {\n\t\treturn this.browserAuth.authenticatedUrl(baseUrl);\n\t}`;
const methodsAfter = `\trequestRejection(request) {\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\tif (allowsLocalNoAuth(this.trustedHosts, request.headers)) return void 0;\n\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n\t}\n\t/** Authenticate an index request through the process-token exchange or cookie. */\n\tauthorizeIndex(request, response) {\n\t\tif (allowsLocalNoAuth(this.trustedHosts, request.headers)) return true;\n\t\treturn this.browserAuth.authorizeIndex(request, response);\n\t}\n\t/** Add this process's launch token to the clean application URL. */\n\tauthenticatedUrl(baseUrl) {\n\t\tif (this.trustedHosts.includes(LOCAL_NO_AUTH_SENTINEL) && isLoopbackUrl(baseUrl)) return baseUrl;\n\t\treturn this.browserAuth.authenticatedUrl(baseUrl);\n\t}`;

if (!source.includes(constantsBefore) || !source.includes(methodsBefore)) {
  throw new Error(
    `Unsupported @deepseek-ai/dsh-client-connection ${packageJson.version}; patch anchors changed`,
  );
}

source = source
  .replace(constantsBefore, constantsAfter)
  .replace(methodsBefore, methodsAfter);
const backupPath = `${targetPath}.dsh-vscode-backup-${packageJson.version}`;
await copyFile(targetPath, backupPath).catch(() => undefined);
await writeFile(targetPath, source, "utf8");
console.log(
  `[dsh-vscode] patched local-only browser auth bypass (${packageJson.version})`,
);
console.log(`[dsh-vscode] backup: ${backupPath}`);
