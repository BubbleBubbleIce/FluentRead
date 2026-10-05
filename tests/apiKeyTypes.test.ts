/**
 * @file tests/apiKeyTypes.test.ts
 * 文件职责：验证多 API Key 设置 UI 使用的纯列表归一化和检查汇总模型。
 * 主要内容：覆盖旧 token 兼容、空行、成功/失败/检查中状态和全失败边界，以及轮换与仅用首个两种方式下参与请求的行和备用行。
 * 模块边界：不挂载 Vue、不访问浏览器 API、不测试真实连接；连接协议由后台测试覆盖。
 */
import { describe, expect, it } from 'vitest'
import { normalizeApiKeyList, summarizeApiKeyChecks, eligibleApiKeyIndexes, duplicateApiKeyIndexes, activeApiKeyIndexes, standbyApiKeyIndexes } from '@/src/features/settings/ui/services/apiKeyTypes'

describe('api key UI model', () => {
  it('keeps an explicit list including empty rows and falls back to legacy token', () => {
    expect(normalizeApiKeyList(['A', '', 'C'], 'legacy')).toEqual(['A', '', 'C'])
    expect(normalizeApiKeyList(undefined, 'legacy')).toEqual(['legacy'])
    expect(normalizeApiKeyList([], '')).toEqual([''])
    expect(normalizeApiKeyList([], 'stale-secret')).toEqual([''])
    expect(normalizeApiKeyList(undefined)).toEqual([''])
    expect(normalizeApiKeyList(undefined, 42 as never)).toEqual([''])
    expect(normalizeApiKeyList([42, 'fixture'])).toEqual(['fixture'])
  })

  it('does not summarize while a row is still checking', () => {
    expect(summarizeApiKeyChecks({0: {status: 'success'}, 1: {status: 'checking'}})).toBeNull()
    expect(summarizeApiKeyChecks({0: {status: 'success'}, 1: {status: 'queued'}})).toBeNull()
    expect(summarizeApiKeyChecks({})).toBeNull()
    expect(summarizeApiKeyChecks({0: {status: 'idle'}})).toBeNull()
  })

  it('summarizes all-success, partial and all-failure checks', () => {
    expect(summarizeApiKeyChecks({0: {status: 'success'}, 1: {status: 'success'}})).toEqual({kind: 'success', passed: 2, failed: 0})
    expect(summarizeApiKeyChecks({0: {status: 'success'}, 1: {status: 'error', error: '401'}})).toEqual({kind: 'partial', passed: 1, failed: 1})
    expect(summarizeApiKeyChecks({0: {status: 'error'}, 1: {status: 'error'}})).toEqual({kind: 'error', passed: 0, failed: 2})
  })
  it('keeps stable indexes while excluding blank and repeated keys', () => {
    const keys = ['first', ' ', ' second ', 'first', 'second', '']
    expect(eligibleApiKeyIndexes(keys)).toEqual([0, 2])
    expect((duplicateApiKeyIndexes(keys).get(0) ?? null)).toBeNull()
    expect((duplicateApiKeyIndexes(keys).get(1) ?? null)).toBeNull()
    expect((duplicateApiKeyIndexes(keys).get(3) ?? null)).toBe(0)
    expect((duplicateApiKeyIndexes(keys).get(4) ?? null)).toBe(2)
    expect((duplicateApiKeyIndexes(keys).get(99) ?? null)).toBeNull()
  })
  it('preserves first-row indexes, whitespace and case with prototype-like credentials', () => {
    expect([...duplicateApiKeyIndexes([' ', ' __proto__ ', 'A', 'a', '__proto__', ' A ', 'constructor', 'constructor', ''])])
      .toEqual([[4, 1], [5, 2], [7, 6]])
    expect([...duplicateApiKeyIndexes([])]).toEqual([])
  })
  it('reads each key once to build duplicate display for a large list', () => {
    let reads = 0
    const keys: string[] = []
    for (let index = 0; index < 500; index++) Object.defineProperty(keys, index, {get: () => {reads += 1;return `fixture-${index % 250}`}, configurable: true})
    const duplicates = duplicateApiKeyIndexes(keys)
    expect(reads).toBe(500);expect(duplicates.size).toBe(250)
    expect(duplicates.get(250)).toBe(0);expect(duplicates.get(499)).toBe(249)
  })

  it('splits usable rows into active and standby rows by usage mode', () => {
    const usable = eligibleApiKeyIndexes(['', 'first', ' ', 'second', 'first', 'third'])
    expect(usable).toEqual([1, 3, 5])
    expect(activeApiKeyIndexes(usable, true)).toEqual([1, 3, 5])
    expect(activeApiKeyIndexes(usable, true)).not.toBe(usable)
    expect(standbyApiKeyIndexes(usable, true)).toEqual([])
    // 仅用首个时跳过开头的空行，与运行时取首个非空 Key 保持一致。
    expect(activeApiKeyIndexes(usable, false)).toEqual([1])
    expect(standbyApiKeyIndexes(usable, false)).toEqual([3, 5])
    expect(activeApiKeyIndexes(eligibleApiKeyIndexes(['', ' ']), false)).toEqual([])
    expect(standbyApiKeyIndexes(eligibleApiKeyIndexes(['only']), false)).toEqual([])
  })
})
