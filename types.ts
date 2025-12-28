
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error'
}

export interface LiveSessionConfig {
  systemInstruction: string;
  voiceName: 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
}
