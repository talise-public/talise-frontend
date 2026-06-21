import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalList } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy — Talise",
  description:
    "How Talise handles your data: what we collect, what we never collect, and how to delete your account.",
};

/**
 * /privacy — the Talise privacy policy.
 *
 * Plain-English and HONEST: every claim here matches the shipped product
 * (zkLogin self-custody, Google sign-in profile data, @handles, country,
 * Sui address, bank details for cash-outs, App Attest). No ads, no
 * third-party analytics SDKs, no tracking, no sale of data — and the
 * policy says exactly that, nothing more. Linked from the iOS app's
 * Profile screen and required by App Store Connect.
 */
export default function PrivacyPolicy() {
  return (
    <LegalPage
      eyebrow="legal"
      title="Privacy Policy"
      updated="Last updated: June 2026"
    >
      <LegalSection title="The short version">
        <p>
          Talise is a self-custodial wallet. Your keys are derived on your
          device — we never hold them and can never recover them. We collect
          only what we need to run the service: your Google profile basics,
          your chosen handle and country, your Sui address, and bank details
          if you cash out. We show <strong>no ads</strong>, run{" "}
          <strong>no third-party analytics or tracking</strong>, and{" "}
          <strong>never sell your data</strong>.
        </p>
      </LegalSection>

      <LegalSection title="Who we are">
        <p>
          Talise is a self-custodial money app built on the Sui blockchain.
          You sign in with your Google account, and your wallet keys are
          derived on your own device using Sui zkLogin. Talise never holds,
          stores, or has access to your private keys, and cannot recover them
          for you.
        </p>
        <p>
          This policy covers the Talise iOS app and the websites at talise.io
          and app.talise.io.
        </p>
      </LegalSection>

      <LegalSection title="What we collect">
        <LegalList
          items={[
            <>
              <strong>Google account basics</strong> — your email address,
              display name, and profile picture, provided by Google when you
              sign in.
            </>,
            <>
              <strong>Your @handle</strong> — the username you choose so
              other people can pay you by name.
            </>,
            <>
              <strong>Country</strong> — the country you tell us you are in.
            </>,
            <>
              <strong>Sui address</strong> — the blockchain address derived
              from your sign-in. This is how your wallet exists on-chain.
            </>,
            <>
              <strong>Transaction history</strong> — your payments are
              recorded on the Sui blockchain, which is public by nature. We
              also keep records of your activity in the app so we can show it
              to you and meet our legal obligations.
            </>,
            <>
              <strong>Bank account details</strong> — if you cash out to a
              Nigerian bank account, we collect the account details you link
              so the payout can be made.
            </>,
            <>
              <strong>Device integrity attestations</strong> — the iOS app
              uses Apple App Attest to prove requests come from a genuine
              copy of the app. Attestations verify the device, not you — we
              do not use them to identify or track you.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="What we never do">
        <LegalList
          items={[
            <>We never hold or have access to your private keys.</>,
            <>We show no advertising of any kind.</>,
            <>
              We use no third-party analytics SDKs and no tracking
              technologies.
            </>,
            <>We never sell or rent your data to anyone.</>,
          ]}
        />
      </LegalSection>

      <LegalSection title="How we use your data">
        <p>
          We use the data above for one purpose: providing the Talise service
          — creating your account, showing your balance and activity, letting
          people pay you by handle, executing cash-outs you request, keeping
          the service secure, and meeting legal requirements. That&apos;s it.
        </p>
      </LegalSection>

      <LegalSection title="When we share data">
        <LegalList
          items={[
            <>
              <strong>Payment partners</strong> — when you cash out, we pass
              your bank account details and the payout amount to the payment
              partner that executes the bank transfer.
            </>,
            <>
              <strong>The blockchain</strong> — transactions on Sui are
              public by design. Your Sui address and on-chain activity are
              visible to anyone, as on any public blockchain.
            </>,
            <>
              <strong>Legal compliance</strong> — we may disclose information
              if required by law, regulation, or a valid legal process.
            </>,
          ]}
        />
        <p>We do not share your data with anyone else.</p>
      </LegalSection>

      <LegalSection title="Retention and deletion">
        <p>
          You can delete your account at any time in the app under{" "}
          <strong>Profile → Delete account</strong>. Deletion redacts your
          personal data from our systems.
        </p>
        <p>
          We retain financial records for as long as the law requires us to.
          Transactions already recorded on the Sui blockchain are permanent
          and public by nature, and cannot be deleted by us or anyone else.
        </p>
      </LegalSection>

      <LegalSection title="Changes to this policy">
        <p>
          We may update this policy as the product evolves. When we do,
          we&apos;ll post the new version here and update the date at the
          top.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about this policy or your data? Email us at{" "}
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
