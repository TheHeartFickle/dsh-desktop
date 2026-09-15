/**
 * 功能层（渲染进程）：启动页的加载动画（鲸鱼）。
 *
 * 等待后端启动的这段时间由本层负责画面；官方 `render()` 判定失败时收起，把页面让给官方恢复界面。
 * 只依赖适配层的 `dshStartupPage.placeArt`：不认识官方页面结构，也不认识后端状态 —— 可见性由官方
 * 已有的 `failed` 变量经 patch 插入的一行调用传进来。
 *
 * 官方 CSP 是 `script-src 'self'; style-src 'self'; img-src 'self' data:`：动画样式在同源
 * `loading-art.css` 里（由 patch 接线加载），图片是同源 `loading-art.png`（由 build.config.json 的
 * copy 映射提供），本层不写任何内联样式或内联脚本。
 */
;(function (global) {
  'use strict'

  const ART_SOURCE = 'loading-art.png'

  const art = global.document.createElement('img')
  art.id = 'loading-art'
  art.src = ART_SOURCE
  art.alt = ''
  art.setAttribute('aria-hidden', 'true')
  global.dshStartupPage.placeArt(art)

  /**
   * 官方 `render()` 每轮都会调用：`failed` 为真时收起动画，否则展示。
   * @param {boolean} failed
   */
  function sync(failed) {
    art.hidden = Boolean(failed)
  }

  global.dshLoadingArt = Object.freeze({ sync })
})(globalThis)
