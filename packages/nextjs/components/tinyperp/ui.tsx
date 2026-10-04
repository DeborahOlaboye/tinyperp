"use client";

import { ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import { Hash } from "viem";
import { Tinyperp, TinyperpActions, explainError } from "~~/hooks/tinyperp";
import { EngineConfig, formatPriceNumber, priceLevels } from "~~/utils/tinyperp";

/** The palette, for styles that depend on data. Static styles live in tinyperp.css. */
export const C = {
  long: "oklch(0.82 0.16 150)",
  short: "oklch(0.76 0.16 30)",
  sun: "oklch(0.89 0.15 95)",
  lilac: "oklch(0.82 0.09 295)",
  ink: "#1A1714",
  paper: "#FFFDF8",
  bg: "#F4EEE2",
  dim: "#EAE3D5",
} as const;

export type ScreenKey = "trade" | "positions" | "pool" | "liquidate" | "faucet" | "markets" | "claim" | "admin";

/** What every screen receives from the shell. */
export type ScreenProps = {
  tp: Tinyperp;
  actions: TinyperpActions;
  /** Seconds since the epoch, ticking. */
  now: number;
  /** True while a transaction is waiting on the wallet or the network. */
  busy: boolean;
  /** Runs a transaction, then shows what happened. Resolves to whether it succeeded. */
  run: (action: () => Promise<Hash>, done: string) => Promise<boolean>;
  go: (screen: ScreenKey) => void;
  /** Show the contract call behind each control. Useful in a template, easy to turn off. */
  dev: boolean;
};

// ---------------------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------------------

type Toast = { id: number; text: string; hash?: Hash; error?: boolean };

const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => undefined);

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ explorerUrl, children }: { explorerUrl?: string; children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current, { ...toast, id }].slice(-3));
    setTimeout(() => setToasts(current => current.filter(entry => entry.id !== id)), toast.error ? 9000 : 6500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="tp-toasts" role="status" aria-live="polite">
        {toasts.map(toast => (
          <div key={toast.id} className={`tp-toast${toast.error ? " tp-toast--error" : ""}`}>
            <span style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.35 }}>{toast.text}</span>
            {toast.hash && (
              <span className="tp-mono" style={{ fontSize: 12, color: "#D9D1C4" }}>
                tx {toast.hash.slice(0, 10)}…{" "}
                {explorerUrl && (
                  <a href={`${explorerUrl}/transaction/${toast.hash}`} target="_blank" rel="noreferrer">
                    HashScan
                  </a>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Wraps a transaction with the busy flag and the toasts every screen wants. */
export function useRunner() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<Hash>, done: string) => {
      setBusy(true);
      try {
        const hash = await action();
        toast({ text: done, hash });
        return true;
      } catch (error) {
        toast({ text: explainError(error), error: true });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return useMemo(() => ({ busy, run }), [busy, run]);
}

// ---------------------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------------------

export function Toggle({
  on,
  onChange,
  onColor = C.sun,
  label,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  onColor?: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="tp-toggle"
      style={on ? { background: onColor } : undefined}
    >
      <span />
    </button>
  );
}

/**
 * The one button at the bottom of a form. It shows the reason when the action is not possible, and waits
 * visibly while a transaction is in flight.
 */
export function ActionButton({
  reason,
  busy,
  onClick,
  children,
  className = "tp-btn",
  blockedClassName = "tp-blocked",
  style,
}: {
  reason?: string | null;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  blockedClassName?: string;
  style?: React.CSSProperties;
}) {
  if (busy || reason) {
    return (
      <button type="button" disabled className={blockedClassName}>
        {busy ? "Waiting for the transaction…" : reason}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className} style={style}>
      {children}
    </button>
  );
}

export const DevNote = ({ show, children }: { show: boolean; children: ReactNode }) =>
  show ? <span className="tp-mono tp-note">{children}</span> : null;

// ---------------------------------------------------------------------------------------------------------
// The price bar: liquidation at one end, the profit cap at the other, entry in between
// ---------------------------------------------------------------------------------------------------------

export type PriceBar = {
  gradient: string;
  liquidationLeft: string;
  entryLeft: string;
  capLeft: string;
  nowLeft: string;
  liquidation: string;
  zero: string;
  cap: string;
  entry: string;
};

export function priceBar(
  entry: number,
  isLong: boolean,
  leverage: number,
  config: EngineConfig,
  current?: number,
): PriceBar {
  const levels = priceLevels(entry, isLong, leverage, config);
  const low = Math.min(levels.liquidation, levels.cap);
  const high = Math.max(levels.liquidation, levels.cap);
  const range = high - low || 1;
  const from = low - range * 0.06;
  const to = high + range * 0.06;
  const at = (price: number) => Math.min(100, Math.max(0, ((price - from) / (to - from)) * 100));

  const liquidationAt = at(levels.liquidation);
  const entryAt = at(entry);
  const capAt = at(levels.cap);
  const gradient = isLong
    ? `linear-gradient(90deg, ${C.short} 0%, ${C.short} ${liquidationAt}%, ${C.sun} ${entryAt}%, ${C.long} ${capAt}%, ${C.long} 100%)`
    : `linear-gradient(90deg, ${C.long} 0%, ${C.long} ${capAt}%, ${C.sun} ${entryAt}%, ${C.short} ${liquidationAt}%, ${C.short} 100%)`;

  return {
    gradient,
    liquidationLeft: `${liquidationAt}%`,
    entryLeft: `${entryAt}%`,
    capLeft: `${capAt}%`,
    nowLeft: `${current === undefined ? entryAt : at(current)}%`,
    liquidation: formatPriceNumber(levels.liquidation),
    zero: formatPriceNumber(levels.zero),
    cap: levels.cap > 0 ? formatPriceNumber(levels.cap) : "none",
    entry: formatPriceNumber(entry),
  };
}
