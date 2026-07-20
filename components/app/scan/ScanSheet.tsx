"use client";

/**
 * Scan-to-pay for the WEB app (mobile-first), a full-screen camera overlay
 * that reads a Talise payment QR (pay links, sui: URIs, addresses, handles -
 * lib/scan-parse.ts) and routes into the Send flow with the recipient (and
 * amount, when the code carries one) prefilled.
 *
 * Detection strategy, best-first:
 *   1. Native `BarcodeDetector` (Chrome/Android, Samsung Internet), free.
 *   2. jsQR on downscaled canvas frames (~8 fps), covers iOS Safari, which
 *      still ships no BarcodeDetector.
 *
 * Camera teardown is unconditional on close/unmount, we never hold the
 * camera while hidden.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseScan } from "@/lib/scan-parse";

type Props = { open: boolean; onClose: () => void };

type CamState = "starting" | "scanning" | "denied" | "unavailable";

export function ScanSheet({ open, onClose }: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef(false);
  const routedRef = useRef(false);
  const [cam, setCam] = useState<CamState>("starting");
  const [unrecognized, setUnrecognized] = useState(false);
  // "Scanned ✓" success beat, without it the Send page snapped in the
  // instant a code was read, too fast to register. ~0.9s hold.
  const [scannedOk, setScannedOk] = useState(false);

  const teardown = useCallback(() => {
    stopRef.current = true;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const handleRaw = useCallback(
    (raw: string) => {
      if (routedRef.current) return;
      const hit = parseScan(raw);
      if (!hit) {
        setUnrecognized(true);
        window.setTimeout(() => setUnrecognized(false), 1600);
        return;
      }
      routedRef.current = true;
      teardown();
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
      setScannedOk(true);
      const q = new URLSearchParams({ to: hit.recipient });
      if (hit.amount != null) q.set("amount", hit.amount.toFixed(2));
      window.setTimeout(() => {
        onClose();
        router.push(`/app/pay?${q.toString()}`);
      }, 900);
    },
    [onClose, router, teardown]
  );

  useEffect(() => {
    if (!open) return;
    stopRef.current = false;
    routedRef.current = false;
    setCam("starting");

    let raf = 0;
    let timer = 0;

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch (e) {
        setCam((e as DOMException)?.name === "NotAllowedError" ? "denied" : "unavailable");
        return;
      }
      if (stopRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setCam("scanning");

      // ── Path 1: native BarcodeDetector ─────────────────────────────────
      const BD = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
      if (BD) {
        try {
          const detector = new BD({ formats: ["qr_code"] });
          const tick = async () => {
            if (stopRef.current) return;
            try {
              const codes = await detector.detect(video);
              if (codes.length > 0 && codes[0].rawValue) handleRaw(codes[0].rawValue);
            } catch {
              /* per-frame failure, keep scanning */
            }
            timer = window.setTimeout(() => {
              raf = requestAnimationFrame(tick);
            }, 180);
          };
          raf = requestAnimationFrame(tick);
          return;
        } catch {
          /* constructor rejected the format, fall through to jsQR */
        }
      }

      // ── Path 2: jsQR on canvas frames (iOS Safari) ─────────────────────
      const { default: jsQR } = await import("jsqr");
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const tick = () => {
        if (stopRef.current || !ctx) return;
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          // Downscale to ≤480px wide, jsQR cost is O(pixels) and QR modules
          // survive the shrink fine.
          const scale = Math.min(1, 480 / w);
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data) handleRaw(code.data);
        }
        timer = window.setTimeout(() => {
          raf = requestAnimationFrame(tick);
        }, 120);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      teardown();
    };
  }, [open, handleRaw, teardown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-[#15300c]">
      {/* Camera feed */}
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Forest scrim with viewfinder cut-out */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="relative size-64 rounded-[28px]"
          style={{ boxShadow: "0 0 0 200vmax rgba(21,48,12,0.55)" }}
        >
          {/* Mint corner brackets */}
          {(["-top-0 -left-0 border-t-[3px] border-l-[3px] rounded-tl-[28px]",
             "-top-0 -right-0 border-t-[3px] border-r-[3px] rounded-tr-[28px]",
             "-bottom-0 -left-0 border-b-[3px] border-l-[3px] rounded-bl-[28px]",
             "-bottom-0 -right-0 border-b-[3px] border-r-[3px] rounded-br-[28px]",
          ] as const).map((cls) => (
            <span
              key={cls}
              className={`absolute size-12 border-[#CAFFB8] ${cls}`}
              aria-hidden
            />
          ))}
          {/* Sweep line */}
          {cam === "scanning" && (
            <span
              aria-hidden
              className="talise-scan-sweep absolute left-5 right-5 h-[2.5px] rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(202,255,184,0.95), transparent)",
                boxShadow: "0 0 12px rgba(202,255,184,0.55)",
              }}
            />
          )}
        </div>
      </div>

      {/* Scanned-successfully beat */}
      {scannedOk && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "rgba(21,48,12,0.55)" }}>
          <div
            className="talise-scan-pop flex flex-col items-center gap-3 rounded-3xl bg-[#f7fcf2] px-8 py-6"
            style={{ boxShadow: "0 1px 2px rgba(18,26,15,0.04), 0 14px 34px -22px rgba(18,26,15,0.22)" }}
          >
            <span className="flex size-16 items-center justify-center rounded-full bg-[#CAFFB8]">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 12.5l5 5L20 6.5" stroke="#15300c" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="text-[13px] font-medium text-[#15300c]">Scanned successfully</span>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 px-4 pb-10 pt-4" style={{ background: "linear-gradient(to bottom, rgba(21,48,12,0.6), transparent)" }}>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => {
              teardown();
              onClose();
            }}
            aria-label="Close scanner"
            className="flex size-10 items-center justify-center rounded-full border border-[#f7fcf2]/25 bg-[#f7fcf2]/15 text-[#f7fcf2] backdrop-blur-sm"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <span className="text-[16px] font-semibold tracking-[-0.05em] text-[#f7fcf2]">
            Point &amp; pay
          </span>
          <span className="size-10" aria-hidden />
        </div>
      </div>

      {/* Bottom caption / states */}
      <div className="absolute inset-x-0 bottom-0 px-8 pb-12 pt-12 text-center" style={{ background: "linear-gradient(to top, rgba(21,48,12,0.6), transparent)" }}>
        {cam === "denied" ? (
          <p className="text-[13px] leading-relaxed text-[#f7fcf2]/90">
            Camera access is blocked. Allow it in your browser settings, then try
            again.
          </p>
        ) : cam === "unavailable" ? (
          <p className="text-[13px] leading-relaxed text-[#f7fcf2]/90">
            No camera available on this device.
          </p>
        ) : unrecognized ? (
          <p className="inline-block rounded-full border border-[#f7fcf2]/25 bg-[#f7fcf2]/15 px-4 py-2 text-[13px] text-[#f7fcf2] backdrop-blur-sm">
            Not a Talise payment code
          </p>
        ) : (
          <p className="text-[13px] leading-relaxed text-[#f7fcf2]/90">
            Frame a Talise code, we&apos;ll set up the payment.
          </p>
        )}
      </div>

      {/* Plain style tag (not styled-jsx, that needs an App Router registry).
          Class names are unique enough to never collide. */}
      <style>{`
        .talise-scan-sweep { top: 12%; animation: talise-sweep 2.4s ease-in-out infinite alternate; }
        @keyframes talise-sweep { from { top: 12%; } to { top: 86%; } }
        .talise-scan-pop { animation: talise-pop 0.32s cubic-bezier(0.34, 1.56, 0.64, 1); }
        @keyframes talise-pop { from { transform: scale(0.55); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
    </div>
  );
}
