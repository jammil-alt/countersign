# Photos (DQ-001)

Small photos carrying an iPhone's EXIF, for Get document's photo location and time taken
(`packages/documents/src/photo.ts`). `site.*` was taken at 30° 16' 1.7508" N, 97° 44' 35.0052" W
(30.267153, -97.743057) on 2026-11-20 14:32:05 at -06:00; `no-gps.*` has no GPS; `no-offset.jpg`
has no OffsetTimeOriginal; `no-exif.jpg` has no metadata.

Made with Pillow 13 and pillow-heif 1.8.1 (libheif 1.23.6, x265), `python make_photos.py fixtures/photos`:

```python
import sys
from fractions import Fraction
from PIL import Image, TiffImagePlugin
import pillow_heif
pillow_heif.register_heif_opener()
out = sys.argv[1]

def R(x, d=1):
    return TiffImagePlugin.IFDRational(Fraction(x).limit_denominator(d * 100000))

def exif(gps=True, offset=True):
    e = Image.Exif()
    e[0x010F] = "Apple"
    e[0x0110] = "iPhone 15"
    ifd = e.get_ifd(0x8769)
    ifd[0x9003] = "2026:11:20 14:32:05"
    if offset:
        ifd[0x9011] = "-06:00"
    if gps:
        g = e.get_ifd(0x8825)
        # 30.267153 N, 97.743057 W (Austin): degrees, minutes, seconds as iPhone writes them.
        g[1] = "N"
        g[2] = (R(30), R(16), TiffImagePlugin.IFDRational(17508, 10000))
        g[3] = "W"
        g[4] = (R(97), R(44), TiffImagePlugin.IFDRational(350052, 10000))
        g[5] = b"\x00"
        g[6] = TiffImagePlugin.IFDRational(1495, 10)
    return e

img = Image.new("RGB", (16, 16), (90, 110, 130))
img.save(f"{out}/site.jpg", exif=exif())
img.save(f"{out}/no-gps.jpg", exif=exif(gps=False))
img.save(f"{out}/no-offset.jpg", exif=exif(offset=False))
img.save(f"{out}/no-exif.jpg")
img.save(f"{out}/site.png", exif=exif())
img.save(f"{out}/site.heic", exif=exif(), quality=50)
img.save(f"{out}/no-gps.heic", exif=exif(gps=False), quality=50)
```
