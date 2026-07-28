/**
 * loader-exif.js
 * EXIF data management module
 * Read and manage EXIF info from image files
 */

import { state, DEBUG } from '../globals.js';
import * as logger from '../utils/logger.js';

// Prevent race conditions in EXIF loading
let exifLoadToken = 0;       // EXIF load generation token

/**
 * Increment and return the EXIF token (used when starting a new load externally)
 * @returns {number} New token value
 */
export function getNextExifToken() {
    return ++exifLoadToken;
}

/**
 * Get the current EXIF token value
 * @returns {number} Current token value
 */
export function getCurrentExifToken() {
    return exifLoadToken;
}

/**
 * Extract the raw EXIF APP1 segment from a JPEG ArrayBuffer.
 * Returns the segment as a Uint8Array (including FFE1 marker + length),
 * or null if no EXIF APP1 is present or input is not a JPEG.
 * The returned bytes can be spliced directly back into another JPEG.
 * Side effect: rewrites the Orientation tag in IFD0 to 1, since
 * the renderer already exports an upright image and re-applying the
 * original Orientation would double-rotate.
 */
export function extractExifApp1Segment(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 4) return null;
    const view = new DataView(arrayBuffer);
    if (view.getUint16(0) !== 0xFFD8) return null;  // Not a JPEG SOI

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
        // A marker must start with 0xFF. JPEG allows any number of 0xFF fill bytes
        // before the marker code; skip them so a fill byte (or a standalone marker
        // emitting an extra 0xFF) does not cause us to mis-read the length and lose
        // valid EXIF. Mirrors the MPO inner-loop handling in the worker.
        if (view.getUint8(offset) !== 0xFF) return null;
        while (offset + 1 < view.byteLength && view.getUint8(offset + 1) === 0xFF) {
            offset++;
        }
        if (offset + 4 > view.byteLength) return null;
        const marker = view.getUint16(offset);
        if ((marker & 0xFF00) !== 0xFF00) return null;
        // SOS or EOI ends the metadata region
        if (marker === 0xFFDA || marker === 0xFFD9) return null;
        // Standalone markers carry no length field: TEM (0xFF01) and RST0–7
        // (0xFFD0–0xFFD7). In a conforming file they appear only inside scan data
        // (after SOS), so this only hardens malformed input — without it the length
        // read below would consume two payload bytes as a bogus length and could
        // bail before the real APP1, silently dropping valid EXIF.
        if (marker === 0xFF01 || (marker >= 0xFFD0 && marker <= 0xFFD7)) {
            offset += 2;
            continue;
        }
        const length = view.getUint16(offset + 2);
        if (length < 2 || offset + 2 + length > view.byteLength) return null;
        if (marker === 0xFFE1 && length >= 8) {
            // Verify "Exif\0\0" identifier
            if (view.getUint8(offset + 4) === 0x45 &&
                view.getUint8(offset + 5) === 0x78 &&
                view.getUint8(offset + 6) === 0x69 &&
                view.getUint8(offset + 7) === 0x66 &&
                view.getUint8(offset + 8) === 0x00 &&
                view.getUint8(offset + 9) === 0x00) {
                const segment = new Uint8Array(arrayBuffer.slice(offset, offset + 2 + length));
                resetOrientationInExifSegment(segment);
                return segment;
            }
        }
        offset += 2 + length;
    }
    return null;
}

/**
 * Rewrite the IFD0 Orientation tag (0x0112) to 1 in-place.
 * The exported image is already upright, so preserving a non-1 Orientation
 * would cause viewers to rotate it again.
 */
function resetOrientationInExifSegment(segment) {
    // Layout: 0..1 = FFE1, 2..3 = length(BE), 4..9 = "Exif\0\0", 10.. = TIFF
    if (segment.length < 18) return;
    const tiffStart = 10;
    const byteOrderByte = segment[tiffStart];
    const littleEndian = (byteOrderByte === 0x49);  // 'I' = little, 'M' = big
    const readU16 = (off) => littleEndian
        ? segment[off] | (segment[off + 1] << 8)
        : (segment[off] << 8) | segment[off + 1];
    const readU32 = (off) => littleEndian
        ? (segment[off] | (segment[off + 1] << 8) | (segment[off + 2] << 16) | (segment[off + 3] << 24)) >>> 0
        : ((segment[off] << 24) | (segment[off + 1] << 16) | (segment[off + 2] << 8) | segment[off + 3]) >>> 0;
    const writeU16 = (off, val) => {
        if (littleEndian) {
            segment[off] = val & 0xFF;
            segment[off + 1] = (val >> 8) & 0xFF;
        } else {
            segment[off] = (val >> 8) & 0xFF;
            segment[off + 1] = val & 0xFF;
        }
    };
    if (readU16(tiffStart + 2) !== 42) return;  // Not a TIFF header
    const ifd0Off = readU32(tiffStart + 4);
    const ifd0Start = tiffStart + ifd0Off;
    if (ifd0Start + 2 > segment.length) return;
    const numEntries = readU16(ifd0Start);
    for (let i = 0; i < numEntries; i++) {
        const entryOff = ifd0Start + 2 + i * 12;
        if (entryOff + 12 > segment.length) break;
        if (readU16(entryOff) === 0x0112) {
            // Orientation: type SHORT (3), count 1, value in first 2 bytes of valueOffset.
            // Only rewrite when the entry really is a SHORT; on a malformed/non-standard
            // tag (e.g. LONG) the 4-byte field is a value offset, not an inline value, and
            // overwriting its first 2 bytes would corrupt the IFD.
            if (readU16(entryOff + 2) === 3) {
                writeU16(entryOff + 8, 1);
            }
            return;
        }
    }
}

/**
 * Return a copy of an EXIF APP1 segment whose recorded pixel dimensions describe
 * the image the segment is about to be written into.
 *
 * The stored segment is captured from the source file and re-embedded verbatim on
 * export, so its dimension tags keep describing the original whenever the output
 * differs: export resize, crop, even-pixel trim, the layout multiplier of the
 * export mode (a Full SBS frame is twice an eye wide), border decoration, and the
 * left/right resolution normalization. A reader that trusts EXIF over the JPEG SOF
 * would then get the wrong size, so rewrite the tags to the real output size.
 * Same reasoning as resetOrientationInExifSegment above, applied to geometry.
 *
 * Returns a COPY (unlike resetOrientationInExifSegment, which mutates a freshly
 * sliced segment): this runs at export time on the shared state.exifRawSegment*,
 * which must stay pristine for the next export at a different size.
 *
 * Only existing tags are rewritten. Tags are never added, because growing the
 * segment would move every subsequent IFD offset and require rebuilding it. For
 * the same reason a SHORT-typed tag asked to hold more than 65535 is left at its
 * old value rather than truncated: widening it to a LONG would grow the entry.
 * That needs an output side longer than 65535px, well past any GPU texture limit.
 *
 * IFD1 (the thumbnail directory) is deliberately not visited — its
 * ImageWidth/ImageLength describe the embedded thumbnail, not this image.
 *
 * @param {Uint8Array} segment - Stored APP1 segment (FFE1 + length + "Exif\0\0" + TIFF)
 * @param {number} width - Actual output width in pixels
 * @param {number} height - Actual output height in pixels
 * @returns {Uint8Array} Patched copy, or the input unchanged if it cannot be parsed
 */
export function setPixelDimensionsInExifSegment(segment, width, height) {
    if (!segment || segment.length < 18) return segment;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        return segment;
    }

    const out = new Uint8Array(segment);
    const tiffStart = 10;
    const littleEndian = (out[tiffStart] === 0x49);  // 'I' = little, 'M' = big
    const readU16 = (off) => littleEndian
        ? out[off] | (out[off + 1] << 8)
        : (out[off] << 8) | out[off + 1];
    const readU32 = (off) => littleEndian
        ? (out[off] | (out[off + 1] << 8) | (out[off + 2] << 16) | (out[off + 3] << 24)) >>> 0
        : ((out[off] << 24) | (out[off + 1] << 16) | (out[off + 2] << 8) | out[off + 3]) >>> 0;
    const writeU16 = (off, val) => {
        if (littleEndian) {
            out[off] = val & 0xFF;
            out[off + 1] = (val >> 8) & 0xFF;
        } else {
            out[off] = (val >> 8) & 0xFF;
            out[off + 1] = val & 0xFF;
        }
    };
    const writeU32 = (off, val) => {
        if (littleEndian) {
            out[off] = val & 0xFF;
            out[off + 1] = (val >> 8) & 0xFF;
            out[off + 2] = (val >> 16) & 0xFF;
            out[off + 3] = (val >>> 24) & 0xFF;
        } else {
            out[off] = (val >>> 24) & 0xFF;
            out[off + 1] = (val >> 16) & 0xFF;
            out[off + 2] = (val >> 8) & 0xFF;
            out[off + 3] = val & 0xFF;
        }
    };

    // A count-1 SHORT or LONG is stored inline in the entry's 4-byte value field,
    // so the segment length never changes. Any other type/count means the field
    // holds an offset instead, and overwriting it would corrupt the IFD.
    const writeEntryValue = (entryOff, val) => {
        const type = readU16(entryOff + 2);
        if (readU32(entryOff + 4) !== 1) return;
        if (type === 3) {
            if (val <= 0xFFFF) writeU16(entryOff + 8, val);
        } else if (type === 4) {
            writeU32(entryOff + 8, val);
        }
    };

    if (readU16(tiffStart + 2) !== 42) return segment;  // Not a TIFF header
    const ifd0Start = tiffStart + readU32(tiffStart + 4);
    // An IFD cannot start inside the 8-byte TIFF header. Rejecting that also
    // rejects a zero offset, which would otherwise make the byte-order mark
    // read as an entry count and send the loop scanning non-IFD bytes.
    if (ifd0Start < tiffStart + 8 || ifd0Start + 2 > out.length) return segment;

    // IFD0 carries ImageWidth/ImageLength (often absent in JPEG EXIF) and the
    // pointer to the EXIF sub-IFD that holds PixelXDimension/PixelYDimension.
    let exifIfdStart = 0;
    const ifd0Entries = readU16(ifd0Start);
    for (let i = 0; i < ifd0Entries; i++) {
        const entryOff = ifd0Start + 2 + i * 12;
        if (entryOff + 12 > out.length) break;
        const tag = readU16(entryOff);
        if (tag === 0x0100) writeEntryValue(entryOff, width);        // ImageWidth
        else if (tag === 0x0101) writeEntryValue(entryOff, height);  // ImageLength
        else if (tag === 0x8769) exifIfdStart = tiffStart + readU32(entryOff + 8);
    }

    if (exifIfdStart >= tiffStart + 8 && exifIfdStart + 2 <= out.length) {
        const exifEntries = readU16(exifIfdStart);
        for (let i = 0; i < exifEntries; i++) {
            const entryOff = exifIfdStart + 2 + i * 12;
            if (entryOff + 12 > out.length) break;
            const tag = readU16(entryOff);
            if (tag === 0xA002) writeEntryValue(entryOff, width);         // PixelXDimension
            else if (tag === 0xA003) writeEntryValue(entryOff, height);   // PixelYDimension
        }
    }

    return out;
}

/**
 * Read EXIF info using ExifReader (single file)
 * Race condition mitigation: do not overwrite newer state with stale results
 * For single file loads, store as left-eye EXIF and set right-eye to null
 * @param {File} file - File to read
 */
export async function readExifData(file) {
    // Issue a new token (race condition mitigation)
    const myToken = getNextExifToken();

    // Check whether ExifReader is loaded
    if (typeof ExifReader === 'undefined') {
        logger.warn('EXIF', 'ExifReader library not loaded');
        if (exifLoadToken === myToken) {
            state.exifDataLeft = null;
            state.exifThumbnailLeft = null;
            state.exifRawSegmentLeft = null;
            syncActiveExifState();
            window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif: false, hasThumbnail: false } }));
        }
        return;
    }

    try {
        // Token check (ensure no new load started)
        if (exifLoadToken !== myToken) {
            if (DEBUG.EXIF_LOG) {
                logger.debug('EXIF_LOG', 'EXIF', 'Skipping outdated read (newer load started)');
            }
            return;
        }

        // Clear right-eye EXIF (none for single file)
        // Cleared after token check to avoid prematurely clearing data when a newer load overtakes
        state.exifDataRight = null;
        state.exifThumbnailRight = null;
        state.exifRawSegmentRight = null;

        const arrayBuffer = await file.arrayBuffer();

        if (exifLoadToken !== myToken) {
            if (DEBUG.EXIF_LOG) {
                logger.debug('EXIF_LOG', 'EXIF', 'Skipping outdated read after arrayBuffer (newer load started)');
            }
            return;
        }

        const tags = ExifReader.load(arrayBuffer, { expanded: true });

        if (exifLoadToken !== myToken) {
            if (DEBUG.EXIF_LOG) {
                logger.debug('EXIF_LOG', 'EXIF', 'Skipping outdated read after load (newer load started)');
            }
            return;
        }

        // Check if EXIF actually exists (treat empty object as null)
        const hasActualData = tags && typeof tags === 'object' && !Array.isArray(tags) && Object.keys(tags).length > 0;
        if (!hasActualData) {
            if (DEBUG.EXIF_LOG) {
                logger.debug('EXIF_LOG', 'EXIF', 'EXIF data empty (left)');
            }
            state.exifDataLeft = null;
            state.exifThumbnailLeft = null;
            state.exifRawSegmentLeft = null;
            syncActiveExifState();
            window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif: false, hasThumbnail: false } }));
            return;
        }

        // Store as left-eye EXIF
        state.exifDataLeft = tags;
        state.exifRawSegmentLeft = extractExifApp1Segment(arrayBuffer);

        if (DEBUG.EXIF_LOG) {
            logger.debug('EXIF_LOG', 'EXIF', 'EXIF data loaded (left):', tags);
        }

        // Extract thumbnail (if present)
        if (tags.Thumbnail && tags.Thumbnail.image) {
            const thumbData = tags.Thumbnail.image;
            if (thumbData instanceof Uint8Array || thumbData instanceof ArrayBuffer) {
                const blob = new Blob([thumbData], { type: 'image/jpeg' });
                const reader = new FileReader();
                let settled = false;

                // Settle exactly once. A timeout guards against a FileReader that
                // never fires onload/onerror, which would otherwise leave the
                // exif-loaded event undispatched (the UI never refreshes) even
                // though the EXIF tags themselves were already stored. Mirrors the
                // 5s timeout used in readExifDataFromBuffer().
                const finish = (thumbnailResult) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeoutId);
                    reader.onload = null;
                    reader.onerror = null;
                    if (exifLoadToken === myToken) {
                        state.exifThumbnailLeft = thumbnailResult;
                        syncActiveExifState();
                        window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif: true, hasThumbnail: thumbnailResult !== null } }));
                    }
                };

                const timeoutId = setTimeout(() => {
                    logger.warn('EXIF', 'Thumbnail FileReader timed out');
                    finish(null);
                    try { reader.abort(); } catch (_) { /* ignore */ }
                }, 5000);

                reader.onload = (e) => finish(e.target.result);
                reader.onerror = () => {
                    // Thumbnail read failed, but EXIF data is still available
                    logger.warn('EXIF', 'Failed to read EXIF thumbnail');
                    finish(null);
                };
                reader.readAsDataURL(blob);
            } else {
                syncActiveExifState();
                window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif: true, hasThumbnail: false } }));
            }
        } else {
            syncActiveExifState();
            window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif: true, hasThumbnail: false } }));
        }
    } catch (err) {
        logger.warn('EXIF', 'Failed to read EXIF data:', err);
        if (exifLoadToken === myToken) {
            state.exifDataLeft = null;
            state.exifThumbnailLeft = null;
            state.exifRawSegmentLeft = null;
            syncActiveExifState();
            window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif: false, hasThumbnail: false } }));
        }
    }
}

/**
 * Read EXIF info from ArrayBuffer (for left/right)
 * Used to load separate EXIF for MPO or dual images
 * @param {ArrayBuffer} arrayBuffer - Image data ArrayBuffer
 * @param {'left'|'right'} side - Which side to store EXIF for
 * @param {number} token - Token for race condition mitigation
 * @returns {Promise<{tags: Object|null, thumbnail: string|null}>}
 */
export async function readExifDataFromBuffer(arrayBuffer, side, token) {
    if (typeof ExifReader === 'undefined') {
        logger.warn('EXIF', 'ExifReader library not loaded');
        return { tags: null, thumbnail: null, rawSegment: null };
    }

    try {
        // Token check
        if (exifLoadToken !== token) {
            return { tags: null, thumbnail: null, rawSegment: null };
        }

        const tags = ExifReader.load(arrayBuffer, { expanded: true });

        // Check if EXIF actually exists (treat empty object as null)
        const hasActualData = tags && typeof tags === 'object' && !Array.isArray(tags) && Object.keys(tags).length > 0;
        if (!hasActualData) {
            if (DEBUG.EXIF_LOG) {
                logger.debug('EXIF_LOG', 'EXIF', `EXIF data empty (${side})`);
            }
            return { tags: null, thumbnail: null, rawSegment: null };
        }

        if (exifLoadToken !== token) {
            return { tags: null, thumbnail: null, rawSegment: null };
        }

        const rawSegment = extractExifApp1Segment(arrayBuffer);

        if (DEBUG.EXIF_LOG) {
            logger.debug('EXIF_LOG', 'EXIF', `EXIF data loaded (${side}):`, tags);
        }

        let thumbnail = null;

        // Extract thumbnail
        if (tags.Thumbnail && tags.Thumbnail.image) {
            const thumbData = tags.Thumbnail.image;
            if (thumbData instanceof Uint8Array || thumbData instanceof ArrayBuffer) {
                const blob = new Blob([thumbData], { type: 'image/jpeg' });
                thumbnail = await new Promise((resolve) => {
                    const reader = new FileReader();
                    const timeoutId = setTimeout(() => {
                        reader.onload = null;
                        reader.onerror = null;
                        logger.warn('EXIF', 'Thumbnail FileReader timed out');
                        resolve(null);
                    }, 5000);
                    reader.onload = (e) => { clearTimeout(timeoutId); resolve(e.target.result); };
                    reader.onerror = () => { clearTimeout(timeoutId); resolve(null); };
                    reader.readAsDataURL(blob);
                });
            }
        }

        return { tags, thumbnail, rawSegment };
    } catch (err) {
        logger.warn('EXIF', `Failed to read EXIF data (${side}):`, err);
        return { tags: null, thumbnail: null, rawSegment: null };
    }
}

/**
 * Update display exifData/exifThumbnail based on swapLR
 * swapLR=false: show left-eye EXIF
 * swapLR=true: show right-eye EXIF
 */
export function syncActiveExifState() {
    // CRITICAL: Check if state.params is initialized before accessing
    if (!state || !state.params) {
        logger.warn('EXIF', 'State not initialized, skipping sync');
        return;
    }

    if (state.params.swapLR) {
        // Show right-eye EXIF (if present)
        state.exifData = state.exifDataRight;
        state.exifThumbnail = state.exifThumbnailRight;
        state.exifRawSegment = state.exifRawSegmentRight;
    } else {
        // Show left-eye EXIF
        state.exifData = state.exifDataLeft;
        state.exifThumbnail = state.exifThumbnailLeft;
        state.exifRawSegment = state.exifRawSegmentLeft;
    }

    if (DEBUG.EXIF_LOG) {
        logger.debug('EXIF_LOG', 'EXIF', `syncActiveExifState: swapLR=${state.params.swapLR}, hasExif=${!!state.exifData}`);
    }
}
