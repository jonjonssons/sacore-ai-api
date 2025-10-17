const Profiles = require('../models/Profiles');
const Projects = require('../models/Projects');

// Create a new profile or multiple profiles under a project
exports.createProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        const profilesData = Array.isArray(req.body) ? req.body : [req.body];

        if (profilesData.length === 0) {
            return res.status(400).json({ error: 'Request body is empty' });
        }

        // 1. Check all projects exist and belong to the user
        const uniqueProjectIds = [...new Set(profilesData.map(p => p.projectId))];

        const ownedProjects = await Projects.find({
            _id: { $in: uniqueProjectIds },
            userId,
        }).select('_id');

        const ownedProjectIds = ownedProjects.map(p => p._id.toString());

        const unauthorizedProjects = uniqueProjectIds.filter(pid => !ownedProjectIds.includes(pid));
        if (unauthorizedProjects.length > 0) {
            return res.status(403).json({
                error: `Access denied or projects not found: ${unauthorizedProjects.join(', ')}`,
            });
        }

        // 2. Check for existing profiles by linkedinUrl AND projectId
        const profileConditions = profilesData.map(p => ({
            linkedinUrl: p.linkedinUrl,
            projectId: p.projectId
        }));

        const existingProfiles = await Profiles.find({
            $or: profileConditions
        }).select('linkedinUrl projectId');

        const existingPairs = new Set(existingProfiles.map(p => `${p.projectId}_${p.linkedinUrl}`));

        // 3. Filter out duplicates within the same project
        const newProfiles = profilesData.filter(p => {
            const key = `${p.projectId}_${p.linkedinUrl}`;
            return !existingPairs.has(key);
        });

        if (newProfiles.length === 0) {
            if (profilesData.length === 1) {
                return res.status(200).json({ message: 'The profile already exists in the selected project' });
            } else {
                return res.status(200).json({ message: `${profilesData.length} profiles already exist in the selected project` });
            }
        }

        // 4. Insert only new profiles
        const createdProfiles = await Profiles.insertMany(newProfiles);
        const alreadyExistsCount = profilesData.length - newProfiles.length;
        let message = `${createdProfiles.length} profile${createdProfiles.length === 1 ? '' : 's'} saved successfully`;
        if (alreadyExistsCount > 0) {
            message += `, ${alreadyExistsCount} profile${alreadyExistsCount === 1 ? '' : 's'} already existed`;
        }
        res.status(201).json({
            message,
            profiles: createdProfiles
        });

    } catch (error) {
        // Handle MongoDB duplicate key error (code 11000)
        if (error.code === 11000) {
            console.log('⚠️ Duplicate profile detected:', error.keyValue);
            return res.status(200).json({
                message: 'One or more profiles already exist in this project',
                error: 'Duplicate profile detected',
                duplicate: error.keyValue
            });
        }

        console.error('Error in createProfile:', error);
        res.status(500).json({ error: error.message });
    }
};



// Get all profiles for a project
exports.getProfilesByProject = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { projectId } = req.params;

        // Verify project belongs to user
        const project = await Projects.findOne({ _id: projectId, userId });
        if (!project) {
            return res.status(404).json({ error: 'Project not found or access denied' });
        }

        const profiles = await Profiles.find({ projectId });
        res.json(profiles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Get a profile by id
exports.getProfileById = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { id } = req.params;

        const profile = await Profiles.findById(id);
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Verify project ownership
        const project = await Projects.findOne({ _id: profile.projectId, userId });
        if (!project) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json(profile);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Update a profile by id
exports.updateProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { id } = req.params;
        const updateData = req.body;

        console.log('=== PROFILE UPDATE DEBUG ===');
        console.log('Profile ID:', id);
        console.log('Update data received:', JSON.stringify(updateData, null, 2));

        const profile = await Profiles.findById(id);
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Verify project ownership
        const project = await Projects.findOne({ _id: profile.projectId, userId });
        if (!project) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Prepare validated update object
        const validatedUpdate = {};

        // Handle basic profile fields
        if (updateData.name !== undefined) {
            validatedUpdate.name = updateData.name;
        }

        if (updateData.title !== undefined) {
            validatedUpdate.title = updateData.title;
        }

        if (updateData.company !== undefined) {
            validatedUpdate.company = updateData.company;
        }

        if (updateData.location !== undefined) {
            validatedUpdate.location = updateData.location;
        }

        if (updateData.linkedinUrl !== undefined) {
            validatedUpdate.linkedinUrl = updateData.linkedinUrl;
        }

        if (updateData.email !== undefined) {
            validatedUpdate.email = updateData.email;
        }

        // Handle UID and SignalHire data
        if (updateData.uid !== undefined) {
            validatedUpdate.uid = updateData.uid;
        }

        if (updateData.signalhireData !== undefined) {
            validatedUpdate.signalhireData = updateData.signalhireData;
        }

        // Handle analysis data - transform from your payload structure
        if (updateData.analysisScore !== undefined ||
            updateData.analysisDescription !== undefined ||
            updateData.analysisBreakdown !== undefined) {

            validatedUpdate.analysis = {
                ...profile.analysis, // Preserve existing analysis data
                score: updateData.analysisScore,
                description: updateData.analysisDescription,
                breakdown: updateData.analysisBreakdown,
                updatedAt: new Date()
            };
        }

        // Handle nested analysis data from enrichedData
        if (updateData.analysis?.enrichedData) {
            validatedUpdate.signalhireData = updateData.analysis.enrichedData;

            // Extract UID if available
            if (updateData.analysis.enrichedData.uid) {
                validatedUpdate.uid = updateData.analysis.enrichedData.uid;
            }
        }

        // Handle relevance score
        if (updateData.relevanceScore !== undefined) {
            validatedUpdate.relevanceScore = updateData.relevanceScore;
        }

        // Handle matched categories
        if (updateData.matchedCategories !== undefined) {
            validatedUpdate.matchedCategories = updateData.matchedCategories;
        }

        if (updateData.matchedCategoriesValue !== undefined) {
            validatedUpdate.matchedCategoriesValue = updateData.matchedCategoriesValue;
        }

        console.log('Validated update object:', JSON.stringify(validatedUpdate, null, 2));

        // Apply updates
        Object.assign(profile, validatedUpdate);
        await profile.save();

        console.log('Profile updated successfully:', profile._id);

        res.json({
            success: true,
            message: 'Profile updated successfully',
            profile
        });

    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

// Delete a profile by id
exports.deleteProfile = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { id } = req.params;

        const profile = await Profiles.findById(id);
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Verify project ownership
        const project = await Projects.findOne({ _id: profile.projectId, userId });
        if (!project) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await profile.deleteOne();
        res.json({ message: 'Profile deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Delete multiple profiles by ids
exports.deleteMultipleProfiles = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { profileIds } = req.body;

        // Validate input
        if (!Array.isArray(profileIds) || profileIds.length === 0) {
            return res.status(400).json({
                error: 'profileIds must be a non-empty array'
            });
        }

        // Find all profiles to delete
        const profiles = await Profiles.find({
            _id: { $in: profileIds }
        });

        if (profiles.length === 0) {
            return res.status(404).json({ error: 'No profiles found' });
        }

        // Get unique project IDs from the profiles
        const projectIds = [...new Set(profiles.map(profile => profile.projectId.toString()))];

        // Verify all projects belong to the user
        const userProjects = await Projects.find({
            _id: { $in: projectIds },
            userId
        }).select('_id');

        const userProjectIds = userProjects.map(project => project._id.toString());

        // Check if user owns all the projects
        const unauthorizedProjects = projectIds.filter(projectId =>
            !userProjectIds.includes(projectId)
        );

        if (unauthorizedProjects.length > 0) {
            return res.status(403).json({
                error: 'Access denied: Some profiles belong to projects you do not own'
            });
        }

        // Filter profiles that actually exist and belong to user's projects
        const validProfileIds = profiles
            .filter(profile => userProjectIds.includes(profile.projectId.toString()))
            .map(profile => profile._id);

        if (validProfileIds.length === 0) {
            return res.status(403).json({
                error: 'No valid profiles found that you have permission to delete'
            });
        }

        // Delete the profiles
        const deleteResult = await Profiles.deleteMany({
            _id: { $in: validProfileIds }
        });

        const notFoundCount = profileIds.length - profiles.length;
        const unauthorizedCount = profiles.length - validProfileIds.length;

        res.json({
            message: 'Profiles deletion completed',
            deleted: deleteResult.deletedCount,
            requested: profileIds.length,
            notFound: notFoundCount,
            unauthorized: unauthorizedCount,
            success: deleteResult.deletedCount > 0
        });

    } catch (error) {
        console.error('Error in deleteMultipleProfiles:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get all profiles for the authenticated user across all projects
exports.getAllProfilesForUser = async (req, res) => {
    try {
        const userId = req.user.userId;

        // First, get all project IDs that belong to this user
        const userProjects = await Projects.find({ userId }).select('_id');
        const projectIds = userProjects.map(project => project._id);

        if (projectIds.length === 0) {
            return res.status(200).json({
                success: true,
                count: 0,
                profiles: [],
                message: 'No projects found for this user'
            });
        }

        // Then, get all profiles that belong to those projects
        const profiles = await Profiles.find({
            projectId: { $in: projectIds }
        }).populate('projectId', 'name description');

        res.status(200).json({
            success: true,
            count: profiles.length,
            profiles
        });
    } catch (error) {
        console.error('Error getting all profiles for user:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve profiles'
        });
    }
};
