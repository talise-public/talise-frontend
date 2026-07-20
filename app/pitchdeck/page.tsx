import type { Metadata } from "next";
import Deck from "./Deck";

export const metadata: Metadata = {
  title: "Talise · Pitch deck",
  description:
    "The Talise pitch deck — a gasless, private dollar wallet on Sui mainnet. Use ← → to navigate.",
};

export default function PitchDeckPage() {
  return <Deck />;
}
