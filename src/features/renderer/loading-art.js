/**
 * 功能层（渲染进程）：启动页的加载动画（鲸鱼）。
 *
 * 等待后端的这段时间由本层负责画面；官方不再等待时（切到失败报告，或应用已经挂载）收起。
 * 本层只依赖适配层的 `dshStartupPage.placeArt`：不认识官方页面结构，也不认识后端状态 —— 可见性由 patch
 * 订阅适配层的 `onFailed` 后调用 `sync(failed)` 传进来。
 *
 * 资源全部同源：动画样式在同源 `loading-art.css`，图片在同源 `loading-art.png`（由 build.config.json
 * 的 copy 映射提供），两者与本文本同置于 `dsh-app://app/local/`，本层不写任何内联样式或内联脚本。
 */
;(function (global) {
  'use strict'

  const ART_SOURCE = '/local/loading-art.png'

  const art = global.document.createElement('img')
  art.id = 'loading-art'
  art.src = ART_SOURCE
  art.alt = ''
  art.setAttribute('aria-hidden', 'true')
  global.dshStartupPage.placeArt(art)

  /**
   * 官方启动页还在等待时展示动画，不再等待时收起。
   * @param {boolean} failed 官方启动页是否已经不再等待。
   */
  function sync(failed) {
    art.hidden = Boolean(failed)
  }

  global.dshLoadingArt = Object.freeze({ sync })
})(globalThis)
