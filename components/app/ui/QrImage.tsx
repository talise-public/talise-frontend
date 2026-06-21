"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export type QrImageProps = { value: string; size?: number; className?: string };

/**
 * Renders `value` as a QR code (ink modules on white) on a white rounded panel
 * so cameras scan reliably. Uses the `qrcode` package to produce a data URL.
 */
export function QrImage({ value, size = 220, className = "" }: QrImageProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      width: size * 2, // 2x for crisp rendering on retina
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#15300c", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div
      className={`inline-flex items-center justify-center border border-[#15300c]/15 bg-white p-3 shadow-[0_14px_34px_-18px_rgba(21,48,12,0.18)] ${className}`}
      style={{ borderRadius: 18, width: size + 24, height: size + 24 }}
    >
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt="QR code" width={size} height={size} style={{ display: "block" }} />
      ) : (
        <div
          style={{ width: size, height: size, background: "#CAFFB8" }}
          className="animate-pulse rounded-lg"
        />
      )}
    </div>
  );
}
