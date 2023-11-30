import {
  IMediaRecorder,
  MediaRecorder,
  register,
} from "extendable-media-recorder";
import { connect } from "extendable-media-recorder-wav-encoder";
import React from "react";
import {
  ConversationConfig,
  ConversationStatus,
  CurrentSpeaker,
  SelfHostedConversationConfig,
  Transcript,
  CallDetails,
} from "../types/conversation";
import { blobToBase64, stringify } from "../utils";
import { AudioEncoding } from "../types/vocode/audioEncoding";
import {
  AudioConfigStartMessage,
  AudioMessage,
  StartMessage,
  StopMessage,
  FinalComboAudioMessage,
} from "../types/vocode/websocket";
import { DeepgramTranscriberConfig, TranscriberConfig } from "../types";
import { isSafari, isChrome } from "react-device-detect";
import { Buffer } from "buffer";

const VOCODE_API_URL = "api.vocode.dev";
const DEFAULT_CHUNK_SIZE = 2048;

export const useConversation = (
  config: ConversationConfig | SelfHostedConversationConfig
): {
  status: ConversationStatus;
  start: () => void;
  stop: () => void;
  error: Error | undefined;
  active: boolean;
  setActive: (active: boolean) => void;
  toggleActive: () => void;
  analyserNode: AnalyserNode | undefined;
  transcripts: Transcript[];
  currentSpeaker: CurrentSpeaker;
  callDetails: CallDetails | undefined;
  localRecordingUrl: string | undefined;
} => {
  const comboChunksRef = React.useRef([]);
  const combinedStreamDestRef = React.useRef<MediaStreamAudioDestinationNode>();
  const [audioContext, setAudioContext] = React.useState<AudioContext>();
  const [localRecordingUrl, setLocalRecordingUrl] = React.useState<string>();

  const [audioAnalyser, setAudioAnalyser] = React.useState<AnalyserNode>();
  const [callDetails, setCallDetails] = React.useState<CallDetails>();

  const [audioQueue, setAudioQueue] = React.useState<Buffer[]>([]);
  const [currentSpeaker, setCurrentSpeaker] =
    React.useState<CurrentSpeaker>("none");
  const [processing, setProcessing] = React.useState(false);
  const [recorder, setRecorder] = React.useState<IMediaRecorder>();
  const [agentAndUserRecorder, setAgentAndUserRecorder] =
    React.useState<IMediaRecorder>();
  const [socket, setSocket] = React.useState<WebSocket>();
  const [status, setStatus] = React.useState<ConversationStatus>("idle");
  const [error, setError] = React.useState<Error>();
  const [transcripts, setTranscripts] = React.useState<Transcript[]>([]);
  const [active, setActive] = React.useState(true);
  const toggleActive = () => setActive(!active);

  // get audio context and metadata about user audio
  React.useEffect(() => {
    const _audioContext = new AudioContext();
    setAudioContext(_audioContext);
    const audioAnalyser = _audioContext.createAnalyser();
    setAudioAnalyser(audioAnalyser);

    combinedStreamDestRef.current =
      _audioContext.createMediaStreamDestination();
  }, []);

  const recordingDataListener = ({ data }: { data: Blob }) => {
    blobToBase64(data).then((base64Encoded: string | null) => {
      if (!base64Encoded) return;
      const audioMessage: AudioMessage = {
        type: "websocket_audio",
        data: base64Encoded,
      };
      socket?.readyState === WebSocket.OPEN &&
        socket.send(stringify(audioMessage));
    });
  };

  const comboRecordingDataListener = ({ data }: { data: Blob }) => {
    comboChunksRef.current.push(data);
  };

  // once the conversation is connected, stream the microphone audio into the socket
  React.useEffect(() => {
    if (!recorder || !socket) return;
    if (status === "connected") {
      if (active) {
        recorder.addEventListener("dataavailable", recordingDataListener);
        agentAndUserRecorder.addEventListener(
          "dataavailable",
          comboRecordingDataListener
        );
      } else {
        recorder.removeEventListener("dataavailable", recordingDataListener);
        agentAndUserRecorder.removeEventListener(
          "dataavailable",
          comboRecordingDataListener
        );
      }
    }
  }, [recorder, agentAndUserRecorder, socket, status, active]);

  // accept wav audio from webpage
  React.useEffect(() => {
    const registerWav = async () => {
      await register(await connect());
    };
    registerWav().catch(console.error);
  }, []);

  // play audio that is queued
  React.useEffect(() => {
    const playArrayBuffer = (arrayBuffer: ArrayBuffer) => {
      audioContext &&
        audioAnalyser &&
        audioContext.decodeAudioData(arrayBuffer, (buffer) => {
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(audioContext.destination);
          source.connect(audioAnalyser);
          setCurrentSpeaker("agent");
          source.start(0);
          source.onended = () => {
            if (audioQueue.length <= 0) {
              setCurrentSpeaker("user");
            }
            setProcessing(false);
          };
        });
    };
    if (!processing && audioQueue.length > 0) {
      setProcessing(true);
      const audio = audioQueue.shift();
      const __addServerAudioToComboRecording = async () => {
        const audioBuffer = await __convertBase64ToAudioBuffer(
          audio,
          audioContext
        );
        __playAudioBuffer(
          audioBuffer,
          audioContext,
          combinedStreamDestRef.current
        );
      };
      __addServerAudioToComboRecording();

      const audioBuffer = Buffer.from(audio, "base64");
      audioBuffer &&
        fetch(URL.createObjectURL(new Blob([audioBuffer])))
          .then((response) => response.arrayBuffer())
          .then(playArrayBuffer);
    }
  }, [audioQueue, processing]);

  const stopConversation = (error?: Error) => {
    setAudioQueue([]);
    setCurrentSpeaker("none");
    setStatus("idle");

    recorder && recorder.stop();
    if (agentAndUserRecorder) {
      agentAndUserRecorder.stop();
    } else if (socket) {
      const stopMessage: StopMessage = {
        type: "websocket_stop",
      };
      socket.send(stringify(stopMessage));
      socket.close();
    }
    setAgentAndUserRecorder(undefined);
  };

  const getBackendUrl = async () => {
    if ("backendUrl" in config) {
      return config.backendUrl;
    } else if ("vocodeConfig" in config) {
      const baseUrl = config.vocodeConfig.baseUrl || VOCODE_API_URL;
      return `wss://${baseUrl}/conversation?key=${config.vocodeConfig.apiKey}`;
    } else {
      throw new Error("Invalid config");
    }
  };

  const getStartMessage = (
    config: ConversationConfig,
    inputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding },
    outputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding }
  ): StartMessage => {
    let transcriberConfig: TranscriberConfig = Object.assign(
      config.transcriberConfig,
      inputAudioMetadata
    );
    if (isSafari && transcriberConfig.type === "transcriber_deepgram") {
      (transcriberConfig as DeepgramTranscriberConfig).downsampling = 2;
    }

    return {
      type: "websocket_start",
      transcriberConfig: Object.assign(
        config.transcriberConfig,
        inputAudioMetadata
      ),
      agentConfig: config.agentConfig,
      synthesizerConfig: Object.assign(
        config.synthesizerConfig,
        outputAudioMetadata
      ),
      conversationId: config.vocodeConfig.conversationId,
    };
  };

  const getAudioConfigStartMessage = (
    inputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding },
    outputAudioMetadata: { samplingRate: number; audioEncoding: AudioEncoding },
    chunkSize: number | undefined,
    downsampling: number | undefined,
    conversationId: string | undefined,
    subscribeTranscript: boolean | undefined
  ): AudioConfigStartMessage => ({
    type: "websocket_audio_config_start",
    inputAudioConfig: {
      samplingRate: inputAudioMetadata.samplingRate,
      audioEncoding: inputAudioMetadata.audioEncoding,
      chunkSize: chunkSize || DEFAULT_CHUNK_SIZE,
      downsampling,
    },
    outputAudioConfig: {
      samplingRate: outputAudioMetadata.samplingRate,
      audioEncoding: outputAudioMetadata.audioEncoding,
    },
    conversationId,
    subscribeTranscript,
  });

  const startConversation = async () => {
    setTranscripts([]);
    setCallDetails(undefined);
    setLocalRecordingUrl(undefined);
    comboChunksRef.current = [];
    if (!audioContext || !audioAnalyser) return;
    setStatus("connecting");

    if (!isSafari && !isChrome) {
      stopConversation(new Error("Unsupported browser"));
      return;
    }

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    const backendUrl = await getBackendUrl();

    setError(undefined);
    const socket = new WebSocket(backendUrl);
    let error: Error | undefined;
    socket.onerror = (event) => {
      console.error(event);
      error = new Error("See console for error details");
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "websocket_audio") {
        setAudioQueue((prev) => [...prev, message.data]);
      } else if (message.type === "websocket_ready") {
        setCallDetails({
          callId: message.call_id,
          callerId: message.caller_id,
          orgId: message.org_id,
          orgLocationId: message.org_location_id,
          fromPhone: message.from_phone,
          toPhone: message.to_phone,
        });
        setStatus("connected");
      } else if (message.type == "websocket_transcript") {
        setTranscripts((prevMessages) => [
          ...prevMessages,
          {
            sender: message.sender,
            text: message.text,
            timestamp: message.timestamp,
          },
        ]);
      }
    };
    socket.onclose = () => {
      stopConversation(error);
    };
    setSocket(socket);

    // wait for socket to be ready
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          clearInterval(interval);
          resolve(null);
        }
      }, 100);
    });

    let audioStream;
    try {
      const trackConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (config.audioDeviceConfig.inputDeviceId) {
        trackConstraints.deviceId = config.audioDeviceConfig.inputDeviceId;
      }
      audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: trackConstraints,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        alert(
          "Allowlist this site at chrome://settings/content/microphone to talk to the bot."
        );
        error = new Error("Microphone access denied");
      }
      console.error(error);
      stopConversation(error as Error);
      return;
    }

    /**
     * Create a media recorder that combines the microphone audio and output
     * audio from the socket. This creates a single stream that can be downloaded once
     * the call is complete.
     */
    const micSource = audioContext.createMediaStreamSource(audioStream);
    micSource.connect(combinedStreamDestRef.current);

    const micSettings = audioStream.getAudioTracks()[0].getSettings();

    const inputAudioMetadata = {
      samplingRate: micSettings.sampleRate || audioContext.sampleRate,
      audioEncoding: "linear16" as AudioEncoding,
    };

    const outputAudioMetadata = {
      samplingRate:
        config.audioDeviceConfig.outputSamplingRate || audioContext.sampleRate,
      audioEncoding: "linear16" as AudioEncoding,
    };

    let startMessage;
    if (
      [
        "transcriberConfig",
        "agentConfig",
        "synthesizerConfig",
        "vocodeConfig",
      ].every((key) => key in config)
    ) {
      startMessage = getStartMessage(
        config as ConversationConfig,
        inputAudioMetadata,
        outputAudioMetadata
      );
    } else {
      const selfHostedConversationConfig =
        config as SelfHostedConversationConfig;
      startMessage = getAudioConfigStartMessage(
        inputAudioMetadata,
        outputAudioMetadata,
        selfHostedConversationConfig.chunkSize,
        selfHostedConversationConfig.downsampling,
        selfHostedConversationConfig.conversationId,
        selfHostedConversationConfig.subscribeTranscript
      );
    }

    socket.send(stringify(startMessage));

    let recorderToUse = recorder;
    if (recorderToUse && recorderToUse.state === "paused") {
      recorderToUse.resume();
    } else if (!recorderToUse) {
      recorderToUse = new MediaRecorder(audioStream, {
        mimeType: "audio/wav",
      });
      setRecorder(recorderToUse);
    }

    let combinedRecorderToUse = agentAndUserRecorder;
    if (combinedRecorderToUse && combinedRecorderToUse.state === "paused") {
      combinedRecorderToUse.resume();
    } else if (!combinedRecorderToUse) {
      combinedRecorderToUse = new MediaRecorder(
        combinedStreamDestRef.current.stream,
        {
          mimeType: "audio/wav",
        }
      );
      setAgentAndUserRecorder(combinedRecorderToUse);
      combinedRecorderToUse.onstop = async () => {
        const audioBlob = new Blob(comboChunksRef.current, {
          type: "audio/wav",
        });
        const audioUrl = URL.createObjectURL(audioBlob);
        setLocalRecordingUrl(audioUrl);
        const base64_url = await blobToBase64(audioBlob);

        const recordingFile: FinalComboAudioMessage = {
          type: "websocket_final_combo_audio",
          data: base64_url || "",
        };

        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(stringify(recordingFile));
          const stopMessage: StopMessage = {
            type: "websocket_stop",
          };
          socket.send(stringify(stopMessage));
        }

        socket.close();
      };
    }

    let timeSlice;
    if ("transcriberConfig" in startMessage) {
      timeSlice = Math.round(
        (1000 * startMessage.transcriberConfig.chunkSize) /
          startMessage.transcriberConfig.samplingRate
      );
    } else if ("timeSlice" in config) {
      timeSlice = config.timeSlice;
    } else {
      timeSlice = 10;
    }

    if (recorderToUse.state === "recording") {
      // When the recorder is in the recording state, see:
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/state
      // which is not expected to call `start()` according to:
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start.
      return;
    } else {
      recorderToUse.start(timeSlice);
    }

    if (combinedRecorderToUse.state === "recording") {
      // When the recorder is in the recording state, see:
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/state
      // which is not expected to call `start()` according to:
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/start.
      return;
    } else {
      combinedRecorderToUse.start(timeSlice);
    }
  };

  return {
    status,
    start: startConversation,
    stop: stopConversation,
    error,
    toggleActive,
    active,
    setActive,
    analyserNode: audioAnalyser,
    transcripts,
    currentSpeaker,
    callDetails,
    localRecordingUrl,
  };
};

function __convertBase64ToAudioBuffer(base64, audioContext) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return audioContext.decodeAudioData(bytes.buffer);
}

function __playAudioBuffer(audioBuffer, audioContext, destination) {
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(destination);
  source.start();
}
