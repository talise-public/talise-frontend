import { Suspense } from "react";
import { SendFlow } from "@/components/app/pay/SendFlow";
import { PaySubNav } from "@/components/app/pay/PaySubNav";

/**
 * /app/pay — Send is the default Pay landing.
 *
 * The full multi-step send flow (amount → recipient → review → confirm) lives
 * in the SendFlow client component. It reads `?to=&amount=` for deep-link
 * prefill (the public /pay/<handle> link and Home quick-send), so it must sit
 * under a Suspense boundary (useSearchParams).
 *
 * PaySubNav makes the sibling Pay routes — Request, Cheques (claimable links)
 * and Stream (streamed payouts) — reachable; without it they had no in-app
 * entry point.
 */
export default function PayPage() {
  return (
    <>
      <PaySubNav />
      <Suspense fallback={null}>
        <SendFlow />
      </Suspense>
    </>
  );
}
