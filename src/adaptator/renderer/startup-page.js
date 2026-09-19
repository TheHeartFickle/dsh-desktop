/**
 * 适配层（渲染进程）：把官方启动页的内部结构固定成稳定接口。
 *
 * 官方文件：`packages/client/web/src/boot-page.ts`（网络前端的 BootPage）。功能层只要「把一张图放进
 * 启动页」这一件事，不该知道官方用 `data-dsh-boot` / `data-dsh-boot-spinner` 标记结构，也不该知道这个
 * 启动页是在本脚本之后才创建、并在应用挂载时被整体移除。官方改结构时只改本文件。
 *
 * 形态：官方启动页是框架无关的普通 DOM，所以本层以经典脚本注入，把稳定的 `dshStartupPage` 挂到全局，
 * 供功能层同源取用。两层的接线由 patch 在注入处写死（patch 订阅 `onFailed`，接到功能层原有的 `sync`）。
 */
;(function (global) {
  'use strict'

  /** 官方启动页根节点。 */
  const ROOT_SELECTOR = '[data-dsh-boot]'
  /** 官方「仍在等待」的标记；它消失即表示官方已切到失败报告，或应用已经挂载。 */
  const BUSY_SELECTOR = '[data-dsh-boot-spinner]'

  /** 订阅者都是「按当前 DOM 重新判断一次」的函数；观察器只建一个。 */
  const watchers = []
  let observing = false

  /** 让所有订阅者按当前 DOM 重新判断一次。 */
  function refresh() {
    for (const watcher of watchers) watcher()
  }

  /**
   * 订阅官方启动页的 DOM 变化，并立即按当前状态跑一次。
   * @param {() => void} watcher 订阅者。
   */
  function watch(watcher) {
    watchers.push(watcher)
    if (!observing) {
      observing = true
      new global.MutationObserver(refresh).observe(global.document.documentElement, { childList: true, subtree: true })
    }
    watcher()
  }

  /** @returns {Element | null} 当前的官方启动页根节点。 */
  function startupRoot() {
    return global.document.querySelector(ROOT_SELECTOR)
  }

  /**
   * 把元素放进官方启动页。官方启动页在本脚本之后才创建、应用挂载时又被整体移除，所以跟着它走，
   * 而不是假设它已经存在。
   * @param {Element} element 功能层要展示的元素。
   */
  function placeArt(element) {
    watch(function () {
      const host = startupRoot()
      if (host !== null && element.parentElement !== host) host.prepend(element)
    })
  }

  /**
   * 订阅「官方启动页已经不再等待」：官方还在转圈时回调 `false`，切到失败报告或应用已经挂载时回调 `true`
   * ——两种情形下动画都该收起。订阅时立即回调一次。
   * @param {(failed: boolean) => void} listener 状态变化时的回调。
   */
  function onFailed(listener) {
    let reported
    watch(function () {
      const root = startupRoot()
      const failed = root === null || root.querySelector(BUSY_SELECTOR) === null
      if (failed === reported) return
      reported = failed
      listener(failed)
    })
  }

  global.dshStartupPage = Object.freeze({ placeArt, onFailed })
})(globalThis)
