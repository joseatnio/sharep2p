import { DiscordSDK } from "https://esm.sh/@discord/embedded-app-sdk";

// === DISCORD ACTIVITY SETUP ===
const DISCORD_CLIENT_ID = '1534236568242360540';
let discordSdk = null;

async function initDiscord() {
    if (window.parent !== window) {
        discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);
        await discordSdk.ready();
        console.log("Discord SDK is ready!");
    }
}
initDiscord();
// ==============================

const socket = io('/');
const peerConnections = {}; // Map socket.id to RTCPeerConnection
let localStream;
let myRole = null; // 'host' or 'viewer'
let currentRoom = null;

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

        // BURLADOR DE RESTRIÇÃO DO DISCORD:
        // Se estivermos rodando dentro da Activity do Discord, mandamos o usuário pro navegador externo!
        if (discordSdk) {
            // Usa o link atual (que o Render gerou) + os parametros pra ele abrir como HOST lá fora
            const externalUrl = window.location.origin + '/?room=' + currentRoom + '&role=host';
            await discordSdk.commands.openExternalLink({ url: externalUrl });
            
            // Atualiza a tela do Host dentro da Activity para avisar o que houve
            lobby.innerHTML = `
                <div class="card" style="text-align: center;">
                    <h2>Transmissão Enviada pro Navegador! 🚀</h2>
                    <p style="color: var(--text-secondary); margin-bottom: 20px;">Você foi redirecionado para o Chrome/Edge para conseguir compartilhar a tela sem bloqueios.</p>
                    <p>Diga para os seus amigos que estão no Discord digitarem o código abaixo para assistirem:</p>
                    <div class="room-id" style="font-size: 2.5rem; letter-spacing: 5px; margin: 20px 0; user-select: all;">${currentRoom}</div>
                </div>
            `;
            return; // Interrompe aqui, a transmissão vai ocorrer lá no navegador
        }

        // Se NÃO estiver no Discord (ou seja, ele já está no navegador externo da Opção 1 ou do Pop-out), prossegue normal:
        
        // Request Screen Share
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always",
                displaySurface: "browser" // Pede pro navegador focar em compartilhar Guias
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                sampleRate: 44100
            },
            systemAudio: "exclude" // Diz ao navegador para evitar áudio do sistema (para não pegar o Discord)
        });

        // UI Updates
        myRole = 'host';

        // Show video locally for host
        screenVideo.srcObject = localStream;
        screenVideo.muted = true; // Mute locally to prevent echo/feedback
        videoPlaceholder.classList.add('hidden');

        lobby.classList.add('hidden');
        streamingArea.classList.remove('hidden');
        activeRoomInfo.classList.remove('hidden');
        document.getElementById('btn-change-screen').classList.remove('hidden');
        displayRoomId.textContent = currentRoom;

        updateStatus('connected', 'Broadcasting (Waiting for viewers...)');

        // Join Room
        socket.emit('join-room', currentRoom, myRole);

        // If host stops sharing from browser UI
        localStream.getVideoTracks()[0].onended = () => {
            leaveRoom();
        };

    } catch (err) {
        console.error("Error sharing screen: ", err);
        alert("Failed to capture screen.");
    }
});

// Host receives notification that a viewer joined
socket.on('viewer-joined', async (viewerId) => {
    if (myRole !== 'host') return;

    updateStatus('connected', 'Viewer connected!');

    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnections[viewerId] = peerConnection;

    // Add local stream tracks to connection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Send ICE candidates
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', currentRoom, event.candidate, viewerId);
        }
    };

    // Create Offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('offer', currentRoom, offer, viewerId);
});

// Host receives answer from viewer
socket.on('answer', async (answer, viewerId) => {
    if (myRole !== 'host') return;
    const peerConnection = peerConnections[viewerId];
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
});


// ---- VIEWER LOGIC ----
document.getElementById('btn-join-room').addEventListener('click', () => {
    const roomId = document.getElementById('input-room-id').value.trim().toUpperCase();
    if (!roomId) return alert('Enter a Room ID');

    currentRoom = roomId;
    myRole = 'viewer';

    lobby.classList.add('hidden');
    streamingArea.classList.remove('hidden');
    updateStatus('warning', 'Connecting to host...');

    socket.emit('join-room', currentRoom, myRole);
});

// Viewer receives offer from host
socket.on('offer', async (offer, hostId) => {
    if (myRole !== 'viewer') return;

    updateStatus('warning', 'Negotiating connection...');
    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnections[hostId] = peerConnection;

    // Receive ICE candidates
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', currentRoom, event.candidate, hostId);
        }
    };

    // Receive Video Stream
    peerConnection.ontrack = event => {
        screenVideo.srcObject = event.streams[0];
        videoPlaceholder.classList.add('hidden');
        updateStatus('connected', 'Receiving Stream');
    };

    // Set Remote & Create Answer
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', currentRoom, answer, hostId);
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

            // Video
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (videoSender && newStream.getVideoTracks().length > 0) {
                videoSender.replaceTrack(newStream.getVideoTracks()[0]);
            }

            // Audio
            const audioSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (audioSender && newStream.getAudioTracks().length > 0) {
                audioSender.replaceTrack(newStream.getAudioTracks()[0]);
            }
        }

        // Stop the old capture
        localStream.getTracks().forEach(track => track.stop());
        localStream = newStream;
        localStream.getVideoTracks()[0].onended = () => leaveRoom();

    } catch (err) {
        console.error("Cancelled screen change", err);
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
