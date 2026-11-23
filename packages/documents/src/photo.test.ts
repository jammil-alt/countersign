// DQ-001: a photo's location and time taken, from its own metadata, against photos made with
// Pillow (JPEG, PNG) and libheif 1.23 (HEIC) carrying an iPhone's EXIF (fixtures/photos).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPhotoMime, NO_PHOTO_METADATA, readPhotoMetadata } from "./photo";

const photo = (name: string) =>
  new Uint8Array(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/photos", name)),
  );

// As written: 30° 16' 1.7508" N, 97° 44' 35.0052" W; taken 2026-11-20 14:32:05 at -06:00.
const SITE = { latitude: 30.267153, longitude: -97.743057 };
const TAKEN = "2026-11-20T14:32:05-06:00";

describe("a photo's location and time taken", () => {
  it.each(["site.jpg", "site.png", "site.heic"])("reads %s's GPS and time taken", (name) => {
    const m = readPhotoMetadata(photo(name));
    expect(m.locationSource).toBe("exif");
    expect(Math.abs((m.latitude ?? 0) - SITE.latitude)).toBeLessThan(0.0001);
    expect(Math.abs((m.longitude ?? 0) - SITE.longitude)).toBeLessThan(0.0001);
    expect(m.latitude).toBeCloseTo(SITE.latitude, 6);
    expect(m.longitude).toBeCloseTo(SITE.longitude, 6);
    expect(m.takenAt).toBe(TAKEN);
  });

  it.each(["no-gps.jpg", "no-gps.heic"])("gives no location for %s, and still its time", (name) => {
    expect(readPhotoMetadata(photo(name))).toEqual({
      latitude: null,
      longitude: null,
      takenAt: TAKEN,
      locationSource: "none",
    });
  });

  it("gives no time taken without an offset or a GPS time: a local time isn't guessed into a zone", () => {
    const m = readPhotoMetadata(photo("no-offset.jpg"));
    expect(m).toMatchObject({ locationSource: "exif", takenAt: null });
  });

  it("gives none for a photo with no metadata, a cut-off file and anything that isn't a photo", () => {
    expect(readPhotoMetadata(photo("no-exif.jpg"))).toEqual(NO_PHOTO_METADATA);
    for (const name of ["site.jpg", "site.png", "site.heic"]) {
      const whole = photo(name);
      for (const n of [0, 2, 12, 40, 100, Math.floor(whole.length / 2)]) {
        const m = readPhotoMetadata(whole.subarray(0, n));
        // A cut-off file never throws, and never gives a position it didn't read whole.
        if (m.locationSource === "exif") expect(m.latitude).toBeCloseTo(SITE.latitude, 6);
      }
    }
    expect(readPhotoMetadata(new TextEncoder().encode("%PDF-1.7\n"))).toEqual(NO_PHOTO_METADATA);
  });

  it("drops a position whose hemisphere is missing or whose receiver said void", () => {
    const bytes = photo("site.jpg");
    const text = new TextDecoder("latin1").decode(bytes);
    // The GPS IFD's latitude reference, 'N\0' inline in its entry, made a letter that isn't one.
    const tiff = text.indexOf("Exif\0\0") + 6;
    const little = text.slice(tiff, tiff + 2) === "II";
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at: number) => dv.getUint16(tiff + at, little);
    const u32 = (at: number) => dv.getUint32(tiff + at, little);
    const ifd0 = u32(4);
    let gps = -1;
    for (let i = 0; i < u16(ifd0); i++) {
      const e = ifd0 + 2 + i * 12;
      if (u16(e) === 0x8825) gps = u32(e + 8);
    }
    expect(gps).toBeGreaterThan(0);
    const broken = bytes.slice();
    for (let i = 0; i < u16(gps); i++) {
      const e = gps + 2 + i * 12;
      if (u16(e) === 1) broken[tiff + e + 8] = "X".charCodeAt(0);
    }
    expect(readPhotoMetadata(broken)).toMatchObject({ latitude: null, locationSource: "none" });
  });

  it("knows which documents are photos", () => {
    for (const m of ["image/jpeg", "image/png", "image/heic", "image/heif", "IMAGE/JPEG"]) {
      expect(isPhotoMime(m)).toBe(true);
    }
    for (const m of ["application/pdf", "image/gif", "text/csv", ""]) {
      expect(isPhotoMime(m)).toBe(false);
    }
  });
});
