import { snakeCase } from "snake-case";
import {
  ConversationConfig,
  SelfHostedConversationConfig,
} from "./types/conversation";

export const blobToBase64 = (blob: Blob): Promise<string | null> => {
  return new Promise((resolve, _) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(reader.result?.toString().split(",")[1] || null);
    reader.readAsDataURL(blob);
  });
};

export const stringify = (obj: Object): string => {
  return JSON.stringify(obj, function (key, value) {
    if (value && typeof value === "object") {
      var replacement: { [key: string]: any } = {};
      for (var k in value) {
        if (Object.hasOwnProperty.call(value, k)) {
          replacement[k && snakeCase(k.toString())] = value[k];
        }
      }
      return replacement;
    }
    return value;
  });
};

export async function genBase64ToAudioBuffer(
  base64: string,
  audioContext: AudioContext
): Promise<AudioBuffer> {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return audioContext.decodeAudioData(bytes.buffer);
}

export function playAudioBuffer(
  audioBuffer: AudioBuffer,
  audioContext: AudioContext,
  destination: MediaStreamAudioDestinationNode
): void {
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(destination);
  source.start();
}

export const getBackendUrl = async ({
  config,
}: {
  config: ConversationConfig | SelfHostedConversationConfig;
}) => {
  if ("backendUrl" in config) {
    return config.backendUrl;
  } else if ("vocodeConfig" in config) {
    const baseUrl = config.vocodeConfig.baseUrl || "api.vocode.dev";
    return `wss://${baseUrl}/conversation?key=${config.vocodeConfig.apiKey}`;
  } else {
    throw new Error("Invalid config");
  }
};
