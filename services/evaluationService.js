/**
 * Service for evaluating profiles against criteria
 */
const fs = require('fs').promises;
const path = require('path');

// Directory for storing evaluations
const DATA_DIR = path.join(__dirname, '..', 'data');
const EVALUATIONS_DIR = path.join(DATA_DIR, 'evaluations');

// Initialize the evaluations cache
let evaluationsCache = {};

// Load evaluations from disk
const loadEvaluations = async () => {
  try {
    // Ensure directory exists
    await fs.mkdir(EVALUATIONS_DIR, { recursive: true });
    
    // Try to read the evaluations file
    const evaluationsFile = path.join(DATA_DIR, 'evaluations.json');
    try {
      const data = await fs.readFile(evaluationsFile, 'utf8');
      evaluationsCache = JSON.parse(data);
      console.log(`Loaded ${Object.keys(evaluationsCache).length} evaluations from disk`);
    } catch (err) {
      // File doesn't exist or other error
      console.log('No existing evaluations file found, creating new one');
      evaluationsCache = {};
      await saveEvaluations();
    }
  } catch (error) {
    console.error('Error loading evaluations:', error);
  }
};

// Save evaluations to disk
const saveEvaluations = async () => {
  try {
    // Ensure directory exists
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    // Save the evaluations
    const evaluationsFile = path.join(DATA_DIR, 'evaluations.json');
    await fs.writeFile(evaluationsFile, JSON.stringify(evaluationsCache, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving evaluations:', error);
    throw error;
  }
};

// Initialize on module load
loadEvaluations();

// Store evaluation criteria for a profile
exports.storeEvaluationCriteria = async (linkedinUrl, userId, criteria) => {
  try {
    evaluationsCache[linkedinUrl] = {
      userId,
      criteria,
      timestamp: new Date().toISOString(),
      evaluated: false
    };
    
    await saveEvaluations();
    return true;
  } catch (error) {
    console.error('Error storing evaluation criteria:', error);
    throw error;
  }
};

// Get evaluation for a profile
exports.getEvaluation = (linkedinUrl) => {
  if (evaluationsCache[linkedinUrl] && evaluationsCache[linkedinUrl].evaluated) {
    return {
      found: true,
      evaluation: evaluationsCache[linkedinUrl].evaluation,
      timestamp: evaluationsCache[linkedinUrl].timestamp
    };
  }
  
  return {
    found: false,
    message: 'No evaluation found for this URL.'
  };
};

// Analyze profile against criteria
exports.analyzeProfile = async (profileData, criteria) => {
  try {
    const profile = profileData.profile || {};
    
    // Default evaluation structure
    const evaluation = {
      score: 0,
      maxScore: 0,
      criteria: {},
      summary: '',
      timestamp: new Date().toISOString()
    };
    
    // Process each criterion
    if (criteria && Array.isArray(criteria)) {
      for (const criterion of criteria) {
        const { name, weight, keywords } = criterion;
        
        if (!name || !weight || !keywords || !Array.isArray(keywords)) {
          continue;
        }
        
        evaluation.maxScore += weight;
        
        // Check if any keywords match in the profile
        const matches = [];
        const profileText = JSON.stringify(profile).toLowerCase();
        
        for (const keyword of keywords) {
          if (profileText.includes(keyword.toLowerCase())) {
            matches.push(keyword);
          }
        }
        
        // Calculate score based on matches
        const criterionScore = matches.length > 0 ? weight : 0;
        evaluation.score += criterionScore;
        
        // Store criterion evaluation
        evaluation.criteria[name] = {
          score: criterionScore,
          maxScore: weight,
          matches: matches
        };
      }
    }
    
    // Calculate percentage score
    evaluation.percentage = evaluation.maxScore > 0 
      ? Math.round((evaluation.score / evaluation.maxScore) * 100) 
      : 0;
    
    // Generate summary
    evaluation.summary = `Profile matches ${evaluation.score} out of ${evaluation.maxScore} criteria (${evaluation.percentage}%)`;
    
    return evaluation;
  } catch (error) {
    console.error('Error analyzing profile:', error);
    throw error;
  }
};

// Update evaluation with results
exports.updateEvaluation = async (linkedinUrl, evaluation) => {
  try {
    if (!evaluationsCache[linkedinUrl]) {
      throw new Error(`No evaluation found for URL: ${linkedinUrl}`);
    }
    
    evaluationsCache[linkedinUrl].evaluation = evaluation;
    evaluationsCache[linkedinUrl].evaluated = true;
    
    await saveEvaluations();
    return true;
  } catch (error) {
    console.error('Error updating evaluation:', error);
    throw error;
  }
};