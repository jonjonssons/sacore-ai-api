module.exports = {
  models: {
    default: 'gpt-4o-mini',
    fallback: 'gpt-3.5-turbo'
  },
  prompts: {
    profileExtraction: `Extract LinkedIn profile information from the provided data. 
                       Return a JSON object with name, title, company, and location fields.
                       If you cannot determine a field, leave it as an empty string.`
  }
};