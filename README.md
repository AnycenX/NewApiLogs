# WebApiLogs

基于 `Tauri 2 + React + TypeScript + Rust + SQLite` 的跨平台桌面日志客户端，用于登录 New API 并查看、缓存、筛选、导出个人日志数据。

## 项目定位

这个项目面向桌面使用场景，目标是提供一个比网页更稳定、响应更快、适合长期查看日志的本地客户端。

核心思路：

- 使用 `Tauri` 构建轻量桌面应用
- 使用 `React + TypeScript` 提供前端界面
- 使用 `Rust` 负责本地命令、配置、网络请求与数据处理
- 使用 `SQLite` 做本地缓存，减少重复请求并提升查询体验

## 功能概览

- 使用 `BaseUrl + UserId + Token` 进行登录校验
- 拉取并展示用户状态与今日消费
- 同步 `/api/log/self` 日志数据
- 优先读取本地 SQLite 缓存
- 支持按模型、Token、请求 ID、时间范围筛选
- 支持本地缓存管理与日志导出
- 支持浅色、深色、跟随系统三种主题
- 桌面端界面采用圆角卡片化风格

## 技术栈

- 前端：`React 18`、`TypeScript`、`Vite`
- 桌面壳：`Tauri 2`
- 后端逻辑：`Rust`
- 本地数据库：`SQLite (rusqlite bundled)`

## 快速开始

### 1. 安装依赖

需要先准备：

- Node.js 18+
- Rust 工具链
- 对应平台的 Tauri 构建依赖

安装前端依赖：

```bash
npm install
```

### 2. 启动开发环境

```bash
npm run tauri dev
```

如果只想启动前端开发服务器，也可以运行：

```bash
npm run dev
```

## 构建

### 常用命令

```bash
npm run build
npm run tauri build
npm run build:mac
npm run build:mac:publish
```

### PowerShell 构建脚本

仓库提供了一个 Windows 下可直接使用的辅助脚本：

```powershell
.\build.ps1
```

可选模式：

```powershell
.\build.ps1 -Mode frontend
.\build.ps1 -Mode check
.\build.ps1 -Mode debug
.\build.ps1 -Mode release
```

### macOS 构建脚本

仓库也提供了一个 macOS 下的辅助脚本：

```bash
./build-macos.sh
```

可选模式：

```bash
./build-macos.sh frontend
./build-macos.sh check
./build-macos.sh debug local
./build-macos.sh release local
./build-macos.sh release sign
./build-macos.sh release publish
```

如果只想走默认的本机 release 构建，也可以直接运行：

```bash
npm run build:mac
```

也可以使用更明确的命令：

```bash
npm run build:mac:sign
npm run build:mac:publish
```

三种模式的区别：

- `local`：只用于本机测试。先生成 `.app`，再做 ad hoc 签名，并重新生成 `.dmg`，避免出现安装后提示“已损坏”
- `sign`：使用 `Developer ID Application` 证书签名 `.app` 和 `.dmg`，但不做 notarization
- `publish`：使用 `Developer ID Application` 证书签名，并通过 Apple notarization，适合对外发布

默认行为：

- `npm run build:mac` 固定走 `local`
- `npm run build:mac:sign` 固定走 `sign`
- `npm run build:mac:publish` 固定走 `publish`

发布前需要准备：

- 在本机钥匙串中安装 `Developer ID Application` 证书
- 用 `security find-identity -v -p codesigning` 确认签名身份名称
- 设置 `APPLE_SIGNING_IDENTITY`
- notarization 凭据二选一：
- 方式一：`APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH`
- 方式二：`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`

示例：

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID1234)"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
export APPLE_API_KEY="ABC123DEFG"
export APPLE_API_KEY_PATH="$HOME/.private_keys/AuthKey_ABC123DEFG.p8"
npm run build:mac:publish
```

说明：

- `local` 模式下，`codesign --verify` 可以通过，但 `spctl` 和 Gatekeeper 仍会拒绝 ad hoc 签名
- `sign` 模式适合做发布前签名检查，不适合直接公开分发
- `publish` 模式才是 macOS 对外分发所需的完整流程

如果你不打算购买 Apple Developer Program，也可以直接分发 `local` 模式生成的 `.dmg`，但需要在发布页明确告诉用户按下面步骤安装：

```text
1. 下载并打开 dmg，把应用拖到“应用程序”
2. 不要直接双击第一次打开
3. 打开“系统设置 -> 隐私与安全性”
4. 在底部看到“已阻止打开 WebApiLogs”后，点击“仍要打开”
5. 或者在“应用程序”里右键 WebApiLogs，选择“打开”，再确认一次
```

这种方式更适合开源项目、技术用户或小范围分发，不适合面向普通用户的大规模公开发布。

## 平台依赖

### Windows

- Rust 工具链
- Visual Studio C++ Build Tools
- Microsoft Edge WebView2 Runtime

### macOS

- Rust 工具链
- Xcode Command Line Tools

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

## 数据与配置

- 配置文件保存在系统应用配置目录
- SQLite 数据库保存在系统应用数据目录
- 日志按账号作用域和时间桶进行缓存
- 远程同步后会覆盖本地对应时间范围内的旧日志

这意味着仓库本身默认不保存你的实际登录配置和运行数据库。

## 目录结构

- `src/`：React 前端页面与样式
- `src-tauri/src/`：Rust 业务逻辑、命令、配置和数据库处理
- `src-tauri/tauri.conf.json`：窗口与打包配置
- `build.ps1`：Windows 下的构建辅助脚本

## 当前状态

- 已按 `Windows / macOS / Linux` 区分窗口尺寸与最小尺寸
- 已补齐主要字体回退链，减少跨平台显示差异
- 已替换默认图标并纳入 Tauri 打包配置
- 当前仅在 Windows 环境完成过实际构建验证
- macOS 与 Linux 仍建议在对应系统做最终人工验收

## 仓库说明

- 已配置 `.gitignore`，默认忽略 `node_modules`、`dist`、`src-tauri/target`、本地数据库和环境文件
- 如需二次开发，建议先创建自己的测试账号配置，再进行真实日志同步
