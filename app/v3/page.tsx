import Motion from "./Motion";
import Nav from "./Nav";
import Hero from "./Hero";
import Stats from "./Stats";
import Bento from "./Bento";
import Rows from "./Rows";
import Card from "./Card";
import Invest from "./Invest";
import More from "./More";
import Trust from "./Trust";
import Insights from "./Insights";
import Faq from "./Faq";
import Footer from "./Footer";

export const dynamic = "force-dynamic";

/**
 * Talise landing, v3 PREVIEW, engineering-blueprint editorial (Finexis-
 * inspired construction grid + corner ticks + mono microtype + bracket
 * buttons), in Talise's own brand: neutral canvas, forest-green accent, real
 * app screens. Light sections alternate with dark product moments (Card,
 * Perps). Lives at /v3 so the production landing (app/page.tsx → v2) is
 * untouched until approved, then app/page.tsx swaps to import this.
 */
export default function LandingV3() {
  return (
    <main className="relative">
      <Motion />
      <Nav />
      <Hero />
      <Stats />
      <Bento />
      <Rows />
      <Card />
      <Invest />
      <More />
      <Trust />
      <Insights />
      <Faq />
      <Footer />
    </main>
  );
}
