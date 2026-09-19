/**
 * 适配层：Windows ACL runner 的控制台前提。
 *
 * 官方文件：`packages/sandbox/sandbox-windows-acl/src/runner.ts`（建受限令牌、派生子进程）与
 * `packages/subprocess/win32-process/src/process.ts`（`CreateProcessAsUserW` 的 creation flags）。
 * Windows 的沙箱把被包装的命令放在 **WRITE_RESTRICTED** 令牌下：这种进程**不能新建控制台，只能继承
 * 一个**；没有控制台可继承时，它在 DLL 初始化阶段就结束（`STATUS_DLL_INIT_FAILED`，退出码
 * `0xC0000142`），命令一个字都跑不出来（runner 会把这个退出码原样镜像给上层）。
 *
 * 桌面端整条链都是 Electron 的 GUI 子系统进程（主进程 → `ELECTRON_RUN_AS_NODE` 的 Host → 同样以
 * `process.execPath` 起的 runner），**永远没有控制台**，于是桌面端每条命令都以 0xC0000142 结束；
 * `dsh web` 由终端启动，控制台一路继承，所以同一份官方代码在 web 侧正常（实测与判据见
 * docs/reproduce.zh.md R34）。
 *
 * runner 自己**不受限**，可以给自己补一个控制台，之后的受限子进程就能继承它。本文件只做这一件事：
 * 没有控制台时 `AllocConsole` + 隐藏窗口，已有控制台（终端 / web 场景）时什么都不做。判断与调用都在
 * 这里，patch 只把它接线到 runner 进程的最前面（`--import`，见 src/patch/sandbox-local.ts.patch）。
 *
 * 本文件不被任何 TypeScript 程序 import（只被 runner 以 `--import` 加载），所以不成对写 `.d.mts`。
 */

import { createRequire } from 'node:module'

/**
 * 让本进程拥有一个控制台，供随后的受限子进程继承。
 *
 * 不写任何 stdio：它的输出会混进被包装命令的结果里。FFI 拿不到时按原样返回——命令仍以原有方式失败，
 * 不会多出一种失败类型。
 * @returns 本次动作：`skipped-platform`（非 Windows）、`inherited`（已有控制台，未改动）、
 *   `allocated`（新建并隐藏）、`failed`（`AllocConsole` 失败）、`unavailable`（koffi 或 Win32 调用不可用）。
 */
export function ensureHostConsole() {
  if (process.platform !== 'win32') return 'skipped-platform'
  let koffi
  try {
    koffi = createRequire(import.meta.url)('koffi')
  } catch {
    // koffi 是官方 `@deepseek-ai/dsh-win32-process` 的依赖，正常安装下必然可解析；解析不到就退回原状。
    return 'unavailable'
  }
  try {
    const kernel32 = koffi.load('kernel32.dll')
    const consoleWindow = kernel32.func('void * __stdcall GetConsoleWindow()')
    if (consoleWindow() !== null) return 'inherited'
    if (kernel32.func('int __stdcall AllocConsole()')() === 0) return 'failed'
    const window = consoleWindow()
    // SW_HIDE = 0：runner 被官方以 STARTF_USESHOWWINDOW/SW_HIDE 起时窗口本来就是隐藏的，这里只是兜底。
    if (window !== null) koffi.load('user32.dll').func('int __stdcall ShowWindow(void * hWnd, int nCmdShow)')(window, 0)
    return 'allocated'
  } catch {
    return 'unavailable'
  }
}

// 本文件由 patch 以 `--import` 加载：加载即接线，runner 的 main 还没跑，控制台就已经就位。
ensureHostConsole()
