const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 10000;
const COLORS = ["red", "blue", "green", "yellow"];
const rooms = new Map();

app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({ ok: true, game: "Card Clash" });
});

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function makeDeck() {
  const deck = [];

  for (const color of COLORS) {
    deck.push({ color, value: "0" });

    for (let n = 1; n <= 9; n++) {
      deck.push(
        { color, value: String(n) },
        { color, value: String(n) }
      );
    }

    for (const value of ["Skip", "Reverse", "Draw 2"]) {
      deck.push(
        { color, value },
        { color, value }
      );
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push(
      { color: "wild", value: "Wild" },
      { color: "wild", value: "Wild +4" }
    );
  }

  return shuffle(deck);
}

function draw(room) {
  if (room.deck.length === 0) {
    if (room.discard.length > 1) {
      const top = room.discard.pop();
      room.deck = shuffle(room.discard);
      room.discard = [top];
    } else {
      room.deck = makeDeck();
    }
  }

  return room.deck.pop();
}

function otherPlayer(room, id) {
  return room.players.find(player => player !== id);
}

function getRoom(id) {
  for (const room of rooms.values()) {
    if (room.players.includes(id)) return room;
  }
  return null;
}

function sendState(room) {
  for (const id of room.players) {
    const opponent = otherPlayer(room, id);

    io.to(id).emit("gameState", {
      code: room.code,
      status: room.status,
      hand: room.hands[id] || [],
      opponentCount:
        opponent && room.hands[opponent]
          ? room.hands[opponent].length
          : 0,
      topCard: room.topCard || null,
      currentColor: room.currentColor || "red",
      isMyTurn: room.turn === id,
      message: room.message,
      winner: room.winner || null
    });
  }
}

function startGame(room) {
  room.deck = makeDeck();
  room.discard = [];
  room.hands = {};

  for (const id of room.players) {
    room.hands[id] = [];
  }

  for (let i = 0; i < 7; i++) {
    for (const id of room.players) {
      room.hands[id].push(draw(room));
    }
  }

  room.topCard = draw(room);

  while (room.topCard.color === "wild") {
    room.deck.push(room.topCard);
    room.topCard = draw(room);
  }

  room.currentColor = room.topCard.color;
  room.turn = room.players[0];
  room.status = "playing";
  room.message = "Game started!";
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("createRoom", () => {
    let code;

    do {
      code = Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase();
    } while (rooms.has(code));

    const room = {
      code,
      players: [socket.id],
      status: "waiting",
      message: "Waiting for another player"
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit("roomCreated", { code });
    socket.emit("roomMessage", room.message);

    console.log("Room created:", code);
  });

  socket.on("joinRoom", ({ code } = {}) => {
    code = String(code || "").trim().toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      socket.emit("roomError", {
        message: "Room code not found"
      });
      return;
    }

    if (room.players.length >= 2 || room.status !== "waiting") {
      socket.emit("roomError", {
        message: "Room is full or game already started"
      });
      return;
    }

    room.players.push(socket.id);
    socket.join(code);

    startGame(room);
    room.message = "Both players connected. Game started!";

    console.log("Player joined:", code);
    sendState(room);
  });

  socket.on("playCard", ({ index, color } = {}) => {
    const room = getRoom(socket.id);

    if (!room) {
  socket.emit("roomMessage", "তুমি কোনো Room-এ নেই।");
  return;
}

if (room.status !== "playing") {
  socket.emit("roomMessage", "দুইজন খেলোয়াড় যোগ দিলে গেম শুরু হবে।");
  return;
}

if (room.turn !== socket.id) {
  socket.emit("roomMessage", "এখন তোমার চাল নয়।");
  return;
}

    const hand = room.hands[socket.id];

    if (!Number.isInteger(index) || index < 0 || index >= hand.length) {
      return;
    }

    const card = hand[index];

    const valid =
      card.color === "wild" ||
      card.color === room.currentColor ||
      card.value === room.topCard.value;

    if (!valid) {
  socket.emit("roomMessage", "এই কার্ডটি চালা যাবে না।");
  return;
}

    if (card.color === "wild" && !COLORS.includes(color)) {
      color = "red";
    }

    hand.splice(index, 1);
    room.discard.push(room.topCard);
    room.topCard = card;

    room.currentColor =
      card.color === "wild" ? color : card.color;

    if (hand.length === 0) {
      room.status = "finished";
      room.winner = socket.id;
      room.message = "Game over! You have a winner.";
      sendState(room);
      return;
    }

    const opponent = otherPlayer(room, socket.id);

    if (
      ["Skip", "Reverse", "Draw 2", "Wild +4"].includes(card.value)
    ) {
      const amount =
        card.value === "Draw 2" ? 2 :
        card.value === "Wild +4" ? 4 : 0;

      for (let i = 0; i < amount; i++) {
        room.hands[opponent].push(draw(room));
      }

      room.turn = socket.id;
    } else {
      room.turn = opponent;
    }

    room.message = "Card played: " + card.value;
    sendState(room);
  });

  socket.on("drawCard", () => {
    const room = getRoom(socket.id);

    if (
      !room ||
      room.status !== "playing" ||
      room.turn !== socket.id
    ) return;

    room.hands[socket.id].push(draw(room));
    room.turn = otherPlayer(room, socket.id);
    room.message = "A card was drawn.";
    sendState(room);
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket.id);
    console.log("Disconnected:", socket.id);

    if (!room) return;

    room.players = room.players.filter(
      player => player !== socket.id
    );

    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      room.status = "waiting";
      room.message = "Opponent disconnected. Waiting for a player.";
      room.hands = {};
      room.deck = [];
      room.discard = [];
      room.topCard = null;
      room.turn = null;
      sendState(room);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Card Clash server running on port " + PORT);
});
