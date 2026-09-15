/**
 * 功能层单测：用 `node:vm` 把两个经典脚本按接线顺序跑起来（与上游 `startup-renderer.spec.ts` 同款方式），
 * 只验证「跑完之后画面长什么样」。
 *
 * 为什么不是直接 import：渲染进程受官方 CSP 约束（`script-src 'self'`），且官方 `startup.js` 是经典
 * 脚本，所以功能层与适配层都是经典脚本、经全局对象组装，没有 ESM 导出可 import。
 * 假 DOM 只实现这两个脚本用到的那一小块，因此本测试不依赖 jsdom 与官方代码。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const ADAPTOR = readFileSync(new URL('../../adaptator/renderer/startup-page.js', import.meta.url), 'utf8')
const FEATURE = readFileSync(new URL('./loading-art.js', import.meta.url), 'utf8')

/** 一页等价结构：`main > #spinner`；`created` 记录脚本创建过的标签名。 */
function rendererPage() {
  const created = []
  const element = tag => ({
    tag,
    id: '',
    hidden: false,
    attributes: {},
    children: [],
    prepend(child) { this.children.unshift(child) },
    setAttribute(name, value) { this.attributes[name] = String(value) },
  })
  const main = element('main')
  const spinner = element('div')
  spinner.id = 'spinner'
  main.prepend(spinner)
  return {
    created,
    main,
    spinner,
    document: {
      createElement(tag) { created.push(tag); return element(tag) },
      querySelector(selector) { return selector === 'main' ? main : null },
    },
  }
}

/** 按接线顺序执行适配层与功能层，返回页面与功能层接口。 */
function load() {
  const page = rendererPage()
  const context = createContext({ document: page.document })
  runInContext(ADAPTOR, context)
  runInContext(FEATURE, context)
  return { ...page, art: page.main.children[0], api: context.dshLoadingArt }
}

test('动画图落在官方加载指示器之前，且是同源装饰图', () => {
  const page = load()
  assert.equal(page.art.tag, 'img')
  assert.equal(page.art, page.main.children[0])
  assert.equal(page.main.children[1], page.spinner)
  assert.equal(page.art.src, 'loading-art.png')
  assert.equal(page.art.alt, '')
  assert.equal(page.art.attributes['aria-hidden'], 'true')
  assert.equal(page.art.hidden, false)
})

test('等待后端时展示，官方 render 判定失败时收起，可反复调用', () => {
  const page = load()
  page.api.sync(false)
  assert.equal(page.art.hidden, false)
  page.api.sync(true)
  assert.equal(page.art.hidden, true)
  page.api.sync(true)
  assert.equal(page.art.hidden, true)
  page.api.sync(false)
  assert.equal(page.art.hidden, false)
})

test('不违反官方 CSP：只创建图片元素，不产生内联样式或内联事件', () => {
  const page = load()
  assert.deepEqual(page.created, ['img'])
  assert.equal(page.art.style, undefined)
  assert.equal(page.art.attributes.style, undefined)
  for (const name of Object.keys(page.art.attributes)) assert.doesNotMatch(name, /^on/u)
})
