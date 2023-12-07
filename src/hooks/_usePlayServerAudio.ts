import React from "react";
import { playAudioBuffer, genBase64ToAudioBuffer } from "../utils";

import { Buffer } from "buffer";

export const _usePlayServerAudio = ({
  audioContext,
  audioAnalyser,
  setCurrentSpeaker,
  audioQueue,
  setProcessing,
  processing,
  combinedStreamDestRef,
}: {
  audioContext: AudioContext;
  audioAnalyser: AnalyserNode;
  setCurrentSpeaker: React.Dispatch<React.SetStateAction<boolean>>;
  audioQueue: Buffer[];
  setProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  processing: boolean;
  combinedStreamDestRef: React.RefObject<MediaStreamAudioDestinationNode>;
}) => {
  React.useEffect(() => {
    const playArrayBuffer = (arrayBuffer: ArrayBuffer) => {
      console.log("playArrayBuffer:", arrayBuffer);
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

      // const __addServerAudioToComboRecording = async () => {
      //   // @ts-ignore
      //   const audioBuffer = await genBase64ToAudioBuffer(audio, audioContext);
      //   playAudioBuffer(
      //     audioBuffer,
      //     audioContext,
      //     combinedStreamDestRef.current
      //   );
      // };
      // __addServerAudioToComboRecording();

      // @ts-ignore
      const audioBuffer = Buffer.from(audio, "base64");
      if (audioBuffer) {
        fetch(URL.createObjectURL(new Blob([audioBuffer])))
          .then((response) => response.arrayBuffer())
          .then(playArrayBuffer);
      }
    }
  }, [audioQueue, processing]);
};
