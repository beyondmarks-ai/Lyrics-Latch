import { getCompanionStatus, type CompanionStatus } from "../shared/companion";

const React = Spicetify.React;

function Dashboard() {
  const [status, setStatus] = React.useState(null as CompanionStatus | null);
  const [connectionError, setConnectionError] = React.useState(false);
  const currentTrack = Spicetify.Player?.data?.item;

  const refreshStatus = React.useCallback(async () => {
    try {
      setStatus(await getCompanionStatus());
      setConnectionError(false);
    } catch {
      setStatus(null);
      setConnectionError(true);
    }
  }, []);

  React.useEffect(() => void refreshStatus(), [refreshStatus]);

  return React.createElement(
    "main",
    { className: "custom-client" },
    React.createElement(
      "section",
      { className: "custom-client__hero" },
      React.createElement("span", { className: "custom-client__eyebrow" }, "LYRICLATCH · VOICE-FIRST MUSIC"),
      React.createElement("h1", null, "Say it. Find it. Loop it."),
      React.createElement(
        "p",
        null,
        "Control playback in your language, find songs from imperfect clues, and practise any lyric section hands-free."
      )
    ),
    React.createElement(
      "section",
      { className: "custom-client__card" },
      React.createElement("span", null, "NOW PLAYING"),
      React.createElement("strong", null, currentTrack?.name ?? "Play something to begin")
    ),
    React.createElement(
      "section",
      { className: "custom-client__settings" },
      React.createElement("h2", null, "Voice and integrations"),
      React.createElement("p", null, "Wake phrase: Hey Monday (offline ONNX model)"),
      React.createElement(
        "div",
        { className: "custom-client__status-grid" },
        React.createElement(Status, { label: "Companion", ready: Boolean(status?.ready) }),
        React.createElement(Status, { label: "Hey Monday", ready: Boolean(status?.wakeWordModelReady) }),
        React.createElement(Status, { label: "Sarvam Speech", ready: Boolean(status?.sarvamConfigured) }),
        React.createElement(Status, { label: "Speech fallback", ready: Boolean(status?.speechConfigured) }),
        React.createElement(Status, { label: "AI lyric matching", ready: Boolean(status?.aiLyricMatchingConfigured) }),
        React.createElement(Status, { label: "YouTube API", ready: Boolean(status?.youtubeConfigured) })
      ),
      React.createElement(
        "p",
        { className: connectionError ? "custom-client__connection is-offline" : "custom-client__connection" },
        connectionError
          ? "Companion is offline. Build it, create .env, then run npm run companion."
          : "Companion connected. Credentials remain outside the Spotify interface."
      ),
      React.createElement("button", { className: "is-secondary", onClick: refreshStatus }, "Check connection")
    )
  );
}

function Status({ label, ready }: { label: string; ready: boolean }) {
  return React.createElement(
    "div",
    { className: "custom-client__status" },
    React.createElement("i", { className: ready ? "is-ready" : "" }),
    React.createElement("span", null, label),
    React.createElement("strong", null, ready ? "Ready" : "Not configured")
  );
}

export function render() {
  return React.createElement(Dashboard);
}
