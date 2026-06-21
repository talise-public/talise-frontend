import { RequestPanel } from "@/components/app/pay/RequestPanel";
import { PaySubNav } from "@/components/app/pay/PaySubNav";

/**
 * /app/pay/request — Receive a payment.
 *
 * Two modes: a plain receive QR (`sui:<address>`) and a request builder that
 * produces a shareable `/pay/<handle>?amount=&memo=` payment link with its own
 * QR. All client-side (RequestPanel).
 *
 * PaySubNav keeps the Pay-area sub-navigation present here so the user can
 * cross back to Send / Cheques / Stream — without it, landing on Request was a
 * dead end with no in-app way back to the other Pay tabs.
 */
export default function RequestPage() {
  return (
    <>
      <PaySubNav />
      <RequestPanel />
    </>
  );
}
