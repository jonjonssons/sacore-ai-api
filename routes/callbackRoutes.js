const express = require('express');
const router = express.Router();
const profileService = require('../services/profileService');
const signalHireService = require('../services/signalHireService');
const contactOutService = require('../services/contactOutService');
// Handle SignalHire callbacks
// router.post('/signalhire', async (req, res) => {
//   try {
//     const { requestId, status, data } = req.body;

//     if (!requestId) {
//       return res.status(400).json({ error: 'Missing required field: requestId' });
//     }

//     // Get the original request
//     const request = await profileService.getRequestById(requestId);

//     if (!request) {
//       return res.status(404).json({ error: `Request with ID ${requestId} not found` });
//     }

//     // Update the request status
//     await profileService.updateRequestStatus(requestId, status, { data });

//     // If the request was successful, update the profile
//     if (status === 'success' && data && request.url) {
//       // Get the profile
//       const profile = await profileService.getProfileByUrl(request.url);

//       // Enrich the profile with the new data
//       const enrichedProfile = {
//         ...profile,
//         email: data.email || profile.email || '',
//         phone: data.phone || profile.phone || '',
//         signalHireData: data,
//         lastUpdated: new Date().toISOString()
//       };

//       // Save the enriched profile
//       await profileService.saveProfile(enrichedProfile);
//     }

//     return res.status(200).json({ success: true });
//   } catch (error) {
//     console.error('Error processing SignalHire callback:', error);
//     return res.status(500).json({ error: 'Internal server error processing callback' });
//   }
// });
router.post('/signalhire', async (req, res) => {
  console.log('📬 SignalHire callback received!');
  console.log('Raw callback body:', JSON.stringify(req.body, null, 2));

  try {
    const updates = [];


    for (const { item, candidate, status } of req.body) {
      if (!item) continue;

      console.log(`➡️ Updating ${item} with status: ${status}`);

      // Check if this is a failed LinkedIn URL that can use ContactOut fallback
      if (status === 'failed' && item.includes('linkedin.com/in/')) {
        console.log(`🔄 SignalHire failed for ${item}, attempting ContactOut fallback...`);

        try {
          // Attempt ContactOut enrichment as fallback
          const contactOutResult = await contactOutService.enrichProfile(item);

          if (contactOutResult.success && contactOutResult.profile) {
            console.log(`✅ ContactOut fallback successful for ${item}`);

            // Update the request with ContactOut data instead of failed status
            let updated = null;
            if (item.includes('linkedin')) {
              updated = await profileService.updateRequestStatusByUrl(item, 'success', {
                ...contactOutResult.profile,
                enrichmentSource: 'contactout_fallback',
                fallbackUsed: true,
                originalSignalHireStatus: 'failed'
              });
            }

            updates.push({
              item,
              status: 'success',
              fallbackUsed: true,
              source: 'contactout'
            });
          } else {
            console.log(`❌ ContactOut fallback also failed for ${item}: ${contactOutResult.message}`);

            // Both SignalHire and ContactOut failed
            let updated = null;
            if (item.includes('linkedin')) {
              updated = await profileService.updateRequestStatusByUrl(item, 'failed', {
                signalHireStatus: 'failed',
                contactOutStatus: 'failed',
                contactOutError: contactOutResult.message,
                bothEnrichmentsFailed: true
              });
            }

            updates.push({
              item,
              status: 'failed',
              fallbackAttempted: true,
              fallbackFailed: true
            });
          }
        } catch (contactOutError) {
          console.error(`💥 ContactOut fallback exception for ${item}:`, contactOutError.message);

          // ContactOut threw an exception
          let updated = null;
          if (item.includes('linkedin')) {
            updated = await profileService.updateRequestStatusByUrl(item, 'failed', {
              signalHireStatus: 'failed',
              contactOutError: contactOutError.message,
              bothEnrichmentsFailed: true
            });
          }

          updates.push({
            item,
            status: 'failed',
            fallbackAttempted: true,
            fallbackError: contactOutError.message
          });
        }
      } else {
        // Normal processing for non-failed items or non-LinkedIn URLs
        let updated = null;
        let shouldTryIcypeasFallback = false;

        if (item.includes('linkedin')) {
          const requestRecord = await profileService.getRequestByUrl(item);
          if (!requestRecord) {
            console.warn(`❗ No matching request found for LinkedIn URL: ${item}`);
            continue;
          }

          // Check if this is a successful response but with no email contacts
          if (status === 'success' && candidate) {
            const hasEmailContacts = candidate.contacts &&
              Array.isArray(candidate.contacts) &&
              candidate.contacts.some(contact => contact.type === 'email');

            if (!hasEmailContacts) {
              console.log(`🔍 SignalHire succeeded for ${item} but found no email contacts. Checking for Icypeas fallback...`);
              shouldTryIcypeasFallback = true;
            }
          }

          // Try Icypeas fallback if SignalHire found no emails
          if (shouldTryIcypeasFallback) {
            try {
              // Check if we have the required profile data for Icypeas fallback
              // We need firstname, lastname, and domainOrCompany
              const profileData = candidate;
              let icypeasData = null;

              // Extract name parts
              const fullName = profileData.fullName || '';
              const nameParts = fullName.split(' ');
              const firstname = nameParts[0] || '';
              const lastname = nameParts.slice(1).join(' ') || '';

              // Extract company domain from experience
              let domainOrCompany = '';
              if (profileData.experience && profileData.experience.length > 0) {
                domainOrCompany = profileData.experience[0].company || '';
              }

              if (firstname && lastname && domainOrCompany) {
                console.log(`🔄 Attempting Icypeas fallback for ${item} (${firstname} ${lastname} at ${domainOrCompany})`);

                const icypeasService = require('../services/icypeasService');
                const icypeasResult = await icypeasService.enrichProfileWithEmail(
                  firstname,
                  lastname,
                  domainOrCompany
                );

                if (icypeasResult.success && icypeasResult.data && icypeasResult.data.emails.length > 0) {
                  console.log(`✅ Icypeas fallback successful for ${item}, found ${icypeasResult.data.emails.length} emails`);

                  // Merge Icypeas email data with SignalHire profile data
                  const enhancedCandidate = {
                    ...candidate,
                    contacts: [
                      ...(candidate.contacts || []),
                      ...icypeasResult.data.emails.map(emailData => ({
                        type: 'email',
                        email: emailData.email,
                        label: emailData.type || 'professional',
                        verification: emailData.verification || {}
                      }))
                    ],
                    enrichmentSource: 'signalhire_with_icypeas_fallback',
                    fallbackUsed: true,
                    icypeasData: icypeasResult.data.raw
                  };

                  updated = await profileService.updateRequestStatusByUrl(item, status, enhancedCandidate);

                  updates.push({
                    item,
                    status: 'success_with_icypeas_fallback',
                    emailsFound: icypeasResult.data.emails.length
                  });
                } else {
                  console.log(`❌ Icypeas fallback failed for ${item}: ${icypeasResult.error || 'No emails found'}`);

                  // Use original SignalHire data with fallback info
                  const candidateWithFallbackInfo = {
                    ...candidate,
                    enrichmentSource: 'signalhire_only',
                    fallbackUsed: true,
                    icypeasError: icypeasResult.error || 'No emails found',
                    noEmailsFound: true
                  };

                  updated = await profileService.updateRequestStatusByUrl(item, status, candidateWithFallbackInfo);

                  updates.push({
                    item,
                    status: 'success_no_emails',
                    fallbackAttempted: true,
                    fallbackError: icypeasResult.error || 'No emails found'
                  });
                }
              } else {
                console.log(`⚠️ Cannot use Icypeas fallback for ${item}: insufficient profile data (firstname: ${!!firstname}, lastname: ${!!lastname}, company: ${!!domainOrCompany})`);

                // Use original SignalHire data
                updated = await profileService.updateRequestStatusByUrl(item, status, candidate);
                updates.push({
                  item,
                  status: 'success_no_emails',
                  reason: 'Insufficient data for Icypeas fallback'
                });
              }
            } catch (icypeasError) {
              console.error(`❌ Icypeas fallback error for ${item}:`, icypeasError.message);

              // Use original SignalHire data with error info
              const candidateWithError = {
                ...candidate,
                enrichmentSource: 'signalhire_only',
                fallbackUsed: true,
                icypeasError: icypeasError.message,
                noEmailsFound: true
              };

              updated = await profileService.updateRequestStatusByUrl(item, status, candidateWithError);

              updates.push({
                item,
                status: 'success_no_emails',
                fallbackAttempted: true,
                fallbackError: icypeasError.message
              });
            }
          } else {
            // Normal SignalHire processing (has emails or not a success status)
            updated = await profileService.updateRequestStatusByUrl(item, status, candidate);
            updates.push({ item, status });
          }
        } else {
          const requestRecord = await profileService.getRequestByProfileId(item);
          if (!requestRecord) {
            console.warn(`❗ No matching request found for profileId: ${item}`);
            continue;
          }
          updated = await profileService.updateRequestStatusByProfileId(item, status, candidate);
          updates.push({ item, status });
        }
      }
    }

    return res.status(200).json({
      success: true,
      updated: updates.length,
      details: updates
    });
  } catch (error) {
    console.error('Error in callback:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


module.exports = router;