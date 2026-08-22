const socket = io('/', { transports: ['websocket'] });
const peerConnections = {}; // Map socket.id to RTCPeerConnection
let localStream;
let micStream = null;
let myRole = null; // 'host' or 'viewer'
let currentRoom = null;
let viewerCount = 0;

// STUN/TURN servers to resolve public IPs and relay traffic across strict NATs
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// DOM Elements
const lobby = document.getElementById('lobby');
const streamingArea = document.getElementById('streaming-area');
const screenVideo = document.getElementById('screen-video');
const videoPlaceholder = document.getElementById('video-placeholder');
const statusDot = document.querySelector('.dot');
const statusText = document.getElementById('connection-status');
const displayRoomId = document.getElementById('header-room-id');
const activeRoomInfo = document.getElementById('active-room-info');

// Generate a random room ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Update Status UI
function updateStatus(status, text) {
    statusDot.className = `dot ${status}`;
    statusText.textContent = text;
}

// ---- HOST LOGIC ----
document.getElementById('btn-create-room').addEventListener('click', async () => {
    try {
        if (!currentRoom) {
            currentRoom = generateRoomId();
        }

        // Tenta iniciar o compartilhamento de tela
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always",
                displaySurface: "browser"
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                sampleRate: 44100
            },
            systemAudio: "exclude"
        });

        // Tenta capturar o microfone também (opcional, se falhar continua só com tela)
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            document.getElementById('btn-toggle-mic').classList.remove('hidden');
        } catch (e) {
            console.warn("Microfone não autorizado ou não encontrado.", e);
        }

        // Combina tela e microfone no localStream
        localStream = new MediaStream();
        screenStream.getTracks().forEach(track => localStream.addTrack(track));
        if (micStream) {
            micStream.getTracks().forEach(track => localStream.addTrack(track));
        }

        // Se conseguiu capturar a tela (ou seja, não foi bloqueado):
        myRole = 'host';
        screenVideo.srcObject = localStream;
        screenVideo.muted = true; 
        videoPlaceholder.classList.add('hidden');
        lobby.classList.add('hidden');
        streamingArea.classList.remove('hidden');
        activeRoomInfo.classList.remove('hidden');
        document.getElementById('btn-change-screen').classList.remove('hidden');
        displayRoomId.textContent = currentRoom;

        updateStatus('connected', 'Broadcasting (0 viewers)');
        socket.emit('join-room', currentRoom, myRole);

        localStream.getVideoTracks()[0].onended = () => {
            leaveRoom();
        };

    } catch (err) {
        console.warn("Screen capture cancelled or failed.", err);
        alert("Falha ao capturar a tela ou ação cancelada.");
    }
});

// ---- VIEWER LOGIC ----
document.getElementById('btn-join-room').addEventListener('click', async () => {
    const roomId = document.getElementById('input-room-id').value.trim().toUpperCase();
    if (!roomId) return alert('Enter a Room ID');

    currentRoom = roomId;
    myRole = 'viewer';

    lobby.classList.add('hidden');
    streamingArea.classList.remove('hidden');
    updateStatus('warning', 'Connecting to room...');

    // Tenta capturar o microfone para voz
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream = new MediaStream();
        micStream.getTracks().forEach(track => localStream.addTrack(track));
        document.getElementById('btn-toggle-mic').classList.remove('hidden');
    } catch (e) {
        console.warn("Microfone não autorizado ou não encontrado. Entrando apenas para assistir.", e);
    }

    socket.emit('join-room', currentRoom, myRole);
});

// ---- MESH SIGNALING LOGIC ----

function setupRemoteTracks(peerConnection, remoteRole, remoteId) {
    peerConnection.ontrack = event => {
        const track = event.track;
        if (track.kind === 'video' && remoteRole === 'host') {
            screenVideo.srcObject = event.streams[0];
            videoPlaceholder.classList.add('hidden');
            if (myRole === 'viewer') {
                updateStatus('connected', 'Receiving Stream');
            }
        } else if (track.kind === 'audio') {
            // Play remote audio
            let audioEl = document.getElementById(`audio-${remoteId}`);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = `audio-${remoteId}`;
                audioEl.autoplay = true;
                document.body.appendChild(audioEl);
            }
            if (!audioEl.srcObject) {
                audioEl.srcObject = new MediaStream();
            }
            audioEl.srcObject.addTrack(track);
        }
    };
}

// Quando qualquer pessoa entra na sala, quem já está lá manda uma Oferta
socket.on('user-joined', async (userId, userRole) => {
    // Se eu sou host e entrou um viewer, atualiza contador
    if (myRole === 'host' && userRole === 'viewer') {
        viewerCount++;
        updateStatus('connected', `Broadcasting (${viewerCount} viewer${viewerCount !== 1 ? 's' : ''})`);
    }

    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnections[userId] = peerConnection;

    setupRemoteTracks(peerConnection, userRole, userId);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', currentRoom, event.candidate, userId);
        }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', currentRoom, offer, userId, myRole);
});

// Quando eu acabei de entrar na sala, recebo Ofertas de quem já estava lá
socket.on('offer', async (offer, senderId, senderRole) => {
    if (myRole === 'viewer') {
        updateStatus('warning', 'Negotiating connection...');
    }

    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnections[senderId] = peerConnection;

    setupRemoteTracks(peerConnection, senderRole, senderId);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', currentRoom, event.candidate, senderId);
        }
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', currentRoom, answer, senderId);
});

// Receber a Resposta da oferta que eu mandei
socket.on('answer', async (answer, senderId) => {
    const peerConnection = peerConnections[senderId];
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
});

// ---- COMMON LOGIC ----

// Handle incoming ICE candidates
socket.on('ice-candidate', async (candidate, senderId) => {
    const peerConnection = peerConnections[senderId];
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    }
});

// Handle User Disconnection
socket.on('user-disconnected', (userId) => {
    if (peerConnections[userId]) {
        peerConnections[userId].close();
        delete peerConnections[userId];
        
        if (myRole === 'host') {
            viewerCount = Math.max(0, viewerCount - 1);
            updateStatus('connected', `Broadcasting (${viewerCount} viewer${viewerCount !== 1 ? 's' : ''})`);
        }
    }

    if (myRole === 'viewer') {
        updateStatus('disconnected', 'Host disconnected');
        screenVideo.srcObject = null;
        videoPlaceholder.classList.remove('hidden');
    }
});

function leaveRoom() {
    window.location.reload();
}

document.getElementById('btn-leave').addEventListener('click', leaveRoom);
document.getElementById('btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoom);
    document.getElementById('btn-copy').textContent = 'Copied!';
    setTimeout(() => {
        document.getElementById('btn-copy').textContent = 'Copy';
    }, 2000);
});

document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (screenVideo.requestFullscreen) {
        screenVideo.requestFullscreen();
    } else if (screenVideo.webkitRequestFullscreen) { /* Safari */
        screenVideo.webkitRequestFullscreen();
    } else if (screenVideo.msRequestFullscreen) { /* IE11 */
        screenVideo.msRequestFullscreen();
    }
});

document.getElementById('btn-change-screen').addEventListener('click', async () => {
    if (myRole !== 'host') return;

    try {
        const newStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always", displaySurface: "browser" },
            audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 44100 },
            systemAudio: "exclude"
        });

        screenVideo.srcObject = newStream;

        // Swap out tracks for all viewers silently
        for (const peerId in peerConnections) {
            const pc = peerConnections[peerId];

            // Replace Video
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender && newStream.getVideoTracks().length > 0) {
                videoSender.replaceTrack(newStream.getVideoTracks()[0]);
            }

            // Para áudio, é complexo porque temos mic e system audio.
            // Para não quebrar o mic, apenas paramos os tracks antigos da tela e dependemos da re-negociação no futuro se necessário.
            // Por enquanto, atualiza apenas o vídeo para simplificar.
        }

        // Stop the old screen capture tracks (those not in micStream)
        localStream.getTracks().forEach(track => {
            if (!micStream || !micStream.getTracks().includes(track)) {
                track.stop();
            }
        });

        // Create new combined stream
        localStream = new MediaStream();
        newStream.getTracks().forEach(track => localStream.addTrack(track));
        if (micStream) {
            micStream.getTracks().forEach(track => localStream.addTrack(track));
        }

        localStream.getVideoTracks()[0].onended = () => leaveRoom();

    } catch (err) {
        console.error("Cancelled screen change", err);
    }
});

// --- MUTE LOGIC ---
let isMuted = false;
document.getElementById('btn-toggle-mic').addEventListener('click', () => {
    if (!micStream) return;
    
    isMuted = !isMuted;
    micStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
    });

    const btn = document.getElementById('btn-toggle-mic');
    if (isMuted) {
        btn.textContent = 'Desmutar';
        btn.classList.replace('primary', 'danger');
    } else {
        btn.textContent = 'Mutar';
        btn.classList.replace('danger', 'primary');
    }
});

// --- AUTO-JOIN LOGIC VIA URL PARAMS ---
window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    const roleParam = urlParams.get('role');

    if (roomParam && roleParam) {
        if (roleParam === 'host') {
            currentRoom = roomParam;
            // O host ainda precisa clicar em "Start Sharing" por segurança do navegador
        } else if (roleParam === 'viewer') {
            document.getElementById('input-room-id').value = roomParam;
            document.getElementById('btn-join-room').click(); // Auto-join automático para viewer
        }
    }
});
