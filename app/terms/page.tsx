import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalList } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service — Talise",
  description:
    "The terms that apply when you use Talise during the invite-only beta.",
};

/**
 * /terms — the Talise terms of service for the invite-only beta.
 *
 * Plain-English and deliberately conservative: no fee promises, no rate
 * claims, honest about self-custody (the user's Google account controls
 * the wallet), Earn's third-party lending risk, and beta as-is service.
 * Linked from the iOS app's Profile screen alongside /privacy.
 */
export default function TermsOfService() {
  return (
    <LegalPage
      eyebrow="legal"
      title="Terms of Service"
      updated="Last updated: June 2026"
    >
      <LegalSection title="Agreeing to these terms">
        <p>
          These terms apply when you use Talise — the iOS app and the
          websites at talise.io and app.talise.io. By creating an account or
          using the service, you agree to them. If you don&apos;t agree,
          please don&apos;t use Talise.
        </p>
      </LegalSection>

      <LegalSection title="Talise is in beta">
        <p>
          Talise is currently an <strong>invite-only beta</strong>. Features
          may change, break, or be removed without notice, and access may be
          limited, paused, or revoked while we build. Please treat the
          service accordingly and don&apos;t keep more money in Talise than
          you&apos;re comfortable with during this period.
        </p>
      </LegalSection>

      <LegalSection title="Self-custody — your keys, your responsibility">
        <p>
          Talise is a self-custodial wallet. Your wallet keys are derived on
          your device from your Google sign-in using Sui zkLogin.{" "}
          <strong>
            Talise never holds your keys and cannot recover them.
          </strong>
        </p>
        <p>
          Because your Google account controls your wallet, you are
          responsible for keeping it secure — use a strong password and
          two-factor authentication. If you lose access to your Google
          account, or someone else gains access to it, Talise cannot restore
          your wallet or reverse transactions made with it. Blockchain
          transactions are final.
        </p>
      </LegalSection>

      <LegalSection title="No financial advice">
        <p>
          Nothing in Talise — the app, the website, or anything we publish —
          is financial, investment, legal, or tax advice. You alone decide
          how to use your money.
        </p>
      </LegalSection>

      <LegalSection title="Earn">
        <p>
          The Earn feature routes your deposit to a third-party lending
          protocol on the Sui blockchain. You should understand:
        </p>
        <LegalList
          items={[
            <>
              Yields are variable and set by the protocol, not by Talise.{" "}
              <strong>There are no guaranteed returns.</strong>
            </>,
            <>
              Funds in Earn are <strong>not insured</strong> by any
              government deposit-insurance scheme or by Talise.
            </>,
            <>
              Third-party protocols carry smart-contract and market risk. You
              could lose some or all of what you deposit.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Cash-outs">
        <p>
          Cash-outs to bank accounts are executed by third-party payment
          partners. Talise passes your payout instruction to the partner but
          does not control bank processing times or partner availability.
        </p>
      </LegalSection>

      <LegalSection title="What you can't use Talise for">
        <LegalList
          items={[
            <>
              Anything that violates sanctions laws, or use from a
              sanctioned jurisdiction or by a sanctioned person.
            </>,
            <>Fraud, scams, money laundering, or financing illegal activity.</>,
            <>
              Interfering with the service — probing, attacking, or abusing
              Talise&apos;s systems or other users.
            </>,
          ]}
        />
        <p>
          We may suspend or terminate accounts involved in prohibited
          activity.
        </p>
      </LegalSection>

      <LegalSection title="The service is provided as-is">
        <p>
          During the beta, Talise is provided <strong>as-is</strong> and{" "}
          <strong>as available</strong>, without warranties of any kind,
          express or implied — including availability, fitness for a
          particular purpose, or error-free operation.
        </p>
      </LegalSection>

      <LegalSection title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, Talise and its team are not
          liable for indirect, incidental, special, or consequential damages,
          or for loss of funds, profits, or data arising from your use of the
          service — including losses caused by blockchain networks,
          third-party protocols, payment partners, or loss of access to your
          Google account.
        </p>
      </LegalSection>

      <LegalSection title="Ending your access">
        <p>
          You can stop using Talise at any time and delete your account in
          the app under <strong>Profile → Delete account</strong>. We may
          suspend or terminate your access to the service at any time during
          the beta, including for violations of these terms. Because Talise
          is self-custodial, termination of service access does not give us
          control over your keys or your on-chain funds.
        </p>
      </LegalSection>

      <LegalSection title="Governing law">
        <p>
          These terms are governed by the laws of the jurisdiction in which
          the Talise operating entity is established, without regard to
          conflict-of-law rules. We&apos;ll name the venue here as the
          service moves out of beta.
        </p>
      </LegalSection>

      <LegalSection title="Changes to these terms">
        <p>
          We may update these terms as the product evolves. When we do,
          we&apos;ll post the new version here and update the date at the
          top. Continuing to use Talise after a change means you accept the
          updated terms.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about these terms? Email us at{" "}
          <a
            href="mailto:team@talise.io"
            className="text-[var(--color-accent-deep)] underline underline-offset-4"
          >
            team@talise.io
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
