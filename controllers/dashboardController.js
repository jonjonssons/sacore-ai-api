const SearchHistory = require('../models/SearchHistory');
const Projects = require('../models/Projects');
const Profiles = require('../models/Profiles');
const User = require('../models/User');

exports.getDashboardData = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Get user and organization information
        const user = await User.findById(userId).populate('organization');
        const organization = user.organization;

        // Get past searches sorted by most recent first
        const pastSearchesRaw = await SearchHistory.find({ userId }).sort({ createdAt: -1 });

        // Deduplicate searches by query (keep the most recent)
        const seenQueries = new Set();
        const pastSearches = [];

        for (const search of pastSearchesRaw) {
            if (!seenQueries.has(search.query)) {
                seenQueries.add(search.query);
                pastSearches.push(search);
            }
        }

        // Get projects (still user-scoped within organization)
        const projects = await Projects.find({ userId });

        // Get profile counts grouped by projectId
        const profileCounts = await Profiles.aggregate([
            { $match: { projectId: { $in: projects.map(p => p._id) } } },
            { $group: { _id: "$projectId", count: { $sum: 1 } } }
        ]);

        // Convert profileCounts array to a map
        const profileCountMap = {};
        profileCounts.forEach(pc => {
            profileCountMap[pc._id.toString()] = pc.count;
        });

        // Map projectId to project name
        const projectIdNameMap = {};
        projects.forEach(project => {
            projectIdNameMap[project._id.toString()] = project.name || 'Unnamed Project';
        });

        // Convert profileCountMap keys from projectId to project name
        const profileCountMapByName = {};
        Object.keys(profileCountMap).forEach(projectId => {
            const projectName = projectIdNameMap[projectId] || 'Unknown Project';
            profileCountMapByName[projectName] = profileCountMap[projectId];
        });

        // Calculate organization trial information (primary)
        let organizationTrialInfo = null;
        if (organization) {
            const orgTrialEndDate = new Date(organization.trialStartDate);
            orgTrialEndDate.setDate(orgTrialEndDate.getDate() + 7);

            organizationTrialInfo = {
                trialStartDate: organization.trialStartDate,
                trialEndDate: orgTrialEndDate,
                remainingTrialDays: organization.getRemainingTrialDays(),
                isTrialValid: organization.isTrialValid(),
                trialStatus: organization.trialEnded ? 'ended' : (organization.isTrialValid() ? 'active' : 'expired')
            };
        }

        // Calculate user trial information (for backward compatibility)
        const userTrialEndDate = new Date(user.trialStartDate);
        userTrialEndDate.setDate(userTrialEndDate.getDate() + 7);

        res.status(200).json({
            pastSearches,
            projects,
            profileCountMap: profileCountMapByName,
            userInfo: {
                // Organization-level info (primary)
                credits: organization ? organization.credits : user.credits,
                subscription: organization ? organization.subscription : user.subscription,
                billingInterval: organization ? organization.billingInterval : user.billingInterval,

                // Organization info
                organization: organization ? {
                    id: organization._id,
                    name: organization.name,
                    memberCount: organization.memberCount,
                    memberLimit: organization.getCurrentMemberLimit(),
                    remainingSlots: organization.getRemainingMemberSlots(),
                    canAddMembers: organization.canAddMembers(),
                    trialInfo: organizationTrialInfo
                } : null,

                // User's role in organization
                organizationRole: user.organizationRole,
                isOrganizationOwner: user.isOrganizationOwner,

                // Primary trial info (organization-level if available, user-level as fallback)
                trialInfo: organizationTrialInfo || {
                    trialStartDate: user.trialStartDate,
                    trialEndDate: userTrialEndDate,
                    remainingTrialDays: user.getRemainingTrialDays(),
                    isTrialValid: user.isTrialValid(),
                    trialStatus: user.trialEnded ? 'ended' : (user.isTrialValid() ? 'active' : 'expired')
                }
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
