const OPUS_SAMPLE_RATE = 48_000
const PAGE_HEADER_BYTES = 27
const OPUS_HEAD_BYTES = 19

function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * Cheap structural look at an audio buffer. `isOggOpus` = starts with 'OggS'
 * and the first packet is 'OpusHead'. `channels` from the OpusHead header.
 * `durationSeconds` from the last Ogg page's granule position (Opus granules
 * are 48 kHz samples; subtract the header's pre-skip), or null if unreadable.
 *
 * Never throws: anything short, truncated or not Ogg Opus comes back as
 * `{ isOggOpus: false, channels: null, durationSeconds: null }`.
 */
export function inspectOggOpus(bytes: Uint8Array): {
  isOggOpus: boolean
  channels: number | null
  durationSeconds: number | null
} {
  const none = { isOggOpus: false, channels: null, durationSeconds: null }
  if (!hasAscii(bytes, 0, 'OggS') || bytes.length < PAGE_HEADER_BYTES) return none

  const head = PAGE_HEADER_BYTES + bytes[26] // first page's payload
  if (!hasAscii(bytes, head, 'OpusHead') || bytes.length < head + OPUS_HEAD_BYTES) return none
  const channels = bytes[head + 9]
  const preSkip = bytes[head + 10] | (bytes[head + 11] << 8)

  // Walk the pages; keep the last granule position that marks a finished
  // packet (all-ones means "no packet ends on this page"). A truncated
  // file simply stops the walk at the last whole page header.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let granule = 0
  let pos = 0
  while (pos + PAGE_HEADER_BYTES <= bytes.length && hasAscii(bytes, pos, 'OggS')) {
    const segments = bytes[pos + 26]
    if (pos + PAGE_HEADER_BYTES + segments > bytes.length) break
    const lo = view.getUint32(pos + 6, true)
    const hi = view.getUint32(pos + 10, true)
    if (!(lo === 0xffffffff && hi === 0xffffffff)) granule = hi * 2 ** 32 + lo
    let payload = 0
    for (let i = 0; i < segments; i++) payload += bytes[pos + PAGE_HEADER_BYTES + i]
    pos += PAGE_HEADER_BYTES + segments + payload
  }

  return {
    isOggOpus: true,
    channels,
    durationSeconds: granule > preSkip ? (granule - preSkip) / OPUS_SAMPLE_RATE : null,
  }
}
