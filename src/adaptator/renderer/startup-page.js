/**
 * 适配层（渲染进程）：把官方启动页的内部结构固定成稳定接口。
 *
 * 官方文件：`apps/desktop/renderer/startup.html`。功能层只要「把一张图放进启动页」这一件事，不该知道
 * 官方把内容画在 `<main>` 里；官方改结构时只改本文件。
 *
 * 形态：渲染进程受官方 CSP 约束（`script-src 'self'`），且官方 `startup.js` 是经典脚本，所以本层以
 * 经典脚本注入，把稳定的 `dshStartupPage` 挂到全局，供功能层同源取用。
 */
;(function (global) {
  'use strict'

  /** 官方启动页的内容容器；加载动画作为它的第一个子元素，落在官方加载指示器之前 */
  const ROOT_SELECTOR = 'main'

  /**
   * 把元素放进启动页。
   * @param {Element} element
   */
  function placeArt(element) {
    global.document.querySelector(ROOT_SELECTOR).prepend(element)
  }

  global.dshStartupPage = Object.freeze({ placeArt })
})(globalThis)
