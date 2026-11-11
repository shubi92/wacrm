import { describe, expect, it } from 'vitest'
import { inspectOggOpus } from './ogg'

const NONE = { isOggOpus: false, channels: null, durationSeconds: null }

/** One Ogg page: 27-byte header + a one-entry segment table + payload. */
function oggPage(granule: number, payload: number[]): number[] {
  const header = new Uint8Array(27)
  header.set([0x4f, 0x67, 0x67, 0x53]) // "OggS"
  const view = new DataView(header.buffer)
  view.setUint32(6, granule >>> 0, true)
  view.setUint32(10, Math.floor(granule / 2 ** 32), true)
  header[26] = 1 // one segment
  return [...header, payload.length, ...payload]
}

/** The 19-byte OpusHead identification packet. */
function opusHead(channels: number, preSkip: number): number[] {
  return [
    ...new TextEncoder().encode('OpusHead'),
    1, // version
    channels,
    preSkip & 0xff,
    preSkip >> 8,
    0x80, 0xbb, 0, 0, // input sample rate 48000
    0, 0, // output gain
    0, // mapping family
  ]
}

const PRE_SKIP = 312

function oggOpus(channels: number, lastGranule: number): Uint8Array {
  return new Uint8Array([
    ...oggPage(0, opusHead(channels, PRE_SKIP)),
    ...oggPage(lastGranule, [0xde, 0xad, 0xbe, 0xef]),
  ])
}

describe('inspectOggOpus', () => {
  it('reads mono + duration from a minimal Ogg Opus file', () => {
    // 3 seconds of audio = 144000 samples after the pre-skip.
    expect(inspectOggOpus(oggOpus(1, 3 * 48_000 + PRE_SKIP))).toEqual({
      isOggOpus: true,
      channels: 1,
      durationSeconds: 3,
    })
  })

  it('reports 2 channels for a stereo header', () => {
    expect(inspectOggOpus(oggOpus(2, 48_000 + PRE_SKIP))).toMatchObject({
      isOggOpus: true,
      channels: 2,
      durationSeconds: 1,
    })
  })

  it('skips a trailing "no packet ends here" page and reads a subarray view', () => {
    const file = [
      ...oggPage(0, opusHead(1, PRE_SKIP)),
      ...oggPage(2 * 48_000 + PRE_SKIP, [1, 2, 3]),
    ]
    const noPacketEnds = oggPage(0, [9])
    noPacketEnds.fill(0xff, 6, 14) // granule = -1
    const padded = new Uint8Array([0, 0, 0, ...file, ...noPacketEnds])
    expect(inspectOggOpus(padded.subarray(3))).toEqual({
      isOggOpus: true,
      channels: 1,
      durationSeconds: 2,
    })
  })

  it('gives a null duration when only the header page is there', () => {
    expect(inspectOggOpus(new Uint8Array(oggPage(0, opusHead(1, PRE_SKIP))))).toEqual({
      isOggOpus: true,
      channels: 1,
      durationSeconds: null,
    })
  })

  it('rejects MP3, random, empty and Ogg-but-not-Opus bytes', () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])
    const random = Uint8Array.from({ length: 256 }, (_, i) => (i * 97 + 13) % 256)
    const vorbis = new Uint8Array(oggPage(0, [1, ...new TextEncoder().encode('vorbis'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    for (const bytes of [mp3, random, new Uint8Array(), vorbis]) {
      expect(inspectOggOpus(bytes)).toEqual(NONE)
    }
  })

  it('never throws on a file truncated at any length', () => {
    const full = oggOpus(1, 48_000 + PRE_SKIP)
    for (let len = 0; len <= full.length; len++) {
      expect(() => inspectOggOpus(full.subarray(0, len))).not.toThrow()
    }
  })
})
