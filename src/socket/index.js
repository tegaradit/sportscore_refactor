const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { corsConfig } = require('../config/cors');

// Socket handlers
const MatchHandler = require('./handlers/MatchHandler');
const CategoryHandler = require('./handlers/CategoryHandler');
const GeneralHandler = require('./handlers/GeneralHandler');

class SocketService {
  constructor() {
    this.io = null;
    this.connections = new Map();
  }

  init(server) {
    this.io = new Server(server, {
      cors: corsConfig,
      transports: ['websocket', 'polling'],
      allowEIO3: true
    });

    this.setupMiddleware();
    this.setupConnectionHandling();
    this.setupEventHandlers();

    logger.info('🔌 Socket.IO initialized');
  }

  setupMiddleware() {
    // Rate limiting
    this.io.use((socket, next) => {
      const clientId = socket.handshake.address;
      const now = Date.now();
      
      if (!this.connections.has(clientId)) {
        this.connections.set(clientId, { count: 1, lastReset: now });
      } else {
        const client = this.connections.get(clientId);
        if (now - client.lastReset > 60000) {
          client.count = 1;
          client.lastReset = now;
        } else if (client.count >= 50) {
          return next(new Error('Rate limit exceeded'));
        } else {
          client.count++;
        }
      }
      next();
    });

    // Optional authentication
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          socket.user = decoded;
        } catch (err) {
          logger.warn('Invalid socket token:', err.message);
        }
      }
      
      next();
    });
  }

  setupConnectionHandling() {
    this.io.on('connection', (socket) => {
      logger.info(`Client connected: ${socket.id}`);

      // Join general room
      socket.join('general');

      // Handle room joining with debouncing
      this.handleRoomJoining(socket);

      // Cleanup on disconnect
      socket.on('disconnect', (reason) => {
        logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
        this.cleanupClient(socket);
      });
    });
  }

  handleRoomJoining(socket) {
    const joinCooldowns = new Map();

    socket.on('join_match', (matchId) => {
      this.joinWithCooldown(socket, `match_${matchId}`, joinCooldowns, 2000);
    });

    socket.on('leave_match', (matchId) => {
      socket.leave(`match_${matchId}`);
      logger.debug(`Socket ${socket.id} left match_${matchId}`);
    });

    socket.on('join_category', (categoryId) => {
      this.joinWithCooldown(socket, `category_${categoryId}`, joinCooldowns, 2000);
    });

    socket.on('leave_category', (categoryId) => {
      socket.leave(`category_${categoryId}`);
      logger.debug(`Socket ${socket.id} left category_${categoryId}`);
    });
  }

  joinWithCooldown(socket, room, cooldowns, cooldownMs) {
    const now = Date.now();
    const lastJoin = cooldowns.get(socket.id + room) || 0;

    if (now - lastJoin < cooldownMs) {
      logger.debug(`Join cooldown active for ${socket.id} -> ${room}`);
      return;
    }

    cooldowns.set(socket.id + room, now);
    socket.join(room);
    logger.debug(`Socket ${socket.id} joined ${room}`);
  }

  setupEventHandlers() {
    this.matchHandler = new MatchHandler(this.io);
    this.categoryHandler = new CategoryHandler(this.io);
    this.generalHandler = new GeneralHandler(this.io);
  }

  cleanupClient(socket) {
    // Clean up any client-specific data
    this.connections.forEach((value, key) => {
      if (value.socketId === socket.id) {
        this.connections.delete(key);
      }
    });
  }

  // Public methods for emitting events
  emitToMatch(matchId, event, data) {
    this.io.to(`match_${matchId}`).emit(event, { matchId, ...data });
  }

  emitToCategory(categoryId, event, data) {
    this.io.to(`category_${categoryId}`).emit(event, { categoryId, ...data });
  }

  emitToAll(event, data) {
    this.io.emit(event, data);
  }

  emitToGeneral(event, data) {
    this.io.to('general').emit(event, data);
  }
}

module.exports = new SocketService();