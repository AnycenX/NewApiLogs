# WebApiLogs

基于 `Tauri 2 + React + TypeScript + Rust + SQLite` 的跨平台 New API 日志客户端。

## 功能概览

- `BaseUrl + UserId + Token` 登录校验
- 用户状态与今日消费刷新
- `/api/log/self` 日志分页同步
- SQLite 本地缓存优先读取
- 模型、Token、时间范围筛选
- 浅色 / 深色 / 跟随系统 三主题
- 参考 CC Switch 的圆角卡片化桌面风格

## 启动开发环境

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build
```

## 平台依赖

### Windows

- Rust 工具链
- Visual Studio C++ Build Tools
- Microsoft Edge WebView2 Runtime

### macOS

- Rust 工具链
- Xcode Command Line Tools
- 建议使用系统默认 `SF Pro / PingFang SC` 字体回退链验证浅色、深色与跟随系统主题

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

- 应用会优先使用 `Noto Sans CJK SC / Ubuntu / DejaVu Sans` 作为 Linux 字体回退

## 跨平台收尾说明

- 已按 `Windows / macOS / Linux` 区分主窗口、设置窗口、悬浮窗的默认尺寸与最小尺寸
- 已按平台补齐字体回退链，避免中文和数字在不同系统下出现明显挤压
- 已替换前端默认 Vite 图标，并把 `icons/icon.png` 纳入 Tauri 打包图标列表
- 当前这台机器只实际执行了 Windows 构建验证；macOS 与 Ubuntu 仍需在对应系统做最终人工验收

## 目录说明

- `src/`: React 前端与主题 UI
- `src-tauri/src/`: Rust 命令、HTTP、配置和 SQLite
- `src-tauri/tauri.conf.json`: 桌面窗口与打包配置

## 数据说明

- 配置文件保存在系统应用配置目录
- SQLite 数据库保存在系统应用数据目录
- 日志按账号作用域和时间桶缓存，远程同步后会覆盖本地旧数据
