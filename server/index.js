import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import OpenAI from "openai"; // ✅ NEW: OpenAI integration

dotenv.config();

// -------------------- APP CONFIG ---------------------
const app = express();
app.use(cors());
app.use(express.json());
// -------------------- SERVER SETUP --------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// -------------------- IN-MEMORY STORAGE --------------------
const userSocketMap = {}; // socketId -> { username, roomId }
const roomsFiles = {};    // roomId -> [{ name: "main.py", content: "" }]

// =====================================================
// 🧠 OPENAI API SETUP
// =====================================================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // store key in .env
});

// =====================================================
// 🤖 AI CHAT ENDPOINT
// =====================================================
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || message.trim() === "") {
      return res.status(400).json({ reply: "Please enter a message." });
    }

    // Call GPT model
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an AI coding assistant that helps users debug, explain, and write code. Keep replies short, clear, and relevant.",
        },
        { role: "user", content: message },
      ],
      temperature: 0.7,
    });

    const aiReply = completion.choices[0].message.content.trim();
    res.json({ reply: aiReply });
  } catch (error) {
    console.error("AI Chat Error:", error);
    res.status(500).json({
      reply: "⚠️ AI Assistant is currently unavailable. Please try again later.",
    });
  }
});

// =====================================================
//                    SOCKET.IO LOGIC
// =====================================================
io.on("connection", (socket) => {
  console.log("✅ New client connected:", socket.id);

  // -------------------- JOIN ROOM --------------------
  socket.on("join", ({ roomId, username }) => {
    userSocketMap[socket.id] = { username, roomId };
    socket.join(roomId);

    if (!roomsFiles[roomId]) {
      roomsFiles[roomId] = [{ name: "main.py", content: "" }];
    }

    socket.emit("initialize-files", roomsFiles[roomId]);

    const clients = [...(io.sockets.adapter.rooms.get(roomId) || [])].map((id) => ({
      socketId: id,
      username: userSocketMap[id]?.username || "Anonymous",
    }));

    io.to(roomId).emit("joined", { clients });
    console.log(`📢 ${username} joined room: ${roomId}`);
  });

  // -------------------- CODE CHANGE --------------------
  socket.on("code-change", ({ roomId, code, fileIndex }) => {
    if (roomsFiles[roomId] && roomsFiles[roomId][fileIndex]) {
      roomsFiles[roomId][fileIndex].content = code;
    }
    socket.to(roomId).emit("code-change", { code, fileIndex });
  });

  // -------------------- CURSOR CHANGE --------------------
  socket.on("cursor-change", ({ roomId, username, cursor }) => {
    socket.to(roomId).emit("cursor-change", { username, cursor });
  });

  // -------------------- CHAT MESSAGE --------------------
  socket.on("chat-message", ({ roomId, username, message, timestamp }) => {
    io.to(roomId).emit("chat-message", { username, message, timestamp });
  });

  // -------------------- ADD NEW FILE --------------------
  socket.on("add-file", ({ roomId, file }) => {
    if (!roomsFiles[roomId]) roomsFiles[roomId] = [];
    roomsFiles[roomId].push(file);
    const fileIndex = roomsFiles[roomId].length - 1;
    io.to(roomId).emit("file-added", { file, fileIndex });
    console.log(`🆕 File added in room ${roomId}: ${file.name}`);
  });

  // -------------------- RENAME FILE --------------------
  socket.on("rename-file", ({ roomId, fileIndex, newName }) => {
    if (roomsFiles[roomId] && roomsFiles[roomId][fileIndex]) {
      roomsFiles[roomId][fileIndex].name = newName;
      io.to(roomId).emit("file-renamed", { fileIndex, newName });
      console.log(`File renamed in room ${roomId}: ${newName}`);
    }
  });

  // -------------------- DELETE FILE --------------------
  socket.on("delete-file", ({ roomId, fileIndex }) => {
    if (roomsFiles[roomId]) {
      const deletedFile = roomsFiles[roomId][fileIndex];
      roomsFiles[roomId].splice(fileIndex, 1);
      io.to(roomId).emit("file-deleted", { fileIndex });
      console.log(`File deleted in room ${roomId}: ${deletedFile?.name}`);
    }
  });

  // -------------------- DISCONNECT --------------------
  socket.on("disconnect", () => {
    const { roomId } = userSocketMap[socket.id] || {};
    delete userSocketMap[socket.id];

    if (roomId) {
      const clients = [...(io.sockets.adapter.rooms.get(roomId) || [])].map((id) => ({
        socketId: id,
        username: userSocketMap[id]?.username || "Anonymous",
      }));

      io.to(roomId).emit("disconnected", { socketId: socket.id, clients });
      console.log(`❌ ${socket.id} disconnected from room ${roomId}`);
    }
  });
});

// =====================================================
//                 CODE EXECUTION (JDoodle)
// =====================================================
app.post("/run", async (req, res) => {
  const { language, code } = req.body;

  const versionMap = {
    python: "4", java: "4", cpp: "5", c: "5", javascript: "4",
    php: "4", ruby: "3", go: "3", csharp: "3", swift: "4", kotlin: "4",
  };

  const langMap = {
    python: "python3", java: "java", cpp: "cpp17", c: "c", javascript: "nodejs",
    php: "php", ruby: "ruby", go: "go", csharp: "csharp", swift: "swift", kotlin: "kotlin",
  };

  const jdoodleLang = langMap[language] || "python3";
  const versionIndex = versionMap[language] || "4";

  try {
    const response = await fetch("https://api.jdoodle.com/v1/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: process.env.jDoodle_clientId,
        clientSecret: process.env.jDoodle_clientSecret,
        script: code,
        language: jdoodleLang,
        versionIndex,
      }),
    });

    const data = await response.json();
    res.json({ output: data.output || data.error || "No output" });
  } catch (err) {
    console.error("❌ JDoodle error:", err);
    res.json({ output: "Error running code" });
  }
});

// =====================================================
//                     START SERVER
// =====================================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
import path from "path";

const __dirname = new URL('.', import.meta.url).pathname;

app.use(express.static(path.join(__dirname, "../client/build")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/build/index.html"));
});
