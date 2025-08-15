const { validationResult } = require('express-validator');
const { ApiResponse } = require('../../utils/helpers/responseHelper');
const logger = require('../../utils/logger');

class BaseController {
  constructor() {
    // Bind methods to preserve 'this' context
    this.handleValidationErrors = this.handleValidationErrors.bind(this);
    this.asyncHandler = this.asyncHandler.bind(this);
  }

  // Async error handler wrapper
  asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // Validation error handler
  handleValidationErrors(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return ApiResponse.validationError(res, errors.array());
    }
    next();
  }

  // Success responses
  sendSuccess(res, data = null, message = 'Success', statusCode = 200) {
    return ApiResponse.success(res, data, message, statusCode);
  }

  sendCreated(res, data = null, message = 'Created successfully') {
    return ApiResponse.success(res, data, message, 201);
  }

  // Error responses
  sendError(res, message = 'Internal server error', statusCode = 500) {
    return ApiResponse.error(res, message, statusCode);
  }

  sendNotFound(res, message = 'Resource not found') {
    return ApiResponse.error(res, message, 404);
  }

  sendBadRequest(res, message = 'Bad request') {
    return ApiResponse.error(res, message, 400);
  }

  sendUnauthorized(res, message = 'Unauthorized') {
    return ApiResponse.error(res, message, 401);
  }

  sendForbidden(res, message = 'Forbidden') {
    return ApiResponse.error(res, message, 403);
  }

  // Logging helper
  logAction(action, userId = null, details = {}) {
    logger.info(`Action: ${action}`, {
      userId,
      timestamp: new Date().toISOString(),
      ...details
    });
  }

  // Extract user from request
  getCurrentUser(req) {
    return req.user || req.admin || req.team || null;
  }

  // Get pagination parameters
  getPaginationParams(req) {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    return { page, limit, offset };
  }

  // Get sort parameters
  getSortParams(req, defaultSort = 'created_at', defaultOrder = 'DESC') {
    const sortBy = req.query.sortBy || defaultSort;
    const sortOrder = (req.query.sortOrder || defaultOrder).toUpperCase();
    
    if (!['ASC', 'DESC'].includes(sortOrder)) {
      throw new Error('Invalid sort order');
    }

    return { sortBy, sortOrder };
  }

  // Get filter parameters
  getFilterParams(req, allowedFilters = []) {
    const filters = {};
    
    allowedFilters.forEach(filter => {
      if (req.query[filter] !== undefined) {
        filters[filter] = req.query[filter];
      }
    });

    return filters;
  }
}

module.exports = BaseController;