const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

// Security headers required by Discord Embedded App SDK
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors https://discord.com https://*.discord.com");
    next();
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join-room', (roomId, role, username) => {
        socket.join(roomId);
        console.log(`Socket ${socket.id} (${username}) joined room ${roomId} as ${role}`);

        // Notify everyone else in the room that a new user arrived
        socket.to(roomId).emit('user-joined', socket.id, role, username);

        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id);
            socket.to(roomId).emit('user-disconnected', socket.id);
        });
    });

    // WebRTC Signaling Events
    socket.on('offer', (roomId, offer, targetId, senderRole) => {
        // Send the offer to the specific viewer
        socket.to(targetId).emit('offer', offer, socket.id, senderRole);
    });

    socket.on('answer', (roomId, answer, targetId) => {
        // Send the answer back to the host
        socket.to(targetId).emit('answer', answer, socket.id);
    });

    socket.on('ice-candidate', (roomId, candidate, targetId) => {
        if (targetId) {
             socket.to(targetId).emit('ice-candidate', candidate, socket.id);
        } else {
             socket.to(roomId).emit('ice-candidate', candidate, socket.id);
        }
    });

    // Profile Synchronization
    socket.on('sync-profile', (targetId, username) => {
        socket.to(targetId).emit('sync-profile', socket.id, username);
    });

    // Voice Activity Detection
    socket.on('speaking-start', (roomId) => {
        socket.to(roomId).emit('speaking-start', socket.id);
    });

    socket.on('speaking-stop', (roomId) => {
        socket.to(roomId).emit('speaking-stop', socket.id);
    });
});

http.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

require('./bot.js');
