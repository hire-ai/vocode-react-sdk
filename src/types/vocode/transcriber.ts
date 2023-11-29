import { AudioEncoding } from "./audioEncoding";

export type TranscriberType =
  | "transcriber_deepgram"
  | "transcriber_google"
  | "transcriber_assembly_ai";

export type EndpointingType =
  | "endpointing_time_based"
  | "endpointing_punctuation_based";

export interface EndpointingConfig {
  type: EndpointingType;
}

export interface TimeEndpointingConfig extends EndpointingConfig {
  type: "endpointing_time_based";
  timeCutoffSeconds?: number;
}

export interface PunctuationEndpointingConfig extends EndpointingConfig {
  type: "endpointing_punctuation_based";
  timeCutoffSeconds?: number;
}

export interface CallDetails {
  call_Id: string;
  caller_Id: string;
  org_id: string;
  org_location_id: string;
  from_phone: string;
  to_phone: string;
}

export interface TranscriberConfig {
  type: string;
  samplingRate: number;
  audioEncoding: AudioEncoding;
  chunkSize: number;
  endpointingConfig?: EndpointingConfig;
}

export interface DeepgramTranscriberConfig extends TranscriberConfig {
  type: "transcriber_deepgram";
  model?: string;
  tier?: string;
  shouldWarmupModel?: boolean;
  version?: string;
  downsampling?: number;
}

export interface GoogleTranscriberConfig extends TranscriberConfig {
  type: "transcriber_google";
  model?: string;
  shouldWarmupModel?: boolean;
  languageCode?: string;
}

export interface AssemblyAITranscriberConfig extends TranscriberConfig {
  type: "transcriber_assembly_ai";
  shouldWarmupModel?: boolean;
}
