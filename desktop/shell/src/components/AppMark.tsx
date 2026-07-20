import type { CSSProperties } from "react";
import { appAccent, appInitials } from "../lib/app-visual";
import styles from "./AppMark.module.css";

interface AppMarkProps {
  appId: string;
  name: string;
  size?: "small" | "medium" | "large";
  muted?: boolean;
}

export function AppMark({ appId, name, size = "medium", muted = false }: AppMarkProps) {
  return (
    <span
      className={`${styles.mark} ${styles[size]} ${muted ? styles.muted : ""}`}
      style={{ "--app-accent": appAccent(appId) } as CSSProperties}
      aria-hidden="true"
    >
      <span>{appInitials(name)}</span>
    </span>
  );
}
