const jwt = require('jsonwebtoken');
const { ApiResponse } = require('../../utils/helpers/responseHelper');
const logger = require('../../utils/logger');

const verifyToken = (options = {}) => {
  const {
    cookieName = 'token',
    requireRole = null,
    allowedRoles = [],
    optional = false
  } = options;

  return (req, res, next) => {
    try {
      // Get token from cookie or Authorization header
      const token = req.cookies[cookieName] || 
                   (req.headers.authorization?.startsWith('Bearer ') ? 
                    req.headers.authorization.slice(7) : null);

      if (!token) {
        if (optional) {
          return next();
        }
        return ApiResponse.unauthorized(res, 'Access token required');
      }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Check if token is expired
      if (decoded.exp && decoded.exp < Date.now() / 1000) {
        return ApiResponse.unauthorized(res, 'Token expired');
      }

      // Role validation
      if (requireRole && decoded.role !== requireRole) {
        return ApiResponse.forbidden(res, `Requires ${requireRole} role`);
      }

      if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.role)) {
        return ApiResponse.forbidden(res, 'Insufficient permissions');
      }

      // Add user to request
      req.user = decoded;
      req.token = token;

      next();
    } catch (error) {
      logger.warn('Token verification failed:', {
        error: error.message,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      if (optional) {
        return next();
      }

      return ApiResponse.unauthorized(res, 'Invalid token');
    }
  };
};

// Predefined middleware for different roles
const authMiddleware = {
  // General authentication
  required: verifyToken(),
  optional: verifyToken({ optional: true }),

  // Role-specific authentication
  admin: verifyToken({ 
    cookieName: 'admin_token', 
    requireRole: 'admin' 
  }),
  
  eventOrganizer: verifyToken({ 
    cookieName: 'eo_token', 
    requireRole: 'event_organizer' 
  }),
  
  team: verifyToken({ 
    cookieName: 'token',
    allowedRoles: ['team'] 
  }),

  // Multi-role authentication
  adminOrEO: verifyToken({ 
    allowedRoles: ['admin', 'event_organizer'] 
  }),

  // Custom role checker
  hasRole: (roles) => verifyToken({ allowedRoles: Array.isArray(roles) ? roles : [roles] })
};

module.exports = authMiddleware;