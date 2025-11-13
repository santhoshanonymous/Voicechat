import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

// Establish socket connection; if running via Vite dev server on a different port use explicit signaling URL.
// You can override via Vite env var: VITE_SIGNAL_URL
// Prefer an environment override; fallback to previous Render URL. Ensure you set VITE_SIGNAL_URL in your build env (.env file for Vite)
const serverUrl = import.meta.env.VITE_SIGNAL_URL || "https://chatpoc-dlhb.onrender.com"; // removed trailing slash to avoid duplicate //
// Allow polling fallback (some hosts/proxies block direct websocket upgrade until initial polling). Add basic diagnostics.
const socket = io(serverUrl, {
  autoConnect: true,
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
  timeout: 10000,
});

socket.on('connect', () => console.log('[socket] connected', socket.id));
socket.on('disconnect', (reason) => console.warn('[socket] disconnected', reason));
socket.on('reconnect_attempt', (attempt) => console.log('[socket] reconnect attempt', attempt));
socket.on('connect_error', (err) => console.error('[socket] connect_error', err.message));
socket.on('error', (err) => console.error('[socket] generic error', err));
const config = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: [
        "turn:openrelay.metered.ca:443?transport=tcp",
        "turn:openrelay.metered.ca:443?transport=udp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};



export default function App() {
  const [displayName, setDisplayName] = useState('');
  const [room, setRoom] = useState('123');
  const [error, setError] = useState('');
  const [inMeeting, setInMeeting] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [connectionState, setConnectionState] = useState('idle');
  const [participants, setParticipants] = useState([]); // array of {id,name}
  const localStreamRef = useRef(null);
  const analyserRef = useRef(null);
  const micLevelRef = useRef(null);
  const liveMicLevelRef = useRef(null);
  const peersRef = useRef(new Map()); // peerId -> { pc, audioEl, name }

  function showError(msg) { setError(msg); }
  function clearError() { setError(''); }

  async function testMic() {
    clearError();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setMicReady(true);
      initAnalyser(stream);
    } catch (err) { showError('Mic error: ' + err.message); }
  }
  function initAnalyser(stream) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyserRef.current = analyser;
    renderMicLevel();
  }
  function renderMicLevel() {
    const analyser = analyserRef.current; if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser.getByteTimeDomainData(dataArray);
      let sum = 0; for (let i = 0; i < dataArray.length; i++) { sum += Math.abs(dataArray[i] - 128); }
      const avg = sum / dataArray.length;
      const pct = Math.min(100, (avg / 50) * 100);
      if (micLevelRef.current) micLevelRef.current.style.width = pct + '%';
      if (liveMicLevelRef.current) liveMicLevelRef.current.style.width = pct + '%';
      requestAnimationFrame(loop);
    };
    loop();
  }

  function ensurePeerConnection(peerId) {
    let entry = peersRef.current.get(peerId);
    if (entry && entry.pc) return entry.pc;
    const pc = new RTCPeerConnection(config);
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current)); }
    pc.ontrack = e => {
      const audioEl = entry?.audioEl || document.getElementById('audio-' + peerId);
      if (audioEl) {
        audioEl.srcObject = e.streams[0];
        audioEl.play().catch(err => console.warn('Audio play blocked:', err));
      }
      updateConnectionState();
    };

    pc.onconnectionstatechange = updateConnectionState;
    pc.onicecandidate = e => { if (e.candidate) { socket.emit('ice-candidate', { target: peerId, candidate: e.candidate }); } };
    peersRef.current.set(peerId, { ...(entry || {}), pc });
    return pc;
  }
  function updateConnectionState() {
    const states = [];
    for (const { pc } of peersRef.current.values()) { if (pc) states.push(pc.connectionState); }
    if (states.length === 0) { setConnectionState('idle'); return; }
    if (states.some(s => s === 'failed')) { setConnectionState('failed'); return; }
    if (states.every(s => s === 'connected')) { setConnectionState('connected'); return; }
    setConnectionState(states.join(','));
  }

  async function joinMeeting() {
    clearError();
    // Auto-init mic if user skipped test
    if (!micReady) {
      await testMic();
      if (!micReady) { showError('Mic not ready'); return; }
    }
    if (!displayName.trim() || !room.trim()) { showError('Name and room required'); return; }
    if (socket?.connected) {
      socket.emit('join-room', { roomId: room.trim(), name: displayName.trim() });
      setInMeeting(true);
    } else {
      showError('Socket not connected');
    }
  }
  function leaveMeeting() {
    socket.emit('leave-room', { roomId: room.trim() });
    for (const [id, entry] of peersRef.current.entries()) { if (entry.pc) entry.pc.close(); }
    peersRef.current.clear();
    setParticipants([]);
    setInMeeting(false);
    setConnectionState('closed');
  }

  useEffect(() => {
    socket.on('room-users', users => {
      setParticipants(prev => [...prev, ...users.filter(u => !prev.find(p => p.id === u.id))]);
      users.forEach(u => ensurePeerConnection(u.id));
      // initiate offer flow manually (simple version)
      users.forEach(async u => {
        const pc = ensurePeerConnection(u.id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: u.id, sdp: offer, from: socket.id });
      });
    });
    socket.on('user-joined', ({ id, name }) => {
      setParticipants(prev => prev.find(p => p.id === id) ? prev : [...prev, { id, name }]);
      (async () => {
        const pc = ensurePeerConnection(id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: id, sdp: offer, from: socket.id });
      })();
    });
    socket.on('user-left', ({ id }) => {
      setParticipants(prev => prev.filter(p => p.id !== id));
      const entry = peersRef.current.get(id);
      if (entry?.pc) entry.pc.close();
      peersRef.current.delete(id);
      updateConnectionState();
    });
    socket.on('offer', async ({ sdp, from }) => {
      const pc = ensurePeerConnection(from);
      if (pc.signalingState !== 'stable') { console.warn('Ignoring glare offer'); return; }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { target: from, sdp: answer, from: socket.id });
    });
    socket.on('answer', async ({ sdp, from }) => {
      const entry = peersRef.current.get(from); if (!entry) return;
      const pc = entry.pc; if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      updateConnectionState();
    });
    socket.on('ice-candidate', ({ candidate, from }) => {
      const entry = peersRef.current.get(from); if (!entry || !entry.pc) return;
      entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => showError('ICE error: ' + err.message));
    });
    return () => { socket.off(); };
  }, []);

  return (
    <div id="app" className="app">
      <header className="app-header"><h1>Voice Chat (React)</h1></header>
      {!inMeeting && (
        <section className="card">
          <h2>Join a Meeting</h2>
          <div className="field-group">
            <label>Your Name</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Alex" maxLength={40} />
          </div>
          <div className="field-group inline">
            <div className="flex1">
              <label>Meeting Code</label>
              <input value={room} onChange={e => setRoom(e.target.value)} placeholder="Room ID" />
            </div>
            <button type="button" className="secondary" onClick={() => setRoom(Math.random().toString(36).substring(2, 8).toUpperCase())}>🔁</button>
          </div>
          <div className="mic-test">
            <div className="mic-level-bar" title="Microphone level"><span ref={micLevelRef}></span></div>
            <button type="button" className="secondary" onClick={testMic}>Test Mic</button>
            <span className="status-text">{micReady ? 'Mic active' : 'Mic not started'}</span>
          </div>
          <div className="actions">
            <button className="primary" disabled={!displayName || !room} onClick={joinMeeting}>Join Meeting</button>
          </div>
          {error && <div className="error">{error}</div>}
        </section>
      )}
      {inMeeting && (
        <section className="card">
          <div className="meeting-header">
            <h2>Meeting {room}</h2>
            <div className="pill">{connectionState}</div>
          </div>
          <div className="meeting-body">
            <div className="pane self">
              <h3>You</h3>
              <div className="mic-level-bar large"><span ref={liveMicLevelRef}></span></div>
              <div className="self-status">Mic {micReady ? 'active' : 'inactive'}</div>
            </div>
            {participants.map(p => (
              <div key={p.id} className="pane">
                <h3>{p.name || 'Guest'}</h3>
                <div className="remote-status">Participant</div>
                <audio id={'audio-' + p.id} autoPlay playsInline />
                <div className="small-pill">{p.id.slice(0, 6)}</div>
              </div>
            ))}
          </div>
          <div className="controls">
            <button className="control" onClick={() => {
              const track = localStreamRef.current?.getAudioTracks()[0];
              if (track) { track.enabled = !track.enabled; }
            }}>Toggle Mic</button>
            <button className="control" onClick={() => {
              const url = location.origin + '?room=' + encodeURIComponent(room);
              navigator.clipboard.writeText(url).catch(() => showError('Copy failed'));
            }}>Copy Link</button>
            <button className="danger" onClick={leaveMeeting}>Leave</button>
          </div>
        </section>
      )}
      <footer className="app-footer">Simple WebRTC demo</footer>
    </div>
  );
}
