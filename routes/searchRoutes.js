const express = require('express');
const router = express.Router();
const searchController = require('../controllers/searchController');
const usageService = require('../services/usageService');
const { authenticateUser, checkCredits } = require('../middleware/authentication');
const upload = require('../middleware/fileUpload');

router.post('/parse-requirements', authenticateUser, searchController.parseJobRequirements);
router.post('/linkedin', authenticateUser, checkCredits, upload.single('file'), searchController.searchLinkedInProfiles);
router.post('/linkedin-profiles', authenticateUser, checkCredits, searchController.getFormattedLinkedInProfiles);
router.post('/generate-query', authenticateUser, searchController.generateSearchQueries);
router.post('/linkedin-bulk', authenticateUser, checkCredits, searchController.bulkSearchLinkedInProfiles);
// Update the route to use the controller instead of service directly
router.post('/signalhire', authenticateUser, checkCredits, searchController.searchSignalHireProfiles);// Headless browser routes
// router.post('/analyze-google-cse', authenticateUser, checkCredits, searchController.analyzeGoogleCseStructure);
router.post('/brave', authenticateUser, checkCredits, searchController.searchBraveLinkedInProfiles);

// CSV import route with file upload support
router.post('/import-csv',
    authenticateUser,
    upload.single('csvFile'), // 'csvFile' is the form field name for file uploads
    searchController.importCsv
);

// CSV profile extraction route with file upload support
router.post('/extract-profiles-csv',
    authenticateUser,
    upload.single('csvFile'), // 'csvFile' is the form field name for file uploads
    searchController.extractProfilesFromCsv
);

// Claude API - Filter profiles from CSV based on title, location, and industries
router.post('/filter-profiles-csv',
    authenticateUser,
    upload.single('csvFile'), // 'csvFile' is the form field name for file uploads
    searchController.filterProfilesFromCsv
);

// OpenAI API - Filter profiles from CSV based on title, location, and industries
router.post('/filter-profiles-csv-openai',
    authenticateUser,
    upload.single('csvFile'), // 'csvFile' is the form field name for file uploads
    searchController.filterProfilesFromCsvOpenAI
);

// Gemini API - Filter profiles from CSV based on title, location, and industries
router.post('/filter-profiles-csv-gemini',
    authenticateUser,
    upload.single('csvFile'), // 'csvFile' is the form field name for file uploads
    searchController.filterProfilesFromCsvGemini
);

// Process CSV/XLSX file and return formatted profiles without filters using Gemini AI
router.post('/process-csv-profiles',
    authenticateUser,
    upload.any(), // Use upload.any() to handle multipart/form-data (file or rawData)
    searchController.processCsvProfiles
);

// Usage endpoint
router.get('/usage', authenticateUser, async (req, res) => {
    try {
        const usage = await usageService.getSearchUsage(req.user.userId);
        res.status(200).json({
            success: true,
            data: usage
        });
    } catch (error) {
        console.error('Error getting search usage:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;