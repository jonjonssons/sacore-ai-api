const Task = require('../models/Task');
const { StatusCodes } = require('http-status-codes');
const { BadRequestError, NotFoundError } = require('../errors');

// Create a new task
const createTask = async (req, res) => {
    try {
        const { title, description, priority, dueDate, campaign, campaignId, type } = req.body;

        // Validate required fields
        if (!title || !title.trim()) {
            throw new BadRequestError('Title is required');
        }

        // Validate priority if provided
        if (priority && !['low', 'medium', 'high'].includes(priority)) {
            throw new BadRequestError('Priority must be low, medium, or high');
        }

        // Validate type if provided
        if (type && type !== 'manual') {
            throw new BadRequestError('Type must be manual');
        }

        // Validate dueDate if provided
        if (dueDate) {
            const parsedDate = new Date(dueDate);
            if (isNaN(parsedDate.getTime())) {
                throw new BadRequestError('Invalid due date format. Use YYYY-MM-DD');
            }
            const today = new Date().setHours(0, 0, 0, 0);
            if (parsedDate.getTime() < today) {
                throw new BadRequestError('Due date cannot be in the past');
            }
        }

        const taskData = {
            title: title.trim(),
            description: description ? description.trim() : undefined,
            priority: priority || 'medium',
            dueDate: dueDate ? new Date(dueDate) : undefined,
            campaign: campaign ? campaign.trim() : undefined,
            campaignId: campaignId || undefined, // Add campaignId field
            type: type || 'manual',
            userId: req.user.userId,
            createdBy: req.user.userId
        };

        const task = await Task.create(taskData);
        await task.populate('createdBy', 'name email');
        await task.populate('campaignId', '_id name');

        res.status(StatusCodes.CREATED).json({
            message: 'Task created successfully',
            task
        });
    } catch (error) {
        if (error.name === 'ValidationError') {
            const errorMessage = Object.values(error.errors).map(err => err.message).join(', ');
            throw new BadRequestError(errorMessage);
        }
        throw error;
    }
};

// Get all tasks for the authenticated user
const getAllTasks = async (req, res) => {
    try {
        const {
            status,
            priority,
            campaign,
            dueDate,
            overdue,
            page = 1,
            limit = 20,
            sortBy = 'createdAt',
            sortOrder = 'desc'
        } = req.query;

        // Build filter object
        const filter = { userId: req.user.userId };

        // Exclude completed tasks by default unless specifically requested
        if (!status) {
            filter.status = { $ne: 'completed' };
        } else {
            if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
                throw new BadRequestError('Invalid status filter');
            }
            filter.status = status;
        }

        if (priority) {
            if (!['low', 'medium', 'high'].includes(priority)) {
                throw new BadRequestError('Invalid priority filter');
            }
            filter.priority = priority;
        }

        if (campaign) {
            filter.campaign = { $regex: campaign, $options: 'i' };
        }

        if (dueDate) {
            const date = new Date(dueDate);
            if (isNaN(date.getTime())) {
                throw new BadRequestError('Invalid due date format');
            }
            filter.dueDate = {
                $gte: new Date(date.setHours(0, 0, 0, 0)),
                $lt: new Date(date.setHours(23, 59, 59, 999))
            };
        }

        if (overdue === 'true') {
            filter.dueDate = { $lt: new Date() };
            filter.status = { $nin: ['completed', 'cancelled'] };
        }

        // Build sort object
        const sort = {};
        const validSortFields = ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title', 'status'];
        if (validSortFields.includes(sortBy)) {
            sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
        } else {
            sort.createdAt = -1;
        }

        // Add secondary sort for consistency
        if (sortBy !== 'createdAt') {
            sort.createdAt = -1;
        }

        // Pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const limitNum = Math.min(parseInt(limit), 100); // Max 100 items per page

        const [tasks, totalCount] = await Promise.all([
            Task.find(filter)
                .populate('createdBy', 'name email')
                .populate('campaignId', '_id name') // Populate campaign details directly
                .sort(sort)
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Task.countDocuments(filter)
        ]);

        // Enhance tasks with campaign information
        const enhancedTasks = tasks.map(task => ({
            ...task,
            campaignDetails: task.campaignId ? {
                id: task.campaignId._id,
                name: task.campaignId.name
            } : {
                id: null,
                name: task.campaign || null // Fallback to the campaign string field
            }
        }));

        const totalPages = Math.ceil(totalCount / limitNum);

        res.status(StatusCodes.OK).json({
            tasks: enhancedTasks,
            pagination: {
                currentPage: parseInt(page),
                totalPages,
                totalCount,
                hasNext: parseInt(page) < totalPages,
                hasPrev: parseInt(page) > 1
            },
            filters: {
                status,
                priority,
                campaign,
                dueDate,
                overdue
            }
        });
    } catch (error) {
        throw error;
    }
};

// Get task by ID
const getTaskById = async (req, res) => {
    try {
        const { id } = req.params;

        const task = await Task.findOne({
            _id: id,
            userId: req.user.userId
        }).populate('createdBy', 'name email')
            .populate('campaignId', '_id name');

        if (!task) {
            throw new NotFoundError('Task not found');
        }

        res.status(StatusCodes.OK).json({ task });
    } catch (error) {
        if (error.name === 'CastError') {
            throw new NotFoundError('Task not found');
        }
        throw error;
    }
};

// Update task
const updateTask = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, priority, dueDate, campaign, campaignId, type, status } = req.body;

        const task = await Task.findOne({
            _id: id,
            userId: req.user.userId
        });

        if (!task) {
            throw new NotFoundError('Task not found');
        }

        // Validate fields if provided
        if (priority && !['low', 'medium', 'high'].includes(priority)) {
            throw new BadRequestError('Priority must be low, medium, or high');
        }

        if (type && type !== 'manual') {
            throw new BadRequestError('Type must be manual');
        }

        if (status && !['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
            throw new BadRequestError('Status must be pending, in_progress, completed, or cancelled');
        }

        if (dueDate) {
            const parsedDate = new Date(dueDate);
            if (isNaN(parsedDate.getTime())) {
                throw new BadRequestError('Invalid due date format. Use YYYY-MM-DD');
            }
            const today = new Date().setHours(0, 0, 0, 0);
            if (parsedDate.getTime() < today) {
                throw new BadRequestError('Due date cannot be in the past');
            }
        }

        // Update fields
        if (title !== undefined) task.title = title.trim();
        if (description !== undefined) task.description = description ? description.trim() : '';
        if (priority !== undefined) task.priority = priority;
        if (dueDate !== undefined) task.dueDate = dueDate ? new Date(dueDate) : null;
        if (campaign !== undefined) task.campaign = campaign ? campaign.trim() : '';
        if (campaignId !== undefined) task.campaignId = campaignId || null;
        if (type !== undefined) task.type = type;
        if (status !== undefined) task.status = status;

        await task.save();
        await task.populate('createdBy', 'name email');
        await task.populate('campaignId', '_id name');

        // DEBUG: Log task details before webhook check
        console.log(`🔍 TASK UPDATE DEBUG:`, {
            taskId: task._id,
            status: status,
            taskStatus: task.status,
            hasExecutionId: !!task.executionId,
            executionId: task.executionId
        });

        // If task was marked as completed and has executionId, trigger webhook
        if (status === 'completed' && task.executionId) {
            try {
                console.log(`🎯 Task ${task._id} completed - triggering webhook for execution ${task.executionId}`);

                // Make internal webhook call to resume campaign
                const webhookPayload = {
                    taskId: task._id.toString(),
                    executionId: task.executionId.toString(),
                    status: 'completed'
                };

                // Import the campaign service directly for internal call
                const campaignService = require('../services/campaignService');
                await campaignService.resumeExecutionAfterTask(
                    task.executionId.toString(),
                    task._id.toString()
                );

                console.log(`✅ Campaign execution resumed successfully for task ${task._id}`);
            } catch (webhookError) {
                console.error('❌ Failed to trigger campaign resume:', webhookError);
                console.error('❌ Webhook error details:', webhookError.message);
                console.error('❌ Webhook error stack:', webhookError.stack);
                // Don't fail the task update if webhook fails
            }
        } else {
            console.log(`⚠️ Webhook NOT triggered:`, {
                statusIsCompleted: status === 'completed',
                hasExecutionId: !!task.executionId,
                reason: !task.executionId ? 'No executionId' : status !== 'completed' ? 'Status not completed' : 'Unknown'
            });
        }

        res.status(StatusCodes.OK).json({
            message: 'Task updated successfully',
            task
        });
    } catch (error) {
        if (error.name === 'CastError') {
            throw new NotFoundError('Task not found');
        }
        if (error.name === 'ValidationError') {
            const errorMessage = Object.values(error.errors).map(err => err.message).join(', ');
            throw new BadRequestError(errorMessage);
        }
        throw error;
    }
};

// Delete task
const deleteTask = async (req, res) => {
    try {
        const { id } = req.params;

        const task = await Task.findOneAndDelete({
            _id: id,
            userId: req.user.userId
        });

        if (!task) {
            throw new NotFoundError('Task not found');
        }

        res.status(StatusCodes.OK).json({
            message: 'Task deleted successfully',
            taskId: id
        });
    } catch (error) {
        if (error.name === 'CastError') {
            throw new NotFoundError('Task not found');
        }
        throw error;
    }
};

// Get task statistics
const getTaskStats = async (req, res) => {
    try {
        const userId = req.user.userId;

        const stats = await Task.aggregate([
            { $match: { userId: userId } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]);

        const priorityStats = await Task.aggregate([
            { $match: { userId: userId, status: { $nin: ['completed', 'cancelled'] } } },
            {
                $group: {
                    _id: '$priority',
                    count: { $sum: 1 }
                }
            }
        ]);

        const overdueCount = await Task.countDocuments({
            userId: userId,
            dueDate: { $lt: new Date() },
            status: { $nin: ['completed', 'cancelled'] }
        });

        const dueTodayCount = await Task.countDocuments({
            userId: userId,
            dueDate: {
                $gte: new Date().setHours(0, 0, 0, 0),
                $lt: new Date().setHours(23, 59, 59, 999)
            },
            status: { $nin: ['completed', 'cancelled'] }
        });

        // Format stats
        const statusCounts = {
            pending: 0,
            in_progress: 0,
            completed: 0,
            cancelled: 0
        };

        stats.forEach(stat => {
            statusCounts[stat._id] = stat.count;
        });

        const priorityCounts = {
            low: 0,
            medium: 0,
            high: 0
        };

        priorityStats.forEach(stat => {
            priorityCounts[stat._id] = stat.count;
        });

        res.status(StatusCodes.OK).json({
            statusCounts,
            priorityCounts,
            overdueCount,
            dueTodayCount,
            totalActive: statusCounts.pending + statusCounts.in_progress,
            totalCompleted: statusCounts.completed
        });
    } catch (error) {
        throw error;
    }
};

// Bulk update tasks
const bulkUpdateTasks = async (req, res) => {
    try {
        const { taskIds, updates } = req.body;

        if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
            throw new BadRequestError('Task IDs array is required');
        }

        if (!updates || typeof updates !== 'object') {
            throw new BadRequestError('Updates object is required');
        }

        // Validate updates
        const allowedUpdates = ['status', 'priority', 'campaign'];
        const updateKeys = Object.keys(updates);
        const isValidUpdate = updateKeys.every(key => allowedUpdates.includes(key));

        if (!isValidUpdate) {
            throw new BadRequestError(`Invalid update fields. Allowed: ${allowedUpdates.join(', ')}`);
        }

        if (updates.status && !['pending', 'in_progress', 'completed', 'cancelled'].includes(updates.status)) {
            throw new BadRequestError('Invalid status value');
        }

        if (updates.priority && !['low', 'medium', 'high'].includes(updates.priority)) {
            throw new BadRequestError('Invalid priority value');
        }

        // If updating status to completed, we need to handle webhooks for each task
        if (updates.status === 'completed') {
            // Get tasks that will be updated to completed and have executionId
            const tasksToComplete = await Task.find({
                _id: { $in: taskIds },
                userId: req.user.userId,
                executionId: { $exists: true, $ne: null }
            });

            console.log(`🔍 BULK UPDATE DEBUG: Found ${tasksToComplete.length} tasks with executionId to complete`);

            // Update the tasks
            const result = await Task.updateMany(
                {
                    _id: { $in: taskIds },
                    userId: req.user.userId
                },
                { $set: updates }
            );

            // Trigger webhooks for tasks that have executionId
            for (const task of tasksToComplete) {
                try {
                    console.log(`🎯 Bulk update: Task ${task._id} completed - triggering webhook for execution ${task.executionId}`);

                    const campaignService = require('../services/campaignService');
                    await campaignService.resumeExecutionAfterTask(
                        task.executionId.toString(),
                        task._id.toString()
                    );

                    console.log(`✅ Bulk update: Campaign execution resumed successfully for task ${task._id}`);
                } catch (webhookError) {
                    console.error(`❌ Bulk update: Failed to trigger campaign resume for task ${task._id}:`, webhookError);
                    // Don't fail the bulk update if webhook fails
                }
            }

            res.status(StatusCodes.OK).json({
                message: 'Tasks updated successfully',
                modifiedCount: result.modifiedCount,
                matchedCount: result.matchedCount,
                webhooksTriggered: tasksToComplete.length
            });
        } else {
            // Regular bulk update without webhook handling
            const result = await Task.updateMany(
                {
                    _id: { $in: taskIds },
                    userId: req.user.userId
                },
                { $set: updates }
            );

            res.status(StatusCodes.OK).json({
                message: 'Tasks updated successfully',
                modifiedCount: result.modifiedCount,
                matchedCount: result.matchedCount
            });
        }
    } catch (error) {
        throw error;
    }
};

// Bulk delete tasks
const bulkDeleteTasks = async (req, res) => {
    try {
        const { taskIds } = req.body;

        if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
            throw new BadRequestError('Task IDs array is required');
        }

        // Validate that all IDs are valid ObjectId format
        const invalidIds = taskIds.filter(id => {
            try {
                return !id.match(/^[0-9a-fA-F]{24}$/);
            } catch {
                return true;
            }
        });

        if (invalidIds.length > 0) {
            throw new BadRequestError(`Invalid task IDs: ${invalidIds.join(', ')}`);
        }

        // Delete tasks that belong to the authenticated user
        const result = await Task.deleteMany({
            _id: { $in: taskIds },
            userId: req.user.userId
        });

        res.status(StatusCodes.OK).json({
            message: 'Tasks deleted successfully',
            deletedCount: result.deletedCount,
            requestedCount: taskIds.length
        });
    } catch (error) {
        throw error;
    }
};

module.exports = {
    createTask,
    getAllTasks,
    getTaskById,
    updateTask,
    deleteTask,
    getTaskStats,
    bulkUpdateTasks,
    bulkDeleteTasks
}; 