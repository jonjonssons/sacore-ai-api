const express = require('express');
const router = express.Router();
const campaignService = require('../services/campaignService');
const { StatusCodes } = require('http-status-codes');

// Webhook endpoint for task completion
router.post('/task-completed', async (req, res) => {
    try {
        const { taskId, executionId, status } = req.body;

        if (!taskId || !executionId || status !== 'completed') {
            return res.status(StatusCodes.BAD_REQUEST).json({
                error: 'Invalid webhook payload. Required: taskId, executionId, status=completed'
            });
        }

        console.log(`🎯 WEBHOOK: Task ${taskId} completed, resuming execution ${executionId}`);

        // Resume campaign execution
        await campaignService.resumeExecutionAfterTask(executionId, taskId);

        res.status(StatusCodes.OK).json({
            message: 'Task completion processed successfully',
            taskId,
            executionId
        });

    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: 'Failed to process task completion webhook'
        });
    }
});

module.exports = router;
