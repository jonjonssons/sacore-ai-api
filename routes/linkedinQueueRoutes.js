const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authentication');
const {
  addInvitationJob,
  getQueueStats,
  getQueueDetails,
  clearQueue,
  getUserRateLimits,
  isWorkingHours,
  getNextWorkingHour,
  RATE_LIMITS,
  WORKING_HOURS
} = require('../services/linkedinInvitationQueue');

// Import message queue functions
const {
  addMessageJob,
  getQueueStats: getMessageQueueStats,
  getQueueDetails: getMessageQueueDetails,
  clearQueue: clearMessageQueue,
  getUserRateLimits: getMessageUserRateLimits,
  isWorkingHours: isMessageWorkingHours,
  getNextWorkingHour: getMessageNextWorkingHour,
  RATE_LIMITS: MESSAGE_RATE_LIMITS,
  WORKING_HOURS: MESSAGE_WORKING_HOURS
} = require('../services/linkedinMessageQueue');

// ================================
// INVITATION QUEUE ENDPOINTS
// ================================

// Get invitation queue statistics
router.get('/invitations/stats', authenticateUser, async (req, res) => {
  try {
    const stats = await getQueueStats();
    const userRateLimits = await getUserRateLimits(req.user.id);
    const workingHours = {
      isWorkingHours: isWorkingHours(),
      nextWorkingHour: isWorkingHours() ? null : getNextWorkingHour().toISOString(),
      schedule: `${WORKING_HOURS.START}:00 - ${WORKING_HOURS.END}:00 (Mon-Fri)`,
    };

    res.json({
      success: true,
      data: {
        queue: stats,
        rateLimits: {
          ...userRateLimits,
          limits: RATE_LIMITS,
        },
        workingHours,
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting invitation queue stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Legacy endpoint (for backward compatibility)
router.get('/stats', authenticateUser, async (req, res) => {
  try {
    const stats = await getQueueStats();
    const userRateLimits = await getUserRateLimits(req.user.id);
    const workingHours = {
      isWorkingHours: isWorkingHours(),
      nextWorkingHour: isWorkingHours() ? null : getNextWorkingHour().toISOString(),
      schedule: `${WORKING_HOURS.START}:00 - ${WORKING_HOURS.END}:00 (Mon-Fri)`,
    };

    res.json({
      success: true,
      data: {
        queue: stats,
        rateLimits: {
          ...userRateLimits,
          limits: RATE_LIMITS,
        },
        workingHours,
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting queue stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed queue information
router.get('/details', authenticateUser, async (req, res) => {
  try {
    const details = await getQueueDetails();
    const userRateLimits = await getUserRateLimits(req.user.id);

    res.json({
      success: true,
      data: {
        ...details,
        userRateLimits,
        workingHours: {
          isWorkingHours: isWorkingHours(),
          nextWorkingHour: isWorkingHours() ? null : getNextWorkingHour().toISOString(),
          schedule: `${WORKING_HOURS.START}:00 - ${WORKING_HOURS.END}:00 (Mon-Fri)`,
        },
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting queue details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clear queue (admin only or user's own jobs)
router.delete('/clear', authenticateUser, async (req, res) => {
  try {
    // For now, allow users to clear the entire queue
    // In production, you might want to filter by user ID
    const result = await clearQueue();

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add invitation to queue
router.post('/add-invitation', authenticateUser, async (req, res) => {
  try {
    const { profileUrl, message, campaignId, prospectId } = req.body;

    if (!profileUrl) {
      return res.status(400).json({
        success: false,
        error: 'Profile URL is required'
      });
    }

    const jobData = {
      userId: req.user.id,
      profileUrl,
      message: message || '',
      campaignId,
      prospectId,
    };

    const result = await addInvitationJob(jobData);

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error adding invitation to queue:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get user's rate limit status
router.get('/rate-limits', authenticateUser, async (req, res) => {
  try {
    const rateLimits = await getUserRateLimits(req.user.id);

    res.json({
      success: true,
      data: {
        rateLimits: {
          ...rateLimits,
          limits: RATE_LIMITS,
        },
        workingHours: {
          isWorkingHours: isWorkingHours(),
          nextWorkingHour: isWorkingHours() ? null : getNextWorkingHour().toISOString(),
          schedule: `${WORKING_HOURS.START}:00 - ${WORKING_HOURS.END}:00 (Mon-Fri)`,
        },
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting rate limits:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================================
// MESSAGE QUEUE ENDPOINTS
// ================================

// Get message queue statistics
router.get('/messages/stats', authenticateUser, async (req, res) => {
  try {
    const stats = await getMessageQueueStats();
    const userRateLimits = await getMessageUserRateLimits(req.user.id);
    const workingHours = {
      isWorkingHours: isMessageWorkingHours(),
      nextWorkingHour: isMessageWorkingHours() ? null : getMessageNextWorkingHour().toISOString(),
      schedule: `${MESSAGE_WORKING_HOURS.START}:00 - ${MESSAGE_WORKING_HOURS.END}:00 (Mon-Fri)`,
    };

    res.json({
      success: true,
      data: {
        queue: stats,
        rateLimits: {
          ...userRateLimits,
          limits: MESSAGE_RATE_LIMITS,
        },
        workingHours,
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting message queue stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed message queue information
router.get('/messages/details', authenticateUser, async (req, res) => {
  try {
    const details = await getMessageQueueDetails();
    const userRateLimits = await getMessageUserRateLimits(req.user.id);

    res.json({
      success: true,
      data: {
        ...details,
        userRateLimits,
        workingHours: {
          isWorkingHours: isMessageWorkingHours(),
          nextWorkingHour: isMessageWorkingHours() ? null : getMessageNextWorkingHour().toISOString(),
          schedule: `${MESSAGE_WORKING_HOURS.START}:00 - ${MESSAGE_WORKING_HOURS.END}:00 (Mon-Fri)`,
        },
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting message queue details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clear message queue (admin only or user's own jobs)
router.delete('/messages/clear', authenticateUser, async (req, res) => {
  try {
    const result = await clearMessageQueue();

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error clearing message queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add message to queue
router.post('/add-message', authenticateUser, async (req, res) => {
  try {
    const { targetProfileUrn, profileUrl, message, campaignId, prospectId } = req.body;

    if (!profileUrl || !message) {
      return res.status(400).json({
        success: false,
        error: 'Profile URL and message are required'
      });
    }

    const jobData = {
      userId: req.user.id,
      targetProfileUrn,
      profileUrl,
      message,
      campaignId,
      prospectId,
    };

    const result = await addMessageJob(jobData);

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error adding message to queue:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// Get user's message rate limit status
router.get('/messages/rate-limits', authenticateUser, async (req, res) => {
  try {
    const rateLimits = await getMessageUserRateLimits(req.user.id);

    res.json({
      success: true,
      data: {
        rateLimits: {
          ...rateLimits,
          limits: MESSAGE_RATE_LIMITS,
        },
        workingHours: {
          isWorkingHours: isMessageWorkingHours(),
          nextWorkingHour: isMessageWorkingHours() ? null : getMessageNextWorkingHour().toISOString(),
          schedule: `${MESSAGE_WORKING_HOURS.START}:00 - ${MESSAGE_WORKING_HOURS.END}:00 (Mon-Fri)`,
        },
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting message rate limits:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ================================
// COMBINED QUEUE ENDPOINTS
// ================================

// Get both invitation and message queue stats
router.get('/combined/stats', authenticateUser, async (req, res) => {
  try {
    const [invitationStats, messageStats] = await Promise.all([
      getQueueStats(),
      getMessageQueueStats()
    ]);

    const [invitationRateLimits, messageRateLimits] = await Promise.all([
      getUserRateLimits(req.user.id),
      getMessageUserRateLimits(req.user.id)
    ]);

    const workingHours = {
      isWorkingHours: isWorkingHours(),
      nextWorkingHour: isWorkingHours() ? null : getNextWorkingHour().toISOString(),
      schedule: `${WORKING_HOURS.START}:00 - ${WORKING_HOURS.END}:00 (Mon-Fri)`,
    };

    res.json({
      success: true,
      data: {
        invitations: {
          queue: invitationStats,
          rateLimits: {
            ...invitationRateLimits,
            limits: RATE_LIMITS,
          },
        },
        messages: {
          queue: messageStats,
          rateLimits: {
            ...messageRateLimits,
            limits: MESSAGE_RATE_LIMITS,
          },
        },
        workingHours,
        timestamp: new Date().toISOString(),
      }
    });
  } catch (error) {
    console.error('Error getting combined queue stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
