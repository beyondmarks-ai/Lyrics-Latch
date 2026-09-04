export const CONFIG_KEYS = {
  voiceEnabled: "lyriclatch:voice-enabled"
} as const;

export function isVoiceEnabled(): boolean {
  return Spicetify.LocalStorage.get(CONFIG_KEYS.voiceEnabled) === "true";
}

export function setVoiceEnabled(enabled: boolean): void {
  Spicetify.LocalStorage.set(CONFIG_KEYS.voiceEnabled, String(enabled));
}
