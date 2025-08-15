// src/controllers/match/MatchController.js
import BaseController from '../base/baseController';
import MatchService from '../../services/match/MatchService';
import LiveMatchService from '../../services/match/LiveMatchService';
import { emitToMatch, emitToCategory } from '../../socket';
import { body, param, query } from 'express-validator';

class MatchController extends BaseController {
  constructor() {
    super();
    this.matchService = new MatchService();
    this.liveMatchService = new LiveMatchService();
  }

  // Validation schemas
  static get validationSchemas() {
    return {
      createMatch: [
        body('id_kategori').isInt().withMessage('Category ID must be an integer'),
        body('team_1').isInt().withMessage('Team 1 ID must be an integer'),
        body('team_2').isInt().withMessage('Team 2 ID must be an integer'),
        body('waktu').isISO8601().withMessage('Invalid datetime format'),
        body('grup').optional().isString().withMessage('Group must be a string')
      ],
      
      matchEvent: [
        body('id_match').isInt().withMessage('Match ID must be an integer'),
        body('id_team').isInt().withMessage('Team ID must be an integer'),
        body('id_pemain').isInt().withMessage('Player ID must be an integer'),
        body('jenis').isIn(['GOL', 'BUNUH_DIRI', 'KUNING', 'MERAH']).withMessage('Invalid event type'),
        body('menit').isInt({ min: 0 }).withMessage('Minute must be a positive integer')
      ],

      updateScore: [
        body('id_match').isInt().withMessage('Match ID must be an integer'),
        body('skor_1').isInt({ min: 0 }).withMessage('Score 1 must be a non-negative integer'),
        body('skor_2').isInt({ min: 0 }).withMessage('Score 2 must be a non-negative integer')
      ]
    };
  }

  // GET /api/matches
  getMatches = this.asyncHandler(async (req, res) => {
    const { page, limit, offset } = this.getPaginationParams(req);
    const { sortBy, sortOrder } = this.getSortParams(req);
    const filters = this.getFilterParams(req, ['kategori', 'status', 'grup']);

    const result = await this.matchService.getMatches({
      pagination: { limit, offset },
      sort: { sortBy, sortOrder },
      filters
    });

    return this.sendSuccess(res, {
      matches: result.data,
      pagination: {
        page,
        limit,
        total: result.total
      }
    });
  });

  // GET /api/matches/:id
  getMatchById = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const match = await this.matchService.getMatchById(id);
    
    if (!match) {
      return this.sendNotFound(res, 'Match not found');
    }

    return this.sendSuccess(res, match);
  });

  // GET /api/matches/:id/detail
  getMatchDetail = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const matchDetail = await this.matchService.getMatchDetailWithLineup(id);
    
    if (!matchDetail) {
      return this.sendNotFound(res, 'Match not found');
    }

    return this.sendSuccess(res, matchDetail);
  });

  // POST /api/matches
  createMatch = this.asyncHandler(async (req, res) => {
    const matchData = req.body;
    const userId = this.getCurrentUser(req)?.id;

    // Check if teams are different
    if (matchData.team_1 === matchData.team_2) {
      return this.sendBadRequest(res, 'Teams must be different');
    }

    const match = await this.matchService.createMatch(matchData, userId);

    this.logAction('CREATE_MATCH', userId, { matchId: match.id });

    return this.sendCreated(res, match, 'Match created successfully');
  });

  // PUT /api/matches/:id
  updateMatch = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updateData = req.body;
    const userId = this.getCurrentUser(req)?.id;

    const match = await this.matchService.updateMatch(id, updateData, userId);

    if (!match) {
      return this.sendNotFound(res, 'Match not found');
    }

    this.logAction('UPDATE_MATCH', userId, { matchId: id });

    // Emit update to connected clients
    emitToMatch(id, 'match:updated', match);

    return this.sendSuccess(res, match, 'Match updated successfully');
  });

  // DELETE /api/matches/:id
  deleteMatch = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = this.getCurrentUser(req)?.id;

    const deleted = await this.matchService.deleteMatch(id, userId);

    if (!deleted) {
      return this.sendNotFound(res, 'Match not found');
    }

    this.logAction('DELETE_MATCH', userId, { matchId: id });

    return this.sendSuccess(res, null, 'Match deleted successfully');
  });

  // POST /api/matches/:id/events
  addMatchEvent = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const eventData = req.body;
    const userId = this.getCurrentUser(req)?.id;

    const event = await this.matchService.addMatchEvent(id, eventData, userId);

    // Get updated match detail for real-time updates
    const matchDetail = await this.matchService.getMatchDetailWithLineup(id);

    this.logAction('ADD_MATCH_EVENT', userId, { 
      matchId: id, 
      eventType: eventData.jenis,
      playerId: eventData.id_pemain 
    });

    // Emit to connected clients
    emitToMatch(id, 'match:event_added', {
      event,
      matchDetail
    });

    return this.sendCreated(res, event, 'Match event added successfully');
  });

  // PUT /api/matches/:id/score
  updateScore = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { skor_1, skor_2 } = req.body;
    const userId = this.getCurrentUser(req)?.id;

    const match = await this.matchService.updateScore(id, skor_1, skor_2, userId);

    if (!match) {
      return this.sendNotFound(res, 'Match not found');
    }

    this.logAction('UPDATE_SCORE', userId, { 
      matchId: id, 
      score: `${skor_1}-${skor_2}` 
    });

    // Emit score update
    emitToMatch(id, 'match:score_updated', {
      skor_1,
      skor_2,
      timestamp: new Date().toISOString()
    });

    return this.sendSuccess(res, match, 'Score updated successfully');
  });

  // POST /api/matches/:id/start
  startMatch = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { babak = 1 } = req.body;
    const userId = this.getCurrentUser(req)?.id;

    const match = await this.liveMatchService.startMatch(id, babak, userId);

    if (!match) {
      return this.sendNotFound(res, 'Match not found');
    }

    this.logAction('START_MATCH', userId, { matchId: id, babak });

    // Emit start event
    emitToMatch(id, 'match:started', {
      babak,
      timestamp: new Date().toISOString()
    });

    return this.sendSuccess(res, match, 'Match started successfully');
  });

  // POST /api/matches/:id/pause
  pauseMatch = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = this.getCurrentUser(req)?.id;

    const match = await this.liveMatchService.pauseMatch(id, userId);

    if (!match) {
      return this.sendNotFound(res, 'Match not found or not in progress');
    }

    this.logAction('PAUSE_MATCH', userId, { matchId: id });

    // Emit pause event
    emitToMatch(id, 'match:paused', {
      timestamp: new Date().toISOString()
    });

    return this.sendSuccess(res, match, 'Match paused successfully');
  });

  // POST /api/matches/:id/resume
  resumeMatch = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = this.getCurrentUser(req)?.id;

    const match = await this.liveMatchService.resumeMatch(id, userId);

    if (!match) {
      return this.sendNotFound(res, 'Match not found or not paused');
    }

    this.logAction('RESUME_MATCH', userId, { matchId: id });

    // Emit resume event
    emitToMatch(id, 'match:resumed', {
      timestamp: new Date().toISOString()
    });

    return this.sendSuccess(res, match, 'Match resumed successfully');
  });

  // POST /api/matches/:id/finish
  finishMatch = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = this.getCurrentUser(req)?.id;

    const result = await this.liveMatchService.finishMatch(id, userId);

    if (!result) {
      return this.sendNotFound(res, 'Match not found');
    }

    this.logAction('FINISH_MATCH', userId, { 
      matchId: id,
      finalScore: `${result.match.skor_1}-${result.match.skor_2}`
    });

    // Emit finish event with standings update
    emitToMatch(id, 'match:finished', {
      match: result.match,
      standings: result.standings,
      timestamp: new Date().toISOString()
    });

    // Also emit to category room for standings update
    emitToCategory(result.match.id_kategori, 'standings:updated', {
      standings: result.standings
    });

    return this.sendSuccess(res, result, 'Match finished successfully');
  });

  // GET /api/matches/live
  getLiveMatches = this.asyncHandler(async (req, res) => {
    const filters = this.getFilterParams(req, ['kategori', 'event']);
    
    const liveMatches = await this.liveMatchService.getLiveMatches(filters);

    return this.sendSuccess(res, liveMatches);
  });

  // GET /api/matches/:id/timeline
  getMatchTimeline = this.asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const timeline = await this.matchService.getMatchTimeline(id);

    if (!timeline) {
      return this.sendNotFound(res, 'Match not found');
    }

    return this.sendSuccess(res, timeline);
  });

  // POST /api/matches/generate/group
  generateGroupMatches = this.asyncHandler(async (req, res) => {
    const { id_kategori, grup, match_day_start, jam_awal, jeda_menit } = req.body;
    const userId = this.getCurrentUser(req)?.id;

    const matches = await this.matchService.generateGroupMatches({
      id_kategori,
      grup,
      match_day_start,
      jam_awal,
      jeda_menit
    }, userId);

    this.logAction('GENERATE_GROUP_MATCHES', userId, { 
      kategori: id_kategori, 
      grup,
      matchCount: matches.length 
    });

    return this.sendCreated(res, matches, 'Group matches generated successfully');
  });

  // POST /api/matches/generate/bracket
  generateBracketMatches = this.asyncHandler(async (req, res) => {
    const { id_kategori, type } = req.body;
    const userId = this.getCurrentUser(req)?.id;

    const bracket = await this.matchService.generateBracketMatches(id_kategori, type, userId);

    this.logAction('GENERATE_BRACKET', userId, { 
      kategori: id_kategori, 
      type 
    });

    return this.sendCreated(res, bracket, 'Bracket matches generated successfully');
  });
}

export default MatchController;