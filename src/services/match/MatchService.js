// src/services/match/MatchService.js
const database = require('../../config/database');
const { AppError } = require('../../middleware/error/errorHandler');
const logger = require('../../utils/logger');
const StandingService = require('./StandingService');

class MatchService {
  constructor() {
    this.standingService = new StandingService();
  }

  async getMatches(options = {}) {
    const { pagination = {}, sort = {}, filters = {} } = options;
    const { limit = 10, offset = 0 } = pagination;
    const { sortBy = 'waktu', sortOrder = 'ASC' } = sort;

    try {
      // Build WHERE clause
      const whereConditions = [];
      const queryParams = [];

      if (filters.kategori) {
        whereConditions.push('m.id_kategori = ?');
        queryParams.push(filters.kategori);
      }

      if (filters.status) {
        whereConditions.push('m.status = ?');
        queryParams.push(filters.status);
      }

      if (filters.grup) {
        whereConditions.push('m.grup = ?');
        queryParams.push(filters.grup);
      }

      if (filters.event) {
        whereConditions.push('ec.id_event = ?');
        queryParams.push(filters.event);
      }

      const whereClause = whereConditions.length > 0 
        ? `WHERE ${whereConditions.join(' AND ')}` 
        : '';

      // Count total records
      const countQuery = `
        SELECT COUNT(*) as total
        FROM matches m
        LEFT JOIN event_categories ec ON m.id_kategori = ec.id
        ${whereClause}
      `;
      
      const [countResult] = await database.query(countQuery, queryParams);
      const total = countResult[0].total;

      // Main query with pagination
      const query = `
        SELECT 
          m.*,
          t1.nama_club AS team1_name,
          t1.logo_club AS team1_logo,
          t2.nama_club AS team2_name, 
          t2.logo_club AS team2_logo,
          ec.nama_kategori,
          e.nama_event
        FROM matches m
        LEFT JOIN teams t1 ON m.team_1 = t1.id
        LEFT JOIN teams t2 ON m.team_2 = t2.id
        LEFT JOIN event_categories ec ON m.id_kategori = ec.id
        LEFT JOIN events e ON ec.id_event = e.id
        ${whereClause}
        ORDER BY m.${sortBy} ${sortOrder}
        LIMIT ? OFFSET ?
      `;

      queryParams.push(limit, offset);
      const matches = await database.query(query, queryParams);

      return {
        data: matches,
        total,
        pagination: {
          limit,
          offset,
          hasNext: offset + limit < total,
          hasPrev: offset > 0
        }
      };
    } catch (error) {
      logger.error('Error fetching matches:', error);
      throw new AppError('Failed to fetch matches', 500);
    }
  }

  async getMatchById(id) {
    try {
      const query = `
        SELECT 
          m.*,
          t1.nama_club AS team1_name,
          t1.logo_club AS team1_logo,
          t2.nama_club AS team2_name,
          t2.logo_club AS team2_logo,
          ec.nama_kategori,
          ec.durasi_babak,
          ec.jumlah_babak,
          e.nama_event
        FROM matches m
        LEFT JOIN teams t1 ON m.team_1 = t1.id
        LEFT JOIN teams t2 ON m.team_2 = t2.id
        LEFT JOIN event_categories ec ON m.id_kategori = ec.id
        LEFT JOIN events e ON ec.id_event = e.id
        WHERE m.id = ?
      `;

      const [match] = await database.query(query, [id]);
      return match || null;
    } catch (error) {
      logger.error('Error fetching match by ID:', error);
      throw new AppError('Failed to fetch match', 500);
    }
  }

  async getMatchDetailWithLineup(id) {
    try {
      // Get basic match info
      const match = await this.getMatchById(id);
      if (!match) return null;

      // Get lineup for both teams
      const lineupQuery = `
        SELECT 
          ml.*,
          p.nama_pemain,
          p.foto_pemain,
          pe.no_punggung,
          pe.id_team
        FROM match_lineup ml
        JOIN pemain_event pe ON ml.id_pemain_event = pe.id
        JOIN pemain p ON pe.id_pemain = p.id
        WHERE ml.id_match = ?
        ORDER BY pe.id_team, ml.is_starting DESC, pe.no_punggung
      `;

      const lineup = await database.query(lineupQuery, [id]);

      // Group lineup by team
      const lineupByTeam = {
        team_1: lineup.filter(player => player.id_team === match.team_1),
        team_2: lineup.filter(player => player.id_team === match.team_2)
      };

      // Get match events
      const eventsQuery = `
        SELECT 
          me.*,
          p.nama_pemain,
          pe.no_punggung,
          t.nama_club AS team_name
        FROM match_events me
        JOIN pemain p ON me.id_pemain = p.id
        LEFT JOIN pemain_event pe ON pe.id_pemain = p.id 
          AND pe.id_team = me.id_team 
          AND pe.id_kategori = me.id_kategori
        JOIN teams t ON me.id_team = t.id
        WHERE me.id_match = ?
        ORDER BY me.menit ASC, me.created_at ASC
      `;

      const events = await database.query(eventsQuery, [id]);

      // Get staff lineup
      const staffQuery = `
        SELECT 
          msl.*,
          s.nama_staff,
          s.foto,
          se.id_team
        FROM match_staff_lineup msl
        JOIN staff_event se ON msl.id_staff_event = se.id
        JOIN staff s ON se.id_staff = s.id
        WHERE msl.id_match = ?
        ORDER BY se.id_team
      `;

      const staff = await database.query(staffQuery, [id]);

      // Group staff by team
      const staffByTeam = {
        team_1: staff.filter(s => s.id_team === match.team_1),
        team_2: staff.filter(s => s.id_team === match.team_2)
      };

      return {
        ...match,
        lineup: lineupByTeam,
        staff: staffByTeam,
        events: events.map(event => ({
          id: event.id,
          jenis: event.jenis,
          menit: event.menit,
          nama_pemain: event.nama_pemain,
          no_punggung: event.no_punggung,
          team_name: event.team_name,
          created_at: event.created_at
        }))
      };
    } catch (error) {
      logger.error('Error fetching match detail:', error);
      throw new AppError('Failed to fetch match detail', 500);
    }
  }

  async createMatch(matchData, userId) {
    return await database.transaction(async (connection) => {
      try {
        // Validate teams exist and are in the same category
        const teamsQuery = `
          SELECT et.id_team, t.nama_club 
          FROM event_teams et
          JOIN teams t ON et.id_team = t.id
          WHERE et.id_kategori = ? AND et.id_team IN (?, ?)
        `;
        
        const teams = await connection.query(teamsQuery, [
          matchData.id_kategori, 
          matchData.team_1, 
          matchData.team_2
        ]);

        if (teams.length !== 2) {
          throw new AppError('One or both teams are not registered for this category', 400);
        }

        // Check for scheduling conflicts
        const conflictQuery = `
          SELECT id FROM matches 
          WHERE waktu = ? 
          AND (team_1 IN (?, ?) OR team_2 IN (?, ?))
          AND status != 'cancelled'
        `;
        
        const conflicts = await connection.query(conflictQuery, [
          matchData.waktu,
          matchData.team_1, matchData.team_2,
          matchData.team_1, matchData.team_2
        ]);

        if (conflicts.length > 0) {
          throw new AppError('Teams have scheduling conflict at this time', 400);
        }

        // Insert match
        const insertQuery = `
          INSERT INTO matches (
            id_kategori, team_1, team_2, waktu, grup, 
            status, skor_1, skor_2, created_by
          ) VALUES (?, ?, ?, ?, ?, 'belum_main', 0, 0, ?)
        `;

        const [result] = await connection.query(insertQuery, [
          matchData.id_kategori,
          matchData.team_1,
          matchData.team_2,
          matchData.waktu,
          matchData.grup || null,
          userId
        ]);

        // Get the created match
        const match = await this.getMatchById(result.insertId);
        
        logger.info('Match created successfully', { 
          matchId: result.insertId, 
          userId 
        });

        return match;
      } catch (error) {
        logger.error('Error creating match:', error);
        throw error;
      }
    });
  }

  async updateMatch(id, updateData, userId) {
    return await database.transaction(async (connection) => {
      try {
        // Check if match exists and get current status
        const currentMatch = await this.getMatchById(id);
        if (!currentMatch) {
          return null;
        }

        // Prevent updates to finished matches
        if (currentMatch.status === 'selesai' && updateData.status !== 'selesai') {
          throw new AppError('Cannot modify finished match', 400);
        }

        // Build update query dynamically
        const allowedFields = ['waktu', 'status', 'grup', 'skor_1', 'skor_2'];
        const updateFields = [];
        const updateValues = [];

        Object.keys(updateData).forEach(key => {
          if (allowedFields.includes(key)) {
            updateFields.push(`${key} = ?`);
            updateValues.push(updateData[key]);
          }
        });

        if (updateFields.length === 0) {
          throw new AppError('No valid fields to update', 400);
        }

        updateFields.push('updated_at = NOW()');
        updateFields.push('updated_by = ?');
        updateValues.push(userId, id);

        const updateQuery = `
          UPDATE matches 
          SET ${updateFields.join(', ')}
          WHERE id = ?
        `;

        await connection.query(updateQuery, updateValues);

        // Get updated match
        const updatedMatch = await this.getMatchById(id);
        
        logger.info('Match updated successfully', { 
          matchId: id, 
          userId,
          changes: Object.keys(updateData)
        });

        return updatedMatch;
      } catch (error) {
        logger.error('Error updating match:', error);
        throw error;
      }
    });
  }

  async deleteMatch(id, userId) {
    return await database.transaction(async (connection) => {
      try {
        // Check if match exists and can be deleted
        const match = await this.getMatchById(id);
        if (!match) {
          return false;
        }

        if (match.status === 'sedang_main') {
          throw new AppError('Cannot delete match in progress', 400);
        }

        // Delete related records first
        await connection.query('DELETE FROM match_events WHERE id_match = ?', [id]);
        await connection.query('DELETE FROM match_lineup WHERE id_match = ?', [id]);
        await connection.query('DELETE FROM match_staff_lineup WHERE id_match = ?', [id]);

        // Delete the match
        const [result] = await connection.query('DELETE FROM matches WHERE id = ?', [id]);

        logger.info('Match deleted successfully', { 
          matchId: id, 
          userId 
        });

        return result.affectedRows > 0;
      } catch (error) {
        logger.error('Error deleting match:', error);
        throw error;
      }
    });
  }

  async addMatchEvent(matchId, eventData, userId) {
    return await database.transaction(async (connection) => {
      try {
        // Validate match exists and is in progress
        const match = await this.getMatchById(matchId);
        if (!match) {
          throw new AppError('Match not found', 404);
        }

        if (match.status !== 'sedang_main') {
          throw new AppError('Match is not in progress', 400);
        }

        // Validate player belongs to one of the teams
        const playerQuery = `
          SELECT pe.id_team 
          FROM pemain_event pe
          WHERE pe.id_pemain = ? 
          AND pe.id_kategori = ?
          AND pe.id_team IN (?, ?)
        `;

        const [player] = await connection.query(playerQuery, [
          eventData.id_pemain,
          match.id_kategori,
          match.team_1,
          match.team_2
        ]);

        if (!player) {
          throw new AppError('Player not found in this match', 400);
        }

        // Insert match event
        const eventQuery = `
          INSERT INTO match_events (
            id_match, id_kategori, id_team, id_pemain, 
            jenis, menit, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await connection.query(eventQuery, [
          matchId,
          match.id_kategori,
          eventData.id_team,
          eventData.id_pemain,
          eventData.jenis,
          eventData.menit,
          userId
        ]);

        // Update match score if it's a goal
        if (eventData.jenis === 'GOL') {
          await this.updateScoreFromEvent(connection, matchId, eventData.id_team, match);
        } else if (eventData.jenis === 'BUNUH_DIRI') {
          // Own goal - add score to opponent
          const opponentTeam = eventData.id_team === match.team_1 ? match.team_2 : match.team_1;
          await this.updateScoreFromEvent(connection, matchId, opponentTeam, match);
        }

        // Update player statistics if it's a goal
        if (['GOL', 'BUNUH_DIRI'].includes(eventData.jenis)) {
          await this.updatePlayerStats(connection, eventData.id_pemain, match.id_kategori, eventData.jenis);
        }

        logger.info('Match event added', { 
          matchId, 
          eventType: eventData.jenis,
          playerId: eventData.id_pemain,
          userId 
        });

        // Return the created event with player details
        const eventDetailQuery = `
          SELECT 
            me.*,
            p.nama_pemain,
            pe.no_punggung,
            t.nama_club AS team_name
          FROM match_events me
          JOIN pemain p ON me.id_pemain = p.id
          LEFT JOIN pemain_event pe ON pe.id_pemain = p.id 
            AND pe.id_team = me.id_team 
            AND pe.id_kategori = me.id_kategori
          JOIN teams t ON me.id_team = t.id
          WHERE me.id = ?
        `;

        const [eventDetail] = await connection.query(eventDetailQuery, [result.insertId]);
        return eventDetail;
      } catch (error) {
        logger.error('Error adding match event:', error);
        throw error;
      }
    });
  }

  async updateScoreFromEvent(connection, matchId, scoringTeam, match) {
    try {
      const scoreField = scoringTeam === match.team_1 ? 'skor_1' : 'skor_2';
      
      const updateQuery = `
        UPDATE matches 
        SET ${scoreField} = ${scoreField} + 1, updated_at = NOW()
        WHERE id = ?
      `;

      await connection.query(updateQuery, [matchId]);
    } catch (error) {
      logger.error('Error updating score from event:', error);
      throw error;
    }
  }

  async updatePlayerStats(connection, playerId, kategoriId, eventType) {
    try {
      if (eventType === 'GOL') {
        const updateQuery = `
          UPDATE pemain_event 
          SET jumlah_gol = jumlah_gol + 1
          WHERE id_pemain = ? AND id_kategori = ?
        `;
        await connection.query(updateQuery, [playerId, kategoriId]);
      }
    } catch (error) {
      logger.error('Error updating player stats:', error);
      throw error;
    }
  }

  async updateScore(id, skor1, skor2, userId) {
    return await database.transaction(async (connection) => {
      try {
        const match = await this.getMatchById(id);
        if (!match) {
          return null;
        }

        const updateQuery = `
          UPDATE matches 
          SET skor_1 = ?, skor_2 = ?, updated_at = NOW(), updated_by = ?
          WHERE id = ?
        `;

        await connection.query(updateQuery, [skor1, skor2, userId, id]);

        logger.info('Match score updated', { 
          matchId: id, 
          score: `${skor1}-${skor2}`,
          userId 
        });

        return await this.getMatchById(id);
      } catch (error) {
        logger.error('Error updating match score:', error);
        throw error;
      }
    });
  }

  async getMatchTimeline(id) {
    try {
      const query = `
        SELECT 
          me.menit,
          me.jenis,
          me.created_at,
          p.nama_pemain,
          pe.no_punggung,
          t.nama_club AS team_name,
          t.logo_club AS team_logo
        FROM match_events me
        JOIN pemain p ON me.id_pemain = p.id
        LEFT JOIN pemain_event pe ON pe.id_pemain = p.id 
          AND pe.id_team = me.id_team 
          AND pe.id_kategori = me.id_kategori
        JOIN teams t ON me.id_team = t.id
        WHERE me.id_match = ?
        ORDER BY me.menit ASC, me.created_at ASC
      `;

      const events = await database.query(query, [id]);
      
      return {
        matchId: id,
        events: events.map(event => ({
          minute: event.menit,
          type: event.jenis,
          player: {
            name: event.nama_pemain,
            number: event.no_punggung
          },
          team: {
            name: event.team_name,
            logo: event.team_logo
          },
          timestamp: event.created_at
        }))
      };
    } catch (error) {
      logger.error('Error fetching match timeline:', error);
      throw new AppError('Failed to fetch match timeline', 500);
    }
  }

  async generateGroupMatches(options, userId) {
    return await database.transaction(async (connection) => {
      try {
        const { id_kategori, grup, match_day_start, jam_awal = '13:00:00', jeda_menit = 90 } = options;

        // Get teams in the group
        const teamsQuery = `
          SELECT et.id_team, t.nama_club
          FROM event_teams et
          JOIN teams t ON et.id_team = t.id
          WHERE et.id_kategori = ? AND et.grup = ?
          ORDER BY t.nama_club
        `;

        const teams = await connection.query(teamsQuery, [id_kategori, grup]);

        if (teams.length < 2) {
          throw new AppError('Not enough teams in group to generate matches', 400);
        }

        // Generate round-robin matches
        const matches = [];
        const startDate = new Date(match_day_start);
        let currentTime = new Date(`${match_day_start}T${jam_awal}`);

        for (let i = 0; i < teams.length; i++) {
          for (let j = i + 1; j < teams.length; j++) {
            const matchDay = startDate.toISOString().split('T')[0];
            const waktu = currentTime.toISOString().slice(0, 19).replace('T', ' ');

            const insertQuery = `
              INSERT INTO matches (
                id_kategori, team_1, team_2, waktu, grup, 
                status, skor_1, skor_2, created_by
              ) VALUES (?, ?, ?, ?, ?, 'belum_main', 0, 0, ?)
            `;

            const [result] = await connection.query(insertQuery, [
              id_kategori,
              teams[i].id_team,
              teams[j].id_team,
              waktu,
              grup,
              userId
            ]);

            matches.push({
              id: result.insertId,
              team_1: teams[i].nama_club,
              team_2: teams[j].nama_club,
              waktu: waktu,
              grup: grup
            });

            // Add time interval for next match
            currentTime.setMinutes(currentTime.getMinutes() + jeda_menit);
          }
        }

        logger.info('Group matches generated', { 
          kategori: id_kategori, 
          grup, 
          matchCount: matches.length,
          userId 
        });

        return matches;
      } catch (error) {
        logger.error('Error generating group matches:', error);
        throw error;
      }
    });
  }

  async generateBracketMatches(id_kategori, type, userId) {
    return await database.transaction(async (connection) => {
      try {
        // Get category details
        const categoryQuery = `
          SELECT * FROM event_categories WHERE id = ?
        `;
        const [category] = await connection.query(categoryQuery, [id_kategori]);
        
        if (!category) {
          throw new AppError('Category not found', 404);
        }

        if (category.tipe_final !== 'final_four') {
          throw new AppError('Category does not support bracket generation', 400);
        }

        // Get top teams from groups
        const standingsQuery = `
          SELECT k.*, t.nama_club, et.grup
          FROM klasemen k
          JOIN teams t ON k.id_team = t.id
          JOIN event_teams et ON k.id_team = et.id_team AND et.id_kategori = k.id_kategori
          WHERE k.id_kategori = ?
          ORDER BY et.grup, k.point DESC, k.selisih DESC, k.goal_masuk DESC
        `;

        const standings = await connection.query(standingsQuery, [id_kategori]);

        // Group by grup and get top 2 from each
        const groupStandings = {};
        standings.forEach(team => {
          if (!groupStandings[team.grup]) {
            groupStandings[team.grup] = [];
          }
          if (groupStandings[team.grup].length < 2) {
            groupStandings[team.grup].push(team);
          }
        });

        // Validate we have enough teams
        const qualifiedTeams = Object.values(groupStandings).flat();
        if (qualifiedTeams.length < 4) {
          throw new AppError('Not enough teams qualified for bracket', 400);
        }

        // Sort qualified teams and create bracket
        const sortedTeams = qualifiedTeams
          .sort((a, b) => {
            if (b.point !== a.point) return b.point - a.point;
            if (b.selisih !== a.selisih) return b.selisih - a.selisih;
            return b.goal_masuk - a.goal_masuk;
          })
          .slice(0, 4);

        // Create semifinal matches
        const semifinals = [
          { team_1: sortedTeams[0].id_team, team_2: sortedTeams[3].id_team, kode: 'SF1' },
          { team_1: sortedTeams[1].id_team, team_2: sortedTeams[2].id_team, kode: 'SF2' }
        ];

        const createdMatches = [];

        for (const match of semifinals) {
          // Insert match
          const matchQuery = `
            INSERT INTO matches (
              id_kategori, team_1, team_2, grup, status, 
              skor_1, skor_2, created_by
            ) VALUES (?, ?, ?, 'semifinal', 'belum_main', 0, 0, ?)
          `;

          const [matchResult] = await connection.query(matchQuery, [
            id_kategori, match.team_1, match.team_2, userId
          ]);

          // Insert bracket entry
          const bracketQuery = `
            INSERT INTO brackets (
              id_kategori, round, kode, team_1, team_2, 
              match_id, status
            ) VALUES (?, 'semifinal', ?, ?, ?, ?, 'belum_main')
          `;

          await connection.query(bracketQuery, [
            id_kategori, match.kode, match.team_1, match.team_2, matchResult.insertId
          ]);

          createdMatches.push({
            id: matchResult.insertId,
            round: 'semifinal',
            kode: match.kode,
            team_1: match.team_1,
            team_2: match.team_2
          });
        }

        // Create placeholder brackets for final and 3rd place
        const finalBrackets = [
          { round: 'final', kode: 'F1' },
          { round: 'juara_3', kode: 'J3' }
        ];

        for (const bracket of finalBrackets) {
          const bracketQuery = `
            INSERT INTO brackets (
              id_kategori, round, kode, status
            ) VALUES (?, ?, ?, 'menunggu')
          `;

          await connection.query(bracketQuery, [
            id_kategori, bracket.round, bracket.kode
          ]);
        }

        logger.info('Bracket matches generated', { 
          kategori: id_kategori, 
          type,
          semifinalCount: createdMatches.length,
          userId 
        });

        return {
          semifinals: createdMatches,
          message: 'Semifinal matches created, final matches will be generated after semifinals complete'
        };
      } catch (error) {
        logger.error('Error generating bracket matches:', error);
        throw error;
      }
    });
  }

  async getMatchesByCategory(kategoriId) {
    try {
      const query = `
        SELECT 
          m.*,
          t1.nama_club AS team1_name,
          t1.logo_club AS team1_logo,
          t2.nama_club AS team2_name,
          t2.logo_club AS team2_logo
        FROM matches m
        LEFT JOIN teams t1 ON m.team_1 = t1.id
        LEFT JOIN teams t2 ON m.team_2 = t2.id
        WHERE m.id_kategori = ?
        ORDER BY m.waktu ASC
      `;

      const matches = await database.query(query, [kategoriId]);
      return matches;
    } catch (error) {
      logger.error('Error fetching matches by category:', error);
      throw new AppError('Failed to fetch matches by category', 500);
    }
  }

  async getMatchesByTeam(teamId, kategoriId = null) {
    try {
      let query = `
        SELECT 
          m.*,
          t1.nama_club AS team1_name,
          t1.logo_club AS team1_logo,
          t2.nama_club AS team2_name,
          t2.logo_club AS team2_logo,
          ec.nama_kategori,
          e.nama_event
        FROM matches m
        LEFT JOIN teams t1 ON m.team_1 = t1.id
        LEFT JOIN teams t2 ON m.team_2 = t2.id
        LEFT JOIN event_categories ec ON m.id_kategori = ec.id
        LEFT JOIN events e ON ec.id_event = e.id
        WHERE (m.team_1 = ? OR m.team_2 = ?)
      `;

      const params = [teamId, teamId];

      if (kategoriId) {
        query += ' AND m.id_kategori = ?';
        params.push(kategoriId);
      }

      query += ' ORDER BY m.waktu DESC';

      const matches = await database.query(query, params);
      return matches;
    } catch (error) {
      logger.error('Error fetching matches by team:', error);
      throw new AppError('Failed to fetch matches by team', 500);
    }
  }

  async getUpcomingMatches(limit = 10) {
    try {
      const query = `
        SELECT 
          m.*,
          t1.nama_club AS team1_name,
          t1.logo_club AS team1_logo,
          t2.nama_club AS team2_name,
          t2.logo_club AS team2_logo,
          ec.nama_kategori,
          e.nama_event
        FROM matches m
        LEFT JOIN teams t1 ON m.team_1 = t1.id
        LEFT JOIN teams t2 ON m.team_2 = t2.id
        LEFT JOIN event_categories ec ON m.id_kategori = ec.id
        LEFT JOIN events e ON ec.id_event = e.id
        WHERE m.status = 'belum_main' 
        AND m.waktu > NOW()
        ORDER BY m.waktu ASC
        LIMIT ?
      `;

      const matches = await database.query(query, [limit]);
      return matches;
    } catch (error) {
      logger.error('Error fetching upcoming matches:', error);
      throw new AppError('Failed to fetch upcoming matches', 500);
    }
  }

  async getMatchStatistics(id) {
    try {
      const statsQuery = `
        SELECT 
          me.id_team,
          me.jenis,
          COUNT(*) as count,
          t.nama_club AS team_name
        FROM match_events me
        JOIN teams t ON me.id_team = t.id
        WHERE me.id_match = ?
        GROUP BY me.id_team, me.jenis, t.nama_club
        ORDER BY me.id_team, me.jenis
      `;

      const stats = await database.query(statsQuery, [id]);

      // Format statistics
      const teamStats = {};
      stats.forEach(stat => {
        if (!teamStats[stat.id_team]) {
          teamStats[stat.id_team] = {
            team_name: stat.team_name,
            goals: 0,
            yellow_cards: 0,
            red_cards: 0,
            own_goals: 0
          };
        }

        switch (stat.jenis) {
          case 'GOL':
            teamStats[stat.id_team].goals = stat.count;
            break;
          case 'KUNING':
            teamStats[stat.id_team].yellow_cards = stat.count;
            break;
          case 'MERAH':
            teamStats[stat.id_team].red_cards = stat.count;
            break;
          case 'BUNUH_DIRI':
            teamStats[stat.id_team].own_goals = stat.count;
            break;
        }
      });

      return teamStats;
    } catch (error) {
      logger.error('Error fetching match statistics:', error);
      throw new AppError('Failed to fetch match statistics', 500);
    }
  }
}

module.exports = MatchService;