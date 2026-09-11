#!/usr/bin/env node
/**
 * apply-local.mjs 的逆操作：把官方工作区还原到注入前的状态。
 *
 * 流程：
 *   1. 读取 .state.json（apply 时写入）
 *   2. git checkout -- . 丢弃补丁对官方文件的改动
 *   3. checkout 回原始 ref
 *   4. 删除注入目录
 *   5. 校验工作区干净
 *
 * 用法：
 *   node scripts/restore-local.mjs [--upstream <路径>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PATCH_DIR = join(HERE, 'upstream-patches')
const STATE_FILE = join(PATCH_DIR, '.state.json')

function fail(message) {
  console.error(`restore-local: ${message}`)
  process.exit(1)
}

function git(upstream, args) {
  return execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim()
}

function parseArgs(argv) {
  const options = { upstream: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--upstream') options.upstream = resolve(argv[++i] ?? '')
    else fail(`未知参数 ${argv[i]}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (!existsSync(STATE_FILE)) fail('未找到注入状态，无需还原（或已被还原）')

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
const upstream = options.upstream ?? state.upstream
if (!existsSync(join(upstream, '.git'))) fail(`上游不是 git 仓库: ${upstream}`)

// 1. 丢弃补丁对官方文件的改动
git(upstream, ['checkout', '--', '.'])
console.log('restore-local: 已丢弃补丁改动')

// 2. 回到原始 ref
const head = git(upstream, ['rev-parse', 'HEAD'])
const originalCommit = git(upstream, ['rev-parse', state.originalRef])
if (head !== originalCommit) {
  git(upstream, ['checkout', state.originalRef])
  console.log(`restore-local: 已切回 ${state.originalRef}`)
}

// 3. 删除注入目录
const injectionDir = join(upstream, state.injectionDir)
if (existsSync(injectionDir)) {
  rmSync(injectionDir, { recursive: true, force: true })
  console.log(`restore-local: 已删除 ${state.injectionDir}`)
}

// 4. 移除构建目录重定向（只删 junction 本身，缓存内容保留在 <repo>/.cache/）
const buildRoot = join(upstream, 'apps', 'desktop', '.desktop-build')
if (lstatSync(buildRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
  unlinkSync(buildRoot)
  console.log('restore-local: 已移除构建目录重定向（缓存保留在 .cache/desktop-build）')
}

// 4. 校验干净
const dirty = git(upstream, ['status', '--porcelain'])
if (dirty !== '') fail(`上游仍有残留改动:\n${dirty}`)

unlinkSync(STATE_FILE)
console.log('restore-local: 上游工作区已还原干净')
