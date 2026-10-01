// 由 scripts/make-icons.mjs 的图形定义派生：把品牌标记按商店要求的尺寸重新矢量渲染，
// 而不是把 128px 的图标放大（放大必然发虚）。只在 .tmp/ 下运行，产物拷进 发布版/商店素材/。
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let crc = -1
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4 + 1
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// —— 与 scripts/make-icons.mjs 完全一致的图形定义（归一化 0..1 坐标）——
function roundedRect(u, v, inset, radius) {
  const dx = Math.abs(u - 0.5) - (0.5 - inset - radius)
  const dy = Math.abs(v - 0.5) - (0.5 - inset - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return radius - outside
}
function box(u, v, x0, y0, x1, y1) {
  return Math.min(u - x0, x1 - u, v - y0, y1 - v)
}
function markShape(u, v) {
  return {
    bg: roundedRect(u, v, 0.035, 0.18),
    letter: Math.max(box(u, v, 0.24, 0.27, 0.76, 0.405), box(u, v, 0.43, 0.27, 0.57, 0.76)),
  }
}

const SUB = 4
const STEP = 1 / (SUB + 1)

/** 透明底 + 品牌标记，用于商店图标（1:1）。 */
function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgCover = 0
      let letterCover = 0
      for (let sy = 1; sy <= SUB; sy += 1) {
        for (let sx = 1; sx <= SUB; sx += 1) {
          const { bg, letter } = markShape((x + sx * STEP) / size, (y + sy * STEP) / size)
          if (bg > 0) bgCover += 1
          if (letter > 0) letterCover += 1
        }
      }
      const samples = SUB * SUB
      const bgA = bgCover / samples
      const letterA = letterCover / samples
      const i = (y * size + x) * 4
      px[i] = Math.round(0x3b + (0xff - 0x3b) * letterA)
      px[i + 1] = Math.round(0x82 + (0xff - 0x82) * letterA)
      px[i + 2] = Math.round(0xf6 + (0xff - 0xf6) * letterA)
      px[i + 3] = Math.round(bgA * 255)
    }
  }
  return encodePng(size, size, px)
}

/** 深色渐变底 + 居中品牌标记的宣传图，用于商店 promotional tile。 */
function renderTile(width, height, opts = {}) {
  const top = opts.top ?? [0x0b, 0x12, 0x20]
  const bottom = opts.bottom ?? [0x17, 0x27, 0x40]
  const markRatio = opts.markRatio ?? 0.46
  const px = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    const t = height > 1 ? y / (height - 1) : 0
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      px[i] = Math.round(top[0] + (bottom[0] - top[0]) * t)
      px[i + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t)
      px[i + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t)
      px[i + 3] = 255
    }
  }

  const side = Math.round(Math.min(width, height) * markRatio)
  const x0 = Math.round((width - side) / 2)
  const y0 = Math.round((height - side) / 2)

  for (let y = y0; y < y0 + side; y += 1) {
    for (let x = x0; x < x0 + side; x += 1) {
      let bgCover = 0
      let letterCover = 0
      for (let sy = 1; sy <= SUB; sy += 1) {
        for (let sx = 1; sx <= SUB; sx += 1) {
          const u = (x - x0 + sx * STEP) / side
          const v = (y - y0 + sy * STEP) / side
          const { bg, letter } = markShape(u, v)
          if (bg > 0) bgCover += 1
          if (letter > 0) letterCover += 1
        }
      }
      const samples = SUB * SUB
      const bgA = bgCover / samples
      const letterA = letterCover / samples
      if (bgA === 0) continue
      const i = (y * width + x) * 4
      const vT = side > 1 ? (y - y0) / (side - 1) : 0
      const mr = Math.round(0x3b + (0x25 - 0x3b) * vT)
      const mg = Math.round(0x82 + (0x63 - 0x82) * vT)
      const mb = Math.round(0xf6 + (0xeb - 0xf6) * vT)
      // 标记底色按覆盖率先压在渐变底上，再把白色字母叠上去
      px[i] = Math.round(px[i] * (1 - bgA) + mr * bgA)
      px[i + 1] = Math.round(px[i + 1] * (1 - bgA) + mg * bgA)
      px[i + 2] = Math.round(px[i + 2] * (1 - bgA) + mb * bgA)
      px[i] = Math.round(px[i] * (1 - letterA) + 0xff * letterA)
      px[i + 1] = Math.round(px[i + 1] * (1 - letterA) + 0xff * letterA)
      px[i + 2] = Math.round(px[i + 2] * (1 - letterA) + 0xff * letterA)
    }
  }
  return encodePng(width, height, px)
}

const out = process.argv[2]
mkdirSync(out, { recursive: true })

writeFileSync(`${out}/icon-128.png`, renderIcon(128))
writeFileSync(`${out}/logo-300.png`, renderIcon(300))
writeFileSync(`${out}/promo-440x280.png`, renderTile(440, 280))
writeFileSync(`${out}/promo-1400x560.png`, renderTile(1400, 560, { markRatio: 0.5 }))

console.log(`[store-assets] 已生成到 ${out}`)
