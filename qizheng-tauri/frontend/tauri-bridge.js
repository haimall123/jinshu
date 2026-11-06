"use strict";

(() => {
  const events = new EventTarget();
  const invoke = window.__TAURI__.core.invoke;
  let queue = Promise.resolve();
  let currentJob = 0;

  function deliver(message) {
    events.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  window.moiraBridge = {
    addEventListener(type, listener) {
      events.addEventListener(type, listener);
    },
    postMessage(message) {
      if (message.action === "cancel") {
        invoke("cancel_job", { jobId: currentJob }).catch((error) => {
          deliver({ event: "toast", level: "error", message: String(error) });
        });
        return;
      }
      if (message.action === "testComplete") {
        invoke("finish_test", { report: message.report });
        return;
      }
      const jobId = message.action === "calculate" ? ++currentJob : 0;
      queue = queue.then(async () => {
        const responses = await invoke("dispatch", { message, jobId });
        responses.forEach(deliver);
      }).catch((error) => {
        deliver(message.action === "calculate"
          ? { event: "calculationError", message: String(error) }
          : { event: "toast", level: "error", message: String(error) });
      });
    },
  };
})();
