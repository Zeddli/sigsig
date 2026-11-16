import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A QR code as inline SVG (crisp at any size, no canvas). Upper-case WIZ:// URIs encode in alphanumeric mode. */
export function QrCode({ value, label, size = 232 }: { value: string; label: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    const alnum = /^[0-9A-Z $%*+\-./:]*$/.test(value);
    qr.addData(value, alnum ? 'Alphanumeric' : 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { d, n };
  }, [value]);
  return (
    <svg className="s-qr" role="img" aria-label={label} width={size} height={size} viewBox={`-2 -2 ${path.n + 4} ${path.n + 4}`} shapeRendering="crispEdges">
      <rect x="-2" y="-2" width={path.n + 4} height={path.n + 4} fill="#ffffff" />
      <path d={path.d} fill="#0b0c0e" />
    </svg>
  );
}
