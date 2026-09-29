"use strict";

const $ = (selector) => document.querySelector(selector);
const tokenPattern = /^[a-f0-9]{64}$/;
const signalLabels = { green: "Everything is clear", yellow: "Can you explain further?", red: "I'm confused" };
const route = location.pathname.match(/^\/(presenter|join)\/([a-f0-9]{24})\/?$/);
let stopped = false;
let pollTimer;

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== `${name}-view`; });
}

function notify(message) {
  $("#global-error").textContent = message;
  $("#global-error").hidden = false;
}

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `form-status ${kind}`;
}

async function api(path, { method = "GET", body, token } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
      cache: "no-store"
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unexpected response. Please try again.");
  }
  if (!response.ok) {
    const error = new Error(data.error ?? "Your request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function audienceIdentity(id) {
  const key = `roompulse:participant:${id}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing && tokenPattern.test(existing)) return existing;
    const token = randomToken();
    localStorage.setItem(key, token);
    return token;
  } catch {
    notify("Browser storage is unavailable. Your feedback will work, but reloading this page will count you as a new participant.");
    return randomToken();
  }
}

function beginPolling(update) {
  async function tick() {
    if (stopped) return;
    await update();
    if (!stopped) pollTimer = setTimeout(tick, document.hidden ? 8000 : 2000);
  }
  void tick();
}

window.addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(pollTimer);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

function setupHome() {
  showView("home");
  $("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#create-button");
    button.disabled = true;
    button.textContent = "Creating your room...";
    $("#create-error").textContent = "";
    try {
      const session = await api("/api/sessions", { method: "POST", body: { title: $("#session-title").value.trim() } });
      location.assign(`/presenter/${session.id}#${session.presenterToken}`);
    } catch (error) {
      $("#create-error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Create presentation \u2192";
    }
  });
}

async function copyLink(value, button, input) {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard access isn't available in this browser.");
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = "Copied!";
    $("#share-status").textContent = "Link copied to clipboard.";
    setTimeout(() => { button.textContent = original; }, 2000);
  } catch {
    if (input) {
      input.focus();
      input.select();
      notify("Automatic copying is unavailable. The audience link is selected; copy it manually.");
    } else {
      notify("Automatic copying is unavailable. Copy the full address from your browser's address bar to save your private dashboard link.");
    }
  }
}

function setupPresenter(id) {
  showView("presenter");
  const token = location.hash.slice(1);
  if (!tokenPattern.test(token)) {
    $("#connection-text").textContent = "Private link required";
    $("#connection").classList.add("offline");
    $("#end-button").disabled = true;
    notify("This dashboard needs its private access key. Open the complete presenter link, including everything after #.");
    return;
  }
  const base = `/api/sessions/${id}`;
  const audienceUrl = `${location.origin}/join/${id}`;
  $("#audience-link").value = audienceUrl;
  $("#open-audience").href = audienceUrl;
  $("#network-note").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  $("#copy-audience").addEventListener("click", () => { void copyLink(audienceUrl, $("#copy-audience"), $("#audience-link")); });
  $("#copy-presenter").addEventListener("click", () => { void copyLink(location.href, $("#copy-presenter")); });
  let closed = false;
  let closing = false;
  let lastCount = 0;
  const renderedMessages = new Set();

  function updateDashboard(data) {
    closed = data.closed;
    $("#presenter-title").textContent = data.title;
    document.title = `${data.title} | Presenter - RoomPulse`;
    $("#connection").className = `status-pill${closed ? " ended" : ""}`;
    $("#connection-text").textContent = closed ? "Session ended" : "Live";
    $("#end-button").disabled = closed || closing;
    $("#end-button").textContent = closed ? "Session ended" : "End session";
    for (const color of ["green", "yellow", "red"]) {
      const percent = data.responses ? Math.round(data.counts[color] / data.responses * 100) : 0;
      $(`#${color}-count`).textContent = data.counts[color];
      $(`#${color}-percent`).textContent = `${percent}%`;
      $(`#${color}-bar`).value = percent;
    }
    $("#response-count").textContent = data.responses;
    $("#participant-count").textContent = data.participants;
    let insight = "Your room is ready. Share the link to get the first signal.";
    if (closed) insight = "Session complete. These results are saved, and your private dashboard link will keep working.";
    else if (data.counts.red > 0) insight = `${data.counts.red} ${data.counts.red === 1 ? "person is" : "people are"} feeling lost. This could be a good moment to pause and try another explanation.`;
    else if (data.counts.yellow > 0) insight = `${data.counts.yellow} ${data.counts.yellow === 1 ? "person would" : "people would"} like more detail. An example could make things click.`;
    else if (data.responses > 0) insight = "Everyone who has sent a signal is following along. Keep the good stuff coming.";
    if ($("#pulse-insight").textContent !== insight) $("#pulse-insight").textContent = insight;
    $("#feedback-count").textContent = data.feedback.length;
    $("#feedback-empty").hidden = data.feedback.length > 0;
    const fragment = document.createDocumentFragment();
    for (const item of [...data.feedback].reverse()) {
      if (renderedMessages.has(item.id)) continue;
      renderedMessages.add(item.id);
      const article = document.createElement("article");
      article.className = "feedback-item";
      const header = document.createElement("header");
      const name = document.createElement("strong");
      name.textContent = "Audience member";
      const time = document.createElement("time");
      time.dateTime = item.createdAt;
      time.textContent = new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      time.title = new Date(item.createdAt).toLocaleString();
      const message = document.createElement("p");
      message.textContent = item.message;
      header.append(name, time);
      article.append(header, message);
      fragment.append(article);
    }
    $("#feedback-list").prepend(fragment);
    if (data.feedback.length !== lastCount) {
      $("#feedback-announcement").textContent = `${data.feedback.length} audience messages received.`;
      lastCount = data.feedback.length;
    }
    $("#last-updated").textContent = `Last synced ${new Date().toLocaleTimeString()} \u00b7 Signals stay until changed; they don't indicate who is online.`;
  }

  beginPolling(async () => {
    try {
      updateDashboard(await api(`${base}/dashboard`, { token }));
    } catch (error) {
      $("#connection").className = "status-pill offline";
      $("#connection-text").textContent = "Updates paused";
      $("#last-updated").textContent = `${error.message} Displayed results may be out of date. Retrying automatically.`;
      if (error.status === 403 || error.status === 404) {
        stopped = true;
        $("#end-button").disabled = true;
        notify(error.message);
      }
    }
  });

  $("#end-button").addEventListener("click", () => { $("#end-dialog").showModal(); });
  $("#end-dialog").addEventListener("close", async () => {
    if ($("#end-dialog").returnValue !== "confirm" || closed) return;
    closing = true;
    $("#end-button").disabled = true;
    try {
      await api(`${base}/close`, { method: "POST", body: {}, token });
      closed = true;
      $("#connection-text").textContent = "Session ended";
      $("#end-button").textContent = "Session ended";
      $("#connection").className = "status-pill ended";
      $("#pulse-insight").textContent = "Session complete. These results are saved, and your private dashboard link will keep working.";
    } catch (error) {
      notify(error.message);
    } finally {
      closing = false;
      $("#end-button").disabled = closed;
    }
  });
}

function setupAudience(id) {
  showView("audience");
  const participantToken = audienceIdentity(id);
  const base = `/api/sessions/${id}`;
  const buttons = [...document.querySelectorAll("[data-signal]")];
  let ready = false;
  let closed = false;
  let sendingSignal = false;
  let sendingFeedback = false;
  let signalRevision = 0;
  let pendingMessage;
  let connectionErrorShown = false;

  function updateControls() {
    buttons.forEach((button) => { button.disabled = !ready || closed || sendingSignal; });
    $("#feedback-message").disabled = !ready || closed || sendingFeedback;
    $("#send-feedback").disabled = !ready || closed || sendingFeedback;
    $("#closed-notice").hidden = !closed;
  }

  function showSignal(signal) {
    buttons.forEach((button) => { button.setAttribute("aria-pressed", String(button.dataset.signal === signal)); });
  }

  beginPolling(async () => {
    const revision = signalRevision;
    try {
      const data = await api(`${base}/state`, { token: participantToken });
      $("#audience-title").textContent = data.title;
      document.title = `${data.title} | Audience - RoomPulse`;
      closed = data.closed;
      ready = true;
      $("#audience-connection").textContent = closed ? "Session ended" : "Connected \u00b7 Anonymous";
      $("#audience-connection").className = `status-pill${closed ? " ended" : ""}`;
      if (!sendingSignal && revision === signalRevision) showSignal(data.signal);
      if (connectionErrorShown && !sendingSignal) {
        setStatus($("#signal-status"), data.signal
          ? `Connected. Your current signal: ${signalLabels[data.signal]}.`
          : "Connected. Your response is anonymous to the presenter.");
        connectionErrorShown = false;
      }
    } catch (error) {
      ready = false;
      $("#audience-connection").textContent = "Disconnected \u00b7 Retrying";
      $("#audience-connection").className = "status-pill offline";
      setStatus($("#signal-status"), `${error.message} Retrying automatically.`, "error");
      connectionErrorShown = true;
      if (error.status === 404) {
        stopped = true;
        notify(error.message);
      }
    }
    updateControls();
  });

  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      if (!ready || closed || sendingSignal) return;
      sendingSignal = true;
      signalRevision += 1;
      updateControls();
      setStatus($("#signal-status"), "Sending your signal...");
      try {
        await api(`${base}/signal`, { method: "POST", body: { participantToken, signal: button.dataset.signal } });
        showSignal(button.dataset.signal);
        setStatus($("#signal-status"), `Signal sent: ${signalLabels[button.dataset.signal]}. You can change it anytime.`, "success");
      } catch (error) {
        setStatus($("#signal-status"), error.message, "error");
      } finally {
        signalRevision += 1;
        sendingSignal = false;
        updateControls();
      }
    });
  });

  $("#feedback-message").addEventListener("input", () => {
    $("#character-count").textContent = `${$("#feedback-message").value.length} / 1,000`;
  });
  $("#feedback-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ready || closed || sendingFeedback) return;
    const message = $("#feedback-message").value.trim();
    if (!message) {
      setStatus($("#feedback-status"), "Please write a message before sending.", "error");
      return;
    }
    if (!pendingMessage || pendingMessage.message !== message) pendingMessage = { message, messageId: randomToken() };
    sendingFeedback = true;
    updateControls();
    $("#send-feedback").textContent = "Sending...";
    setStatus($("#feedback-status"), "");
    try {
      await api(`${base}/feedback`, { method: "POST", body: { participantToken, ...pendingMessage } });
      pendingMessage = undefined;
      $("#feedback-message").value = "";
      $("#character-count").textContent = "0 / 1,000";
      setStatus($("#feedback-status"), "Sent anonymously. Thanks for sharing your thoughts.", "success");
    } catch (error) {
      setStatus($("#feedback-status"), error.message, "error");
    } finally {
      sendingFeedback = false;
      $("#send-feedback").textContent = "Send feedback \u2192";
      updateControls();
    }
  });
}

if (location.pathname === "/") setupHome();
else if (route?.[1] === "presenter") setupPresenter(route[2]);
else if (route?.[1] === "join") setupAudience(route[2]);
else showView("not-found");
