# Pittacus Relay

本地 LLM API 聚合桌面应用。把各家厂商的 API Key 放进 Pittacus Relay，它会在本机 `127.0.0.1` 起一个网关，并给你**一个地址 + 一个本地密钥**；再一键写入 Claude Code / opencode 的配置，之后直接在工具自带的 `/model` 列表里切换不同厂商的模型，不用改配置、不用切换器。

> 名字来自古希腊七贤之一、米蒂利尼的庇塔库斯（Pittacus of Mytilene）。标志是一只九头蛇：身体是你本机的网关，每个蛇头是一家模型提供方。开发期代号为 Hydra。

## 下载与安装

**[前往 Releases 下载最新版本 →](https://github.com/ctrlcakepro/pittacus-relay/releases/latest)**（发布说明里附有各安装包的 SHA-256 校验值）

| 系统 | 安装包 |
|---|---|
| Windows 10/11（x64） | `Pittacus-Relay-<版本>-win-x64.exe` |
| Windows on ARM | `Pittacus-Relay-<版本>-win-arm64.exe` |
| macOS Apple 芯片（M 系列） | `Pittacus-Relay-<版本>-mac-arm64.dmg` |
| macOS Intel | `Pittacus-Relay-<版本>-mac-x64.dmg` |

macOS 另提供同架构的 `.zip` 包，解压后把 `Pittacus Relay.app` 拖进"应用程序"即可，效果与 `.dmg` 相同。

目前安装包**没有代码签名**，首次打开会被系统拦截：

- **Windows**：SmartScreen 提示"已保护你的电脑"时，点"更多信息"→"仍要运行"。
- **macOS**：提示"无法验证开发者"或"已损坏"时，打开"系统设置 → 隐私与安全性"，在底部点"仍要打开"；或在终端执行 `xattr -cr "/Applications/Pittacus Relay.app"` 后再打开。

安装后 Pittacus Relay 常驻托盘（Windows）或菜单栏（macOS）。关闭窗口不会停止网关，要彻底退出请用托盘菜单里的"退出"，或运行 `"Pittacus Relay.exe" --quit`。

启动选项（"设置 → 启动"，托盘菜单里也能切换）：

- **开机自启动**：登录系统后自动运行 Pittacus Relay。Windows 写入当前用户的启动项（卸载时自动清除，升级时保留）；macOS 注册为登录项，首次开启可能需要在"系统设置 → 通用 → 登录项"中允许。
- **静默启动**：启动时不打开主窗口，只在托盘运行；再次双击 Pittacus Relay 图标或点击托盘图标即可打开。

界面语言支持简体中文与 English（"设置 → 语言"，默认跟随系统），托盘菜单与系统通知随之切换。

外观（"设置 → 外观"）：主题可选跟随系统、浅色或深色；强调色默认为品牌紫，另有蓝、紫、粉、红、橙、黄、绿、青、石墨九种 Apple 系统色，深浅模式下各自使用对应的官方色值。

"概览"页底部的 **API 用量** 按今天 / 7 天 / 30 天汇总请求数、输入 / 输出 tokens 与缓存命中，并按模型列出。Token 数取自供应商响应里的 `usage` 字段（不改动请求和响应），按天、按模型保存在本机的 `usage.json`，保留 90 天，不含对话内容；上游没有返回 `usage` 的请求只计入请求数。接入 opencode 时会打开 `includeUsage`，让流式回复也带上用量。

## 工作方式

```
Claude Code ──(Anthropic 格式)──┐
                                ├─► Pittacus Relay 127.0.0.1:17800 ──按模型名路由──► DeepSeek / Kimi / GLM / Qwen / …
opencode ────(OpenAI 格式)──────┘         注入各家真实 Key
```

- 模型名格式为 `供应商ID/模型`，如 `kimi/kimi-k2`；无歧义时也接受裸模型名。
- 工具请求了 Pittacus Relay 不认识的模型（如 Claude Code 内置的 `claude-haiku-*`），按"轻量模型 / 主模型"兜底。
- 第一期**不做协议互转**：请求直接转发到厂商自己的 Anthropic 或 OpenAI 兼容端点。
- 不做订阅账号（OAuth）转发，只聚合正规 API Key。

## 接入的工具

| 工具 | Pittacus Relay 写入的配置 | 切换方式 |
|---|---|---|
| Claude Code（v2.1.242+） | `~/.claude/settings.json` 的 `env` 与 `modelPicker` | `/model` |
| opencode | `~/.config/opencode/opencode.json` 中的 `provider.pittacus` | 模型列表中的 `pittacus/…` |

写入前会记录原值；"还原"只撤销 Pittacus Relay 写入的字段。增删模型、改端口、换密钥后会自动同步到已接入的工具。

## 安全

**厂商的真实 API Key 只留在 Pittacus Relay 里。** 写进 Claude Code / opencode 配置文件的只有 Pittacus Relay 的本地密钥，可随时一键更换。

- **只在本机**：网关只监听 `127.0.0.1`，所有请求需携带本地密钥；请求的 Host 必须是本机地址、且不接受来自网页的跨站请求（防 DNS rebinding）。
- **加密存储**：厂商 Key 用系统密钥存储（Electron `safeStorage`；Windows 为 DPAPI，macOS 为钥匙串）加密后保存，界面进程拿不到明文。
- **Key 与域名绑定**：修改供应商地址时，只要域名变了就必须重新填写 Key，已保存的 Key 不会被带到新地址。
- **不走明文、不跟随跳转**：上游只允许 https（本机地址如 Ollama 除外）；上游返回重定向时 Pittacus Relay 直接报错，不会带着 Key 跟过去。
- **文件权限**：Pittacus Relay 写入的配置文件在 macOS 上仅当前用户可读（0600）。
- **应用加固**：窗口禁止跳转到任何外部页面，IPC 只响应 Pittacus Relay 自己的界面；安装包关闭了 Electron 的 RunAsNode、`NODE_OPTIONS`、`--inspect` 等可被其他程序借用的入口，拒绝以远程调试参数启动，并校验 asar 完整性。
- **复制 Key 需验证**：在"供应商"页可以把某家的真实 Key 复制出来，但必须先在"设置 → 密钥保护"设置 PIN，每次复制都要输入 PIN，或开启后改用 Windows Hello / Touch ID。校验在主进程完成，界面进程始终拿不到明文；连续输错 5 次后按 30 秒起、逐次翻倍（最长 15 分钟）锁定，重启应用不会清零。复制的内容 30 秒后自动从剪贴板清除，并标记为不进入 Windows 剪贴板历史与云剪贴板（macOS 上标记为隐藏内容，供剪贴板管理工具识别）。忘记 PIN 只能重置，重置会同时清除所有已保存的 Key。
- **不看对话**：请求日志与用量统计只记录概要和 token 数，不记录对话内容，没有遥测。

**防护边界**（如实说明）：系统密钥存储能防止配置文件被拷走后解密、防止其他系统账户读取；但无法防御已在你账户下运行的恶意程序——它和 agent 工具一样能读到本地密钥。PIN 与 Windows Hello / Touch ID 只是复制前的身份确认，防的是别人趁你离开时在已解锁的电脑上把 Key 复制走，不是额外的加密层；Key 一旦进入剪贴板，同一账户下的其他程序在清除前都能读到。另外，目前安装包尚未代码签名，见路线图。

## 开发

```bash
npm install
npm run dev        # 启动开发模式
npm test           # 网关与配置写入的单元测试
npm run typecheck
npm run build
npm run dist:win   # Windows 安装包 → dist/
npm run dist:mac   # macOS 安装包（只能在 macOS 上执行）
npm run install:win  # 打包 + 静默覆盖安装到本机并启动（改完代码后用它更新本地安装版）
```

推送到 GitHub 后，`.github/workflows/build.yml` 会在 Windows 与 macOS 机器上分别打包；推送 `v*` 标签时自动创建包含全部安装包的草稿 Release。

改图标：标志是矢量绘制的，几何数据与动效参数在 `src/renderer/src/brand/geometry.ts`，动效样式在 `hydra-mark.css`（标志是一只九头蛇，文件名沿用 hydra）。修改后运行 `npm run brand`（需要 Python + Pillow，可用 `PYTHON` 环境变量指定解释器），会生成 `build/icon.png`（macOS）、`build/icon.ico`（Windows）、`resources/` 下的窗口与托盘图标，以及 `design/brand/` 下的黑白 SVG / PNG / ICO 全套和动效展示页 `showcase.html`。旧的紫色图标与生成脚本备份在 `design/brand/reference/violet/`。

`PITTACUS_RELAY_DATA_DIR`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME` 可把应用数据和写入目标指向临时目录，便于测试而不影响真实配置。

目录结构：

```
src/core/      网关、路由、配置存储、工具接入（不依赖 Electron，便于移植到鸿蒙版 Electron）
src/main/      Electron 主进程：窗口、托盘、IPC
src/preload/   安全桥接（contextIsolation + sandbox）
src/renderer/  React 界面
src/shared/    主进程与界面之间的类型契约
```

## 路线图

- [x] Windows / macOS 安装包（electron-builder + GitHub Actions）
- [ ] 代码签名与公证（Windows 证书、Apple Developer ID），去掉首次打开的系统拦截
- [ ] 自动更新
- [ ] OpenAI ↔ Anthropic 协议互转（让只有 OpenAI 端点的模型也能用于 Claude Code）
- [ ] Codex（OpenAI Responses API）接入
- 设想：鸿蒙 PC 版（暂不排期；需先在真机验证沙箱能否写入工具配置、终端能否访问本地端口）
