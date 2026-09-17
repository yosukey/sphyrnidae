/**
 * bench/lib/png.mjs
 *
 * Minimal PNG reader and writer built on node:zlib alone.
 *
 * The OpenCV.js build shipped in opencv/ is compiled for the browser and its
 * whitelist omits imdecode/imencode, so a Node-side benchmark cannot use OpenCV
 * to get pixels off disk. Rather than add an image-codec dependency to a
 * repository that has none, this module implements the subset of PNG the corpus
 * needs: non-interlaced, 8- or 16-bit, greyscale / RGB / greyscale+alpha / RGBA.
 * 16-bit samples are reduced to 8 bits by keeping the high byte, which is what
 * a browser canvas would also hand back through getImageData.
 *
 * Palette images (colour type 3) and Adam7-interlaced images are rejected with
 * an explicit error rather than decoded incorrectly.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Samples per pixel for each supported PNG colour type. */
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Undo one PNG scanline filter in place.
 *
 * @param {number} filter - filter type byte (0..4)
 * @param {Buffer} line - the filtered scanline
 * @param {Buffer} cur - destination row
 * @param {Buffer|null} prev - previously reconstructed row, or null on row 0
 * @param {number} bpp - bytes per pixel
 */
function unfilterRow(filter, line, cur, prev, bpp) {
    const stride = cur.length;
    for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        switch (filter) {
            case 0: break;
            case 1: v += a; break;
            case 2: v += b; break;
            case 3: v += (a + b) >> 1; break;
            case 4: {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                break;
            }
            default:
                throw new Error(`unsupported PNG filter type ${filter}`);
        }
        cur[i] = v & 0xff;
    }
}

/**
 * Decode a PNG buffer.
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number, channels:number, data:Buffer}}
 *          `data` is row-major, `channels` samples per pixel, 8 bits each
 */
export function decodePng(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('not a PNG file');
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];

    while (offset + 8 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const data = buf.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }

    if (!width || !height) throw new Error('PNG has no IHDR');
    if (interlace !== 0) throw new Error('interlaced (Adam7) PNG is not supported');
    if (colorType === 3) throw new Error('palette PNG (colour type 3) is not supported');
    if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`unsupported PNG bit depth ${bitDepth}`);

    const channels = CHANNELS_BY_COLOR_TYPE[colorType];
    if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

    const bytesPerSample = bitDepth / 8;
    const bpp = channels * bytesPerSample;
    const stride = width * bpp;
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length < height * (stride + 1)) {
        throw new Error('PNG IDAT is shorter than the declared image size');
    }

    const recon = Buffer.alloc(height * stride);
    let p = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[p++];
        const line = raw.subarray(p, p + stride);
        p += stride;
        const cur = recon.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? recon.subarray((y - 1) * stride, y * stride) : null;
        unfilterRow(filter, line, cur, prev, bpp);
    }

    if (bitDepth === 8) {
        return { width, height, channels, data: recon };
    }

    // 16-bit: keep the high byte of each big-endian sample.
    const out = Buffer.alloc(width * height * channels);
    for (let i = 0, j = 0; i < out.length; i++, j += 2) {
        out[i] = recon[j];
    }
    return { width, height, channels, data: out };
}

/**
 * Expand a decoded image to 4 channels, which is the layout OpenCV.js expects
 * for a CV_8UC4 Mat (and what a canvas ImageData carries).
 *
 * @param {{width:number, height:number, channels:number, data:Buffer}} img
 * @returns {Buffer} RGBA, length width * height * 4
 */
export function toRgba(img) {
    const { width, height, channels, data } = img;
    if (channels === 4) return Buffer.from(data);
    const out = Buffer.alloc(width * height * 4);
    const n = width * height;
    for (let i = 0; i < n; i++) {
        const s = i * channels;
        const d = i * 4;
        if (channels === 1) {
            out[d] = out[d + 1] = out[d + 2] = data[s];
            out[d + 3] = 255;
        } else if (channels === 2) {
            out[d] = out[d + 1] = out[d + 2] = data[s];
            out[d + 3] = data[s + 1];
        } else {
            out[d] = data[s];
            out[d + 1] = data[s + 1];
            out[d + 2] = data[s + 2];
            out[d + 3] = 255;
        }
    }
    return out;
}

/**
 * CRC-32 as specified by the PNG format.
 */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
    const out = Buffer.alloc(payload.length + 12);
    out.writeUInt32BE(payload.length, 0);
    out.write(type, 4, 'ascii');
    payload.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + payload.length)), 8 + payload.length);
    return out;
}

/**
 * Encode an 8-bit image as a non-interlaced PNG. Every scanline uses filter 0,
 * which keeps the writer trivial; these files are debugging aids, not assets,
 * so compression ratio does not matter.
 *
 * @param {{width:number, height:number, channels:number, data:Buffer|Uint8Array}} img
 *        channels must be 1, 2, 3 or 4
 * @returns {Buffer}
 */
export function encodePng({ width, height, channels, data }) {
    const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
    if (colorType === undefined) throw new Error(`cannot encode ${channels}-channel image`);

    const stride = width * channels;
    const raw = Buffer.alloc(height * (stride + 1));
    const source = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        source.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
