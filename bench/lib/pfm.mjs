/**
 * bench/lib/pfm.mjs
 *
 * Reader for the PFM (portable float map) files the Middlebury stereo datasets
 * use for ground-truth disparity.
 *
 * A PFM file is a short ASCII header followed by raw 32-bit floats:
 *
 *   Pf            greyscale (one sample per pixel); PF would be three
 *   <w> <h>
 *   <scale>       negative means little-endian samples, positive big-endian
 *   <raw float32 data>
 *
 * Rows are stored bottom-to-top, so the reader flips them to the top-to-bottom
 * order every other image in this benchmark uses. Pixels with no ground truth
 * are stored as +Infinity by the Middlebury convention and are passed through
 * unchanged; callers test with Number.isFinite to select valid pixels.
 */

/**
 * Read one whitespace-delimited header token starting at `offset`, skipping any
 * leading whitespace and PFM comment lines.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{token: string, offset: number}}
 */
function readToken(buf, offset) {
    let i = offset;
    for (;;) {
        while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++;
        if (buf[i] === 0x23) {
            // '#' starts a comment that runs to the end of the line.
            while (i < buf.length && buf[i] !== 0x0a) i++;
            continue;
        }
        break;
    }
    const start = i;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i++;
    if (start === i) throw new Error('malformed PFM header');
    return { token: buf.toString('ascii', start, i), offset: i };
}

/**
 * Decode a PFM buffer.
 *
 * @param {Buffer} buf
 * @returns {{width:number, height:number, channels:number, data:Float32Array}}
 *          `data` is row-major, top-to-bottom
 */
export function decodePfm(buf) {
    let off = 0;
    const type = readToken(buf, off);
    off = type.offset;
    let channels;
    if (type.token === 'Pf') channels = 1;
    else if (type.token === 'PF') channels = 3;
    else throw new Error(`not a PFM file (header "${type.token}")`);

    const wTok = readToken(buf, off);
    off = wTok.offset;
    const hTok = readToken(buf, off);
    off = hTok.offset;
    const sTok = readToken(buf, off);
    off = sTok.offset;

    const width = Number.parseInt(wTok.token, 10);
    const height = Number.parseInt(hTok.token, 10);
    const scale = Number.parseFloat(sTok.token);
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(scale)) {
        throw new Error('malformed PFM header values');
    }

    // Exactly one whitespace byte separates the header from the payload.
    off += 1;

    const littleEndian = scale < 0;
    const count = width * height * channels;
    const expected = count * 4;
    if (buf.length - off < expected) {
        throw new Error('PFM payload is shorter than the declared image size');
    }

    // Read bottom-to-top into a top-to-bottom array.
    const data = new Float32Array(count);
    const rowFloats = width * channels;
    for (let y = 0; y < height; y++) {
        const srcRow = height - 1 - y;
        let p = off + srcRow * rowFloats * 4;
        const dstBase = y * rowFloats;
        for (let i = 0; i < rowFloats; i++, p += 4) {
            data[dstBase + i] = littleEndian ? buf.readFloatLE(p) : buf.readFloatBE(p);
        }
    }

    return { width, height, channels, data };
}
