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

