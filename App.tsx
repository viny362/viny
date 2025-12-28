
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Message, ConnectionStatus } from './types';
import { DEFAULT_CONFIG, AVATAR_URL } from './constants';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audio Contexts
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Live Session refs
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);

  // Transcriptions state
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  const cleanup = useCallback(() => {
    if (scriptProcessorRef.current) scriptProcessorRef.current.disconnect();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (sessionRef.current) sessionRef.current.close();
    
    audioSourcesRef.current.forEach(s => s.stop());
    audioSourcesRef.current.clear();
    
    inputAudioCtxRef.current?.close();
    outputAudioCtxRef.current?.close();
    
    sessionRef.current = null;
    inputAudioCtxRef.current = null;
    outputAudioCtxRef.current = null;
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsAiSpeaking(false);
  }, []);

  const startConversation = async () => {
    try {
      cleanup();
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_CONFIG.voiceName } },
          },
          systemInstruction: DEFAULT_CONFIG.systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioCtxRef.current!.createMediaStreamSource(streamRef.current!);
            scriptProcessorRef.current = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessorRef.current.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Output
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioCtxRef.current) {
              setIsAiSpeaking(true);
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              
              source.onended = () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) setIsAiSpeaking(false);
              };

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
            }

            // Interruptions
            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => s.stop());
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAiSpeaking(false);
            }

            // Transcriptions
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscription.current;
              const aiText = currentOutputTranscription.current;
              
              if (userText || aiText) {
                setMessages(prev => [
                  ...prev,
                  ...(userText ? [{ id: Date.now() + '-u', role: 'user' as const, text: userText, timestamp: Date.now() }] : []),
                  ...(aiText ? [{ id: Date.now() + '-a', role: 'assistant' as const, text: aiText, timestamp: Date.now() }] : [])
                ].slice(-20));
              }

              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }
          },
          onerror: (e) => {
            console.error('Gemini Error:', e);
            setError('Connection error. Please try again.');
            cleanup();
          },
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
            cleanup();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to start session');
      setStatus(ConnectionStatus.ERROR);
    }
  };

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return (
    <div className="min-h-screen bg-slate-900 text-white flex flex-col md:flex-row overflow-hidden">
      {/* Sidebar - Conversation History */}
      <div className="w-full md:w-80 bg-slate-800/50 border-b md:border-b-0 md:border-r border-slate-700 p-4 flex flex-col">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center font-bold text-xl">A</div>
          <div>
            <h1 className="font-bold text-lg leading-tight">Practice with Alex</h1>
            <p className="text-xs text-slate-400">American English Buddy</p>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto space-y-4 pr-2 scrollbar-thin scrollbar-thumb-slate-700">
          {messages.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <p className="text-sm">No messages yet.</p>
              <p className="text-xs mt-1">Start talking to see transcriptions here!</p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <span className="text-[10px] text-slate-500 mb-1 uppercase tracking-wider font-semibold">
                  {m.role === 'user' ? 'You' : 'Alex'}
                </span>
                <div className={`px-3 py-2 rounded-2xl text-sm max-w-[90%] ${
                  m.role === 'user' 
                    ? 'bg-indigo-600 rounded-tr-none' 
                    : 'bg-slate-700 rounded-tl-none'
                }`}>
                  {m.text}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Interaction Area */}
      <div className="flex-1 flex flex-col relative items-center justify-center p-6">
        {/* Status indicator */}
        <div className="absolute top-6 right-6 flex items-center gap-2">
           <div className={`w-2 h-2 rounded-full ${
             status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 
             status === ConnectionStatus.CONNECTING ? 'bg-yellow-500' : 'bg-red-500'
           }`} />
           <span className="text-xs font-medium text-slate-400 uppercase tracking-widest">
             {status}
           </span>
        </div>

        {/* Character Avatar */}
        <div className="relative group">
          <div className={`absolute -inset-4 rounded-full blur-2xl transition-all duration-700 opacity-50 ${
            isAiSpeaking ? 'bg-indigo-500 scale-110' : 'bg-transparent'
          }`} />
          
          <div className={`relative w-48 h-48 md:w-64 md:h-64 rounded-full border-4 overflow-hidden transition-all duration-500 transform ${
            isAiSpeaking ? 'border-indigo-500 scale-105 shadow-[0_0_50px_rgba(99,102,241,0.3)]' : 'border-slate-700 shadow-xl'
          }`}>
            <img 
              src={AVATAR_URL} 
              alt="Alex" 
              className="w-full h-full object-cover"
            />
          </div>

          {/* Voice Pulse Visualization */}
          {isAiSpeaking && (
            <div className="absolute -bottom-2 -right-2 bg-indigo-600 p-3 rounded-full shadow-lg animate-bounce">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
          )}
        </div>

        <div className="mt-12 text-center max-w-md">
          <h2 className="text-2xl font-bold mb-2">Alex is listening...</h2>
          <p className="text-slate-400 text-sm mb-8">
            {status === ConnectionStatus.CONNECTED 
              ? "Speak naturally. Alex will reply with a friendly American accent." 
              : "Ready to practice? Hit the button below to start your private lesson."}
          </p>

          <div className="flex flex-col gap-4">
            {status === ConnectionStatus.DISCONNECTED || status === ConnectionStatus.ERROR ? (
              <button
                onClick={startConversation}
                className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 rounded-full font-bold text-lg shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-2 group"
              >
                Start Chatting
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 group-hover:translate-x-1 transition-transform" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            ) : (
              <button
                onClick={cleanup}
                className="px-8 py-4 bg-rose-600 hover:bg-rose-500 rounded-full font-bold text-lg shadow-lg shadow-rose-500/20 transition-all flex items-center justify-center gap-2"
              >
                Stop Conversation
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
                </svg>
              </button>
            )}

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* Ambient background decoration */}
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-20 -z-10">
          <div className="absolute top-[10%] left-[5%] w-64 h-64 bg-indigo-500 rounded-full blur-[120px]" />
          <div className="absolute bottom-[10%] right-[5%] w-64 h-64 bg-slate-500 rounded-full blur-[120px]" />
        </div>
      </div>
      
      {/* Mobile Sticky CTA */}
      <div className="md:hidden fixed bottom-6 left-1/2 -translate-x-1/2 w-max z-50">
         {status === ConnectionStatus.CONNECTED && (
           <div className="bg-slate-800 px-4 py-2 rounded-full border border-slate-700 shadow-2xl text-xs flex items-center gap-2">
             <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
             Live Session Active
           </div>
         )}
      </div>
    </div>
  );
};

export default App;
