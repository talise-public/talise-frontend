import Image from "next/image";
import Reveal from "./Reveal";
import { BracketButton, Kicker, Ticks } from "./ui";

/**
 * Hero, centered blueprint composition. Mono badge, big title-case grotesque
 * headline, two bracket buttons, then a dotted accent band carrying the real
 * app screens on a dark product panel that overlaps into the section below.
 */
export default function Hero() {
  return (
    <section id="top" className="relative">
      <div className="v3-frame relative px-5 pb-14 pt-24 text-center sm:px-8 sm:pt-28">
        <Ticks />

        <Reveal className="flex justify-center">
          <Kicker>Gasless dollars on Sui</Kicker>
        </Reveal>

        <Reveal
          as="h1"
          delay={60}
          className="mx-auto mt-7 max-w-[17ch] text-[clamp(28px,5.2vw,62px)] leading-[1.04] text-[var(--v3-ink)] sm:mt-8 sm:leading-[1.02]"
          style={{ fontFamily: "var(--font-display-v3)" }}
        >
          Money that moves as freely as messages
        </Reveal>

        <Reveal as="p" delay={140} className="mx-auto mt-5 max-w-[48ch] text-[13.5px] leading-[1.6] text-[var(--v3-muted)] sm:mt-6 sm:max-w-[54ch] sm:text-[15.5px] md:text-[17px] md:leading-[1.55]">
          Hold Sui Dollars (USDsui), send them to a name, cash out at home. No seed
          phrase, no gas to think about, money that finally makes sense.
        </Reveal>

        <Reveal as="div" delay={220} className="mt-7 flex flex-wrap items-center justify-center gap-3 sm:mt-9 sm:gap-4">
          <BracketButton href="https://testflight.apple.com/join/BFNEPYtM" external>
            Get iOS App
          </BracketButton>
          <BracketButton href="#why" variant="ghost">
            How it works
          </BracketButton>
        </Reveal>
      </div>

      {/* product band, dotted accent field + dark app panel overlapping down */}
      <div className="v3-frame relative border-t border-[var(--v3-line)]">
        <Ticks />
        <div
          className="relative px-5 pb-0 pt-16 sm:px-10"
          style={{
            backgroundColor: "#e3efe0",
            backgroundImage:
              "radial-gradient(circle, rgba(47,106,31,0.16) 1.1px, transparent 1.1px)",
            backgroundSize: "15px 15px",
          }}
        >
          <Reveal className="talise-collage-art relative mx-auto -mb-12 w-full max-w-[1180px]">
            <Image
              src="/talise-app-collage.png"
              alt="Three Talise app screens, a savings screen, a review-send screen showing no network fee, and a transaction-successful screen"
              width={1650}
              height={879}
              priority
              className="h-auto w-full"
              style={{ filter: "drop-shadow(0 34px 60px rgba(18,26,15,0.28))" }}
            />
          </Reveal>
        </div>
      </div>
      {/* spacer so the overlapping panel has room */}
      <div className="v3-frame h-20 border-t border-transparent" />
    </section>
  );
}
