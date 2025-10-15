const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true,
        maxlength: [200, 'Title cannot exceed 200 characters']
    },
    description: {
        type: String,
        trim: true,
        maxlength: [1000, 'Description cannot exceed 1000 characters']
    },
    priority: {
        type: String,
        enum: {
            values: ['low', 'medium', 'high'],
            message: 'Priority must be low, medium, or high'
        },
        default: 'medium'
    },
    dueDate: {
        type: Date,
        validate: {
            validator: function (value) {
                // Allow null/undefined, but if provided, must be today or future
                if (!value) return true;
                return value >= new Date().setHours(0, 0, 0, 0);
            },
            message: 'Due date cannot be in the past'
        }
    },
    campaign: {
        type: String,
        trim: true,
        maxlength: [100, 'Campaign name cannot exceed 100 characters']
    },
    type: {
        type: String,
        enum: {
            values: ['manual'],
            message: 'Type must be manual'
        },
        default: 'manual'
    },
    status: {
        type: String,
        enum: {
            values: ['pending', 'in_progress', 'completed', 'cancelled'],
            message: 'Status must be pending, in_progress, completed, or cancelled'
        },
        default: 'pending'
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'User ID is required']
    },
    completedAt: {
        type: Date
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    // Link to campaign execution for manual tasks
    executionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CampaignExecution'
    },
    // Direct reference to campaign for efficient queries
    campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Campaign'
    },
    prospectId: {
        type: String
    },
    // Campaign pause tracking
    campaignPaused: { type: Boolean, default: false },
    pausedAt: Date
}, {
    timestamps: true,
    toJSON: {
        virtuals: true,
        transform: function (doc, ret) {
            delete ret.__v;
            return ret;
        }
    },
    toObject: { virtuals: true }
});

// Virtual for checking if task is overdue
taskSchema.virtual('isOverdue').get(function () {
    if (!this.dueDate || this.status === 'completed' || this.status === 'cancelled') {
        return false;
    }
    return this.dueDate < new Date();
});

// Virtual for days until due
taskSchema.virtual('daysUntilDue').get(function () {
    if (!this.dueDate) return null;
    const today = new Date().setHours(0, 0, 0, 0);
    const due = new Date(this.dueDate).setHours(0, 0, 0, 0);
    return Math.ceil((due - today) / (1000 * 60 * 60 * 24));
});

// Index for efficient queries
taskSchema.index({ userId: 1, status: 1 });
taskSchema.index({ userId: 1, dueDate: 1 });
taskSchema.index({ userId: 1, priority: 1 });
taskSchema.index({ userId: 1, campaign: 1 });

// Middleware to set completedAt when status changes to completed
taskSchema.pre('save', function (next) {
    if (this.isModified('status')) {
        if (this.status === 'completed' && !this.completedAt) {
            this.completedAt = new Date();
        } else if (this.status !== 'completed') {
            this.completedAt = undefined;
        }
    }
    next();
});

module.exports = mongoose.model('Task', taskSchema); 