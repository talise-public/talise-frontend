"use client";

import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";

/**
 * Full-screen branded preloader. Mounts the moment a user clicks
 * "Continue with Google" and stays until the browser actually navigates
 * to Google's OAuth screen. Without this, the dark hero would freeze
 * for half a second while the ephemeral key + state cookie get minted
 * — visually ugly and confusing on a slow network.
 *
 * Why a full-screen overlay (not just a button spinner): the OAuth
 * preparation kicks off TWO fetches in series (the state cookie set,
 * then the Shinami ephemeral key registration). On a cold tab they
 * collectively take 300-900ms — long enough that the user thinks the
 * button is broken.
 *
 * The galaxy backdrop reuses the existing /landing-hero.png so we don't
 * pay for an extra asset, and the brand voice carries through.
 */
export function SigninPreloader({
  active,
  stage,
}: {
  active: boolean;
  stage: "preparing" | "redirecting";
}) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="signin-preloader"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#fafaf7]"
          role="status"
          aria-live="polite"
        >
          {/* Cosmic backdrop — same hero galaxy, faded + scaled out. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-70"
          >
            <Image
              src="/landing-hero.png"
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover object-center"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[#fafaf7]/40 via-transparent to-[#fafaf7]" />
          </div>

          {/* Foreground: logo + breathing pulse + stage label */}
          <div className="relative z-10 flex flex-col items-center text-center">
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
              className="relative"
            >
              {/* Soft halo behind the logo */}
              <motion.div
                aria-hidden
                className="absolute inset-0 rounded-full bg-[#c08a3e]/15 blur-3xl"
                animate={{ scale: [1, 1.15, 1], opacity: [0.45, 0.7, 0.45] }}
                transition={{
                  duration: 2.2,
                  ease: "easeInOut",
                  repeat: Infinity,
                }}
              />
              <Image
                src="/logo.png"
                alt="Talise"
                width={56}
                height={56}
                priority
                className="relative h-14 w-14"
              />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
              className="mt-7 text-[22px] font-medium tracking-[-0.02em] text-[#111]"
            >
              talise
            </motion.div>

            {/* Stage label */}
            <motion.div
              key={stage}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="mt-4 font-mono text-[11px] uppercase tracking-[0.22em] text-[#8a8472]"
            >
              <span className="relative inline-flex items-center gap-2">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#c08a3e] opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#c08a3e]" />
                </span>
                {stage === "preparing"
                  ? "Preparing your wallet"
                  : "Taking you to Google"}
              </span>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
