import * as vscode from "vscode";
import { dirname } from "node:path";

/**
 * 当前 VS Code 窗口在 DSH 中应对应的工作区目录。
 *
 * DevDesk 用多根 .code-workspace 组织一个需求工作区：folders 常为 user、manager
 * 等子仓库目录，而 DSH 只把「需求根目录」（= .code-workspace 所在目录）注册为
 * workspace。若沿用 vscode.workspace.workspaceFolders[0]（对若干需求恰是 user
 * 子目录）去 DSH 解析/注册，会匹配不到根 workspace，并自动在子目录新建一个
 * 独立的 user workspace，导致两边对不上。
 *
 * 因此打开的是 .code-workspace 时取其所在目录作为 DSH 工作区目录；仅普通
 * 单目录工作区（无 .code-workspace）才回退到 workspaceFolders[0]。
 */
export function dshWorkspaceRoot(): string | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile !== undefined && /\.code-workspace$/i.test(workspaceFile.fsPath)) {
    return dirname(workspaceFile.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
