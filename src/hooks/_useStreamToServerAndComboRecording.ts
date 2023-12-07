import React from "react";
import { blobToBase64, stringify } from "../utils";

import { AudioMessage } from "../types/vocode/websocket";
import { _usePlayServerAudio } from "./_usePlayServerAudio";
import { ConversationStatus } from "../types/conversation";
import { IMediaRecorder } from "extendable-media-recorder";

export const _useStreamToServerAndComboRecording = ({
  socket,
  comboChunksRef,

  recorder,
  agentAndUserRecorder,
  status,
}: {
  socket: WebSocket;
  comboChunksRef: React.RefObject<Blob[]>;

  recorder: IMediaRecorder;
  agentAndUserRecorder: IMediaRecorder;
  status: ConversationStatus;
}) => {
  React.useEffect(() => {
    if (!socket) {
      return;
    }
    const __comboRecordingDataListener = ({ data }: { data: Blob }) =>
      comboChunksRef.current.push(data);

    const __recordingDataListener = ({ data }: { data: Blob }) => {
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

    if (status === "connected") {
      recorder?.addEventListener("dataavailable", __recordingDataListener);
      agentAndUserRecorder?.addEventListener(
        "dataavailable",
        __comboRecordingDataListener
      );
    }
    return () => {
      recorder?.removeEventListener("dataavailable", __recordingDataListener);
      agentAndUserRecorder?.removeEventListener(
        "dataavailable",
        __comboRecordingDataListener
      );
    };
  }, [recorder, agentAndUserRecorder, socket, status]);
};
