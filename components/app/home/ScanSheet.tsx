"use client";

/**
 * Scan-to-pay (mobile). Requests the rear camera, scans for a QR with jsQR
 * (works on iOS Safari, which has no BarcodeDetector), parses a Talise pay
 * link / sui address / @handle, and routes into the prefilled send flow.
 * Camera tracks are always stopped on close/unmount.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";
import { Sheet, PrimaryButton } from "@/components/app";

type ScanState = "requesting" | "scanning" | "denied" | "error";

function parseScan(text: string): { to: string; amount?: string } | null {
  const t = text.trim();
  if (!t) return null;
  // Talise pay link: https://host/pay/<handle>?amount=&memo=
  try {
    const u = new URL(t);
    const m = u.pathname.match(/\/pay\/([^/]+)/);
    if (m) return { to: decodeURIComponent(m[1]), amount: u.searchParams.get("amount") ?? undefined };
  } catch {
    /* not a URL, fall through */
  }
  // sui:0x… or a bare 0x address
  const addr = t.replace(/^sui:/i, "").split("?")[0].trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(addr)) return { to: addr };
  // bare @handle / handle
  const handle = t.replace(/^@/, "");
  if (/^[a-z0-9_.-]{2,40}$/i.test(handle)) return { to: handle };
  return null;
}

export function ScanSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<ScanState>("requesting");

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState("requesting");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play().catch(() => {});
        setState("scanning");

        const tick = () => {
          if (cancelled || !ctx) return;
          const vid = videoRef.current;
          if (vid && vid.readyState >= vid.HAVE_ENOUGH_DATA && vid.videoWidth) {
            canvas.width = vid.videoWidth;
            canvas.height = vid.videoHeight;
            ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            const parsed = code?.data ? parseScan(code.data) : null;
            if (parsed) {
              if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
              stop();
              onClose();
              const q = new URLSearchParams({ to: parsed.to });
              if (parsed.amount) q.set("amount", parsed.amount);
              router.push(`/app/pay?${q.toString()}`);
              return;
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        const name = (e as Error)?.name;
        setState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error");
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [open, onClose, router, stop]);

  return (
    <Sheet open={open} onClose={onClose} title="Scan to pay" size="md">
      <div className="space-y-4">
        <div className="relative mx-auto aspect-square w-full max-w-[280px] overflow-hidden rounded-[20px] bg-[#15300c]">
          <video
            ref={videoRef}
            playsInline
            muted
            className="h-full w-full object-cover"
          />
          {state === "scanning" && (
            <div className="pointer-events-none absolute inset-7 rounded-xl border-2 border-white/80" />
          )}
          {state !== "scanning" && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] leading-relaxed text-white">
              {state === "requesting" && "Requesting camera…"}
              {state === "denied" &&
                "Camera access was blocked. Allow camera for this site in your browser settings, then reopen Scan."}
              {state === "error" && "Couldn't start the camera on this device."}
            </div>
          )}
        </div>
        <p className="text-center text-[13px] text-[#3a5230]">
          Point at a Talise QR or a Sui address to pay.
        </p>
        {(state === "denied" || state === "error") && (
          <PrimaryButton variant="ghost" full onClick={onClose}>
            Close
          </PrimaryButton>
        )}
      </div>
    </Sheet>
  );
}
