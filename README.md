# MonoSwitch

一块显示器，两台电脑。用同一套 Chrome 扩展切换 HDMI / DisplayPort 输入，自动显示各电脑的系统信息。

Vue 3 + TypeScript 负责界面，Rust 负责本地显示器控制，JavaScript 负责跨平台安装与打包。无需账号或云服务；可选的键鼠共享通过局域网直连。

## 使用条件

- Chrome / Chromium 123 或更新版本。
- 两台电脑分别用视频线连接到同一显示器的不同输入接口。
- 显示器开启 DDC/CI，并支持通过 VCP `0x60` 切换输入源；支持调亮度不代表支持切换输入。
- 两台电脑各安装扩展、本地程序和对应系统依赖。两台电脑可以使用不同系统。
- 可在扩展页面开启局域网键鼠共享，使用独立的 Deskflow 组件。

系统兼容策略：

| 系统 | 显示器控制方式 | 附加条件 |
| --- | --- | --- |
| Windows 10 / 11，x64 | Rust 调用系统 Win32 DDC/CI API | 支持 DDC/CI 的显卡、连接链路与显示器 |
| macOS 13+，Intel / Apple Silicon | Rust 调用 BetterDisplay CLI | 安装并运行兼容版本的 BetterDisplay；以其对当前 Mac、接口与显示器的实际支持为准 |
| Linux，包括 Manjaro / Arch | Rust 调用 ddcutil | 安装 ddcutil、加载 i2c-dev、当前桌面用户有 I²C 访问权限 |

本地系统和 Linux 发行版自动识别。**视频接口不能识别对端操作系统**：对端信息来自在另一台电脑生成的配对码。配对码包含电脑名称、系统、显示器标识及输入接口；无需手动选择 Windows / macOS / Linux。

界面支持简体中文和 English，默认跟随浏览器语言。右上角可随时切换，选择会保存在本机，并同步到已打开的扩展页面；电脑名称和配对数据不会随语言改变。Chrome 扩展名称与描述跟随浏览器语言。

## 普通用户安装

MonoSwitch 的安装流程：**自动识别系统 → 下载组件 → 按引导完成安装 → 自动连接**。

1. 解压 `releases/monoswitch-extension-v0.1.0.zip`，在 `chrome://extensions` 启用开发者模式，加载解压后的文件夹。
2. 首次加载会自动打开引导页，选择当前系统和架构对应的安装器。点击「下载组件」，等待下载完成。
3. Linux 直接下载单个 `Install MonoSwitch.run`。在文件属性中允许执行后双击，或复制引导中的启动命令运行。Windows 点击「打开安装器」；macOS 当前提供 `.app` ZIP。
4. 按系统提示完成安装。Linux 安装器会检测发行版，安装缺失的 ddcutil、加载 i2c-dev、配置开机加载，并刷新视频设备的 uaccess 权限；需要时请求一次管理员授权。随后安装本机程序并注册 Chrome / Chromium，引导页自动连接并检测显示器。最后完成两台电脑配对。

下载完成后才会显示对应系统的安装操作。重新打开引导页会恢复已有下载记录，无需重复下载；下载中断或文件已删除时可以重试。Linux 下载的是单个 `Install MonoSwitch.run` 程序，运行提示显示在扩展中。安装成功后安装器自动删除自身并退出，不弹出说明文件；失败或存在未完成配置时才显示提示。出现「本地组件已连接」及系统信息，才表示扩展确认安装成功；打开文件或复制命令本身不代表安装完成。

**安装 MonoSwitch 组件不需要 Node.js、Rust 或手动注册。** 本地程序由 Chrome 按需启动，无托盘、无应用开机自启、无常驻 HTTP 服务。Linux 自动安装依赖支持 Manjaro / Arch、Debian / Ubuntu、Fedora / RHEL 和 openSUSE；图形授权需要系统的 polkit 授权代理。Chrome 不会给 Linux 下载文件设置执行权限；首次启动需允许执行，或使用扩展提供的命令。当前安装器未签名，Windows / macOS 的系统安全确认仍需用户处理。

已安装旧版本的用户会看到「更新本地组件」，运行新版安装器一次即可启用自动配置。以后系统缺少配置时，可在扩展中点击「自动配置」，不需要重新下载。取消授权或配置失败时仍会安装用户组件，并显示尚未完成的项目；系统配置不会被误报为成功。

显示器控制依赖仍须满足：Windows 使用系统接口；Linux 自动检查并配置 ddcutil 和 I²C 权限；macOS 仍需要安装并运行 BetterDisplay。界面会显示缺失项，不会把这些情况误报为已连接显示器。当前可下载的平台以扩展内置安装器目录为准，未构建的平台不会展示虚假的下载链接。

## 共用键盘与鼠标

两台电脑各更新 MonoSwitch 本地组件，并安装 [Deskflow](https://github.com/deskflow/deskflow) 1.26 或更新版本。Linux 可在扩展页面点击「安装键鼠组件」；Windows / macOS 使用官方安装器。

首次只需一次配对，不需要手动填 IP 或来回交换配置：

1. 两台各选择本机显示器与实际连接的输入接口。
2. Type-C 那台（实际接收显示器 USB 键鼠的电脑）点击「生成配对码」。
3. HDMI 那台粘贴配对码，点击「连接并开启共享」。双方自动保存对方信息、确定发送/接收角色并连接。看到「已连接，可以切换」即表示键鼠链路已连通。

之后直接点击主界面的 **「切换到另一台电脑」**，或原有 Alt+Shift+M 快捷键，键鼠与画面一起切换。程序先确认键鼠焦点切换，再发送显示器命令；键鼠失败时不继续主动切画面。Ctrl+Shift+F8/F9 保留为备用操作，不再是日常操作要求。

两边 Chrome 保持运行，发送端不能休眠。配对成功后随 Chrome 启动自动连接；主动停止共享会关闭自动连接。键鼠直接接在电脑上时，在那台电脑生成配对码。使用显示器的实体按钮切输入不会触发软件键鼠切换。

一次性配对码包含随机 256 位授权凭据与发送端证书指纹，五分钟有效，使用后失效；仅发送给自己的另一台电脑。配对通过固定证书指纹的 TLS 交换公开身份。正常联动控制使用双向证书验证，输入使用 Deskflow 的双向证书验证；关闭剪贴板，不记录按键。发送端需允许局域网 TCP 24800（键鼠）及 24801（配对/联动）；无账号或云服务。显示器仍需支持 DDC/CI 输入切换。

当前已在 Linux X11 隔离桌面验证双向按钮联动、真实键鼠输入、错误证书拒绝、一次性配对和断线。Wayland 发送端暂不支持按钮联动，需使用 X11；macOS 需为本地组件及 Deskflow 授予辅助功能等输入权限，Windows 安全桌面/提权窗口不保证可控。Windows/macOS 已支持编译，仍需真机验证。

## 从源码构建（开发者）

需要 Node.js 22.12+、npm，以及当前稳定版 Rust 工具链。Windows 编译还需要 Visual Studio C++ Build Tools，macOS 需要 Xcode Command Line Tools；Linux 需要 C 编译器/链接器。

在两台电脑分别运行：

```sh
cd monoswitch
npm ci
npm run bootstrap
npm run build
```

构建会编译 Rust 控制程序，将其嵌入原生安装器，打包进扩展并输出发行 ZIP。然后打开 `chrome://extensions`，启用「开发者模式」，选择「加载已解压的扩展程序」，选择项目的 **`extension/dist`** 文件夹，在引导页安装即可。

扩展内置固定开发公钥，解压安装时不同电脑保持同一扩展 ID。安装器自动计算并嵌入 ID，本机组件只写入当前用户目录；Linux 的系统准备步骤按需请求管理员授权。公钥不包含签名私钥，不用于商店发布签名。

开发者也可以用 `npm run setup` 直接注册当前构建的程序，跳过 GUI 安装器。这个命令是开发入口，普通用户不需要运行。

Chromium 用户安装时改用：

```sh
npm run setup -- --browser chromium
```

如果发布到 Chrome 应用商店后 ID 改变，可显式传入：

```sh
npm run setup -- --extension-id 你的32位扩展ID
```

### Linux / Manjaro

普通用户使用安装器或扩展中的「自动配置」即可。以下命令用于手动排错：

Manjaro / Arch：

```sh
sudo pacman -S --needed ddcutil
sudo modprobe i2c-dev
ddcutil detect
```

Ubuntu / Debian：

```sh
sudo apt install ddcutil
sudo modprobe i2c-dev
ddcutil detect
```

请用普通用户执行 `ddcutil detect` 验证权限。ddcutil 的发行版包通常会安装 udev `uaccess` 规则；安装后可能需要注销再登录。无需用 root 启动 Chrome。若每次开机都需加载模块，可将一行 `i2c-dev` 写入 `/etc/modules-load.d/i2c-dev.conf`。更详细的步骤见 [故障排查](docs/troubleshooting.md)。

### macOS

安装 [BetterDisplay](https://github.com/waydabber/BetterDisplay)，打开应用、启用显示器的 DDC 控制和应用的 CLI / Notification 集成。MonoSwitch 会自动使用应用内置 CLI，**不要求另装 Homebrew 或 CLI**。已有 Homebrew 的用户可选安装独立 CLI：

```sh
brew install waydabber/betterdisplay/betterdisplaycli
betterdisplaycli help
```

BetterDisplay 需要保持运行。内置屏幕、部分 HDMI/转接器或显示器可能不支持 DDC 输入切换。MonoSwitch 不保证绕过硬件限制，也不依赖系统辅助功能权限模拟点击显示器菜单。

## 两台电脑配对

扩展弹窗与选项使用同一个页面，安装、接口选择、首次配对和日常切换都在这里完成。已有配置会保留，无需重新配对。

1. 两台电脑分别打开扩展，按实际接线选择本机显示器和输入接口。完成后此区域自动收起。
2. 在接着键鼠的电脑生成配对码，在另一台粘贴并点击「连接并开启共享」（详见上方键鼠共享说明）。
3. 以后点击页面顶部「切换到…」，画面与键鼠一起切换；配对后自动重连。

「显示器与接口」可随时展开修改接线；电脑名称、重新下载组件和仅切画面的手动配置放在「更多选项」中。需要停止共享时，展开「连接管理」。

若只切画面、不使用键鼠共享，在两台电脑的「更多选项 → 仅切画面时，手动交换配置」中互相导入配置。更换接线后应更新本机接口并重新配对。

有些显示器不能报告完整输入列表，界面会标注标准候选输入，需要根据实际接线手动确认。部分显示器只接受当前输入上的控制命令，因此默认操作流程是**在当前显示的电脑上切到另一台**。两台电脑均须已开机并输出视频。

快捷键可在 `chrome://extensions/shortcuts` 中配置。切换提示「命令已发送」只表示控制请求被接受；切换后连接可能立即断开，不能以软件返回值证明另一台电脑已输出画面。

## 开发与验证

```sh
npm run dev              # http://127.0.0.1:5173
npm test                 # 前端逻辑、Rust 协议/解析器、安装路径测试
npm run check            # 前端编译、Rust Clippy
npm run package          # 校验已有安装器并重新打包扩展
npx playwright install chromium
npm run test:ui          # 界面及隔离浏览器内的真实 Native Messaging 测试
```

浏览器预览默认显示安装引导。仅在 URL 加 `?demo=1` 时显示明确标注的交互演示，不会向真实硬件发送命令。

原生程序只读诊断：

```sh
# Linux / macOS
./native/target/release/monoswitch-host --status
# Windows PowerShell
.\native\target\release\monoswitch-host.exe --status
```

用户发行物位于 `releases/`，扩展 ZIP 内附已构建平台的单文件安装器。每个系统/架构使用其对应二进制，不能直接把 Linux 程序复制到 Windows。

Windows 交叉构建示例（需对应 Rust target 与 MinGW 链接器）：

```sh
npm run build -- --target x86_64-pc-windows-gnu
```

连续构建不同平台会合并安装器目录；`npm run build -- --bundle-only` 只重新校验目录和打包扩展。[CI 工作流](.github/workflows/build.yml) 配置了 Windows、Linux、Intel Mac 和 Apple Silicon Mac 的检查、测试和安装器构建；全部成功后才合并为一份扩展。Linux 作业还验证隔离浏览器中的安装与连接。工作流需提交到 GitHub 后执行，本地交叉编译不代表远端 CI 已通过。

Linux 发行包采用 musl 静态构建，避免依赖某个发行版的 glibc 版本；开发时直接 `npm run build` 使用本机默认目标。静态发行构建可用 `npm run build -- --target x86_64-unknown-linux-musl --zig`，或安装 musl-tools 并配置 musl-gcc 链接器后省略 `--zig`。

安装了 Zig 与 cargo-zigbuild 的开发环境也可交叉构建 Mac，例如 `npm run build -- --target aarch64-apple-darwin --zig`，Intel 改为 `x86_64-apple-darwin`。Mac 产物要求 macOS 13+。交叉构建通过不代表已经在目标系统实机验证。

## 结构

```text
extension/        Vue 3 界面、Chrome 后台服务、配对与设置
native/           Rust Native Messaging、系统检测、平台 DDC 适配
setup/            嵌入控制程序的 Rust 安装器、升级回滚、卸载
shared/           TypeScript JSON 协议类型
scripts/          JavaScript 安装、卸载、打包及测试
docs/             架构和故障排查
```

## 卸载

用对应系统的原生安装器加 `--uninstall` 参数移除其安装的组件与注册，再到 Chrome 扩展管理页移除扩展。开发者通过 JS 注册的版本可用 `npm run uninstall` 移除所选浏览器注册，Chromium 加 `--browser chromium`。开发卸载会核对注册归属，保留后来由原生安装器接管的正式版本；归属不明或无法读取时也会保留配置并提示。扩展本地配置在移除扩展时由 Chrome 清理。

实现与验证范围见 [架构](docs/architecture.md) 和 [验证记录](docs/verification.md)。MIT License。
