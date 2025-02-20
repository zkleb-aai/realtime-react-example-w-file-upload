import './App.css';
import { useRef, useState } from 'react';
import { RealtimeTranscriber } from 'assemblyai/streaming';
import * as RecordRTC from 'recordrtc';

function App() {
  const realtimeTranscriber = useRef(null);
  const recorder = useRef(null);
  const audioPlayer = useRef(null);
  const audioContext = useRef(null);
  const audioSource = useRef(null);
  const processingInterval = useRef(null);
  const currentChunkIndex = useRef(0);
  const audioChunks = useRef([]);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [inputMode, setInputMode] = useState('microphone');
  const [audioFile, setAudioFile] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const cleanupResources = async (previousMode) => {
    try {
      setIsRecording(false);
      setIsPlaying(false);
      setTranscript('');
  
      if (realtimeTranscriber.current) {
        await realtimeTranscriber.current.close();
        realtimeTranscriber.current = null;
      }
  
      if (processingInterval.current) {
        clearInterval(processingInterval.current);
        processingInterval.current = null;
      }
      audioChunks.current = [];
      currentChunkIndex.current = 0;

      if (previousMode === 'microphone') {
        if (recorder.current) {
          recorder.current.stopRecording();
          recorder.current = null;
        }
      } else if (previousMode === 'file') {
        if (audioPlayer.current) {
          audioPlayer.current.removeEventListener('play', handleAudioPlaybackChange);
          audioPlayer.current.removeEventListener('pause', handleAudioPlaybackChange);
          audioPlayer.current.pause();
          audioPlayer.current.src = '';
          audioPlayer.current.currentTime = 0;
        }
        setAudioFile(null);
      }
  
      if (audioContext.current) {
        await audioContext.current.close();
        audioContext.current = null;
      }
    } catch (error) {
      console.error('Error cleaning up resources:', error);
    }
  };

  const handleModeChange = (e) => {
    const newMode = e.target.value;
    const previousMode = inputMode;
    setTranscript('');
    setInputMode(newMode);
    cleanupResources(previousMode);
  };

  const getToken = async () => {
    const response = await fetch('http://localhost:8000/token');
    const data = await response.json();

    if (data.error) {
      alert(data.error);
    }

    return data.token;
  };

  const setupTranscriber = async () => {
    realtimeTranscriber.current = new RealtimeTranscriber({
      token: await getToken(),
      sampleRate: 16_000,
    });

    const texts = {};
    realtimeTranscriber.current.on('transcript', transcript => {
      let msg = '';
      texts[transcript.audio_start] = transcript.text;
      const keys = Object.keys(texts);
      keys.sort((a, b) => a - b);
      for (const key of keys) {
        if (texts[key]) {
          msg += ` ${texts[key]}`;
          console.log(msg);
        }
      }
      setTranscript(msg);
    });

    realtimeTranscriber.current.on('error', event => {
      console.error(event);
      realtimeTranscriber.current.close();
      realtimeTranscriber.current = null;
    });

    realtimeTranscriber.current.on('close', (code, reason) => {
      console.log(`Connection closed: ${code} ${reason}`);
      realtimeTranscriber.current = null;
    });

    await realtimeTranscriber.current.connect();
  };
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    setAudioFile(file);
    if (audioPlayer.current) {
      audioPlayer.current.src = URL.createObjectURL(file);
    }
  };

  const handleAudioPlaybackChange = async () => {
    if (audioPlayer.current.paused) {
      if (processingInterval.current) {
        clearInterval(processingInterval.current);
        processingInterval.current = null;
      }
    } else {
      const currentTime = audioPlayer.current.currentTime;
      currentChunkIndex.current = Math.floor(currentTime * 10); // Convert time to 100ms chunks
      
      processingInterval.current = setInterval(() => {
        if (currentChunkIndex.current < audioChunks.current.length) {
          if (realtimeTranscriber.current) {
            realtimeTranscriber.current.sendAudio(audioChunks.current[currentChunkIndex.current]);
          }
          currentChunkIndex.current++;
        } else {
          clearInterval(processingInterval.current);
          processingInterval.current = null;
        }
      }, 100);
    }
  };

  const processAudioFile = async () => {
    if (!audioContext.current) {
      audioContext.current = new AudioContext({ sampleRate: 16000 });
    }

    const arrayBuffer = await audioFile.arrayBuffer();
    const audioBuffer = await audioContext.current.decodeAudioData(arrayBuffer);
    
    const chunkSize = Math.floor(16000 * 0.1); // 100ms worth of samples
    const chunksCount = Math.ceil(audioBuffer.length / chunkSize);

    audioChunks.current = [];
    for (let i = 0; i < chunksCount; i++) {
      const startSample = i * chunkSize;
      const endSample = Math.min((i + 1) * chunkSize, audioBuffer.length);
      
      const channelData = audioBuffer.getChannelData(0).slice(startSample, endSample);
      
      const samples = new Int16Array(channelData.length);
      for (let j = 0; j < channelData.length; j++) {
        const s = Math.max(-1, Math.min(1, channelData[j]));
        samples[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      audioChunks.current.push(samples.buffer);
    }

    return audioBuffer.duration;
  };

  const startTranscription = async () => {
    await setupTranscriber();

    if (inputMode === 'microphone') {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          recorder.current = new RecordRTC(stream, {
            type: 'audio',
            mimeType: 'audio/webm;codecs=pcm',
            recorderType: RecordRTC.StereoAudioRecorder,
            timeSlice: 250,
            desiredSampRate: 16000,
            numberOfAudioChannels: 1,
            bufferSize: 4096,
            audioBitsPerSecond: 128000,
            ondataavailable: async (blob) => {
              if(!realtimeTranscriber.current) return;
              const buffer = await blob.arrayBuffer();
              realtimeTranscriber.current.sendAudio(buffer);
            },
          });
          recorder.current.startRecording();
        })
        .catch((err) => console.error(err));
    } else {
      await processAudioFile();
      
      audioPlayer.current.addEventListener('play', handleAudioPlaybackChange);
      audioPlayer.current.addEventListener('pause', handleAudioPlaybackChange);
      
      audioPlayer.current.play();
      setIsPlaying(true);
    }

    setIsRecording(true);
  };

  const endTranscription = async (event) => {
    event.preventDefault();
    setIsRecording(false);
    setIsPlaying(false);

    if (realtimeTranscriber.current) {
      await realtimeTranscriber.current.close();
      realtimeTranscriber.current = null;
    }

    if (inputMode === 'microphone' && recorder.current) {
      recorder.current.pauseRecording();
      recorder.current = null;
    } else {
      if (processingInterval.current) {
        clearInterval(processingInterval.current);
        processingInterval.current = null;
      }
      
      if (audioPlayer.current) {
        audioPlayer.current.removeEventListener('play', handleAudioPlaybackChange);
        audioPlayer.current.removeEventListener('pause', handleAudioPlaybackChange);
        audioPlayer.current.pause();
        audioPlayer.current.currentTime = 0;
      }
      
      audioChunks.current = [];
      currentChunkIndex.current = 0;
    }

    if (audioContext.current) {
      await audioContext.current.close();
      audioContext.current = null;
    }
  };

  return (
    <div className="App">
      <header>
        <h1 className="header__title">Real-Time Transcription</h1>
        <p className="header__sub-title">Try AssemblyAI's new real-time transcription endpoint!</p>
      </header>
      <div className="real-time-interface">
        <select 
          value={inputMode} 
          onChange={handleModeChange}
          className="real-time-interface__select"
        >
          <option value="microphone">Microphone</option>
          <option value="file">File Upload</option>
        </select>

        {inputMode === 'file' && (
          <div className="file-upload-container">
            <div className="file-requirements">
              <p className="file-requirements__text">
                Please note: For best results, use a 16kHz WAV file.
              </p>
              <p className="file-requirements__subtext">
                Other formats may not transcribe correctly. You can convert your audio using tools like Audacity or FFmpeg.
              </p>
            </div>
            <input 
              type="file" 
              accept="audio/wav"
              onChange={handleFileUpload}
              className="file-upload-input"
            />
            <audio ref={audioPlayer} controls />
          </div>
        )}

        <p id="real-time-title" className="real-time-interface__title">
          {inputMode === 'microphone' ? 'Click start to begin recording!' : 'Upload an audio file and click play!'}
        </p>
        
        {isRecording ? (
          <button className="real-time-interface__button" onClick={endTranscription}>
            {inputMode === 'microphone' ? 'Stop recording' : 'Stop playing'}
          </button>
        ) : (
          <button 
            className="real-time-interface__button" 
            onClick={startTranscription}
            disabled={inputMode === 'file' && !audioFile}
          >
            {inputMode === 'microphone' ? 'Record' : 'Play'}
          </button>
        )}
      </div>
      <div className="real-time-interface__message">
        {transcript}
      </div>
    </div>
  );
}

export default App;