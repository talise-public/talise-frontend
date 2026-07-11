import { RequestsView } from "@/components/app/requests/RequestsView";

/**
 * /app/requests — tracked money requests.
 *
 * "I need $X from you" links that flip to PAID once settled on-chain (the
 * inverse of a cheque). Distinct from /app/pay/request, which is the ephemeral
 * receive-QR / payment-link surface. All client-side in RequestsView, talking
 * to /api/requests.
 */
export default function RequestsPage() {
  return <RequestsView />;
}
