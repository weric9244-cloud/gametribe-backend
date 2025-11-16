/**
 * User Normalization Script for Search
 * 
 * This script normalizes all existing users in the database to ensure
 * they are searchable in the discover feature.
 * 
 * It ensures all users have:
 * - displayName (primary searchable field)
 * - name (alias for compatibility)
 * - username (searchable username field)
 * - firstName and lastName (extracted from displayName)
 * - photoURL and avatar (consistent photo fields)
 * 
 * Usage:
 *   node scripts/normalizeUsersForSearch.js
 * 
 * Or via API endpoint:
 *   POST /api/migration/normalize-users
 */

const { database } = require('../config/firebase');
const { normalizeUserData: normalizeUserDataUtil } = require('../utils/userNormalization');

/**
 * Normalize a single user's data for search
 * @deprecated Use normalizeUserDataUtil from utils/userNormalization.js instead
 */
function normalizeUserData(userId, userData) {
  const normalized = {
    ...userData,
    uid: userId,
  };

  // Extract displayName from various sources (prioritize Google/Firebase Auth data)
  if (!normalized.displayName) {
    normalized.displayName = normalized.name || 
                             normalized.fullName || 
                             normalized.username ||
                             (normalized.email ? normalized.email.split('@')[0] : 'User');
  }
  
  // Ensure name field exists
  if (!normalized.name && normalized.displayName) {
    normalized.name = normalized.displayName;
  }
  
  // Extract first and last name from displayName if available
  if (normalized.displayName && !normalized.firstName && !normalized.lastName) {
    const nameParts = normalized.displayName.trim().split(/\s+/);
    if (nameParts.length >= 2) {
      normalized.firstName = nameParts[0];
      normalized.lastName = nameParts.slice(1).join(' ');
    } else if (nameParts.length === 1) {
      normalized.firstName = nameParts[0];
    }
  }
  
  // Ensure username exists (create from displayName if missing)
  if (!normalized.username && normalized.displayName) {
    normalized.username = normalized.displayName
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w_]/g, '');
  }
  
  // Ensure photoURL exists (from avatar if available)
  if (!normalized.photoURL && normalized.avatar) {
    normalized.photoURL = normalized.avatar;
  }
  if (!normalized.avatar && normalized.photoURL) {
    normalized.avatar = normalized.photoURL;
  }
  
  // Mark as normalized
  normalized._normalizedForSearch = true;
  normalized._normalizedAt = new Date().toISOString();
  
  return normalized;
}

/**
 * Normalize all users in the database
 */
async function normalizeAllUsers() {
  try {
    console.log('🔄 Starting user normalization...');
    
    const usersRef = database.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const users = usersSnapshot.val() || {};
    
    const userIds = Object.keys(users);
    console.log(`📊 Found ${userIds.length} users to normalize`);
    
    let normalizedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const errors = [];
    
    // Process users in batches to avoid overwhelming Firebase
    const batchSize = 50;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (userId) => {
          try {
            const userData = users[userId];
            
            // Skip if already normalized
            if (userData._normalizedForSearch) {
              skippedCount++;
              return;
            }
            
            // Normalize user data using utility function
            const normalized = normalizeUserDataUtil(userId, userData);
            
            // Update user in database
            const userRef = database.ref(`users/${userId}`);
            await userRef.update({
              displayName: normalized.displayName,
              name: normalized.name,
              username: normalized.username,
              firstName: normalized.firstName,
              lastName: normalized.lastName,
              photoURL: normalized.photoURL,
              avatar: normalized.avatar,
              _normalizedForSearch: true,
              _normalizedAt: normalized._normalizedAt,
            });
            
            normalizedCount++;
            
            if (normalizedCount % 10 === 0) {
              console.log(`✅ Normalized ${normalizedCount} users...`);
            }
          } catch (error) {
            errorCount++;
            errors.push({ userId, error: error.message });
            console.error(`❌ Error normalizing user ${userId}:`, error.message);
          }
        })
      );
    }
    
    console.log('\n✅ User normalization complete!');
    console.log(`📊 Statistics:`);
    console.log(`   - Total users: ${userIds.length}`);
    console.log(`   - Normalized: ${normalizedCount}`);
    console.log(`   - Already normalized (skipped): ${skippedCount}`);
    console.log(`   - Errors: ${errorCount}`);
    
    if (errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      errors.slice(0, 10).forEach(({ userId, error }) => {
        console.log(`   - ${userId}: ${error}`);
      });
      if (errors.length > 10) {
        console.log(`   ... and ${errors.length - 10} more errors`);
      }
    }
    
    return {
      success: true,
      total: userIds.length,
      normalized: normalizedCount,
      skipped: skippedCount,
      errors: errorCount,
      errorDetails: errors,
    };
  } catch (error) {
    console.error('❌ Fatal error during user normalization:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  normalizeAllUsers()
    .then((result) => {
      console.log('\n✅ Script completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { normalizeAllUsers, normalizeUserData };

