const Projects = require('../models/Projects');
const Profiles = require('../models/Profiles');

exports.createProject = async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.userId;
        if (!name || !userId) {
            return res.status(400).json({ error: 'Name and userId are required' });
        }
        const project = new Projects({ name, userId });
        await project.save();
        res.status(201).json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getProjectById = async (req, res) => {
    try {
        const userId = req.user.userId;
        const project = await Projects.findOne({ _id: req.params.id, userId });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.updateProject = async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.userId;
        const project = await Projects.findOneAndUpdate(
            { _id: req.params.id, userId },
            { name },
            { new: true, runValidators: true }
        );
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.deleteProject = async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // Find the project first to ensure it exists
        const project = await Projects.findOne({ _id: req.params.id, userId });
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        
        // Delete all profiles associated with this project
        await Profiles.deleteMany({ projectId: req.params.id });
        
        // Delete the project
        await Projects.findOneAndDelete({ _id: req.params.id, userId });
        
        res.json({ message: 'Project and all associated profiles deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

exports.getProjectsByUserId = async (req, res) => {
    try {
        const userId = req.user.userId;
        const projects = await Projects.find({ userId });
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
