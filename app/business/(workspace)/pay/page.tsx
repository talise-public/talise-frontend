"use client";

import { Suspense } from "react";
import { SendFlow } from "@/components/app/pay/SendFlow";

/** /business/pay, pay anyone (supplier, contractor, refund) in USDsui. */
export default function BusinessPayPage() {
  return (
    <Suspense fallback={null}>
      <SendFlow />
    </Suspense>
  );
}
