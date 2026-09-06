import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  validateSealedInputFileMetadata,
} from '../src/sealed-input-file.js'

const identity = { uid: 10001, gid: 10001, groups: [10001] }
const safe = {
  isFile: true,
  isSymbolicLink: false,
  uid: 0,
  gid: 10001,
  mode: 0o100440,
  size: 128,
  nlink: 1,
}

describe('sealed input file boundary', () => {
  it('accepts only one root-owned group-readable regular file', () => {
    assert.doesNotThrow(() => validateSealedInputFileMetadata(
      safe,
      { expectedGid: 10001, maximumBytes: 1024 },
      identity,
    ))
  })

  it('rejects links, unsafe ownership, mode, size and process groups', () => {
    const mutations = [
      { isSymbolicLink: true }, { uid: 10001 }, { gid: 10002 },
      { mode: 0o100640 }, { size: 0 }, { size: 1025 }, { nlink: 2 },
    ]
    for (const mutation of mutations) {
      assert.throws(() => validateSealedInputFileMetadata(
        { ...safe, ...mutation },
        { expectedGid: 10001, maximumBytes: 1024 },
        identity,
      ))
    }
    assert.throws(() => validateSealedInputFileMetadata(
      safe,
      { expectedGid: 10001, maximumBytes: 1024 },
      { uid: 10002, gid: 10002, groups: [10002] },
    ), /SEALED_INPUT_GROUP_MEMBERSHIP_REQUIRED/)
  })
})
