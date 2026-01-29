const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('UNO WebSocket Server Running');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Game state
const rooms = new Map();

// Card deck generator
function generateDeck() {
  const deck = [];
  const colors = ['red', 'blue', 'green', 'yellow'];
  const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
  
  // Number and action cards (2 of each except 0)
  colors.forEach(color => {
    deck.push({ color, value: '0', type: 'number' });
    values.slice(1).forEach(value => {
      deck.push({ color, value, type: value.includes('+') || value === 'Skip' || value === 'Reverse' ? 'action' : 'number' });
      deck.push({ color, value, type: value.includes('+') || value === 'Skip' || value === 'Reverse' ? 'action' : 'number' });
    });
  });
  
  // Wild cards
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'Wild', type: 'wild' });
    deck.push({ color: 'wild', value: '+4', type: 'wild' });
  }
  
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function broadcastToRoom(roomCode, message, excludeId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  room.players.forEach(player => {
    if (player.id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  });
}

function sendToPlayer(playerId, roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const player = room.players.find(p => p.id === playerId);
  if (player && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(message));
  }
}

wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);
      
      switch (data.type) {
        case 'create_lobby':
          handleCreateLobby(ws, data);
          break;
        case 'join_lobby':
          handleJoinLobby(ws, data);
          break;
        case 'leave_lobby':
          handleLeaveLobby(ws, data);
          break;
        case 'start_game':
          handleStartGame(data);
          break;
        case 'play_card':
          handlePlayCard(data);
          break;
        case 'draw_card':
          handleDrawCard(data);
          break;
        case 'call_uno':
          handleCallUno(data);
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    handleDisconnect(ws);
  });
});

function handleCreateLobby(ws, data) {
  const roomCode = generateRoomCode();
  
  const player = {
    id: data.playerId,
    name: data.playerName,
    ws: ws,
    isHost: true,
    hand: [],
    cardCount: 0
  };
  
  rooms.set(roomCode, {
    code: roomCode,
    players: [player],
    gameStarted: false,
    deck: [],
    discardPile: [],
    currentCard: null,
    currentPlayerIndex: 0,
    direction: 1
  });
  
  ws.send(JSON.stringify({
    type: 'lobby_created',
    roomCode: roomCode
  }));
  
  broadcastLobbyUpdate(roomCode);
  console.log(`Lobby created: ${roomCode}`);
}

function handleJoinLobby(ws, data) {
  const room = rooms.get(data.roomCode);
  
  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Lobby not found'
    }));
    return;
  }
  
  if (room.players.length >= 4) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Lobby is full'
    }));
    return;
  }
  
  if (room.gameStarted) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Game already in progress'
    }));
    return;
  }
  
  const player = {
    id: data.playerId,
    name: data.playerName,
    ws: ws,
    isHost: false,
    hand: [],
    cardCount: 0
  };
  
  room.players.push(player);
  
  ws.send(JSON.stringify({
    type: 'lobby_joined',
    roomCode: data.roomCode
  }));
  
  broadcastLobbyUpdate(data.roomCode);
  console.log(`Player ${data.playerName} joined lobby ${data.roomCode}`);
}

function handleLeaveLobby(ws, data) {
  const room = rooms.get(data.roomCode);
  if (!room) return;
  
  const playerIndex = room.players.findIndex(p => p.id === data.playerId);
  if (playerIndex === -1) return;
  
  const wasHost = room.players[playerIndex].isHost;
  room.players.splice(playerIndex, 1);
  
  if (room.players.length === 0) {
    rooms.delete(data.roomCode);
    console.log(`Lobby ${data.roomCode} deleted`);
  } else {
    if (wasHost) {
      room.players[0].isHost = true;
    }
    broadcastLobbyUpdate(data.roomCode);
  }
}

function handleDisconnect(ws) {
  for (const [roomCode, room] of rooms.entries()) {
    const playerIndex = room.players.findIndex(p => p.ws === ws);
    if (playerIndex !== -1) {
      const wasHost = room.players[playerIndex].isHost;
      room.players.splice(playerIndex, 1);
      
      if (room.players.length === 0) {
        rooms.delete(roomCode);
        console.log(`Lobby ${roomCode} deleted (all players left)`);
      } else {
        if (wasHost) {
          room.players[0].isHost = true;
        }
        broadcastLobbyUpdate(roomCode);
      }
      break;
    }
  }
}

function broadcastLobbyUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const playersInfo = room.players.map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    cardCount: p.cardCount
  }));
  
  room.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({
        type: 'lobby_update',
        players: playersInfo
      }));
    }
  });
}

function handleStartGame(data) {
  const room = rooms.get(data.roomCode);
  if (!room || room.players.length < 2) return;
  
  // Initialize deck and deal cards
  room.deck = shuffleDeck(generateDeck());
  room.discardPile = [];
  room.gameStarted = true;
  room.currentPlayerIndex = 0;
  room.direction = 1;
  
  // Deal 7 cards to each player
  room.players.forEach(player => {
    player.hand = [];
    for (let i = 0; i < 7; i++) {
      player.hand.push(room.deck.pop());
    }
    player.cardCount = player.hand.length;
  });
  
  // Draw first card (make sure it's not a wild)
  let firstCard;
  do {
    firstCard = room.deck.pop();
  } while (firstCard.type === 'wild');
  
  room.currentCard = firstCard;
  room.discardPile.push(firstCard);
  
  // Send game state to each player
  room.players.forEach((player, index) => {
    const playersInfo = room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      cardCount: p.cardCount
    }));
    
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({
        type: 'game_started',
        currentCard: room.currentCard,
        hand: player.hand,
        players: playersInfo,
        currentPlayerIndex: room.currentPlayerIndex,
        direction: room.direction
      }));
    }
  });
  
  console.log(`Game started in lobby ${data.roomCode}`);
}

function handlePlayCard(data) {
  const room = rooms.get(data.roomCode);
  if (!room) return;
  
  const playerIndex = room.players.findIndex(p => p.id === data.playerId);
  if (playerIndex === -1) return;
  
  const player = room.players[playerIndex];
  const card = data.card;
  
  // If wild card, update color
  if (card.type === 'wild' && card.chosenColor) {
    card.color = card.chosenColor;
  }
  
  // Remove card from player's hand
  const cardIndex = player.hand.findIndex(c => 
    c.color === card.color && c.value === card.value
  );
  
  if (cardIndex !== -1) {
    player.hand.splice(cardIndex, 1);
    player.cardCount = player.hand.length;
  }
  
  // Update current card
  room.currentCard = card;
  room.discardPile.push(card);
  
  // Handle special cards
  let skipNext = false;
  
  if (card.value === 'Skip') {
    skipNext = true;
  } else if (card.value === 'Reverse') {
    room.direction *= -1;
    if (room.players.length === 2) {
      skipNext = true;
    }
  } else if (card.value === '+2') {
    const nextPlayerIndex = getNextPlayerIndex(room);
    const nextPlayer = room.players[nextPlayerIndex];
    for (let i = 0; i < 2; i++) {
      if (room.deck.length > 0) {
        const drawnCard = room.deck.pop();
        nextPlayer.hand.push(drawnCard);
      }
    }
    nextPlayer.cardCount = nextPlayer.hand.length;
    skipNext = true;
  } else if (card.value === '+4') {
    const nextPlayerIndex = getNextPlayerIndex(room);
    const nextPlayer = room.players[nextPlayerIndex];
    for (let i = 0; i < 4; i++) {
      if (room.deck.length > 0) {
        const drawnCard = room.deck.pop();
        nextPlayer.hand.push(drawnCard);
      }
    }
    nextPlayer.cardCount = nextPlayer.hand.length;
    skipNext = true;
  }
  
  // Check for winner
  if (player.hand.length === 0) {
    broadcastToRoom(data.roomCode, {
      type: 'game_over',
      winner: {
        id: player.id,
        name: player.name
      }
    });
    return;
  }
  
  // Move to next player
  room.currentPlayerIndex = getNextPlayerIndex(room);
  if (skipNext) {
    room.currentPlayerIndex = getNextPlayerIndex(room);
  }
  
  // Broadcast game update
  const playersInfo = room.players.map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    cardCount: p.cardCount
  }));
  
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({
        type: 'game_update',
        currentCard: room.currentCard,
        currentPlayerIndex: room.currentPlayerIndex,
        direction: room.direction,
        players: playersInfo
      }));
    }
  });
  
  broadcastToRoom(data.roomCode, {
    type: 'card_played',
    playerId: data.playerId,
    playerName: player.name,
    card: card
  });
}

function handleDrawCard(data) {
  const room = rooms.get(data.roomCode);
  if (!room) return;
  
  const player = room.players.find(p => p.id === data.playerId);
  if (!player) return;
  
  if (room.deck.length === 0) {
    // Reshuffle discard pile
    const currentCard = room.discardPile.pop();
    room.deck = shuffleDeck(room.discardPile);
    room.discardPile = [currentCard];
  }
  
  const drawnCard = room.deck.pop();
  player.hand.push(drawnCard);
  player.cardCount = player.hand.length;
  
  // Send drawn card to player
  sendToPlayer(data.playerId, data.roomCode, {
    type: 'card_drawn',
    playerId: data.playerId,
    card: drawnCard
  });
  
  // Move to next player
  room.currentPlayerIndex = getNextPlayerIndex(room);
  
  // Broadcast game update
  const playersInfo = room.players.map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    cardCount: p.cardCount
  }));
  
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({
        type: 'game_update',
        currentCard: room.currentCard,
        currentPlayerIndex: room.currentPlayerIndex,
        direction: room.direction,
        players: playersInfo
      }));
    }
  });
}

function handleCallUno(data) {
  const room = rooms.get(data.roomCode);
  if (!room) return;
  
  broadcastToRoom(data.roomCode, {
    type: 'uno_called',
    playerId: data.playerId
  });
}

function getNextPlayerIndex(room) {
  let nextIndex = room.currentPlayerIndex + room.direction;
  
  if (nextIndex >= room.players.length) {
    nextIndex = 0;
  } else if (nextIndex < 0) {
    nextIndex = room.players.length - 1;
  }
  
  return nextIndex;
}

server.listen(PORT, () => {
  console.log(`WebSocket server is running on port ${PORT}`);
});
