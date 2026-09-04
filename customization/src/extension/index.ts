import { isVoiceEnabled, setVoiceEnabled } from "../shared/config";
import { VoiceController } from "./voice";
import { sectionLoop } from "./section-loop";

const voice = new VoiceController();

function initialize() {
  if (!Spicetify.Player || !Spicetify.Platform) {
    window.setTimeout(initialize, 100);
    return;
  }

  document.documentElement.classList.add("custom-client-enabled");
  sectionLoop.initialize();
  const voiceButton = new Spicetify.Topbar.Button(
    "Toggle voice commands",
    "volume",
    async () => {
      if (voice.isRunning) {
        voice.stop();
        setVoiceEnabled(false);
      } else if (await voice.start()) {
        setVoiceEnabled(true);
      }
    }
  );
  voiceButton.element.dataset.customClient = "voice-toggle";

  if (isVoiceEnabled()) void voice.start();
  console.info("[LyricLatch] Extension loaded");
}

initialize();
