const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');

// Internal imports
const routes = require('./src/routes');
const { errorHandler } = require('./src/middleware/error/errorHandler');
const { corsConfig } = require('./src/config/cors');
const socketService = require('./src/socket');
const rateLimiter = require('./src/middleware/security/rateLimiter');

const app = express();

// Security middleware
app.use(helmet());
app.use(compression());
app.use(rateLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// CORS
app.use(cors(corsConfig));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api', routes);

// Error handling
app.use(errorHandler);

// Socket.IO setup
const server = require('http').createServer(app);
socketService.init(server);

module.exports = server;