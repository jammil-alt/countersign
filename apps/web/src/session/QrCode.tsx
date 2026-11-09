// The authenticator app's QR code (docs/plan.md §1.83), drawn here from the `otpauth://` link:
// no remote image, and the link never leaves the page. Its own chunk, loaded only while setting up.
import qrcode from "qrcode-generator";
import { useMemo } from "react";

// DECISION: the code stays dark on white in both themes, as phone cameras read it best; it is a
// picture of a code, not a part of the page's colours.
export default function QrCode({ value, alt }: { value: string; alt: string }) {
  const src = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    // A quiet zone of four modules around the code, as the QR standard asks.
    const svg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [value]);
  return (
    <img
      src={src}
      alt={alt}
      width={176}
      height={176}
      className="rounded-sm border border-line"
      data-testid="second-factor-qr"
    />
  );
}
