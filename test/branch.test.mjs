/**
 * The branch and directory naming policy: slug derivation, directory
 * sanitizing, placeholder identity, disambiguation, and repository segments.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_SLUG_LENGTH,
  PROVISIONAL_PREFIX,
  disambiguate,
  isProvisionalBranch,
  provisionalBranch,
  repoDirSegment,
  sanitizeDirName,
  shortHash,
  slugifyTitle,
  worktreeDirectory,
} from '../branch.js'

test('slugifyTitle lowercases, hyphenates, and trims', () => {
  assert.equal(slugifyTitle('Fix the Parser Bug!'), 'fix-the-parser-bug')
  assert.equal(slugifyTitle('  spaced  out  '), 'spaced-out')
  assert.equal(slugifyTitle('a___b'), 'a-b')
  assert.equal(slugifyTitle('--leading and trailing--'), 'leading-and-trailing')
})

test('slugifyTitle folds diacritics away', () => {
  assert.equal(slugifyTitle('Café rénové'), 'cafe-renove')
  assert.equal(slugifyTitle('Naïve résumé'), 'naive-resume')
  // NFKD does not transliterate ß, so it survives as a separator.
  assert.equal(slugifyTitle('Straße'), 'stra-e')
})

test('slugifyTitle yields an empty slug for titles with no ASCII alphanumerics', () => {
  assert.equal(slugifyTitle('修复 worktree 隔离'), 'worktree')
  assert.equal(slugifyTitle('修复worktree隔离'), 'worktree')
  assert.equal(slugifyTitle('修复解析器'), '')
  assert.equal(slugifyTitle(''), '')
  assert.equal(slugifyTitle(undefined), '')
  assert.equal(slugifyTitle(42), '')
})

test('slugifyTitle caps the length without leaving a trailing dash', () => {
  const slug = slugifyTitle(`${'a'.repeat(40)} ${'b'.repeat(40)}`)
  assert.equal(slug.length, MAX_SLUG_LENGTH)
  assert.ok(!slug.endsWith('-'))
  assert.equal(slugifyTitle('abc', 2), 'ab')
  assert.equal(slugifyTitle('ab cdef', 3), 'ab')
})

test('sanitizeDirName keeps a branch to one path segment', () => {
  assert.equal(sanitizeDirName('fix/parser'), 'fix-parser')
  assert.equal(sanitizeDirName('wip/1a2b3c4d'), 'wip-1a2b3c4d')
  assert.equal(sanitizeDirName('back\\slash'), 'back-slash')
  assert.equal(sanitizeDirName('///'), 'worktree')
  assert.equal(sanitizeDirName(''), 'worktree')
  assert.equal(sanitizeDirName(undefined), 'worktree')
})

test('placeholder branches are recognized by prefix', () => {
  assert.equal(provisionalBranch('1a2b3c4d'), `${PROVISIONAL_PREFIX}1a2b3c4d`)
  assert.equal(isProvisionalBranch(provisionalBranch('1a2b3c4d')), true)
  assert.equal(isProvisionalBranch('fix/parser'), false)
  assert.equal(isProvisionalBranch(undefined), false)
})

test('disambiguate appends the first free numeric suffix', () => {
  assert.equal(disambiguate('a', new Set()), 'a')
  assert.equal(disambiguate('a', new Set(['a'])), 'a-2')
  assert.equal(disambiguate('a', new Set(['a', 'a-2'])), 'a-3')
  assert.equal(disambiguate('a', new Set(['a', 'a-2', 'a-3'])), 'a-4')
})

test('shortHash is stable, six characters, and distinguishes paths', () => {
  assert.equal(shortHash('/a/repo').length, 6)
  assert.match(shortHash('/a/repo'), /^[0-9a-f]{6}$/)
  assert.equal(shortHash('/a/repo'), shortHash('/a/repo'))
  assert.notEqual(shortHash('/a/repo'), shortHash('/b/repo'))
  assert.equal(shortHash(undefined).length, 6)
})

test('repoDirSegment uses the directory name and escapes a name collision', () => {
  assert.equal(repoDirSegment('/home/me/project'), 'project')
  assert.equal(repoDirSegment('/home/me/project/'), 'project')
  assert.equal(repoDirSegment('/'), 'repo')
  const escaped = repoDirSegment('/other/project', new Set(['project']))
  assert.equal(escaped, `project-${shortHash('/other/project')}`)
})

test('worktreeDirectory composes root, repository segment, and branch segment', () => {
  assert.equal(
    worktreeDirectory('/home/me/.dsh/worktrees', '/src/project', 'fix/parser'),
    '/home/me/.dsh/worktrees/project/fix-parser',
  )
  assert.equal(
    worktreeDirectory('/root', '/src/project', 'wip/1a2b3c4d', new Set(['project'])),
    `/root/project-${shortHash('/src/project')}/wip-1a2b3c4d`,
  )
})