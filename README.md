# DeepSeek Harness Desktop

Electron 桌面壳，用于启动并承载 DeepSeek Harness Web GUI。

它不打包后端：启动时会检测/安装可用的 Node.js 和 `@deepseek-ai/dsh`，
然后拉起 `dsh web --no-open`，待后端返回真实 boot manifest 后再加载页面。

## 目录结构

```text
assets/                 图标等静态资源
scripts/                图标生成等开发脚本
src/main/               Electron 主进程模块（ESM）
  index.js              入口：组装模块、窗口生命周期、启动流程
  config.js             常量与环境变量
  logger.js             文件 + 界面日志
  net.js                系统代理、下载
  node.js               Node.js 检测/安装、npm 执行
  dsh.js                dsh 检测/安装引导
  backend.js            dsh web 后端进程管理
  window.js             窗口、加载覆盖层
  version.js            版本解析纯函数
  net-utils.js          代理解析纯函数
src/preload/index.cjs   沙箱 preload（CommonJS）
src/renderer/loading.html  启动加载页
test/                   node:test 单测
```

## 命令

```bash
npm start       # 启动桌面端
npm test        # 运行单测
npm run dist    # 打包 Windows x64
```

## 说明

- 主进程使用 ESM（`"type": "module"`）。
- preload 因沙箱限制保持 CommonJS，文件名为 `index.cjs`。
- 日志写入可执行文件旁 `logs/`，按天轮转并保留 7 天。
