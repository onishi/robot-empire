import { DEFAULT_ICON } from "@/lib/emoji";

export function Avatar({ icon, size = "sm" }: { icon: string | null | undefined; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`avatar avatar-${size}`} aria-hidden="true">
      {icon || DEFAULT_ICON}
    </span>
  );
}
