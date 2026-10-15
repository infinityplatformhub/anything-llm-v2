import { connectUsb } from "./transport";
import { ABORT_STREAM_EVENT } from "@/utils/chat";

export function createAndroidBridge(connectTransport = connectUsb) {
  let state = Object.freeze({
    status: "disconnected",
    name: "",
    error: null,
    preview: null,
    busy: false,
  });
  let device = null,
    token = null,
    socket = null,
    epoch = 0,
    owner = null;
  let connectController = null;
  let queue = Promise.resolve();
  const listeners = new Set(),
    requests = new Map();
  const set = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  const send = (target, data) => {
    if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify(data));
  };
  const abortRequests = () => {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    set({ busy: false });
  };
  const stop = () => {
    abortRequests();
    socket?.close();
    socket = null;
    window.dispatchEvent(new CustomEvent(ABORT_STREAM_EVENT));
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    getBinding() {
      return token ? { token, connected: !!device } : null;
    },
    getProtocol() {
      return token ? `anythingllm-android.${token}` : null;
    },
    bindOwner(value) {
      if (owner !== null && owner !== value) {
        this.disconnect();
        token = null;
      }
      owner = value;
    },
    stop,
    async connect() {
      stop();
      connectController?.abort();
      const controller = new AbortController();
      connectController = controller;
      const current = ++epoch;
      set({ status: "connecting", error: null });
      try {
        const connected = await connectTransport(controller.signal);
        if (current !== epoch) {
          await connected?.close();
          return;
        }
        if (!connected) {
          set({ status: "disconnected" });
          return;
        }
        device = connected;
        token = [...crypto.getRandomValues(new Uint8Array(32))]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        set({ status: "connected", name: device.name, preview: null });
        device.closed.then(
          () => {
            if (epoch !== current) return;
            this.disconnect(
              "Android disconnected. Reconnect the USB cable to continue."
            );
          },
          () => {
            if (epoch === current)
              this.disconnect(
                "Android connection was lost. Reconnect to continue."
              );
          }
        );
      } catch (error) {
        if (current !== epoch) return;
        set({
          status: "disconnected",
          error:
            error.name === "AbortError"
              ? null
              : error.name === "DeviceBusyError"
                ? "Android is in use by another app. Close ADB or screen mirroring, then reconnect."
                : error.message,
        });
      } finally {
        if (connectController === controller) connectController = null;
      }
    },
    async disconnect(error = null) {
      ++epoch;
      connectController?.abort();
      stop();
      const previous = device;
      device = null;
      // Retain the in-memory capability for private same-page history after
      // disconnect. It does not authorize any device action while disconnected.
      set({ status: "disconnected", name: "", preview: null, error });
      await previous?.close().catch(() => {});
    },
    attachSocket(target, bindingToken) {
      if (!bindingToken) return;
      if (bindingToken !== token) {
        target.close();
        return;
      }
      if (socket && socket !== target) socket.close();
      socket = target;
      target.addEventListener(
        "close",
        () => {
          if (socket !== target) return;
          socket = null;
          abortRequests();
        },
        { once: true }
      );
    },
    detachSocket(target) {
      if (socket !== target) return;
      socket = null;
      abortRequests();
      target.close();
    },
    handleEvent(target, data) {
      if (data?.type !== "androidCommand" && data?.type !== "androidCancel")
        return false;
      if (socket !== target) return true;
      if (data.type === "androidCancel") {
        requests.get(data.id)?.abort();
        return true;
      }
      if (
        typeof data.id !== "string" ||
        data.id.length > 100 ||
        requests.has(data.id)
      )
        return true;
      if (!device || requests.size >= 16) {
        send(target, { type: "androidResult", id: data.id, error: true });
        return true;
      }
      const controller = new AbortController();
      const current = epoch,
        activeDevice = device;
      requests.set(data.id, controller);
      queue = queue
        .catch(() => {})
        .then(async () => {
          if (
            controller.signal.aborted ||
            current !== epoch ||
            socket !== target
          )
            return;
          set({ busy: true, error: null });
          const timer = setTimeout(() => controller.abort(), 25_000);
          try {
            const result = await activeDevice.execute(
              data.action,
              data.args,
              controller.signal
            );
            if (
              controller.signal.aborted ||
              current !== epoch ||
              socket !== target
            )
              return;
            const { preview, ...response } = result;
            if (preview) set({ preview });
            send(target, {
              type: "androidResult",
              id: data.id,
              result: response,
            });
          } catch (error) {
            if (
              !controller.signal.aborted &&
              current === epoch &&
              socket === target
            ) {
              set({ error: error.message });
              send(target, { type: "androidResult", id: data.id, error: true });
            }
          } finally {
            clearTimeout(timer);
            requests.delete(data.id);
            if (current === epoch) set({ busy: requests.size > 0 });
          }
        });
      return true;
    },
  };
}

// In-memory, per tab. Keeping it outside the empty/chat rendering branches also
// preserves USB across the first-message thread navigation. No device capability
// or screenshot is written to localStorage, sessionStorage, or the database.
const androidBridge = createAndroidBridge();
export default androidBridge;
