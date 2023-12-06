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
import { blobToBase64, stringify, getBackendUrl } from "../utils";
import { AudioEncoding } from "../types/vocode/audioEncoding";
import {
  AudioConfigStartMessage,
  StartMessage,
  StopMessage,
  FinalComboAudioMessage,
} from "../types/vocode/websocket";
import { DeepgramTranscriberConfig, TranscriberConfig } from "../types";
import { isSafari, isChrome } from "react-device-detect";
import { Buffer } from "buffer";
import { _usePlayServerAudio } from "./_usePlayServerAudio";
import { _useStreamToServerAndComboRecording } from "./_useStreamToServerAndComboRecording";

export const useConversation = (
  config: ConversationConfig | SelfHostedConversationConfig
): {
  status: ConversationStatus;
  start: () => void;
  stop: () => void;
  error: Error | undefined;
  analyserNode: AnalyserNode | undefined;
  transcripts: Transcript[];
  currentSpeaker: CurrentSpeaker;
  callDetails: CallDetails | undefined;
  localRecordingUrl: string | undefined;
} => {
  const comboChunksRef = React.useRef<Blob[]>([]);
  const combinedStreamDestRef = React.useRef<MediaStreamAudioDestinationNode>();

  const [audioContext, setAudioContext] = React.useState<AudioContext>();
  const [localRecordingUrl, setLocalRecordingUrl] = React.useState<string>();

  const [audioAnalyser, setAudioAnalyser] = React.useState<AnalyserNode>();
  const [callDetails, setCallDetails] = React.useState<CallDetails>();

  const [audioQueue, setAudioQueue] = React.useState<Buffer[]>([]);
  const [currentSpeaker, setCurrentSpeaker] =
    React.useState<CurrentSpeaker>("none");
  const [processing, setProcessing] = React.useState<boolean>(false);
  const [recorder, setRecorder] = React.useState<IMediaRecorder>();
  const [agentAndUserRecorder, setAgentAndUserRecorder] =
    React.useState<IMediaRecorder>();
  const [socket, setSocket] = React.useState<WebSocket>();
  const [status, setStatus] = React.useState<ConversationStatus>("idle");
  const [error, setError] = React.useState<Error>();
  const [transcripts, setTranscripts] = React.useState<Transcript[]>([]);

  _useStreamToServerAndComboRecording({
    socket,
    comboChunksRef,
    recorder,
    agentAndUserRecorder,
    status,
  });

  // accept wav audio from webpage
  React.useEffect(() => {
    const registerWav = async () => {
      await register(await connect());
    };
    registerWav().catch(console.error);
  }, []);

  _usePlayServerAudio({
    audioContext,
    audioAnalyser,
    setCurrentSpeaker,
    audioQueue,
    setProcessing,
    processing,
    combinedStreamDestRef,
  });

  const __genStart = async () => {
    setTranscripts([]);
    setCallDetails(undefined);
    setLocalRecordingUrl(undefined);
    comboChunksRef.current = [];

    const audioContext = new AudioContext();
    setAudioContext(audioContext);
    const audioAnalyser = audioContext.createAnalyser();
    setAudioAnalyser(audioAnalyser);

    combinedStreamDestRef.current = audioContext.createMediaStreamDestination();

    if (!audioContext || !audioAnalyser) return;
    setStatus("connecting");

    if (!isSafari && !isChrome) {
      __stop();
      throw new Error("Only Chrome and Safari are supported");
    }

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    const backendUrl = await getBackendUrl({ config });

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
    socket.onclose = () => __stop();
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
        sampleRate: 8000,
      };
      if (config.audioDeviceConfig.inputDeviceId) {
        trackConstraints.deviceId = config.audioDeviceConfig.inputDeviceId;
      }
      audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: trackConstraints,
      });
      console.log("audioStream: ", audioStream);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        alert(
          "Allowlist this site at chrome://settings/content/microphone to talk to the bot."
        );
        error = new Error("Microphone access denied");
      }
      console.error(error);
      __stop();
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
    console.log("micSettings: ", micSettings);
    console.log("audioContext: ", audioContext);

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
      startMessage = __getStartMessage(
        config as ConversationConfig,
        inputAudioMetadata,
        outputAudioMetadata
      );
    } else {
      const selfHostedConversationConfig =
        config as SelfHostedConversationConfig;
      startMessage = __getAudioConfigStartMessage(
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
  const __stop = () => {
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

  return {
    status,
    start: __genStart,
    stop: __stop,
    error,
    analyserNode: audioAnalyser,
    transcripts,
    currentSpeaker,
    callDetails,
    localRecordingUrl,
  };
};

const __getStartMessage = (
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

const __getAudioConfigStartMessage = (
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
    chunkSize: chunkSize || 2048,
    downsampling,
  },
  outputAudioConfig: {
    samplingRate: outputAudioMetadata.samplingRate,
    audioEncoding: outputAudioMetadata.audioEncoding,
  },
  conversationId,
  subscribeTranscript,
});
