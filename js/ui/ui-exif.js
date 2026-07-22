/**
 * ui-exif.js
 * EXIF info modal features
 */
import { showToast } from './ui-toast.js';
import { state } from '../globals.js';
import { sanitizeFileName } from './ui-export.js';
import * as logger from '../utils/logger.js';

// Categories to skip in details/export (MPF contains raw image data, causes UI freeze)
const HIDDEN_CATEGORIES = new Set(['mpf']);

// AbortController for managing event listeners (prevent memory leaks)
let exifEventAbortController = null;

// Initialization flag
let exifModalInitialized = false;

/**
 * Format EXIF values
 */
export function formatExifValue(value) {
    if (value === null || value === undefined) return '-';

    // When a description property exists (ExifReader format)
    if (typeof value === 'object' && value.description !== undefined) {
        return String(value.description);
    }

    // When a value property exists
    if (typeof value === 'object' && value.value !== undefined) {
        if (Array.isArray(value.value)) {
            return value.value.join(', ');
        }
        return String(value.value);
    }

    // For arrays
    if (Array.isArray(value)) {
        return value.map(v => formatExifValue(v)).join(', ');
    }

    // For objects (other cases)
    if (typeof value === 'object') {
        try {
            // Special case: GPS coordinates, etc.
            if (value.numerator !== undefined && value.denominator !== undefined) {
                // Guard against division by zero
                if (value.denominator === 0) return '[Invalid rational]';
                return (value.numerator / value.denominator).toFixed(4);
            }
            return JSON.stringify(value);
        } catch {
            return '[Object]';
        }
    }

    return String(value);
}

/**
 * Display the EXIF table as "No information available"
 */
export function populateExifTableEmpty() {
    const tbody = document.getElementById('exifTableBody');
    if (!tbody) return;
    tbody.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.style.textAlign = 'center';
    cell.style.color = 'var(--text-tertiary)';
    cell.textContent = window.t?.('exif.noData') ?? 'No EXIF data';
    row.appendChild(cell);
    tbody.appendChild(row);
}

/**
 * Display the EXIF details table as "No information available"
 */
export function populateExifDetailsTableEmpty() {
    const tbody = document.getElementById('exifDetailsTableBody');
    if (!tbody) return;
    tbody.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.style.textAlign = 'center';
    cell.style.color = 'var(--text-tertiary)';
    cell.textContent = window.t?.('exif.noData') ?? 'No details available';
    row.appendChild(cell);
    tbody.appendChild(row);
}

/**
 * Display the thumbnail tab as "No information available"
 */
export function updateThumbnailTabEmpty() {
    const img = document.getElementById('exifThumbnailImg');
    const noThumbnailMsg = document.getElementById('noThumbnailMsg');
    if (img) {
        img.style.display = 'none';
        img.src = '';
    }
    if (noThumbnailMsg) {
        noThumbnailMsg.style.display = 'block';
    }
}

/**
 * Show main EXIF tags in the table
 */
export function populateExifTable() {
    const tbody = document.getElementById('exifTableBody');
    if (!tbody || !state.exifData) return;

    tbody.replaceChildren();

    // List of main tags to display, keyed by ExifReader's { expanded: true } groups.
    // The grouping (verified against ExifReader 4.14.1) is:
    //   - exif: IFD0 + EXIF + the RAW GPS tags (Make, Model, Orientation, Software,
    //           XResolution, GPSTimeStamp, ...). There is NO separate 'image' group;
    //           IFD0 tags land here.
    //   - gps:  ONLY the computed decimals Latitude / Longitude / Altitude.
    //   - file: JPEG frame info whose keys contain spaces, plus FileType. There is
    //           no MIMEType / FileSize (ExifReader reads a buffer, not a File).
    // The tag names below must match these real group keys exactly or the rows
    // silently never render (the previous exif-js-style names left GPS/File/Image
    // permanently empty).
    const importantTags = {
        'exif': [
            'Make', 'Model', 'Orientation', 'Software',
            'DateTime', 'DateTimeOriginal', 'DateTimeDigitized',
            'ExposureTime', 'FNumber', 'ISO', 'ISOSpeedRatings',
            'ExposureProgram', 'ShutterSpeedValue', 'ApertureValue',
            'ExposureBiasValue', 'MaxApertureValue', 'MeteringMode',
            'Flash', 'FocalLength', 'FocalLengthIn35mmFilm',
            'LensModel', 'LensMake', 'WhiteBalance', 'ColorSpace',
            'XResolution', 'YResolution', 'ResolutionUnit',
            'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight',
            'GPSTimeStamp', 'GPSDateStamp'
        ],
        'gps': [
            'Latitude', 'Longitude', 'Altitude'
        ],
        'file': [
            'FileType', 'Image Width', 'Image Height',
            'Bits Per Sample', 'Color Components', 'Subsampling'
        ]
    };

    const exifData = state.exifData;

    // Process in category order
    const categories = [
        { key: 'exif', name: 'EXIF' },
        { key: 'gps', name: 'GPS' },
        { key: 'file', name: 'File' }
    ];

    categories.forEach(category => {
        const tags = importantTags[category.key];
        const dataSection = exifData[category.key];

        if (!dataSection || typeof dataSection !== 'object') {
            return;
        }

        tags.forEach(tagName => {
            let tagValue = dataSection[tagName];

            if (tagValue !== null && tagValue !== undefined) {
                const row = document.createElement('tr');
                const tdCategory = document.createElement('td');
                const tdTagName = document.createElement('td');
                const tdValue = document.createElement('td');
                tdCategory.textContent = category.name;
                tdTagName.textContent = tagName;
                tdValue.textContent = formatExifValue(tagValue);
                row.appendChild(tdCategory);
                row.appendChild(tdTagName);
                row.appendChild(tdValue);
                tbody.appendChild(row);
            }
        });
    });

    // If there is no data
    if (tbody.children.length === 0) {
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.style.textAlign = 'center';
        td.style.color = 'var(--text-tertiary)';
        td.textContent = window.t?.('exif.noData') ?? 'No EXIF data';
        row.appendChild(td);
        tbody.appendChild(row);
    }
}

/**
 * Show all EXIF tags in the details tab
 */
export function populateExifDetailsTable() {
    const tbody = document.getElementById('exifDetailsTableBody');
    if (!tbody || !state.exifData) return;

    tbody.replaceChildren();

    const exifData = state.exifData;

    // Process all categories
    Object.keys(exifData).forEach(category => {
        if (category === 'Thumbnail') return;
        if (HIDDEN_CATEGORIES.has(category)) return;

        const section = exifData[category];
        if (typeof section !== 'object' || section === null) return;

        Object.keys(section).forEach(tagName => {
            const tagValue = section[tagName];
            if (tagValue === undefined || tagValue === null) return;
            if (tagName === 'image') return;

            const row = document.createElement('tr');
            const tdCategory = document.createElement('td');
            const tdTagName = document.createElement('td');
            const tdValue = document.createElement('td');
            tdCategory.textContent = category;
            tdTagName.textContent = tagName;
            tdValue.textContent = formatExifValue(tagValue);
            row.appendChild(tdCategory);
            row.appendChild(tdTagName);
            row.appendChild(tdValue);
            tbody.appendChild(row);
        });
    });

    // If there is no data
    if (tbody.children.length === 0) {
        const row = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.style.textAlign = 'center';
        td.style.color = 'var(--text-tertiary)';
        td.textContent = window.t?.('exif.noData') ?? 'No details available';
        row.appendChild(td);
        tbody.appendChild(row);
    }
}

/**
 * Update the thumbnail tab
 */
export function updateThumbnailTab() {
    const img = document.getElementById('exifThumbnailImg');
    const noThumbnailMsg = document.getElementById('noThumbnailMsg');

    if (!img || !noThumbnailMsg) {
        return;
    }

    if (state.exifThumbnail) {
        img.src = state.exifThumbnail;
        img.style.display = 'block';
        noThumbnailMsg.style.display = 'none';
    } else {
        img.src = '';
        img.style.display = 'none';
        noThumbnailMsg.style.display = 'block';
    }
}

/**
 * Generate EXIF info in text format (for clipboard)
 */
export function generateExifText() {
    if (!state.exifData) return '';

    let text = `EXIF Information - ${state.originalFileNameBase}\n`;
    text += '='.repeat(50) + '\n\n';

    const exifData = state.exifData;

    Object.keys(exifData).forEach(category => {
        if (category === 'Thumbnail') return;
        if (HIDDEN_CATEGORIES.has(category)) return;

        const section = exifData[category];
        if (typeof section !== 'object' || section === null) return;

        text += `[${category}]\n`;

        Object.keys(section).forEach(tagName => {
            const tagValue = section[tagName];
            if (tagValue === undefined || tagValue === null) return;
            if (tagName === 'image') return;

            text += `  ${tagName}: ${formatExifValue(tagValue)}\n`;
        });

        text += '\n';
    });

    return text;
}

/**
 * Generate EXIF info in CSV format
 */
export function generateExifCsv() {
    if (!state.exifData) return '';

    let csv = 'Category,Tag,Value\n';

    const exifData = state.exifData;

    Object.keys(exifData).forEach(category => {
        if (category === 'Thumbnail') return;
        if (HIDDEN_CATEGORIES.has(category)) return;

        const section = exifData[category];
        if (typeof section !== 'object' || section === null) return;

        Object.keys(section).forEach(tagName => {
            const tagValue = section[tagName];
            if (tagValue === undefined || tagValue === null) return;
            if (tagName === 'image') return;

            let value = formatExifValue(tagValue).replace(/"/g, '""');
            // Prevent CSV formula injection: prefix with single quote if the value
            // starts with a character that spreadsheet apps interpret as a formula
            if (/^[=+\-@\t\r]/.test(value)) {
                value = "'" + value;
            }
            csv += `"${category}","${tagName}","${value}"\n`;
        });
    });

    return csv;
}

/**
 * Re-render content if the EXIF modal is visible
 * Used to update EXIF display when swapLR toggles
 */
export function updateExifModalIfVisible() {
    const exifModal = document.getElementById('exifModal');
    if (exifModal && exifModal.style.display === 'flex') {
        // Keep the Left/Right eye tab highlight in sync with the eye actually
        // displayed. syncActiveExifState() reassigns state.exifData from
        // exifDataLeft/Right when swapLR toggles but does not touch the tabs, so
        // without this the highlighted tab could disagree with the shown data.
        const exifEyeTabLeft = document.getElementById('exifEyeTabLeft');
        const exifEyeTabRight = document.getElementById('exifEyeTabRight');
        if (exifEyeTabLeft && exifEyeTabRight) {
            const showingRight = state.exifData != null && state.exifData === state.exifDataRight;
            exifEyeTabLeft.classList.toggle('active', !showingRight);
            exifEyeTabRight.classList.toggle('active', showingRight);
        }

        if (state.exifData) {
            populateExifTable();
            populateExifDetailsTable();
            updateThumbnailTab();
        } else {
            populateExifTableEmpty();
            populateExifDetailsTableEmpty();
            updateThumbnailTabEmpty();
        }
    }
}

/**
 * Clean up EXIF modal resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guard)
 */
export function cleanupExifModal() {
    if (exifEventAbortController) {
        exifEventAbortController.abort();
        exifEventAbortController = null;
    }
    exifModalInitialized = false;
}

/**
 * Set up the EXIF info modal
 */
export function setupExifModal() {
    // Prevent duplicate initialization
    if (exifModalInitialized) {
        logger.warn('UIExif', '[UI-EXIF] setupExifModal() called multiple times. Skipping duplicate registration.');
        return;
    }
    exifModalInitialized = true;

    // Initialize AbortController
    if (exifEventAbortController) {
        exifEventAbortController.abort();
    }
    exifEventAbortController = new AbortController();
    const signal = exifEventAbortController.signal;

    const showExifBtn = document.getElementById('showExifBtn');
    const exifModal = document.getElementById('exifModal');
    const closeExifModalBtn = document.getElementById('closeExifModalBtn');
    const exifTabs = document.querySelectorAll('.exif-tab');
    const copyExifBtn = document.getElementById('copyExifBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const exifEyeTabLeft = document.getElementById('exifEyeTabLeft');
    const exifEyeTabRight = document.getElementById('exifEyeTabRight');

    // EXIF load event
    window.addEventListener('exif-loaded', (e) => {
        const hasExif = e.detail.hasExif;
        if (showExifBtn) {
            showExifBtn.disabled = !hasExif;
        }
        updateExifEyeTabsState();
    }, { signal });

    // Function to update left/right tab state
    function updateExifEyeTabsState() {
        const hasLeft = !!(state.exifDataLeft && Object.keys(state.exifDataLeft).length > 0);
        const hasRight = !!(state.exifDataRight && Object.keys(state.exifDataRight).length > 0);

        if (exifEyeTabLeft) {
            exifEyeTabLeft.classList.toggle('no-data', !hasLeft);
            exifEyeTabLeft.disabled = !hasLeft && !hasRight;
        }
        if (exifEyeTabRight) {
            exifEyeTabRight.classList.toggle('no-data', !hasRight);
            exifEyeTabRight.disabled = !hasLeft && !hasRight;
        }

        const exifEyeTabs = document.getElementById('exifEyeTabs');
        if (exifEyeTabs) {
            exifEyeTabs.style.display = (hasLeft && hasRight) ? 'flex' : 'none';
        }
    }

    // Switch EXIF on left/right tab click
    function switchExifEye(eye) {
        if (exifEyeTabLeft) exifEyeTabLeft.classList.toggle('active', eye === 'left');
        if (exifEyeTabRight) exifEyeTabRight.classList.toggle('active', eye === 'right');

        if (eye === 'left') {
            state.exifData = state.exifDataLeft;
            state.exifThumbnail = state.exifThumbnailLeft;
        } else {
            state.exifData = state.exifDataRight;
            state.exifThumbnail = state.exifThumbnailRight;
        }

        if (state.exifData) {
            populateExifTable();
            populateExifDetailsTable();
            updateThumbnailTab();
        } else {
            populateExifTableEmpty();
            populateExifDetailsTableEmpty();
            updateThumbnailTabEmpty();
        }
    }

    if (exifEyeTabLeft) {
        exifEyeTabLeft.addEventListener('click', () => switchExifEye('left'), { signal });
    }
    if (exifEyeTabRight) {
        exifEyeTabRight.addEventListener('click', () => switchExifEye('right'), { signal });
    }

    // EXIF button click
    if (showExifBtn) {
        showExifBtn.addEventListener('click', () => {
            if (!exifModal) return;
            // Gate on actual EXIF content, not object truthiness: an empty {} is
            // truthy but has no keys, so a plain `exifDataLeft || exifDataRight` test
            // would open the modal while none of the switchExifEye branches below fire,
            // leaving the previous image's stale EXIF tables and thumbnail on screen.
            const hasLeft = !!(state.exifDataLeft && Object.keys(state.exifDataLeft).length > 0);
            const hasRight = !!(state.exifDataRight && Object.keys(state.exifDataRight).length > 0);
            const hasAnyExif = hasLeft || hasRight;
            if (hasAnyExif) {
                updateExifEyeTabsState();

                // Default to the eye that matches the current swapLR state — the eye
                // that is actually displayed and whose EXIF a JPEG export embeds
                // (syncActiveExifState uses the same rule). Opening to a fixed 'left'
                // showed left-eye metadata while a swapped export carried the right
                // eye's. Fall back to whichever eye actually has data.
                const preferRight = !!state.params.swapLR;
                if (preferRight && hasRight) {
                    switchExifEye('right');
                } else if (!preferRight && hasLeft) {
                    switchExifEye('left');
                } else if (hasLeft) {
                    switchExifEye('left');
                } else if (hasRight) {
                    switchExifEye('right');
                }

                exifModal.style.display = 'flex';
            }
        }, { signal });
    }

    // Close button
    if (closeExifModalBtn) {
        closeExifModalBtn.addEventListener('click', () => {
            if (exifModal) exifModal.style.display = 'none';
        }, { signal });
    }

    // Close by clicking the modal backdrop
    if (exifModal) {
        exifModal.addEventListener('click', (e) => {
            if (e.target === exifModal) {
                exifModal.style.display = 'none';
            }
        }, { signal });
    }

    // Tab switching
    exifTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.getAttribute('data-tab');

            exifTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            document.querySelectorAll('.exif-tab-content').forEach(content => {
                content.classList.remove('active');
            });
            const targetTabContent = document.getElementById(`exif-tab-${targetTab}`);
            if (targetTabContent) {
                targetTabContent.classList.add('active');
            }
        }, { signal });
    });

    // Copy to clipboard
    if (copyExifBtn) {
        copyExifBtn.addEventListener('click', () => {
            const text = generateExifText();
            if (!navigator.clipboard || !navigator.clipboard.writeText) {
                logger.warn('UIExif', '[Exif] Clipboard API not available (requires HTTPS)');
                return;
            }
            navigator.clipboard.writeText(text).then(() => {
                copyExifBtn.textContent = window.t?.('exif.copied') ?? 'Copied!';
                setTimeout(() => {
                    copyExifBtn.textContent = window.t?.('exif.copyClipboard') ?? '📋 Copy to clipboard';
                }, 2000);
            }).catch(err => {
                logger.error('UIExif','Failed to copy:', err);
                showToast(window.t?.('messages.copyFailed') ?? 'Copy failed', 'error');
            });
        }, { signal });
    }

    // CSV export
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', () => {
            const csv = generateExifCsv();
            const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Sanitize the source-derived base name so characters like ':' or '"' and
            // Windows reserved device names do not produce an unopenable download name
            // (matches the image-export path).
            const csvBase = sanitizeFileName(state.originalFileNameBase || 'image');
            a.download = `${csvBase}_exif.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Defer revoke to allow browser to start the download (matches ui-export.js)
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, { signal });
    }
}
