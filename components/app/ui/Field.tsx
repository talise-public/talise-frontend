import type { ReactNode } from "react";
import { Eyebrow } from "./Typography";

export type FieldProps = { label: string; children: ReactNode; hint?: string };

/** A labelled form field wrapper: eyebrow label, control, optional hint. */
export function Field({ label, children, hint }: FieldProps) {
  return (
    <label className="block">
      <Eyebrow className="mb-2 block">{label}</Eyebrow>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] text-[#3d7a29]">{hint}</span>}
    </label>
  );
}
