import React from "react";
import { playAudioBuffer, genBase64ToAudioBuffer } from "../utils";

import { Buffer } from "buffer";

export const _usePlayServerAudio = ({
  audioContext,
  audioAnalyser,
  setCurrentSpeaker,
  audioQueue,
  setAudioQueue,
  setProcessing,
  processing,
  combinedStreamDestRef,
}: {
  audioContext: AudioContext;
  audioAnalyser: AnalyserNode;
  setCurrentSpeaker: React.Dispatch<React.SetStateAction<boolean>>;
  audioQueue: Buffer[];
  setProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setAudioQueue: React.Dispatch<React.SetStateAction<Buffer[]>>;
  processing: boolean;
  combinedStreamDestRef: React.RefObject<MediaStreamAudioDestinationNode>;
}) => {
  console.log("audioQueue:", audioQueue.length);
  const [buffers, setBuffers] = React.useState<ArrayBuffer>([]);

  React.useEffect(() => {
    async function bulkProcessAudioQueue() {
      const newBuffers = await Promise.all(
        // @ts-ignore
        audioQueue.map((audio) => genBase64ToAudioBuffer(audio, audioContext))
      );
      setBuffers((x) => [...x, ...newBuffers]);
      const processedChunks = audioQueue.length;
      setAudioQueue((x) => x.slice(processedChunks));
    }
    bulkProcessAudioQueue();
  }, [audioQueue]);

  React.useEffect(() => {
    const playArrayBuffer = (arrayBuffer: ArrayBuffer) => {
      if (audioContext && audioAnalyser) {
        console.log("playArrayBuffer:", arrayBuffer);
        audioContext
          .decodeAudioData(arrayBuffer, (buffer) => {
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
          })
          .catch((error) => {
            console.error("Error decoding audio data", error);
            setProcessing(false);
            // Handle the error appropriately
          });
      }
    };
    if (!processing && buffers.length > 0) {
      setProcessing(true);
      // TODO: maybe even combine many of these chunks together
      const audioBuffer = buffers.shift();

      const __addServerAudioToComboRecording = async () => {
        // @ts-ignore
        // const audioBuffer = await genBase64ToAudioBuffer(audio, audioContext);
        playAudioBuffer(
          audioBuffer,
          audioContext,
          combinedStreamDestRef.current
        );
      };
      __addServerAudioToComboRecording();

      // @ts-ignore
      // const audioBuffer = Buffer.from(audio, "base64");
      playArrayBuffer(audioBuffer);

      // if (audioBuffer) {
      //   fetch(URL.createObjectURL(new Blob([audioBuffer])))
      //     .then((response) => response.arrayBuffer())
      //     .then(playArrayBuffer);
      // }
    }
  }, [buffers, processing]);
};
