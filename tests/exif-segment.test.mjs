/**
 * Regression tests for rewriting the pixel-dimension tags of an EXIF APP1 segment.
 * Run: node tests/exif-segment.test.mjs
 */
import { setPixelDimensionsInExifSegment } from '../js/loaders/loader-exif.js';

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
    if (condition) pass++;
    else { fail++; console.error('  FAIL:', message); }
};

const SHORT = 3;
const LONG = 4;
const TIFF = 10;  // "Exif\0\0" ends here; the TIFF header starts

/**
 * Build a synthetic APP1 segment.
 * ifd0Tags / exifTags are [tag, type, count, value] tuples. Passing an empty
 * exifTags list omits the EXIF sub-IFD pointer entirely.
 */
function buildSegment({ little = true, ifd0Tags = [], exifTags = [], badMagic = false,
                        ifd0Offset = null, subIfdOffset = null, thumbTags = [] } = {}) {
    const hasSubIfd = exifTags.length > 0;
    const ifd0Count = ifd0Tags.length + (hasSubIfd ? 1 : 0);
    const ifd0Rel = 8;
    const subIfdRel = ifd0Rel + 2 + ifd0Count * 12 + 4;
    const subIfdLen = hasSubIfd ? 2 + exifTags.length * 12 + 4 : 0;
    const ifd1Rel = subIfdRel + subIfdLen;
    const total = TIFF + ifd1Rel + (thumbTags.length ? 2 + thumbTags.length * 12 + 4 : 0);
    const buf = new Uint8Array(total);

    const w16 = (o, v) => { if (little) { buf[o] = v & 255; buf[o + 1] = (v >> 8) & 255; }
                            else { buf[o] = (v >> 8) & 255; buf[o + 1] = v & 255; } };
    const w32 = (o, v) => { if (little) { buf[o] = v & 255; buf[o + 1] = (v >> 8) & 255; buf[o + 2] = (v >> 16) & 255; buf[o + 3] = (v >>> 24) & 255; }
                            else { buf[o] = (v >>> 24) & 255; buf[o + 1] = (v >> 16) & 255; buf[o + 2] = (v >> 8) & 255; buf[o + 3] = v & 255; } };

    buf[0] = 0xFF; buf[1] = 0xE1;
    // The JPEG segment length is big-endian regardless of the TIFF byte order.
    buf[2] = ((total - 2) >> 8) & 255; buf[3] = (total - 2) & 255;
    [0x45, 0x78, 0x69, 0x66, 0, 0].forEach((b, i) => { buf[4 + i] = b; });
    buf[TIFF] = buf[TIFF + 1] = little ? 0x49 : 0x4D;
    w16(TIFF + 2, badMagic ? 41 : 42);
    w32(TIFF + 4, ifd0Offset === null ? ifd0Rel : ifd0Offset);

    const writeEntries = (start, tags, extra, nextIfd = 0) => {
        w16(start, tags.length + (extra ? 1 : 0));
        tags.forEach(([tag, type, count, value], i) => {
            const e = start + 2 + i * 12;
            w16(e, tag); w16(e + 2, type); w32(e + 4, count);
            if (type === SHORT && count === 1) w16(e + 8, value); else w32(e + 8, value);
        });
        if (extra) {
            const e = start + 2 + tags.length * 12;
            w16(e, 0x8769); w16(e + 2, LONG); w32(e + 4, 1);
            w32(e + 8, subIfdOffset === null ? extra : subIfdOffset);
        }
        w32(start + 2 + (tags.length + (extra ? 1 : 0)) * 12, nextIfd);
    };

    writeEntries(TIFF + ifd0Rel, ifd0Tags, hasSubIfd ? subIfdRel : 0,
                 thumbTags.length ? ifd1Rel : 0);
    if (hasSubIfd) writeEntries(TIFF + subIfdRel, exifTags, 0);
    if (thumbTags.length) writeEntries(TIFF + ifd1Rel, thumbTags, 0);
    return buf;
}

/** Read IFD1's ImageWidth/ImageLength by following IFD0's next-IFD pointer. */
function readThumbTags(segment) {
    const little = segment[TIFF] === 0x49;
    const r16 = o => little ? segment[o] | segment[o + 1] << 8 : segment[o] << 8 | segment[o + 1];
    const r32 = o => (little ? (segment[o] | segment[o + 1] << 8 | segment[o + 2] << 16 | segment[o + 3] << 24)
                             : (segment[o] << 24 | segment[o + 1] << 16 | segment[o + 2] << 8 | segment[o + 3])) >>> 0;
    const ifd0 = TIFF + r32(TIFF + 4);
    const ifd1 = TIFF + r32(ifd0 + 2 + r16(ifd0) * 12);
    const out = {};
    for (let i = 0; i < r16(ifd1); i++) {
        const e = ifd1 + 2 + i * 12;
        if (r16(e) === 0x0100) out.width = r32(e + 8);
        else if (r16(e) === 0x0101) out.height = r32(e + 8);
    }
    return out;
}

/** Read back a tag's inline value, or undefined when the tag is absent. */
function readTag(segment, wanted) {
    const little = segment[TIFF] === 0x49;
    const r16 = o => little ? segment[o] | segment[o + 1] << 8 : segment[o] << 8 | segment[o + 1];
    const r32 = o => (little ? (segment[o] | segment[o + 1] << 8 | segment[o + 2] << 16 | segment[o + 3] << 24)
                             : (segment[o] << 24 | segment[o + 1] << 16 | segment[o + 2] << 8 | segment[o + 3])) >>> 0;
    const scan = (start) => {
        let sub = 0, found;
        for (let i = 0; i < r16(start); i++) {
            const e = start + 2 + i * 12;
            if (r16(e) === 0x8769) sub = TIFF + r32(e + 8);
            if (r16(e) === wanted) found = r16(e + 2) === SHORT ? r16(e + 8) : r32(e + 8);
        }
        return found !== undefined ? found : (sub ? scan(sub) : undefined);
    };
    return scan(TIFF + r32(TIFF + 4));
}

// Both byte orders and both inline numeric types must be rewritten in place.
for (const little of [true, false]) {
    for (const [typeName, type] of [['SHORT', SHORT], ['LONG', LONG]]) {
        const seg = buildSegment({
            little,
            ifd0Tags: [[0x0112, SHORT, 1, 1], [0x0100, type, 1, 4000], [0x0101, type, 1, 3000]],
            exifTags: [[0xA002, type, 1, 4000], [0xA003, type, 1, 3000]]
        });
        const out = setPixelDimensionsInExifSegment(seg, 3998, 2996);
        const label = `${little ? 'little' : 'big'}-endian ${typeName}`;
        ok(readTag(out, 0xA002) === 3998 && readTag(out, 0xA003) === 2996,
            `${label}: PixelXDimension/PixelYDimension rewritten`);
        ok(readTag(out, 0x0100) === 3998 && readTag(out, 0x0101) === 2996,
            `${label}: IFD0 ImageWidth/ImageLength rewritten`);
        ok(out.length === seg.length, `${label}: segment length unchanged`);
        ok(readTag(out, 0x0112) === 1, `${label}: unrelated tags left intact`);
    }
}

// The stored segment is shared across exports, so it must not be mutated.
{
    const seg = buildSegment({ exifTags: [[0xA002, LONG, 1, 4000], [0xA003, LONG, 1, 3000]] });
    const before = Uint8Array.from(seg);
    const out = setPixelDimensionsInExifSegment(seg, 1920, 1080);
    ok(out !== seg, 'returns a copy, not the input instance');
    ok(seg.every((b, i) => b === before[i]), 'input segment is left unmodified');
    ok(readTag(out, 0xA002) === 1920, 'the copy carries the new value');
}

// Absent tags must not be synthesized: growing the segment would invalidate offsets.
{
    const seg = buildSegment({ exifTags: [[0xA002, LONG, 1, 4000], [0xA003, LONG, 1, 3000]] });
    const out = setPixelDimensionsInExifSegment(seg, 800, 600);
    ok(out.length === seg.length, 'no IFD0 dimension tags: length unchanged');
    ok(readTag(out, 0x0100) === undefined, 'missing ImageWidth is not added');
    ok(readTag(out, 0xA002) === 800, 'sub-IFD tags still rewritten');
}
{
    const seg = buildSegment({ ifd0Tags: [[0x0100, LONG, 1, 4000], [0x0101, LONG, 1, 3000]] });
    const out = setPixelDimensionsInExifSegment(seg, 800, 600);
    ok(readTag(out, 0x0100) === 800 && readTag(out, 0x0101) === 600,
        'IFD0 tags rewritten when there is no EXIF sub-IFD');
}

// A SHORT cannot hold a value above 65535; leaving it alone beats truncating it.
{
    const seg = buildSegment({ exifTags: [[0xA002, SHORT, 1, 4000], [0xA003, SHORT, 1, 3000]] });
    const out = setPixelDimensionsInExifSegment(seg, 70000, 2996);
    ok(readTag(out, 0xA002) === 4000, 'SHORT out of range is left unchanged rather than truncated');
    ok(readTag(out, 0xA003) === 2996, 'the in-range sibling is still rewritten');
}
{
    const seg = buildSegment({ exifTags: [[0xA002, LONG, 1, 4000], [0xA003, LONG, 1, 3000]] });
    const out = setPixelDimensionsInExifSegment(seg, 70000, 2996);
    ok(readTag(out, 0xA002) === 70000, 'LONG holds a value above 65535');
}

// With count != 1 the value field is an offset, not a value; touching it would corrupt the IFD.
{
    const seg = buildSegment({ exifTags: [[0xA002, LONG, 2, 4000], [0xA003, LONG, 1, 3000]] });
    const before = Uint8Array.from(seg);
    const out = setPixelDimensionsInExifSegment(seg, 1920, 1080);
    ok(readTag(out, 0xA002) === 4000, 'count != 1 entry is skipped');
    ok(readTag(out, 0xA003) === 1080, 'its count-1 sibling is still rewritten');
    // The skipped entry must be byte-identical: its value field is an offset, and
    // the only bytes allowed to differ anywhere are the sibling's value field.
    const subIfdStart = TIFF + 8 + 2 + 1 * 12 + 4;   // one IFD0 entry: the sub-IFD pointer
    const skippedEntry = subIfdStart + 2;
    const siblingValue = subIfdStart + 2 + 12 + 8;
    const changed = [...out.keys()].filter(i => out[i] !== before[i]);
    ok(changed.every(i => i >= siblingValue && i < siblingValue + 4),
        `only the sibling's value field changed (changed offsets: ${changed})`);
    ok(changed.every(i => i < skippedEntry || i >= skippedEntry + 12),
        'the skipped entry is byte-identical');
}

// An IFD offset inside the 8-byte TIFF header is invalid. A zero offset is the
// dangerous case: the byte-order mark would read as an entry count of 18761 and
// send the loop scanning non-IFD bytes for something that looks like a match.
{
    for (const ifd0Offset of [0, 2, 7]) {
        const seg = buildSegment({
            ifd0Offset,
            ifd0Tags: [[0x0100, LONG, 1, 4000]],
            exifTags: [[0xA002, LONG, 1, 4000], [0xA003, LONG, 1, 3000]]
        });
        ok(setPixelDimensionsInExifSegment(seg, 1920, 1080) === seg,
            `IFD0 offset ${ifd0Offset} (inside the TIFF header) is rejected`);
    }
}
{
    // A bad sub-IFD pointer must not stop IFD0 from being corrected.
    const seg = buildSegment({
        subIfdOffset: 0,
        ifd0Tags: [[0x0100, LONG, 1, 4000], [0x0101, LONG, 1, 3000]],
        exifTags: [[0xA002, LONG, 1, 4000], [0xA003, LONG, 1, 3000]]
    });
    const out = setPixelDimensionsInExifSegment(seg, 1920, 1080);
    ok(readTag(out, 0x0100) === 1920 && readTag(out, 0x0101) === 1080,
        'IFD0 tags still rewritten when the sub-IFD pointer is invalid');
    ok(out.length === seg.length, 'invalid sub-IFD pointer does not change the length');
}

// IFD1 describes the embedded thumbnail, and its ImageWidth/ImageLength are the
// THUMBNAIL's size. Rewriting them to the main image size would corrupt it, so
// the next-IFD pointer must never be followed.
{
    const seg = buildSegment({
        ifd0Tags: [[0x0100, LONG, 1, 4000], [0x0101, LONG, 1, 3000]],
        exifTags: [[0xA002, LONG, 1, 4000], [0xA003, LONG, 1, 3000]],
        thumbTags: [[0x0100, LONG, 1, 160], [0x0101, LONG, 1, 120]]
    });
    const out = setPixelDimensionsInExifSegment(seg, 1920, 1080);
    ok(readTag(out, 0xA002) === 1920 && readTag(out, 0x0100) === 1920,
        'main image tags rewritten while an IFD1 is present');
    const thumb = readThumbTags(out);
    ok(thumb.width === 160 && thumb.height === 120,
        `IFD1 thumbnail dimensions untouched (got ${thumb.width}x${thumb.height}, expected 160x120)`);
}

// Malformed or unusable input must be returned untouched.
{
    const bad = buildSegment({ badMagic: true, exifTags: [[0xA002, LONG, 1, 4000]] });
    ok(setPixelDimensionsInExifSegment(bad, 100, 100) === bad, 'non-TIFF header returns the input');
    ok(setPixelDimensionsInExifSegment(new Uint8Array(4), 100, 100).length === 4, 'too-short segment returns the input');
    ok(setPixelDimensionsInExifSegment(null, 100, 100) === null, 'null segment returns the input');

    const seg = buildSegment({ exifTags: [[0xA002, LONG, 1, 4000]] });
    ok(setPixelDimensionsInExifSegment(seg, 0, 100) === seg, 'zero width returns the input');
    ok(setPixelDimensionsInExifSegment(seg, 100.5, 100) === seg, 'non-integer width returns the input');
    ok(setPixelDimensionsInExifSegment(seg, NaN, 100) === seg, 'NaN width returns the input');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
