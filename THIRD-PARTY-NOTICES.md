# Third-Party Notices

Sphyrnidae itself is distributed under the MIT License. It uses the following
third-party open-source components. Each component remains under its own
license, and the relevant copyright and license notices are reproduced below.

Some components are bundled directly in this repository, while others are
loaded from a CDN at runtime and cached locally by the service worker for
offline use (which constitutes redistribution). All components are used
**unmodified**.

| Component | Version | License | Distribution |
|---|---|---|---|
| [Three.js](https://github.com/mrdoob/three.js) | 0.182.0 | MIT | CDN + service-worker cache |
| [OpenCV.js](https://github.com/opencv/opencv) | 4.13.0 | Apache-2.0 | Bundled (`opencv/`) |
| [i18next](https://github.com/i18next/i18next) | 23.7.6 | MIT | CDN + service-worker cache |
| [ExifReader](https://github.com/mattiasw/ExifReader) | 4.14.1 | MPL-2.0 | CDN + service-worker cache |
| [pako](https://github.com/nodeca/pako) | 2.1.0 | MIT AND Zlib | CDN + service-worker cache |
| [gif.js](https://github.com/jnordberg/gif.js) | 0.2.0 | MIT | CDN + service-worker cache |
| [UPNG.js](https://github.com/photopea/UPNG.js) | 2.1.0 | MIT | CDN + service-worker cache |
| [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) | — | Apache-2.0 | Bundled (`wasm-feature-detect.umd.js`) |

---

## Three.js

- Source: https://github.com/mrdoob/three.js
- License: MIT
- Copyright © 2010-2026 three.js authors

## i18next

- Source: https://github.com/i18next/i18next
- License: MIT
- Copyright © 2025 i18next

## gif.js

- Source: https://github.com/jnordberg/gif.js
- License: MIT
- Copyright © 2013 Johan Nordberg

gif.js includes a TypedArray port of the NeuQuant neural-net image quantization
algorithm:

> NeuQuant Neural-Net Quantization Algorithm
> Copyright © 1994 Anthony Dekker
>
> Any party obtaining a copy of these files from the author, directly or
> indirectly, is granted, free of charge, a full and unrestricted irrevocable,
> world-wide, paid up, royalty-free, nonexclusive right and license to deal in
> this software and documentation files (the "Software"), including without
> limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons who
> receive copies from any such party to do so, with the only requirement being
> that this copyright notice remain intact.

## UPNG.js

- Source: https://github.com/photopea/UPNG.js
- License: MIT
- Copyright © 2017 Photopea

UPNG.js uses pako (see below) for its compression.

## pako

- Source: https://github.com/nodeca/pako
- License: MIT AND Zlib
- Copyright © 2014-2017 Vitaly Puzrin and Andrey Tarasov (JavaScript code, MIT)
- Includes portions ported from zlib — Copyright © 1995-2024 Jean-loup Gailly
  and Mark Adler (Zlib license)

---

## OpenCV.js

- Source: https://github.com/opencv/opencv (built from the 4.13.0 source tree;
  see `docs/opencvjs_build.md` for the build procedure)
- License: Apache License 2.0
- Copyright © 2000-2026 OpenCV team and contributors

This product includes software developed by the OpenCV project. Licensed under
the Apache License, Version 2.0 (the full text is reproduced under
"Apache License 2.0" below). You may obtain a copy of the License at
https://www.apache.org/licenses/LICENSE-2.0

## wasm-feature-detect

- Source: https://github.com/GoogleChromeLabs/wasm-feature-detect
- License: Apache License 2.0
- Copyright © Google LLC

Licensed under the Apache License, Version 2.0 (the full text is reproduced
under "Apache License 2.0" below). You may obtain a copy of the License at
https://www.apache.org/licenses/LICENSE-2.0

---

## ExifReader

- Source: https://github.com/mattiasw/ExifReader
- License: Mozilla Public License 2.0 (MPL-2.0)
- Copyright © 2017 Mattias Wallander

This Source Code Form is subject to the terms of the Mozilla Public License,
v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain
one at https://mozilla.org/MPL/2.0/.

ExifReader is used unmodified. Its source code (the form covered by the MPL) is
available at the URL above and from the npm package `exifreader@4.14.1`. The
full text of the Mozilla Public License 2.0 is available at
https://www.mozilla.org/en-US/MPL/2.0/.

---

# License Texts

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Zlib License

(applies to the zlib-derived portions of pako)

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

## Apache License 2.0

(applies to OpenCV.js and wasm-feature-detect)

The full text of the Apache License, Version 2.0 is available at:
https://www.apache.org/licenses/LICENSE-2.0

A summary of the key terms (the canonical text at the URL above governs):

- You may use, reproduce, and distribute the work and derivative works in
  source or object form.
- You must give recipients a copy of this License, retain all copyright,
  patent, trademark, and attribution notices, and state any significant
  changes you make.
- The license includes an express grant of patent rights from contributors.
- The work is provided "AS IS", without warranties or conditions of any kind.

## Mozilla Public License 2.0

(applies to ExifReader)

The full text of the Mozilla Public License, version 2.0 is available at:
https://www.mozilla.org/en-US/MPL/2.0/

Under the MPL 2.0, the source code of covered files must be made available to
recipients under the terms of the MPL. The covered component (ExifReader) is
used unmodified and its source is available at the URLs listed in its section
above.
