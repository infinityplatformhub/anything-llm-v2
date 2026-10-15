import { useState, useSyncExternalStore } from "react";
import { DeviceMobile, X, Stop, PlugsConnected } from "@phosphor-icons/react";
import androidBridge from "@/utils/android/bridge";

export default function AndroidConnection() {
  const [open, setOpen] = useState(false);
  const state = useSyncExternalStore(
    androidBridge.subscribe,
    androidBridge.getSnapshot
  );
  const supported = !!navigator.usb && window.isSecureContext;
  const connected = state.status === "connected";
  return (
    <div className="absolute top-3 md:top-5 right-[108px] md:right-[120px] z-20">
      <button
        type="button"
        aria-label="Connect Android"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${connected ? "bg-emerald-500/15 text-emerald-400" : "bg-theme-bg-secondary text-theme-text-secondary hover:text-theme-text-primary"}`}
      >
        <DeviceMobile size={20} />
        <span className="hidden sm:inline">
          {connected ? "Android connected" : "Connect Android"}
        </span>
        {state.busy && (
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Android connection"
          className="fixed top-16 right-4 mt-2 w-[min(340px,calc(100vw-48px))] rounded-xl border border-theme-modal-border bg-theme-bg-secondary p-4 shadow-xl text-theme-text-primary"
        >
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-medium">Android</h2>
            <button
              type="button"
              aria-label="Close Android panel"
              onClick={() => setOpen(false)}
              className="p-1 rounded hover:bg-white/10"
            >
              <X size={18} />
            </button>
          </div>
          <p className="text-xs text-theme-text-secondary mb-3">
            Connect your Android by USB, enable USB debugging, and accept the
            prompt on your phone. The AI in this chat can control this device
            while this tab stays open.
          </p>
          {!supported && (
            <p role="status" className="text-sm mb-3">
              Use Chrome or Edge over HTTPS to connect Android.
            </p>
          )}
          {state.status === "connecting" && (
            <p role="status" className="text-sm mb-3">
              Choose your Android, then allow USB debugging on the phone.
            </p>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-red-400 mb-3">
              {state.error}
            </p>
          )}
          {connected && (
            <p role="status" className="text-sm mb-3 flex items-center gap-2">
              <PlugsConnected size={18} />
              {state.name}
            </p>
          )}
          {state.preview && (
            <img
              src={state.preview}
              alt="Latest Android screenshot"
              className="mx-auto max-h-[40vh] max-w-full rounded-lg mb-3"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {!connected && state.status !== "connecting" && (
              <button
                type="button"
                disabled={!supported}
                onClick={() => androidBridge.connect()}
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40"
              >
                Connect device
              </button>
            )}
            {connected && (
              <button
                type="button"
                onClick={() => androidBridge.stop()}
                className="flex items-center gap-1 rounded-lg border border-theme-modal-border px-3 py-2 text-sm"
              >
                <Stop size={16} />
                Stop AI
              </button>
            )}
            {(connected || state.status === "connecting") && (
              <button
                type="button"
                onClick={() => androidBridge.disconnect()}
                className="rounded-lg border border-theme-modal-border px-3 py-2 text-sm"
              >
                {connected ? "Disconnect" : "Cancel"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
