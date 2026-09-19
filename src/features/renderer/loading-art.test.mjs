/**
 * 功能层单测：用 `node:vm` 把两个经典脚本按接线顺序跑起来，只验证「官方启动页在不同阶段长什么样」。
 *
 * 为什么不是直接 import：两层都是经典脚本、经全局对象组装，没有 ESM 导出可 import。
 * 假 DOM 只实现这两个脚本用到的那一小块（`prepend` / `querySelector` / `MutationObserver`），
 * 因此本测试不依赖 jsdom 与官方代码。
 *
 * `load()` 最后那行 `onFailed(dshLoadingArt.sync)` 就是 patch 注入的接线：功能层不认识官方状态，
 * 只把 `sync` 交出去。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const ADAPTOR = readFileSync(new URL('../../adaptator/renderer/startup-page.js', import.meta.url), 'utf8')
const FEATURE = readFileSync(new URL('./loading-art.js', import.meta.url), 'utf8')

/** 官方 `boot-page.ts` 用的两个标记属性。 */
const ROOT_MARKER = 'data-dsh-boot'
const BUSY_MARKER = 'data-dsh-boot-spinner'

/** 极简 DOM：够两个脚本用即可。`made` 按创建顺序留下节点，供断言在启动页出现前查看它。 */
function makeDom() {
  const created = []
  const made = []
  function matches(node, selector) {
    if (selector === `[${ROOT_MARKER}]`) return node.attributes[ROOT_MARKER] !== undefined
    if (selector === `[${BUSY_MARKER}]`) return node.attributes[BUSY_MARKER] !== undefined
    return false
  }
  function element(tag) {
    const node = {
      tag,
      id: '',
      hidden: false,
      src: '',
      alt: '',
      attributes: {},
      children: [],
      parentElement: null,
      prepend(child) {
        if (child.parentElement !== null) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1)
        child.parentElement = node
        node.children.unshift(child)
      },
      querySelector(selector) {
        for (const child of node.children) {
          if (matches(child, selector)) return child
          const found = child.querySelector(selector)
          if (found !== null) return found
        }
        return null
      },
      remove() {
        if (node.parentElement === null) return
        node.parentElement.children.splice(node.parentElement.children.indexOf(node), 1)
        node.parentElement = null
      },
      setAttribute(name, value) { node.attributes[name] = String(value) },
    }
    return node
  }
  const documentElement = element('html')
  return {
    created,
    made,
    element,
    documentElement,
    document: {
      documentElement,
      createElement(tag) { created.push(tag); const node = element(tag); made.push(node); return node },
      querySelector(selector) {
        return matches(documentElement, selector) ? documentElement : documentElement.querySelector(selector)
      },
    },
  }
}

/** 按接线顺序执行适配层、功能层，再由 patch 的接线订阅官方状态。 */
function load() {
  const dom = makeDom()
  const observers = []
  const context = createContext({
    document: dom.document,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {}
    },
  })
  runInContext(ADAPTOR, context)
  runInContext(FEATURE, context)
  context.dshStartupPage.onFailed(context.dshLoadingArt.sync)
  return {
    ...dom,
    observers,
    redraw: () => { for (const observer of observers) observer.callback() },
  }
}

/** 造出官方启动页：`<div data-dsh-boot><div data-dsh-boot-spinner></div></div>`。 */
function openBootPage(page) {
  const root = page.element('div')
  root.setAttribute(ROOT_MARKER, '')
  const boot = page.element('div')
  boot.setAttribute(BUSY_MARKER, '')
  root.prepend(boot)
  page.documentElement.prepend(root)
  return root
}

test('动画图落在官方启动页里、官方加载标记之前，且是同源装饰图', () => {
  const page = load()
  const boot = openBootPage(page)
  page.redraw()

  const art = boot.children[0]
  assert.equal(art, page.made[0])
  assert.equal(art.tag, 'img')
  assert.equal(art.src, '/local/loading-art.png')
  assert.equal(art.alt, '')
  assert.equal(art.attributes['aria-hidden'], 'true')
  assert.equal(art.hidden, false)
})

test('官方启动页出现之前不展示，出现后展示，切到失败报告时收起', () => {
  const page = load()
  // 官方启动页还没建出来：没有可展示的位置，订阅时就没在等待，先收起。
  assert.equal(page.made[0].hidden, true)

  const boot = openBootPage(page)
  page.redraw()
  const art = boot.children[0]
  assert.equal(art.hidden, false)

  // 官方只留下失败报告（加载标记消失）。
  boot.children.splice(boot.children.indexOf(boot.querySelector(`[${BUSY_MARKER}]`)), 1)
  page.redraw()
  assert.equal(art.hidden, true)

  // 重新出现加载标记时再展示，可反复切换。
  const spinner = page.element('div')
  spinner.setAttribute(BUSY_MARKER, '')
  boot.prepend(spinner)
  page.redraw()
  assert.equal(art.hidden, false)
})

test('应用挂载后官方启动页整体移除，动画随之离开文档', () => {
  const page = load()
  const boot = openBootPage(page)
  page.redraw()
  const art = boot.children[0]
  assert.equal(art.hidden, false)

  boot.remove()
  page.redraw()
  assert.equal(art.hidden, true)
  // 启动页连同动画一起离开文档；后续不再有可展示的位置。
  assert.equal(page.document.querySelector(`[${ROOT_MARKER}]`), null)
  assert.equal(art.parentElement, boot)
})

test('不违反渲染进程的样式纪律：只创建图片元素，不产生内联样式或内联事件', () => {
  const page = load()
  openBootPage(page)
  page.redraw()
  assert.deepEqual(page.created, ['img'])
  assert.equal(page.created.includes('style'), false)
  const art = page.document.querySelector(`[${ROOT_MARKER}]`).children[0]
  assert.equal(art.style, undefined)
  assert.equal(art.attributes.style, undefined)
  for (const name of Object.keys(art.attributes)) assert.doesNotMatch(name, /^on/u)
})
