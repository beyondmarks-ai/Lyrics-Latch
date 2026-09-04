import { OpenWakeWord, VAD } from "openwakeword-web";
import { Microphone } from "openwakeword-web/microphone";
import { recognizeVoiceCommand } from "../shared/companion";
import { executeVoiceCommand } from "./commands";
import { buildLoopFollowUpCommand, isLoopFollowUpCancellation } from "./loop-dialog";

const COMPANION_URL = "http://127.0.0.1:43821";
const DETECTION_COOLDOWN_MS = 2_000;

export class VoiceController {
  private detector: OpenWakeWord | null = null;
  private microphone: Microphone | null = null;
  private running = false;
  private starting = false;
  private commandListening = false;
  private lastDetection = 0;
  private lifecycle = 0;
  private inferenceQueue: Promise<void> = Promise.resolve();
  private followUpVad: VAD | null = null;
  private preparingFollowUp = false;
  private followUpListening = false;
  private followUpSpeechStarted = false;
  private followUpSilenceFrames = 0;
  private followUpSpeechFrames = 0;
  private followUpPreRoll: Int16Array[] = [];
  private followUpAudio: Int16Array[] = [];
  private followUpTimeout: number | null = null;

  get isRunning() {
    return this.running || this.starting;
  }

  async start(): Promise<boolean> {
    if (this.isRunning) return true;

    this.starting = true;
    const lifecycle = ++this.lifecycle;
    Spicetify.showNotification("Loading the Hey Monday wake-word model...");

    try {
      this.detector = await OpenWakeWord.create({
        baseUrl: `${COMPANION_URL}/models/`,
        wakewordModels: [{ name: "hey_monday", url: "hey_monday.onnx", inputFrames: 16 }],
        threshold: 0.5,
        ort: { wasmPaths: `${COMPANION_URL}/ort/`, numThreads: 1 },
        onDetection: () => this.handleWakeWord(),
        onUtterance: ({ audio }) => void this.handleUtterance(audio),
        vadStopThreshold: 0.5,
        vadStopFrames: 15,
        maxCaptureDuration: 8
      });
      if (lifecycle !== this.lifecycle) {
        await this.cleanupDetector();
        return false;
      }
      this.microphone = new Microphone(
        (frame) => {
          this.inferenceQueue = this.inferenceQueue.then(() => this.processFrame(frame));
        },
        { workletUrl: `${COMPANION_URL}/mic-worklet.js` }
      );
      await this.microphone.start();
      if (lifecycle !== this.lifecycle) {
        await this.cleanupDetector();
        return false;
      }
      this.running = true;
      Spicetify.showNotification("Voice enabled — say “Hey Monday”");
      return true;
    } catch (error) {
      await this.cleanupDetector();
      const message = error instanceof Error ? error.message : "wake-word initialization failed";
      Spicetify.showNotification(`Hey Monday unavailable: ${message}. Is the companion running?`, true);
      return false;
    } finally {
      if (lifecycle === this.lifecycle) this.starting = false;
    }
  }

  stop(): void {
    this.lifecycle++;
    this.running = false;
    this.starting = false;
    this.commandListening = false;
    this.cancelFollowUp();
    void this.cleanupDetector();
    Spicetify.showNotification("Voice disabled");
  }

  private async processFrame(frame: Int16Array): Promise<void> {
    if (!this.running || !this.detector) return;
    try {
      if (this.preparingFollowUp) return;
      if (this.followUpListening) {
        await this.processFollowUpFrame(frame);
        return;
      }
      await this.detector.predict(frame);
    } catch (error) {
      console.error("[LyricLatch] Wake-word inference failed", error);
    }
  }

  private handleWakeWord(): void {
    const now = Date.now();
    if (
      !this.running || this.commandListening || this.preparingFollowUp || this.followUpListening
      || now - this.lastDetection < DETECTION_COOLDOWN_MS
    ) return;
    this.lastDetection = now;
    this.commandListening = true;
    Spicetify.Player.pause();
    Spicetify.showNotification("Hey Monday detected — say your command...");
  }

  private async handleUtterance(audio: Int16Array): Promise<void> {
    if (!this.running || !this.commandListening) return;
    try {
      Spicetify.showNotification("Understanding your command...");
      const transcript = stripWakePhrase(await recognizeVoiceCommand(audio));
      if (!transcript) {
        Spicetify.showNotification("I didn't hear a command", true);
        return;
      }
      console.info(`[LyricLatch] Speech transcript: ${transcript}`);
      const result = await executeVoiceCommand(transcript);
      if (typeof result === "string") {
        Spicetify.showNotification(result, result.startsWith("Couldn't"));
      } else {
        this.commandListening = false;
        await this.beginLoopFollowUp(result.message);
      }
    } catch (error) {
      console.error("[LyricLatch] Voice command failed", error);
      const message = error instanceof Error ? error.message : "speech recognition failed";
      Spicetify.showNotification(`Voice command failed: ${message}`, true);
    } finally {
      if (!this.preparingFollowUp && !this.followUpListening) this.commandListening = false;
    }
  }

  private async cleanupDetector(): Promise<void> {
    this.cancelFollowUp();
    await this.microphone?.stop();
    this.microphone = null;
    this.detector = null;
    this.followUpVad = null;
    this.inferenceQueue = Promise.resolve();
  }

  private async beginLoopFollowUp(question: string): Promise<void> {
    this.preparingFollowUp = true;
    try {
      this.followUpVad ??= await VAD.create(`${COMPANION_URL}/models/silero_vad.onnx`, {
        executionProviders: ["wasm"]
      });
      Spicetify.showNotification(question);
      await speak(question);
      if (!this.running || !this.followUpVad) return;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      this.followUpVad.reset();
      this.followUpListening = true;
      this.followUpSpeechStarted = false;
      this.followUpSilenceFrames = 0;
      this.followUpSpeechFrames = 0;
      this.followUpPreRoll = [];
      this.followUpAudio = [];
      Spicetify.showNotification("Listening for the loop lyrics or time range...");
      this.followUpTimeout = window.setTimeout(() => {
        this.cancelFollowUp();
        Spicetify.Player.play();
        void this.detector?.reset();
        Spicetify.showNotification("Loop request timed out — say “Hey Monday” to try again", true);
      }, 15_000);
    } catch (error) {
      this.cancelFollowUp();
      throw error;
    } finally {
      this.preparingFollowUp = false;
    }
  }

  private async processFollowUpFrame(frame: Int16Array): Promise<void> {
    if (!this.followUpVad) return;
    const score = await this.followUpVad.predict(frame);
    if (!this.followUpSpeechStarted) {
      this.followUpPreRoll.push(frame.slice());
      if (this.followUpPreRoll.length > 3) this.followUpPreRoll.shift();
      if (score >= 0.5) {
        this.followUpSpeechStarted = true;
        this.followUpAudio = this.followUpPreRoll.map((part) => part.slice());
        this.followUpSpeechFrames = 1;
      }
      return;
    }

    this.followUpAudio.push(frame.slice());
    this.followUpSpeechFrames++;
    this.followUpSilenceFrames = score < 0.5 ? this.followUpSilenceFrames + 1 : 0;
    if ((this.followUpSpeechFrames >= 4 && this.followUpSilenceFrames >= 8) || this.followUpAudio.length >= 100) {
      const audio = concatenateAudio(this.followUpAudio);
      this.cancelFollowUp();
      this.commandListening = true;
      await this.handleLoopFollowUp(audio);
    }
  }

  private async handleLoopFollowUp(audio: Int16Array): Promise<void> {
    try {
      Spicetify.showNotification("Understanding the loop details...");
      const transcript = stripWakePhrase(await recognizeVoiceCommand(audio));
      if (!transcript) {
        Spicetify.Player.play();
        Spicetify.showNotification("I didn't hear the loop details", true);
        return;
      }
      if (isLoopFollowUpCancellation(transcript)) {
        Spicetify.Player.play();
        Spicetify.showNotification("Loop request cancelled");
        return;
      }
      const command = buildLoopFollowUpCommand(transcript);
      const result = await executeVoiceCommand(command);
      const message = typeof result === "string" ? result : "Please start the loop request again";
      Spicetify.showNotification(message, message.startsWith("Couldn't"));
    } catch (error) {
      console.error("[LyricLatch] Loop follow-up failed", error);
      Spicetify.Player.play();
      Spicetify.showNotification(
        `Loop request failed: ${error instanceof Error ? error.message : "could not understand the answer"}`,
        true
      );
    } finally {
      this.commandListening = false;
      await this.detector?.reset();
    }
  }

  private cancelFollowUp(): void {
    if (this.followUpTimeout !== null) window.clearTimeout(this.followUpTimeout);
    this.followUpTimeout = null;
    this.followUpListening = false;
    this.followUpSpeechStarted = false;
    this.followUpSilenceFrames = 0;
    this.followUpSpeechFrames = 0;
    this.followUpPreRoll = [];
    this.followUpAudio = [];
  }
}

export function stripWakePhrase(transcript: string): string {
  return transcript.trim().replace(/^(?:hey\s+)?monday\b[\s,.:;-]*/i, "").trim();
}

function concatenateAudio(parts: Int16Array[]): Int16Array {
  const audio = new Int16Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    audio.set(part, offset);
    offset += part.length;
  }
  return audio;
}

function speak(message: string): Promise<void> {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(safetyTimer);
      resolve();
    };
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "en-IN";
    utterance.rate = 1.02;
    utterance.onend = finish;
    utterance.onerror = finish;
    const safetyTimer = window.setTimeout(finish, 10_000);
    window.speechSynthesis.speak(utterance);
  });
}
